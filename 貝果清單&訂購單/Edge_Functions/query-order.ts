// ============================================================
// query-order — 訂單查詢 Edge Function
// 部署：Supabase 後台 → Edge Functions → Deploy a new function
//       → Via Editor → 函式名稱填 query-order
//       → 把本檔內容貼進它的 index.ts（檔名保持 index.ts，不要改檔名）→ Deploy
// 共用既有的 TURNSTILE_SECRET（Secrets 為專案層級，不用再設一次）
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // 上線後可改成你的 Netlify 網域
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 回傳給前端的欄位（刻意不含 client_ip / user_agent 等內部欄位）
const PUBLIC_COLS =
  "order_code,customer_name,phone,email,delivery_method,address,notes," +
  "items,item_count,subtotal,shipping_fee,total_amount,status,created_at";

function jsonRes(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // CORS 預檢
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { type, value, turnstile_token } = body ?? {};

    // 1. 參數檢查：type 只能是 code 或 phone
    if (type !== "code" && type !== "phone") {
      return jsonRes({ error: "查詢類型錯誤" }, 400);
    }
    const v = String(value ?? "").trim();
    if (!v) return jsonRes({ error: "請輸入查詢內容" }, 400);

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";

    // 2. Turnstile 驗證（防自動化掃描/枚舉）
    const tsRes = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: Deno.env.get("TURNSTILE_SECRET") ?? "",
          response: turnstile_token ?? "",
          remoteip: ip,
        }),
      },
    );
    const tsData = await tsRes.json() as any;
    if (!tsData.success) return jsonRes({ error: "人機驗證失敗，請重新整理再試" }, 403);

    // 3. service_role client（略過 RLS；但只回傳符合條件的列）
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 4. 依條件查詢
    let query = supabase.from("orders").select(PUBLIC_COLS)
      .order("created_at", { ascending: false });
    if (type === "code") query = query.eq("order_code", v.toUpperCase());
    else query = query.eq("phone", v);

    const { data, error } = await query;
    if (error) throw error;

    // 5. 統一回傳訂單陣列（0/1/多筆）
    return jsonRes({ orders: data ?? [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("query-order error:", msg);
    return jsonRes({ error: "系統錯誤：" + msg }, 500);
  }
});
