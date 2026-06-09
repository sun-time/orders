// ============================================================
// 有時貝果訂單 — Google Apps Script Web App
// 接收 submit-order 送來的訂單 → 寫進「訂單」工作表 → 寄確認信給顧客。
// ============================================================

const SHARED_SECRET = '改成你自己的一段長亂碼';   // ← 與 Supabase 的 GSHEET_SECRET 一致
const SHEET_NAME = '訂單';
const HEADERS = ['訂單編號', '時間', '姓名', '電話', 'Email', '配送方式', '地址', '明細', '數量', '小計', '運費', '總計', '備註', '狀態'];

const SHOP_NAME = '有時貝果';
const SEND_CUSTOMER_EMAIL = true;
const ADMIN_EMAIL = '';                            // ← 填你自己的 Gmail，會以密件副本收到與顧客相同的信；留空則不收
const QUERY_URL = 'https://sunorder.netlify.app/';

// 在編輯器選此函式按「執行」可寄測試信給自己（也用來觸發授權）。
function testEmail() {
  const me = Session.getActiveUser().getEmail();
  MailApp.sendEmail({
    to: me,
    subject: '【' + SHOP_NAME + '】測試信',
    body: '如果你收到這封，代表寄信功能與授權都正常。收件人：' + me,
    name: SHOP_NAME,
  });
  Logger.log('已寄測試信給：' + me);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SHARED_SECRET) {
      return json({ ok: false, error: 'unauthorized' });
    }

    // 1. 寫進試算表
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(HEADERS);
    }
    sheet.appendRow([
      body.order_code, body.created_at, body.customer_name, body.phone, body.email,
      body.delivery_method, body.address, body.items_text, body.item_count,
      body.subtotal, body.shipping_fee, body.total_amount, body.notes, body.status,
    ]);

    // 2. 寄確認信給顧客（並以 BCC 給管理者一份相同的信）
    let mailError = '';
    if (SEND_CUSTOMER_EMAIL && body.email) {
      try {
        sendCustomerEmail(body);
      } catch (mailErr) {
        mailError = String(mailErr);
        console.error('寄信失敗: ' + mailError);
      }
    }

    return json({ ok: true, mailError: mailError });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function sendCustomerEmail(o) {
  const lines = [];
  lines.push('親愛的 ' + o.customer_name + ' 您好，');
  lines.push('');
  lines.push('感謝您在' + SHOP_NAME + '訂購！您的訂單已成立：');
  lines.push('');
  lines.push('訂單編號：' + o.order_code);
  lines.push('配送方式：' + o.delivery_method + (o.address ? '（' + o.address + '）' : ''));
  lines.push('訂購明細：' + o.items_text);
  lines.push('數量：' + o.item_count + ' 個');
  lines.push('小計：$' + o.subtotal + '　運費：$' + o.shipping_fee);
  lines.push('總計：NT$' + o.total_amount);
  if (o.notes) lines.push('備註：' + o.notes);
  lines.push('');
  lines.push('到貨日期及付款方式將於收到訂單後與您聯繫。');
  lines.push('查詢訂單：' + QUERY_URL);
  lines.push('');
  lines.push('— ' + SHOP_NAME);

  const opts = {
    to: o.email,
    subject: '【' + SHOP_NAME + '】訂單成立通知 ' + o.order_code,
    body: lines.join('\n'),
    name: SHOP_NAME,
  };
  if (ADMIN_EMAIL) opts.bcc = ADMIN_EMAIL;   // 管理者收到一份相同的信（顧客看不到）

  MailApp.sendEmail(opts);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
