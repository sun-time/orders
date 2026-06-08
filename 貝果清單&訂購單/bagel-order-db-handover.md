# 貝果訂購系統 — 資料庫交接文件

> 給下一個對話的 Claude:這份文件描述了「貝果銷售網站」資料庫端的現況與待辦事項。
> 使用者偏好 Vue 3 (CDN 引入,不用 Next.js)、單一 HTML 檔的部署方式,並透過 Netlify 託管。
> 已部署的管理工具(`index.html`)成功運作中,本文件聚焦在**新增訂購頁面所需的資料庫變更**。

---

## 一、現有環境(已建立,**不需重新做**)

### Supabase 專案

| 項目 | 值 |
|---|---|
| Project URL | `https://krfrlpmgpfdntaqlyjyq.supabase.co` |
| Publishable key (可放前端) | `sb_publishable_Pg8T2D8pc-kkKIDD7hF6UA_5qRDGGsS` |
| 地區 | Northeast Asia (Tokyo) `ap-northeast-1` |
| 三個管理員帳號 | `joyce@bagel.local` / `jassie@bagel.local` / `young@bagel.local`,密碼 `99youngni` |

### 現有 `bagels` 資料表 schema

```sql
create table bagels (
  id           bigint generated always as identity primary key,
  sort_order   integer not null,           -- 排序
  name         text not null,              -- 名稱
  price        integer not null,           -- 定價
  is_meat      boolean default false,      -- 葷食
  is_new       boolean default false,      -- 新品
  is_active    boolean default true,       -- 是否上架
  tag          text,                       -- 特殊標籤(例如「季節限定」、「超人氣」)
  description  text,                       -- 簡介文字
  image_url    text,                       -- 圖片連結(目前都是 nieo7.github.io/suntime/img/bagel/*.jpg)
  updated_at   timestamptz default now()
);
```

### 現有 RLS 政策(`bagels` 表)

- ✅ **任何人可讀**(`select`):這就是訂購頁面要用的能力,**不用任何登入就可以讀取**。
- ✅ 已登入者可寫入/更新/刪除:由管理工具使用。

### 資料來源工作流程

- Google 試算表(已發布為公開 CSV)→ 管理員手動按按鈕同步 → 寫入 `bagels` 表。
- 訂購頁面**只需要從 `bagels` 表讀取**,完全不用碰試算表。

### 圖片儲存

GitHub Pages:`https://nieo7.github.io/suntime/img/bagel/{filename}.jpg`,直接用 `image_url` 欄位的網址就能顯示。

---

## 二、要新增的部分(本次任務)

1. 建立 `orders` 訂單資料表
2. 設定 RLS 政策:**匿名使用者可寫入,但不能讀取**(避免別人看到他人訂單)
3. 防止惡意頻繁寫入(下方有具體方案)
4. 訂單成立時通知管理員(email + Telegram,LINE Notify 已停用)

---

## 三、`orders` 訂單表 — 建議 schema

```sql
create table orders (
  id               bigint generated always as identity primary key,
  order_code       text unique not null,            -- 給客戶看的訂單編號,例如 '260604001'
  customer_name    text not null,                   -- 訂購人姓名
  phone            text not null,                   -- 聯絡電話
  email            text,                            -- email(選填,但通知會用)
  pickup_method    text not null,                   -- 'pickup'(自取) 或 'delivery'(外送)
  pickup_date      date,                            -- 預約取貨/送達日期
  pickup_time      text,                            -- 預約時段,例如 '14:00-15:00'
  delivery_address text,                            -- 外送地址(若為自取則 NULL)
  items            jsonb not null,                  -- 訂購明細(陣列)見下方範例
  item_count       integer not null,                -- 總件數
  total_amount     integer not null,                -- 總金額(後端再算一次以防被改)
  notes            text,                            -- 客戶備註
  status           text not null default 'new',     -- 訂單狀態:new / confirmed / ready / completed / cancelled
  client_ip        text,                            -- 來源 IP(由 edge function 寫入,反濫用用)
  user_agent       text,                            -- 來源瀏覽器(同上)
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index on orders (created_at desc);
create index on orders (status);
create index on orders (phone);
```

### `items` JSONB 範例

```json
[
  { "bagel_id": 1, "name": "乳酪蛋糕貝果", "price": 58, "qty": 2 },
  { "bagel_id": 10, "name": "鹽之花", "price": 55, "qty": 3 }
]
```

> 設計理由:訂單明細用 JSONB 而不另開 `order_items` 表 — 對這個規模(小型烘焙坊)夠用,查詢也簡單。即使日後改成正規化也很好遷移。

### `order_code` 產生邏輯

格式 `YYMMDDNNN`(年月日 + 當日流水號),例如 `260604001`。
建議在 **edge function** 裡產生而不是前端,前端不可信。
做法:抓當天的訂單筆數 + 1,組成編號。

---

## 四、RLS 政策(關鍵安全設定)

```sql
-- 啟用 RLS
alter table orders enable row level security;

-- 任何人可以「寫入」訂單(訂購頁面要用)
create policy "Anonymous can place orders"
  on orders for insert
  to anon, authenticated
  with check (true);

-- 沒有 SELECT 政策 = 匿名沒辦法讀,只有後台 service_role 才能查
-- (管理員之後若需要看訂單,要另外建 SELECT policy 給 authenticated)

-- 已登入管理員可以讀取與更新(改訂單狀態用)
create policy "Authenticated users can view orders"
  on orders for select
  to authenticated using (true);

create policy "Authenticated users can update orders"
  on orders for update
  to authenticated using (true);
```

⚠️ **重點**:不要給匿名 SELECT 權限,否則別人可以列出全部訂單。

---

## 五、防止惡意頻繁寫入

**建議用三層防線**(由輕到重):

### Layer 1:Honeypot 蜜罐欄位(必做,零成本)

在表單裡放一個 CSS 隱藏的欄位(例如 `<input name="website" style="display:none">`),正常使用者看不到不會填,機器人會填。提交時若該欄位有值,就丟掉訂單。

### Layer 2:Cloudflare Turnstile(強烈建議)

免費、無 quota、隱形挑戰,UX 比 reCAPTCHA 好很多。
- 申請:`dash.cloudflare.com` → Turnstile → Add site
- 拿到 **site key**(放前端)+ **secret key**(放 edge function 環境變數)
- 提交時前端產生 token → 後端 edge function 驗證 token → 通過才插入訂單

### Layer 3:資料庫層級的速率限制(可選)

用 Postgres function 在 insert 前檢查:**同一個 IP 在過去 5 分鐘內若已有 3 筆訂單就拒絕**。

```sql
create or replace function check_order_rate_limit()
returns trigger as $$
declare
  recent_count integer;
begin
  if new.client_ip is not null then
    select count(*) into recent_count
    from orders
    where client_ip = new.client_ip
      and created_at > now() - interval '5 minutes';
    if recent_count >= 3 then
      raise exception '訂單頻率過高,請稍後再試';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger orders_rate_limit
  before insert on orders
  for each row execute function check_order_rate_limit();
```

> 注意:這個 trigger 只在 `client_ip` 由可信來源(edge function)寫入時才有效。如果前端直接 insert,客戶端可以亂填 IP,所以推薦的架構是「前端 → Edge Function → DB」,而不是「前端 → DB」直連。

---

## 六、推薦架構 — Edge Function 作為中介

```
┌─────────────┐
│ 訂購頁面     │ (Vue 3 + Turnstile,部署在 Netlify)
└──────┬──────┘
       │ POST { 訂單資料 + turnstile_token }
       ▼
┌──────────────────────────────────┐
│ Supabase Edge Function           │
│   1. 驗證 Turnstile token        │
│   2. 檢查 honeypot              │
│   3. 取得真實 client IP         │
│   4. 產生 order_code            │
│   5. 後端重新計算 total_amount   │
│   6. INSERT INTO orders         │
│   7. 觸發通知(下方第七節)       │
└──────────┬───────────────────────┘
           ▼
       Supabase DB (orders 表)
```

優點:所有驗證集中在 edge function,前端不能繞過。client_ip 由後端取得 header 寫入,使用者改不了。

替代簡化架構(若不想用 Edge Function):前端直接 insert 到 `orders`,只靠 Honeypot + RLS + 資料庫 trigger 防守。較不嚴格但設置簡單。

---

## 七、訂單通知(LINE Notify 已停用!)

LINE Notify 已於 **2025/3/31 停止服務**。可選方案:

### 強烈推薦:Telegram Bot + Email

| 通道 | 成本 | 設定難度 | 即時性 |
|---|---|---|---|
| **Telegram Bot** | 完全免費 | ★ 5 分鐘搞定 | 即時推播 |
| **Email (Resend)** | 100 封/天免費 | ★★ 需 API key | 1-2 秒到 |
| LINE Messaging API | 每月 200 則免費,超過 NT$800/月起 | ★★★ 較複雜 | 即時推播 |
| Discord Webhook | 完全免費 | ★ 最簡單 | 即時推播 |

### Telegram Bot 設定流程

1. 用 Telegram 找 `@BotFather`,送 `/newbot`,跟著步驟設定名稱,**會拿到 token**(類似 `123456:ABC-DEF...`)
2. 建立一個「貝果訂單通知」群組,把剛建立的 bot 加進來
3. 取得 group 的 `chat_id`:對 bot 送一句話,然後瀏覽器開 `https://api.telegram.org/bot<TOKEN>/getUpdates`,在 JSON 裡找 `chat.id`(負數開頭)
4. 把 `TOKEN` 和 `CHAT_ID` 存到 Supabase Edge Function 的環境變數
5. 在 edge function 裡呼叫:
   ```ts
   await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       chat_id: CHAT_ID,
       text: `🥯 新訂單 #${order_code}\n姓名:${customer_name}\n...`,
       parse_mode: 'Markdown'
     })
   });
   ```

### Email 設定(用 Resend)

1. `resend.com` 註冊,免費 100 封/天
2. 拿到 API key(`re_xxx`)
3. 在 edge function 呼叫:
   ```ts
   await fetch('https://api.resend.com/emails', {
     method: 'POST',
     headers: {
       'Authorization': `Bearer ${RESEND_KEY}`,
       'Content-Type': 'application/json'
     },
     body: JSON.stringify({
       from: 'orders@yourdomain.com',  // 需先驗證網域
       to: ['admin@yourdomain.com'],
       subject: `新訂單 #${order_code}`,
       html: '...'
     })
   });
   ```
   ⚠️ Resend 要求驗證寄件人網域(免費,但要在 DNS 加 record)。若沒自己網域,可暫用 `onboarding@resend.dev` 寄,只能寄給自己註冊的 email。

### LINE 若一定要用

LINE Messaging API 每月 200 則免費。對小型烘焙坊一天 7 單來說,撐 28 天剛好用完,可能不夠。建議搭配 Telegram 作為主要通知,LINE 當備援(或乾脆不用)。

---

## 八、Supabase 免費額度與注意事項(2026)

| 項目 | 免費額度 | 對本專案影響 |
|---|---|---|
| 資料庫 | 500 MB | 訂單表很省,文字資料,十年也用不完 |
| 月活躍用戶 | 50,000 MAU | 訂購頁是匿名訪客,不算 MAU |
| Edge Function 呼叫 | 500,000/月 | 即使一天 100 單也用不到 1% |
| 出站頻寬 | 5 GB/月 | 文字資料,不會超過 |
| **專案 7 天閒置會暫停** | — | ⚠️ **重要,見下方** |

### ⚠️ 7 天閒置自動暫停問題

Supabase 免費方案的專案,**連續 7 天沒有任何資料庫流量就會自動暫停**。暫停後第一個訪客會打不開,要管理員到 dashboard 手動 Restore。對訂購網站來說這是不可接受的。

**解法**(擇一):
1. **(免費)** Uptime Robot 設定每 5 分鐘 ping 一次 Supabase REST endpoint。例如 ping `https://krfrlpmgpfdntaqlyjyq.supabase.co/rest/v1/bagels?select=id&limit=1`,要加 `apikey` header。
2. **(免費)** GitHub Actions 排程,每天用 curl 戳一下資料庫,程式碼放在公開 repo 就免費。
3. **(付費)** 升級到 Pro $25/月,不會暫停且有每日備份。

對開始營運的網站,**強烈建議至少做 1 或 2**。

---

## 九、訂購頁面開發提示

使用者偏好:
- **Vue 3 CDN**,不要 Next.js / Vite / build tool
- **單一 HTML 檔**,沿用管理工具的風格(暖色系米色 + 棕色 + 橘色)
- **部署到 Netlify**(Drag-and-drop 或 Git)
- 圖片連結直接用 `bagels.image_url` 欄位

引入 CDN:
```html
<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

**注意**:Supabase JS UMD 會在 `window.supabase` 掛載,所以**不要**在你的 JS 裡用 `const supabase = ...`(會跟 global 衝突),改用 `const sb = window.supabase.createClient(...)` 之類的別名。

讀取貝果清單:
```js
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const { data, error } = await sb.from('bagels')
  .select('*')
  .eq('is_active', true)
  .order('sort_order');
```

---

## 十、給下一個對話的建議步驟

1. 跟使用者確認訂購頁面的細節(取貨/外送選項、營業日期、最低訂購量、付款方式等)
2. 跟使用者確認用 Telegram + Email 通知(或其他偏好)
3. 在 Supabase 跑 `orders` 表的 SQL(本文件第三、四節)
4. 申請 Cloudflare Turnstile site key & secret key
5. 申請 Telegram Bot token & chat_id
6. 申請 Resend API key(或選別的 email 服務)
7. 寫一個 Supabase Edge Function `submit-order` 處理:Turnstile 驗證 → 計算金額 → 寫入 DB → 發通知
8. 寫訂購頁面 HTML(Vue 3 + Supabase client + Turnstile widget)
9. 部署到 Netlify
10. 設定 Uptime Robot 防止 7 天暫停

---

*文件版本:26.06.02*
