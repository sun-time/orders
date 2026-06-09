// ============================================================
// submit-order — 訂單送出 Edge Function（核心版，尚未含通知）
// 這份內容請貼進函式的「index.ts」（進入點）。
// 函式名稱（網址用）在建立畫面的名稱欄位填 submit-order，與檔名無關。
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
    const tsData = await tsRes.json() as any;
    if (!tsData.success) return jsonRes({ error: "人機驗證失敗，請重新整理再試" }, 403);

    // 4. service_role client（略過 RLS）
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 5. 用 bagel_id 向 DB 撈現價、重算金額（不信前端傳的價格）
    const bagelIds = [...new Set((items as any[]).map((it) => Number(it.bagel_id)))];
    const { data: bagels, error: bagelErr } = await supabase
      .from("bagels").select("id,name,price,is_active").in("id", bagelIds);
    if (bagelErr) throw bagelErr;

    // 用一般物件當查表，避免 Map 的型別問題
    const bagelMap: Record<number, any> = {};
    for (const b of (bagels ?? []) as any[]) bagelMap[Number(b.id)] = b;

    const lineItems: any[] = [];
    let subtotal = 0, itemCount = 0;
    for (const it of items as any[]) {
      const b: any = bagelMap[Number(it.bagel_id)];
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
    const c = cfg as any;
    let shipping = 0;
    if (delivery_method === "kaohsiung") shipping = subtotal >= c.kh_free_min ? 0 : c.kh_fee;
    else if (delivery_method === "island") shipping = subtotal >= c.island_free_min ? 0 : c.island_fee;
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

      if (!error) { inserted = data as any; break; }
      if ((error as any).code !== "23505") throw error; // 非「編號重複」就是真錯誤
      // 否則編號撞號 → 迴圈會用更大的 seq 再試
    }
    if (!inserted) return jsonRes({ error: "訂單編號產生失敗，請再試一次" }, 500);

    // 8. 通知（best-effort：失敗不影響已成立的訂單）
    try {
      const tgToken = Deno.env.get("TELEGRAM_TOKEN");
      const tgChat = Deno.env.get("TELEGRAM_CHAT_ID");
      if (tgToken && tgChat) {
        const dmMap: Record<string, string> = {
          pickup: "自取", kaohsiung: "高雄市區送貨", island: "冷凍宅配（本島）",
        };
        const lines = lineItems
          .map((it) => `· ${it.name} ×${it.qty} = $${it.price * it.qty}`)
          .join("\n");
        const text =
          `🥯 新訂單 ${inserted.order_code}\n` +
          `姓名：${name}\n` +
          `電話：${phone}\n` +
          `配送：${dmMap[delivery_method] || delivery_method}` +
          (address ? `（${address}）` : "") + "\n" +
          `${lines}\n` +
          `小計 $${subtotal}　運費 $${shipping}\n` +
          `總計 $${total}` +
          (notes ? `\n備註：${notes}` : "");
        await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: tgChat, text: text }),
        });
      }
    } catch (e) {
      console.error("telegram notify failed:", e instanceof Error ? e.message : String(e));
    }
    // 8b. 寫入 Google 試算表（透過 Apps Script Web App，best-effort）
    try {
      const sheetUrl = Deno.env.get("GSHEET_WEBHOOK_URL");
      if (sheetUrl) {
        const dmMap2: Record<string, string> = {
          pickup: "自取", kaohsiung: "高雄市區送貨", island: "冷凍宅配（本島）",
        };
        const itemsText = lineItems.map((it) => `${it.name}×${it.qty}`).join("、");
        await fetch(sheetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: Deno.env.get("GSHEET_SECRET") ?? "",
            order_code: inserted.order_code,
            created_at: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }),
            customer_name: name,
            phone: phone,
            email: email,
            delivery_method: dmMap2[delivery_method] || delivery_method,
            address: address ?? "",
            items_text: itemsText,
            item_count: itemCount,
            subtotal: subtotal,
            shipping_fee: shipping,
            total_amount: total,
            notes: notes ?? "",
            status: "new",
          }),
        });
      }
    } catch (e) {
      console.error("gsheet write failed:", e instanceof Error ? e.message : String(e));
    }
    // （Resend 寄信之後有網域再補在這裡）

    return jsonRes({ order_code: inserted.order_code });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("submit-order error:", msg);
    return jsonRes({ error: "系統錯誤：" + msg }, 500);
  }
});
