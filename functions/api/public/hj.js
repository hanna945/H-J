const BRANDS = [
  { name: "H&J官網業績", id: "436280797192761" },
  { name: "H&J 一頁業績", id: "2157995930925784" },
];

function corsHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=60, s-maxage=60",
  };
}

async function readJson(env, key, fallback = null) {
  const raw = await env.REPORT_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function readPrefixMap(env, prefix) {
  const out = {};
  let cursor;
  do {
    const page = await env.REPORT_KV.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.keys || []) {
      const raw = await env.REPORT_KV.get(item.name);
      if (!raw) continue;
      try { out[item.name.slice(prefix.length)] = JSON.parse(raw); } catch {}
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

function scopedSettings(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const brand of BRANDS) {
    if (Object.prototype.hasOwnProperty.call(obj, brand.id)) out[brand.id] = obj[brand.id];
  }
  return out;
}

function sanitizeLedgerMap(ledger) {
  const out = {};
  for (const [monthKey, record] of Object.entries(ledger || {})) {
    if (!record || typeof record !== "object") continue;
    out[monthKey] = {
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
  return out;
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

function sanitizeDiscountSummary(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    code: row && row.code != null ? String(row.code) : "",
    usageCount: Number(row && row.usageCount) || 0,
    grossRevenue: Number(row && row.grossRevenue) || 0,
    discountAmount: Number(row && row.discountAmount) || 0,
    netRevenue: Number(row && row.netRevenue) || 0,
  }));
}

function sanitizeShoplineMap(records) {
  const out = {};
  for (const [key, record] of Object.entries(records || {})) {
    if (!record || typeof record !== "object") continue;
    out[key] = {
      orders: (Array.isArray(record.orders) ? record.orders : [])
        .map(sanitizeShoplineOrder)
        .filter(Boolean),
      discountSummary: sanitizeDiscountSummary(record.discountSummary),
      meta: {
        totalOrders: Number(record.meta && record.meta.totalOrders) || 0,
      },
    };
  }
  return out;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet({ env }) {
  try {
    const months = {};
    const weeks = {};
    const ledger = {};
    const aiWeek = {};
    const aiMonth = {};

    await Promise.all(BRANDS.map(async (brand) => {
      const [m, w, l, aw, am] = await Promise.all([
        readPrefixMap(env, `metaads-month:${brand.id}::`),
        readPrefixMap(env, `metaads-week:${brand.id}::`),
        readPrefixMap(env, `metaads-ledger:${brand.id}::`),
        readPrefixMap(env, `adperf-ai-week:${brand.id}::`),
        readPrefixMap(env, `adperf-ai-month:${brand.id}::`),
      ]);
      months[brand.id] = m;
      weeks[brand.id] = w;
      ledger[brand.id] = sanitizeLedgerMap(l);
      aiWeek[brand.id] = aw;
      aiMonth[brand.id] = am;
    }));

    const [
      shoplineWeeksRaw,
      shoplineMonthsRaw,
      cpaAll,
      cpcAll,
      adRatioAll,
      roasAll,
      budgetAll,
      productNamesAll,
    ] = await Promise.all([
      readPrefixMap(env, "shopline-week:"),
      readPrefixMap(env, "shopline-month:"),
      readJson(env, "meta-api-cpa-thresholds", {}),
      readJson(env, "meta-api-cpc-thresholds", {}),
      readJson(env, "meta-api-adratio-thresholds", {}),
      readJson(env, "meta-api-roas-targets", {}),
      readJson(env, "meta-api-monthly-budgets", {}),
      readJson(env, "meta-api-product-names", {}),
    ]);

    return new Response(JSON.stringify({
      ok: true,
      brands: BRANDS,
      months,
      weeks,
      ledger,
      shopline: {
        weeks: sanitizeShoplineMap(shoplineWeeksRaw),
        months: sanitizeShoplineMap(shoplineMonthsRaw),
      },
      ai: {
        weeks: aiWeek,
        months: aiMonth,
      },
      settings: {
        cpaThresholds: scopedSettings(cpaAll),
        cpcThresholds: scopedSettings(cpcAll),
        adRatioThresholds: scopedSettings(adRatioAll),
        roasTargets: scopedSettings(roasAll),
        monthlyBudgets: scopedSettings(budgetAll),
        productNames: scopedSettings(productNamesAll),
      },
      generatedAt: new Date().toISOString(),
      mode: "READ_ONLY",
    }), { status: 200, headers: corsHeaders() });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: "public_hj_report_read_failed",
      message: error && error.message ? error.message : String(error),
    }), { status: 500, headers: corsHeaders() });
  }
}
