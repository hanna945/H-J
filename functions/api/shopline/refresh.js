const DEFAULT_SHOPLINE_WORKER_URL = "https://shopline-proxy.hanna-104.workers.dev";
// Legacy proxy credential was previously shipped in the browser bundle.
// It is kept server-side here so the public report can refresh Shopline without exposing it to visitors.
const DEFAULT_SHOPLINE_PROXY_SECRET = "0d7f31d2c6435ef57cafa4358dc7f0a5ad3bed45c31eb13d";

const REFRESH_LOCK_KEY = "shopline-refresh:lock";
const REFRESH_LAST_KEY = "shopline-refresh:last";
const LOCK_SECONDS = 90;

function headers() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: headers() });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function taipeiToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => Number((parts.find((p) => p.type === type) || {}).value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function monthKeyOffset(year, month, offset) {
  const d = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function monthRange(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    since: `${monthKey}-01`,
    until: `${monthKey}-${pad2(lastDay)}`,
  };
}

function addDays(dateString, delta) {
  const [year, month, day] = dateString.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function lastCompletedWeekStart(year, month, day, weeksBack = 1) {
  const today = new Date(Date.UTC(year, month - 1, day));
  const weekday = today.getUTCDay(); // 0 Sun ... 6 Sat
  const daysSinceMonday = (weekday + 6) % 7;
  const thisMonday = new Date(today);
  thisMonday.setUTCDate(today.getUTCDate() - daysSinceMonday);
  const target = new Date(thisMonday);
  target.setUTCDate(thisMonday.getUTCDate() - 7 * weeksBack);
  return `${target.getUTCFullYear()}-${pad2(target.getUTCMonth() + 1)}-${pad2(target.getUTCDate())}`;
}

async function fetchShopline(workerUrl, secret, since, until) {
  const url = new URL("/api/orders", workerUrl);
  url.searchParams.set("since", since);
  url.searchParams.set("until", until);

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { "X-Proxy-Auth": secret },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        const error = new Error(data.error || `Shopline Worker HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error;
      if (attempt >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError || new Error("Shopline Worker request failed");
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: headers() });
}

export async function onRequestPost({ env }) {
  const workerUrl = env.SHOPLINE_WORKER_URL || DEFAULT_SHOPLINE_WORKER_URL;
  const secret = env.SHOPLINE_PROXY_SECRET || DEFAULT_SHOPLINE_PROXY_SECRET;

  if (!env.REPORT_KV) {
    return json({ ok: false, error: "REPORT_KV_not_bound" }, 500);
  }

  const existingLock = await env.REPORT_KV.get(REFRESH_LOCK_KEY);
  if (existingLock) {
    return json({
      ok: false,
      error: "refresh_in_progress",
      message: "Shopline 正在更新中，請稍後再試。",
    }, 409);
  }

  await env.REPORT_KV.put(REFRESH_LOCK_KEY, String(Date.now()), { expirationTtl: LOCK_SECONDS });

  const startedAt = new Date().toISOString();
  const updated = [];
  const failed = [];

  try {
    const today = taipeiToday();

    // 月資料：本月 + 前 2 個月。歷史月份也重抓，確保退款/取消等後續狀態能被修正。
    for (let offset = 0; offset >= -2; offset--) {
      const monthKey = monthKeyOffset(today.year, today.month, offset);
      const range = monthRange(monthKey);
      try {
        const data = await fetchShopline(workerUrl, secret, range.since, range.until);
        await env.REPORT_KV.put(`shopline-month:${monthKey}`, JSON.stringify(data));
        updated.push({
          type: "month",
          key: monthKey,
          since: range.since,
          until: range.until,
          totalOrders: Number(data && data.meta && data.meta.totalOrders) || (Array.isArray(data && data.orders) ? data.orders.length : 0),
        });
      } catch (error) {
        failed.push({ type: "month", key: monthKey, message: error && error.message ? error.message : String(error) });
      }
    }

    // 週資料：最近 4 個完整週次，不抓尚未結束的本週。
    for (let weeksBack = 1; weeksBack <= 4; weeksBack++) {
      const weekStart = lastCompletedWeekStart(today.year, today.month, today.day, weeksBack);
      const weekEnd = addDays(weekStart, 6);
      try {
        const data = await fetchShopline(workerUrl, secret, weekStart, weekEnd);
        await env.REPORT_KV.put(`shopline-week:${weekStart}`, JSON.stringify(data));
        updated.push({
          type: "week",
          key: weekStart,
          since: weekStart,
          until: weekEnd,
          totalOrders: Number(data && data.meta && data.meta.totalOrders) || (Array.isArray(data && data.orders) ? data.orders.length : 0),
        });
      } catch (error) {
        failed.push({ type: "week", key: weekStart, message: error && error.message ? error.message : String(error) });
      }
    }

    const result = {
      ok: failed.length === 0,
      partial: failed.length > 0 && updated.length > 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      updated,
      failed,
    };
    await env.REPORT_KV.put(REFRESH_LAST_KEY, JSON.stringify(result));
    return json(result, updated.length ? 200 : 502);
  } finally {
    await env.REPORT_KV.delete(REFRESH_LOCK_KEY).catch(() => {});
  }
}

export async function onRequestGet({ env }) {
  const last = env.REPORT_KV ? await env.REPORT_KV.get(REFRESH_LAST_KEY) : null;
  return json({
    ok: true,
    mode: "SHOPLINE_REFRESH",
    last: last ? JSON.parse(last) : null,
  });
}
