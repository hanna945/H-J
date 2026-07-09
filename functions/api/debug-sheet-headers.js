// GET /api/debug-sheet-headers?tab=7月&key=<team key>
// 暫時性的診斷用端點——直接用現有的 Google 服務帳號金鑰,把三份試算表(J.GAO / H&J / Halo-Mavis)
// 指定分頁的「第1列」「第2列」原始內容讀出來,拿來對照 ledgerParser.js 假設的欄位排列
// (T欄/index19開始才是產品代號區塊,每個代號固定8欄寬,第2列裡「帳面營業額」那個字串標記區塊起點)
// 是否跟三份試算表實際的排列一致。
//
// 故意放在 /api/sheets/、/api/kv/ 這兩個既有 _middleware.js 管轄範圍之外(這兩支都只認 Header,
// 但這支是設計成用瀏覽器網址列/純 URL 呼叫,所以驗證改成看 query string 裡的 key 參數,
// 邏輯上仍然是對照 TEAM_CREDENTIALS,不是另開一個後門密碼。
// debug 用完之後這支檔案可以直接刪掉,不影響任何正式功能。

import { getGoogleAccessToken, fetchSheetMonthValues } from "../_shared/googleAuth.js";

const KNOWN_SHEETS = [
  { name: "Halo-Mavis國際連線(光速代操)", accountId: "1818692121940743", sheetId: "1sQ96WcAeOomq-2HiHmd_3Q-qWMu6SWdR9ydyRhQtxDw" },
  { name: "J.GAO", accountId: "2345685238995965", sheetId: "190JsI1zDXM0eZ4wC2zk8q4T8gouPLShZ-Zng02dpmog" },
  { name: "H&J", accountId: "2157995930925784", sheetId: "1YYAE7d4WAYZUvE5xrAyMXSMkUD0S8eE7wguzBUdVGSU" },
];

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const providedKey = url.searchParams.get("key") || "";

  if (env.TEAM_CREDENTIALS) {
    let creds;
    try {
      creds = JSON.parse(env.TEAM_CREDENTIALS);
    } catch {
      return jsonError("TEAM_CREDENTIALS 不是合法 JSON。", 500);
    }
    if (!providedKey || !creds[providedKey]) return jsonError("unauthorized:key 參數不對或沒帶。", 401);
  }

  if (!env.GOOGLE_SERVICE_ACCOUNT_KEY) return jsonError("尚未設定 GOOGLE_SERVICE_ACCOUNT_KEY。", 500);

  const tab = url.searchParams.get("tab") || "7月";

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } catch {
    return jsonError("GOOGLE_SERVICE_ACCOUNT_KEY 不是合法的 JSON。", 500);
  }

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(serviceAccount);
  } catch (e) {
    return jsonError("跟 Google 驗證失敗:" + e.message, 502);
  }

  const results = [];
  for (const sheet of KNOWN_SHEETS) {
    try {
      const values = await fetchSheetMonthValues(accessToken, sheet.sheetId, tab);
      results.push({
        name: sheet.name,
        accountId: sheet.accountId,
        totalRows: values.length,
        totalColsRow1: (values[0] || []).length,
        totalColsRow2: (values[1] || []).length,
        // A欄開始完整列出前2列,連同欄位index(方便對照T欄=19這個假設),缺的儲存格 Sheets API 本來就會直接省略不補。
        row1: (values[0] || []).map((v, i) => `[${i}]${v}`),
        row2: (values[1] || []).map((v, i) => `[${i}]${v}`),
        row3Sample: (values[2] || []).slice(0, 5).map((v, i) => `[${i}]${v}`),
      });
    } catch (e) {
      results.push({ name: sheet.name, accountId: sheet.accountId, error: e.message });
    }
  }

  return new Response(JSON.stringify({ tab, results }, null, 2), { headers: { "Content-Type": "application/json" } });
}
