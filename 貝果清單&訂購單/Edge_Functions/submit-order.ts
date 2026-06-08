// ============================================================
// submit-order — 訂單送出 Edge Function（核心版，尚未含通知）
// 部署：Supabase 後台 → Edge Functions → Deploy a new function
//       → Via Editor → 命名為 submit-order → 貼上本檔內容 → Deploy
// 需要的環境變數（Secrets）：TURNSTILE_SECRET
//   （SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由 Supabase 自動注入，不用自己加）
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // 上線後可改成你的 Netlify 網域
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---- 手機末 8 碼 → 3 碼編碼（單向、會碰撞，故反推不回手機）----
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // 32 字元，排除易混淆 I/L/O/U
function phoneToCode(phone: string): string {
  const last8 = phone.replace(/\D/g, "").slice(-8);
  let n = parseInt(last8, 10) % 32768; // 32^3
  let code = "";
  for (let i = 0; i < 3; i++) { code = ALPHABET[n % 32] + code; n = Math.floor(n / 32); }
  return code;
}

// ---- 取台北時區的年月日 ----
function taipeiDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "2-digit", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const yy = get("year"), mm = get("month"), dd = get("day");
  return { yy, mmdd: mm + dd, dateStr: `20${yy}-${mm}-${dd}` };
}

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
    const {
      name, phone, email, delivery_method, address, notes,
      items, website, turnstile_token,
    } = body ?? {};

    // 1. Honeypot：正常使用者看不到 website 欄位、不會填
    if (website) return jsonRes({ error: "rejected" }, 400);

    // 2. 基本必填檢查
    if (!name || !phone || !email || !delivery_method ||
        !Array.isArray(items) || items.length === 0) {
      return jsonRes({ error: "缺少必要欄位" }, 400);
    }
    if (!["pickup", "kaohsiung", "island"].includes(delivery_method)) {
      return jsonRes({ error: "配送方式錯誤" }, 400);
    }
    if (delivery_method !== "pickup" && !address) {
      return jsonRes({ error: "請填寫收貨地址" }, 400);
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";

    // 3. 驗證 Cloudflare Turnstile token
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
    const tsData = await tsRes.json();
    if (!tsData.success) return jsonRes({ error: "人機驗證失敗，請重新整理再試" }, 403);

    // 4. service_role client（略過 RLS）
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 5. 用 bagel_id 向 DB 撈現價、重算金額（不信前端傳的價格）
    const bagelIds = [...new Set(items.map((it: any) => Number(it.bagel_id)))];
    const { data: bagels, error: bagelErr } = await supabase
      .from("bagels").select("id,name,price,is_active").in("id", bagelIds);
    if (bagelErr) throw bagelErr;

    const bagelMap = new Map((bagels ?? []).map((b: any) => [b.id, b]));
    const lineItems: any[] = [];
    let subtotal = 0, itemCount = 0;
    for (const it of items) {
      const b = bagelMap.get(Number(it.bagel_id));
      const qty = Math.floor(Number(it.qty));
      if (!b || !b.is_active) return jsonRes({ error: "有品項已下架或不存在，請重新整理" }, 400);
      if (!Number.isInteger(qty) || qty <= 0) continue;
      subtotal += b.price * qty;
      itemCount += qty;
      lineItems.push({ bagel_id: b.id, name: b.name, price: b.price, qty });
    }
    if (lineItems.length === 0) return jsonRes({ error: "訂單內容是空的" }, 400);

    // 6. 讀 settings 算運費
    const { data: cfg, error: cfgErr } = await supabase
      .from("settings").select("*").eq("id", 1).single();
    if (cfgErr) throw cfgErr;
    let shipping = 0;
    if (delivery_method === "kaohsiung") shipping = subtotal >= cfg.kh_free_min ? 0 : cfg.kh_fee;
    else if (delivery_method === "island") shipping = subtotal >= cfg.island_free_min ? 0 : cfg.island_fee;
    const total = subtotal + shipping;

    // 7. 產生訂單編號（撞號重試）
    const { yy, mmdd, dateStr } = taipeiDate();
    const code3 = phoneToCode(phone);
    let inserted: { order_code: string } | null = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const { count } = await supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .gte("created_at", `${dateStr}T00:00:00+08:00`)
        .lte("created_at", `${dateStr}T23:59:59+08:00`);
      const seq = String((count ?? 0) + 1 + attempt).padStart(2, "0");
      const order_code = `${yy}.${mmdd}.${code3}${seq}`;

      const { data, error } = await supabase.from("orders").insert({
        order_code, customer_name: name, phone, email,
        delivery_method, address: address ?? null, notes: notes ?? null,
        items: lineItems, item_count: itemCount,
        subtotal, shipping_fee: shipping, total_amount: total,
        client_ip: ip, user_agent: req.headers.get("user-agent") ?? null,
      }).select("order_code").single();

      if (!error) { inserted = data; break; }
      if (error.code !== "23505") throw error; // 非「編號重複」就是真錯誤
      // 否則編號撞號 → 迴圈會用更大的 seq 再試
    }
    if (!inserted) return jsonRes({ error: "訂單編號產生失敗，請再試一次" }, 500);

    // 8. TODO：通知（Telegram / Resend / 寫 Google 試算表）— 之後補在這裡

    return jsonRes({ order_code: inserted.order_code });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("submit-order error:", msg);
    return jsonRes({ error: "系統錯誤：" + msg }, 500);
  }
});
