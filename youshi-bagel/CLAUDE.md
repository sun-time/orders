# YOUSHI-BAGEL 工作區

兩個「有時貝果」相關的前端專案，**共用同一個 Supabase 後端**。它們共用的是資料層，不是前端程式碼。

## 兩個 app（互相獨立，不要合併程式碼或 build 設定）

- `bagel-order-system/` — 單筆訂購系統。**免建置、單檔 HTML + Vue 3 (CDN)**。細節見其 `README.md` 與 `CLAUDE.md`。
- `group-buy/` — 團購系統。**Vite + npm 專案**（`npm install` / `npm run dev|build`）。細節見其 `README.md` / `CLAUDE.md` / `AGENTS.md`。團購原本用 Google 試算表當資料庫（讀寫慢），計畫遷移到此處共用的 Supabase。

> 兩邊建置方式不同，不要把一邊的工具（npm、Vite）套到另一邊（order-system 是直接改 HTML、無 npm）。

## 共用的 Supabase（真正的接點在這裡）

- Project URL：`https://krfrlpmgpfdntaqlyjyq.supabase.co`
- Publishable key（公開，可放前端）：`sb_publishable_Pg8T2D8pc-kkKIDD7hF6UA_5qRDGGsS`
- 同一個專案、同一張 `bagels` 表（商品來源，由 Google 試算表同步）。

### 資料表歸屬

- `bagels`（**共用**，兩個 app 都讀）、`orders`、`settings` → 屬於 order-system。
- 團購遷移時會在**同一個 Supabase 專案**新增團購自己的表（例如 `group_orders`），勿與既有表衝突。
- 動到 `bagels` 的 schema 會**同時影響兩個 app**，需謹慎。

## 機密與外部後台（重要）

密鑰都在外部後台、不在這個工作區：Supabase Edge Function Secrets、Cloudflare Turnstile、Google Apps Script、`group-buy/.env.local`。

- 絕不把密鑰寫進程式碼或 commit 進 git。
- 需要動到 **Supabase 後台、Cloudflare、Apps Script 部署、或設定密鑰**時 → 停下來請使用者手動處理（你無法存取這些後台）。

## git

兩個子資料夾各自是獨立 repo；上層 `YOUSHI-BAGEL/` 只是容器。不要做巢狀 git，也不要併掉任一邊的 git 歷史。
