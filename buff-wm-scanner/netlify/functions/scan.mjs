// Netlify Function (ESM) - Buff163 -> Market.CSGO (buy orders)
// Place in: netlify/functions/scan.mjs
//
// Updates:
//   - Works with BUFF_COOKIE or BUFF163_COOKIE
//   - Works with FX_CNYUSD or FX_CNY_USD
//   - Fixes MarketCSGO prices/class_instance parsing so names actually match

// ----- ENV -----

const RAW_BUFF_COOKIE =
  (process.env.BUFF_COOKIE || process.env.BUFF163_COOKIE || "").trim();

// strip accidental newlines from Netlify UI
const BUFF_COOKIE = RAW_BUFF_COOKIE.replace(/\r?\n/g, "");

const FX_ENV = process.env.FX_CNYUSD || process.env.FX_CNY_USD || "0.14";
const FX_CNYUSD_NUM = Number(FX_ENV);
const FX_CNYUSD =
  Number.isFinite(FX_CNYUSD_NUM) && FX_CNYUSD_NUM > 0 ? FX_CNYUSD_NUM : 0.14;

// Buff endpoints
const BUFF_LIST_URL =
  "https://buff.163.com/api/market/goods?game=csgo&page_num=1&page_size=200&sort_by=sell_num.desc";

// First page of sell orders contains cheapest listings (with floats)
function buffSellOrdersUrl(goodsId, pageSize = 5) {
  const url = new URL("https://buff.163.com/api/market/goods/sell_order");
  url.searchParams.set("game", "csgo");
  url.searchParams.set("goods_id", String(goodsId));
  url.searchParams.set("page_num", "1");
  url.searchParams.set("page_size", String(pageSize));
  url.searchParams.set("sort_by", "price.asc");
  url.searchParams.set("mode", "");
  url.searchParams.set("allow_tradable_cooldown", "1");
  return url.toString();
}

// Market.CSGO public price list (includes max buy order)
const MCSGO_PRICES_URL =
  "https://market.csgo.com/api/v2/prices/class_instance/USD.json";

// ----- helpers -----

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    ...options,
  });

  const ct = res.headers.get("content-type") || "";
  const text = await res.text();

  if (!res.ok) {
    const snippet = text.slice(0, 500);
    throw new Error(`HTTP ${res.status} at ${url}: ${snippet}`);
  }

  if (ct.includes("application/json")) return JSON.parse(text);

  // Sometimes APIs respond with JSON but wrong content-type
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response at ${url}: ${text.slice(0, 500)}`);
  }
}

function buffHeaders() {
  if (!BUFF_COOKIE) {
    throw new Error("Missing BUFF_COOKIE / BUFF163_COOKIE env var");
  }

  return {
    cookie: BUFF_COOKIE, // same as your working version
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    referer: "https://buff.163.com/market/csgo",
    accept: "application/json, text/plain, */*",
  };
}

// ----- BUFF -----

async function buffGoodsList(limit = 30) {
  if (!BUFF_COOKIE) throw new Error("Missing BUFF_COOKIE / BUFF163_COOKIE env var");

  const json = await fetchJson(BUFF_LIST_URL, { headers: buffHeaders() });
  const items = json?.data?.items || [];

  // Keep only items that have a valid sell_min_price
  const trimmed = items
    .filter((x) => x?.sell_min_price != null && x?.sell_num != null)
    .slice(0, limit);

  return trimmed.map((x) => ({
    goodsId: x.id,
    name: x?.goods_info?.name || x?.name || "Unknown",
    image:
      x?.goods_info?.icon_url ||
      x?.goods_info?.iconUrl ||
      x?.goods_info?.original_icon_url ||
      "",
    buffMinPriceCny: Number(x.sell_min_price || 0),
    sellNum: Number(x.sell_num || 0),
  }));
}

async function buffTopListings(goodsId, count = 5) {
  // Returns: [{ priceCny, float }]
  try {
    const url = buffSellOrdersUrl(goodsId, count);
    const json = await fetchJson(url, { headers: buffHeaders() });

    const list = json?.data?.items || json?.data?.sell_orders || [];
    return (list || []).slice(0, count).map((o) => {
      const price = Number(o?.price || o?.sell_price || 0);
      const pw =
        o?.asset_info?.paintwear ??
        o?.asset_info?.paint_wear ??
        o?.asset_info?.paintWear ??
        o?.paintwear ??
        null;
      const fl = pw == null ? null : Number(pw);
      return { priceCny: price, float: fl };
    });
  } catch {
    return [];
  }
}

function normalizeName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim();
}

// ----- MarketCSGO -----

async function mcsgosPricesMap() {
  const json = await fetchJson(MCSGO_PRICES_URL);

  let arr;

  if (Array.isArray(json)) {
    arr = json;
  } else if (Array.isArray(json?.items)) {
    // items is already an array
    arr = json.items;
  } else if (json?.items && typeof json.items === "object") {
    // Typical MarketCSGO structure: { success: true, items: { "name": { ... }, ... } }
    arr = Object.entries(json.items).map(([name, info]) => ({
      market_hash_name: name,
      ...info,
    }));
  } else if (Array.isArray(json?.data)) {
    arr = json.data;
  } else {
    arr = [];
  }

  const map = new Map();
  for (const it of arr) {
    const n =
      it?.market_hash_name ||
      it?.marketHashName ||
      it?.hash_name ||
      it?.name ||
      "";
    if (!n) continue;

    // buy_order can be string; ensure Number
    const buyOrder =
      it?.buy_order ??
      it?.buyOrder ??
      it?.buy ??
      it?.buy_price ??
      it?.best_buy_order ??
      null;

    const avg =
      it?.price ?? it?.avg_price ?? it?.sell_price ?? it?.sellPrice ?? null;

    map.set(normalizeName(n), {
      buyOrderUsd: buyOrder == null ? null : Number(buyOrder),
      avgUsd: avg == null ? null : Number(avg),
    });
  }
  return map;
}

function marketSearchUrl(name) {
  // Item page URLs can vary; search URL always works.
  return `https://market.csgo.com/en/?search=${encodeURIComponent(name)}`;
}

// ----- Netlify handler -----

export async function handler(event) {
  try {
    const limit = Math.min(
      100,
      Math.max(
        1,
        Number(
          new URLSearchParams(event.queryStringParameters || {}).get("limit") ||
            30
        )
      )
    );

    const buffItems = await buffGoodsList(limit);

    // Fetch Market.CSGO price map once per scan
    const mMap = await mcsgosPricesMap();

    // Fetch Buff float listings in parallel
    const listings = await Promise.all(
      buffItems.map((x) => buffTopListings(x.goodsId, 5))
    );

    const out = buffItems.map((x, i) => {
      const key = normalizeName(x.name);
      const m = mMap.get(key);

      const wmPrice = m?.buyOrderUsd != null ? Number(m.buyOrderUsd) : 0;

      let error = "";
      if (!m)
        error =
          "MCSGO: No match in price list (name mismatch or unavailable)";
      else if (!wmPrice) error = "MCSGO: No buy orders";

      return {
        id: x.goodsId,
        name: x.name,
        wear: "-",
        image: x.image,
        buffPrice: x.buffMinPriceCny, // CNY
        quantity: x.sellNum,
        fx: FX_CNYUSD,
        wmPrice, // USD (used by your UI)
        wmBuyQty: null, // not provided by this endpoint
        wmUrl: marketSearchUrl(x.name),
        buffListings: listings[i] || [],
        wmMeta: m || null,
        error,
      };
    });

    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ ok: true, fx: FX_CNYUSD, items: out }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: String(err?.message || err) }),
    };
  }
}
