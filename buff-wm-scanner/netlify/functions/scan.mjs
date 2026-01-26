// netlify/functions/scan.mjs
// Buff163 -> MarketCSGO (market.csgo.com) arbitrage scanner
// - GET /.netlify/functions/scan?limit=30
// - GET /.netlify/functions/scan?goods_id=123&hash_name=AK-47%20%7C%20Redline%20(Field-Tested)  (details for one item)

const BUFF_HOST = "https://buff.163.com";
const MCSGO_HOST = "https://market.csgo.com";

// ---------- Helpers ----------
const json = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(x, fallback = 0) {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function normName(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeMarketSearchUrl(hashName) {
  const q = encodeURIComponent(hashName);
  return `https://market.csgo.com/en/?search=${q}`;
}

// ---------- Fetch wrappers ----------
async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return { ok: res.ok, status: res.status, text, data };
  } finally {
    clearTimeout(t);
  }
}

// ---------- BUFF ----------
function getBuffCookie() {
  // Put your Buff cookies in Netlify env var: BUFF_COOKIE
  const cookie = process.env.BUFF_COOKIE || process.env.BUFF163_COOKIE || "";
  return cookie.trim();
}

async function buffFetch(path, qs = {}) {
  const cookie = getBuffCookie();
  if (!cookie) throw new Error("Missing BUFF_COOKIE env var");

  const url = new URL(BUFF_HOST + path);
  for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, String(v));

  const r = await fetchJson(url.toString(), {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json, text/plain, */*",
      referer: BUFF_HOST + "/",
      cookie,
    },
  });

  if (!r.ok || !r.data) {
    throw new Error(`BUFF HTTP ${r.status}: ${r.text?.slice(0, 200)}`);
  }
  if (r.data.code && r.data.code !== "OK") {
    throw new Error(`BUFF API error: ${r.data.code}`);
  }
  return r.data;
}

async function buffGetTopGoods(limit = 30) {
  const data = await buffFetch("/api/market/goods", {
    game: "csgo",
    page_num: 1,
    page_size: Math.min(Math.max(limit, 1), 80),
    sort_by: "sell_num.desc",
  });

  const items = (data?.data?.items || []).map((it) => ({
    id: it.id,
    name: normName(it.name),
    image: it.goods_info?.icon_url
      ? it.goods_info.icon_url.startsWith("http")
        ? it.goods_info.icon_url
        : `https:${it.goods_info.icon_url}`
      : it.icon_url
      ? it.icon_url.startsWith("http")
        ? it.icon_url
        : `https:${it.icon_url}`
      : "",
    buffPriceCny: num(it.sell_min_price),
    quantity: num(it.sell_num),
  }));
  return items;
}

async function buffGetLowestListingsWithFloats(goodsId, n = 5) {
  const data = await buffFetch("/api/market/goods/sell_order", {
    game: "csgo",
    goods_id: goodsId,
    page_num: 1,
    page_size: Math.min(Math.max(n, 1), 20),
    sort_by: "price.asc",
  });

  const orders = data?.data?.items || [];
  return orders.slice(0, n).map((o) => ({
    priceCny: num(o.price),
    float: o.asset_info?.float_value ?? o.asset_info?.paintwear ?? null,
    paintseed: o.asset_info?.paintseed ?? null,
    inspectUrl: o.asset_info?.inspect_url ?? null,
  }));
}

// ---------- MarketCSGO ----------
function getMcsgoKey() {
  // Put your MarketCSGO API key in Netlify env var: MCSGO_API_KEY
  return (process.env.MCSGO_API_KEY || process.env.MARKETCSGO_API_KEY || "").trim();
}

async function mcCall(path, params = {}, timeoutMs = 15000) {
  const key = getMcsgoKey();
  if (!key) throw new Error("Missing MCSGO_API_KEY env var");

  const url = new URL(MCSGO_HOST + path);
  url.searchParams.set("key", key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const r = await fetchJson(url.toString(), { headers: { accept: "application/json" } }, timeoutMs);
  if (!r.ok || !r.data) {
    throw new Error(`MCSGO HTTP ${r.status}: ${r.text?.slice(0, 200)}`);
  }
  if (r.data.success === false) {
    throw new Error(`MCSGO API error: ${r.data.error || "unknown"}`);
  }
  return r.data;
}

function parseBestFromAnyMcResponse(obj) {
  const root = obj?.data || obj?.item || obj;

  const bestBuy = num(root?.buy_order ?? root?.buy ?? root?.buy_price ?? 0, 0);
  const bestBuyQty = num(root?.buy_order_qty ?? root?.buy_order_count ?? root?.buy_count ?? root?.buy_orders ?? 0, 0);

  const bestSell = num(root?.sell_min ?? root?.sell ?? root?.sell_price ?? root?.sell_min_price ?? 0, 0);
  const bestSellQty = num(root?.sell_min_qty ?? root?.sell_count ?? root?.sell_offers ?? 0, 0);

  return { bestBuy, bestBuyQty, bestSell, bestSellQty };
}

async function mcGetBidAsk(hashName) {
  try {
    const res = await mcCall("/api/v2/bid-ask", { hash_name: hashName }, 12000);
    return { ok: true, ...parseBestFromAnyMcResponse(res), raw: res };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function mcGetByHashSpecific(hashName) {
  try {
    const res = await mcCall("/api/v2/search-item-by-hash-name-specific", { hash_name: hashName }, 12000);
    return { ok: true, ...parseBestFromAnyMcResponse(res), raw: res };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function mcGetBest(hashName) {
  const a = await mcGetBidAsk(hashName);
  if (a.ok && (a.bestBuy > 0 || a.bestSell > 0)) return a;

  const b = await mcGetByHashSpecific(hashName);
  if (b.ok && (b.bestBuy > 0 || b.bestSell > 0)) return b;

  // last fallback: prices list
  try {
    const res = await mcCall("/api/v2/prices/USD.json", {}, 20000);
    const items = res?.items || res?.data?.items || res?.data || res;
    if (Array.isArray(items)) {
      const target = normName(hashName).toLowerCase();
      const match =
        items.find((x) => normName(x?.market_hash_name || x?.name || x?.hash_name || "").toLowerCase() === target) || null;
      if (match) return { ok: true, ...parseBestFromAnyMcResponse(match), raw: match };
    } else if (items && typeof items === "object") {
      const map = new Map();
      for (const [k, v] of Object.entries(items)) map.set(normName(k).toLowerCase(), v);
      const v = map.get(normName(hashName).toLowerCase());
      if (v) return { ok: true, ...parseBestFromAnyMcResponse(v), raw: v };
    }
  } catch {
    // ignore
  }

  return { ok: false, error: "MCSGO: No match / no data for this name" };
}

// ---------- Main handler ----------
export async function handler(event) {
  try {
    const q = event.queryStringParameters || {};
    const goodsId = q.goods_id ? String(q.goods_id) : null;
    const hashName = q.hash_name ? normName(q.hash_name) : null;

    const fx = num(process.env.FX_CNYUSD || process.env.FX_CNY_USD || 0.14, 0.14);

    // Details mode
    if (goodsId && hashName) {
      const [buffListings, mc] = await Promise.all([buffGetLowestListingsWithFloats(goodsId, 5), mcGetBest(hashName)]);

      return json(200, {
        ok: true,
        goods_id: goodsId,
        hash_name: hashName,
        fx,
        buff: { listings: buffListings },
        mc: {
          ok: mc.ok,
          bestBuy: mc.bestBuy || 0,
          bestBuyQty: mc.bestBuyQty || 0,
          bestSell: mc.bestSell || 0,
          bestSellQty: mc.bestSellQty || 0,
          error: mc.ok ? null : mc.error || null,
        },
      });
    }

    // Scan mode
    const limit = Math.min(Math.max(Number(q.limit || 30), 1), 60);
    const buffGoods = await buffGetTopGoods(limit);

    const out = [];
    let errors = 0;

    for (let i = 0; i < buffGoods.length; i++) {
      const it = buffGoods[i];
      const name = it.name;

      const mc = await mcGetBest(name);
      if (!mc.ok) errors++;

      const bestBuyUsd = mc.ok ? mc.bestBuy || 0 : 0;

      out.push({
        id: it.id,
        name,
        image: it.image,
        buffPrice: it.buffPriceCny,
        quantity: it.quantity,
        fx,
        wmPrice: bestBuyUsd, // keep UI field name
        wmBuyQty: mc.ok ? mc.bestBuyQty || 0 : 0,
        wmUrl: makeMarketSearchUrl(name),
        wmErr: mc.ok ? null : mc.error || "Unknown MCSGO error",
      });

      if (i % 8 === 7) await sleep(250);
    }

    return json(200, { ok: true, fx, items: out, errors });
  } catch (e) {
    return json(200, { ok: false, error: String(e?.message || e) });
  }
}
