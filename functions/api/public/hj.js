const BRANDS = [
  { name: "H&J官網業績", id: "436280797192761" },
  { name: "H&J 一頁業績", id: "2157995930925784" },
];
const BRAND_IDS = new Set(BRANDS.map((b) => b.id));

const EXACT_KEYS = new Set([
  "meta-api-brands",
  "meta-api-cpa-thresholds",
  "meta-api-cpc-thresholds",
  "meta-api-adratio-thresholds",
  "meta-api-roas-targets",
  "meta-api-monthly-budgets",
  "meta-api-product-names",
]);

const BRAND_PREFIXES = [
  "metaads-month:",
  "metaads-ledger:",
  "adperf-ai-month:",
];
const SHOPLINE_PREFIXES = ["shopline-month:"];
const LIST_PREFIXES = new Set([...BRAND_PREFIXES, ...SHOPLINE_PREFIXES]);

function corsHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=60, s-maxage=60",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function brandIdFromScopedKey(key, prefix) {
  const rest = key.slice(prefix.length);
  const idx = rest.indexOf("::");
  return idx >= 0 ? rest.slice(0, idx) : "";
}

function allowedPrefixForKey(key) {
  for (const prefix of BRAND_PREFIXES) {
    if (key.startsWith(prefix)) {
      const brandId = brandIdFromScopedKey(key, prefix);
      return BRAND_IDS.has(brandId) ? prefix : null;
    }
  }
  for (const prefix of SHOPLINE_PREFIXES) {
    if (key.startsWith(prefix)) return prefix;
  }
  return null;
}

function scopedSettings(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const brand of BRANDS) {
    if (Object.prototype.hasOwnProperty.call(obj, brand.id)) out[brand.id] = obj[brand.id];
  }
  return out;
}

function sanitizeLedger(record, key) {
  if (!record || typeof record !== "object") return null;
  const monthKey = String(key || "").split("::").pop() || record.monthKey || null;
  return {
    monthKey: record.monthKey || monthKey,
    year: record.year || null,
    month: record.month || null,
    days: Array.isArray(record.days) ? record.days : [],
    monthTotal: record.monthTotal || null,
    productCodes: Array.isArray(record.productCodes) ? record.productCodes : [],
    onePageProductCodes: Array.isArray(record.onePageProductCodes) ? record.onePageProductCodes : [],
    officialSiteCodes: Array.isArray(record.officialSiteCodes) ? record.officialSiteCodes : [],
    externalChannelCodes: Array.isArray(record.externalChannelCodes) ? record.externalChannelCodes : [],
    salesPlatformCodes: Array.isArray(record.salesPlatformCodes) ? record.salesPlatformCodes : [],
    adSourceCodes: Array.isArray(record.adSourceCodes) ? record.adSourceCodes : [],
  };
}

function sanitizeShoplineOrder(order, index) {
  if (!order || typeof order !== "object") return null;
  return {
    orderId: `public-${index + 1}`,
    createdAt: order.createdAt || "",
    amount: Number(order.amount) || 0,
    subtotal: Number(order.subtotal) || 0,
    discountAmount: Number(order.discountAmount) || 0,
    paymentStatus: order.paymentStatus || "",
    status: order.status || "",
    utm: order.utm && typeof order.utm === "object" ? {
      utm_source: order.utm.utm_source || "",
      utm_medium: order.utm.utm_medium || "",
      utm_campaign: order.utm.utm_campaign || "",
      utm_content: order.utm.utm_content || "",
      utm_term: order.utm.utm_term || "",
    } : {},
    discountCodes: Array.isArray(order.discountCodes) ? order.discountCodes.map(String) : [],
  };
}

function sanitizeShopline(record) {
  if (!record || typeof record !== "object") return null;
  return {
    orders: (Array.isArray(record.orders) ? record.orders : [])
      .map(sanitizeShoplineOrder)
      .filter(Boolean),
    discountSummary: (Array.isArray(record.discountSummary) ? record.discountSummary : []).map((row) => ({
      code: row && row.code != null ? String(row.code) : "",
      usageCount: Number(row && row.usageCount) || 0,
      grossRevenue: Number(row && row.grossRevenue) || 0,
      discountAmount: Number(row && row.discountAmount) || 0,
      netRevenue: Number(row && row.netRevenue) || 0,
    })),
    meta: {
      totalOrders: Number(record.meta && record.meta.totalOrders) || 0,
    },
  };
}

async function readRawJson(env, key) {
  const raw = await env.REPORT_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function publicValueForKey(env, key) {
  if (key === "meta-api-brands") return BRANDS;

  if (EXACT_KEYS.has(key)) {
    const raw = await readRawJson(env, key);
    return scopedSettings(raw);
  }

  const prefix = allowedPrefixForKey(key);
  if (!prefix) return undefined;

  const raw = await readRawJson(env, key);
  if (raw == null) return null;
  if (prefix === "metaads-ledger:") return sanitizeLedger(raw, key);
  if (prefix === "shopline-month:") return sanitizeShopline(raw);
  return raw;
}

async function listPublicKeys(env, prefix) {
  if (!LIST_PREFIXES.has(prefix)) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.REPORT_KV.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.keys || []) {
      const key = item.name;
      if (BRAND_PREFIXES.includes(prefix)) {
        const brandId = brandIdFromScopedKey(key, prefix);
        if (!BRAND_IDS.has(brandId)) continue;
      }
      out.push(key);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const op = url.searchParams.get("op") || "health";

    if (op === "health") {
      return jsonResponse({ ok: true, mode: "READ_ONLY", brands: BRANDS.map((b) => b.name) });
    }

    if (op === "list") {
      const prefix = url.searchParams.get("prefix") || "";
      if (!LIST_PREFIXES.has(prefix)) return jsonResponse({ ok: false, error: "prefix_not_allowed" }, 403);
      const keys = await listPublicKeys(env, prefix);
      return jsonResponse({ keys });
    }

    if (op === "get") {
      const key = url.searchParams.get("key") || "";
      if (!EXACT_KEYS.has(key) && !allowedPrefixForKey(key)) {
        return jsonResponse({ ok: false, error: "key_not_allowed" }, 403);
      }
      const value = await publicValueForKey(env, key);
      if (value === undefined) return jsonResponse({ ok: false, error: "key_not_allowed" }, 403);
      if (value === null) return jsonResponse({ ok: false, error: "not_found" }, 404);
      return jsonResponse({ key, value: JSON.stringify(value) });
    }

    return jsonResponse({ ok: false, error: "unsupported_operation" }, 400);
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: "public_hj_report_read_failed",
      message: error && error.message ? error.message : String(error),
    }, 500);
  }
}
