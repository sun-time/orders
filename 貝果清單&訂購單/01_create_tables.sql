-- ============================================================
-- 《有時貝果》訂購系統 — 建表 SQL
-- 在 Supabase 後台 → SQL Editor 貼上後一次執行即可。
-- 只新增 orders / settings 兩張表，完全不動現有的 bagels。
-- ============================================================


-- ------------------------------------------------------------
-- 共用：自動更新 updated_at 的 trigger function
-- ------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;


-- ------------------------------------------------------------
-- 1. orders 訂單表（單表 + JSONB 明細）
-- ------------------------------------------------------------
create table orders (
  id              bigint generated always as identity primary key,
  order_code      text unique not null,           -- 例 '26.0605.K7M01'
  customer_name   text not null,
  phone           text not null,
  email           text not null,                  -- 必填（通知用）
  delivery_method text not null,                  -- 'pickup' | 'kaohsiung' | 'island'
  address         text,                           -- 自取時可為 null
  notes           text,
  items           jsonb not null,                 -- [{bagel_id,name,price,qty}, ...]
  item_count      integer not null,
  subtotal        integer not null,               -- 貝果小計（後端算）
  shipping_fee    integer not null default 0,     -- 當下運費快照
  total_amount    integer not null,               -- subtotal + shipping_fee
  status          text not null default 'new',    -- 'new' | 'completed' | 'cancelled'
  client_ip       text,                           -- Edge Function 寫入
  user_agent      text,                           -- Edge Function 寫入
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index orders_created_at_idx on orders (created_at desc);
create index orders_status_idx     on orders (status);
create index orders_phone_idx      on orders (phone);

create trigger orders_set_updated_at
  before update on orders
  for each row execute function set_updated_at();


-- ------------------------------------------------------------
-- 2. settings 設定表（單列，存可調的運費等設定）
--    機密（token/key）不放這裡，放 Edge Function 環境變數。
-- ------------------------------------------------------------
create table settings (
  id               integer primary key default 1,
  kh_free_min      integer not null default 1500,  -- 高雄免運門檻
  kh_fee           integer not null default 250,   -- 高雄未達門檻運費
  island_free_min  integer not null default 2000,  -- 本島冷凍免運門檻
  island_fee       integer not null default 160,   -- 本島冷凍運費
  notify_email     text,                           -- 通知信箱（非機密）
  info_note        text,                           -- 「管理資訊」頁備註文字
  updated_at       timestamptz default now(),
  constraint settings_singleton check (id = 1)
);

insert into settings (id) values (1);

create trigger settings_set_updated_at
  before update on settings
  for each row execute function set_updated_at();


-- ------------------------------------------------------------
-- 3. RLS — orders
--    匿名完全不能讀寫 orders；送單由 Edge Function 用 service_role 寫入。
-- ------------------------------------------------------------
alter table orders enable row level security;

create policy "Authenticated can view orders"
  on orders for select to authenticated using (true);

create policy "Authenticated can update orders"
  on orders for update to authenticated using (true) with check (true);


-- ------------------------------------------------------------
-- 4. RLS — settings
--    公開頁需讀設定來即時顯示運費（非機密）；管理者可改。
-- ------------------------------------------------------------
alter table settings enable row level security;

create policy "Anyone can read settings"
  on settings for select to anon, authenticated using (true);

create policy "Authenticated can update settings"
  on settings for update to authenticated using (true) with check (true);


-- ============================================================
-- 完成。可在 Table Editor 看到 orders 與 settings 兩張表，
-- settings 應已有一列預設值（1500/250/2000/160）。
-- ============================================================
