// netlify/functions/scan.mjs
// Buff163 → MarketCSGO scanner
// ESM Netlify function

const FX_CNY_USD = Number(process.env.FX_CNY_USD || "0.14");
const BUFF_COOKIE = process.env.BUFF_COOKIE;
const MCSGO_API_KEY = process.env.MCSGO_API_KEY;
const BUFF_PAGE_SIZE = Number(process.env.BUFF_PAGE_SIZE || "30");

// Simple safety so you don't accidentally DDOS APIs
const MAX_ITEMS = 60;

// ---- Helpers -------------------------------------------------------------

import fetch from 'node-fetch'; // you already have this at the top

// ---------- MarketCSGO price-list cache ----------
let mcsgPriceCache = null;
let mcsgPriceCacheTime = 0;

async function getMcsgPriceMap() {
  const now = Date.now();

  // Simple 10-minute cache so we don’t hammer MarketCSGO
  if (mcsgPriceCache && now - mcsgPriceCacheTime < 10 * 60 * 1000) {
    return mcsgPriceCache;
  }

  const res = await fetch(
    'https://market.csgo.com/api/v2/prices/class_instance/USD.json'
  );

  if (!res.ok) {
    throw new Error(`MarketCSGO price list HTTP ${res.status}`);
  }

  const data = await res.json();

  if (!data || data.success === false || !data.items) {
    throw new Error('MarketCSGO price list: bad response');
  }

  // Build a Map keyed by market_hash_name
  const map = new Map();

  for (const key of Object.keys(data.items)) {
    const item = data.items[key];
    const name = item.market_hash_name;

    if (!name) continue;

    map.set(name, {
      priceUsd: Number(item.price) || 0,       // listing price in USD
      buyUsd: Number(item.buy_order) || 0,    // highest buy order in USD
      // you can add more fields if you want later
    });
  }

  mcsgPriceCache = map;
  mcsgPriceCacheTime = now;
  return map;
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(payload),
  };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

// Extract wear from full skin name, e.g.
// "AK-47 | Redline (Field-Tested)" → "Field-Tested"
function extractWear(name) {
  const match = name.match(/\(([^)]+)\)\s*$/);
  return match ? match[1] : "-";
}

// Limit async concurrency (avoid hammering MarketCSGO)
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      try {
        results[current] = await fn(items[current], current);
      } catch (err) {
        console.error("Worker error for index", current, err);
        results[current] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

// ---- Buff163 integration -----------------------------------------------

async function fetchBuffPage(pageNum, pageSize) {
  requireEnv("BUFF_COOKIE");

  const url =
    "https://buff.163.com/api/market/goods?" +
    new URLSearchParams({
      game: "csgo",
      page_num: String(pageNum),
      page_size: String(pageSize),
      // these params are what Buff normally uses; harmless if they change
      use_suggestion: "0",
      sort_by: "price.desc",
    }).toString();

  console.log("Buff163 URL:", url);

  const res = await fetch(url, {
    headers: {
      Cookie: BUFF_COOKIE,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Buff163 HTTP error", res.status, text.slice(0, 500));
    throw new Error(
      `Buff163 HTTP ${res.status}: ${text.slice(0, 120)}`
    );
  }

  const json = await res.json();

  // NOTE: if Buff changes shape, inspect json in Netlify logs and tweak here.
  if (json.code !== "OK" || !json.data || !Array.isArray(json.data.items)) {
    console.error("Unexpected Buff163 JSON:", JSON.stringify(json).slice(0, 500));
    throw new Error("Unexpected Buff163 response format");
  }

  const items = json.data.items.map((it) => {
    const priceCny = Number(it.sell_min_price || it.min_price || it.price || 0);
    const quantity = Number(it.sell_num || it.sell_num || it.volume || 0);
    const imagePath =
      it.goods_info && (it.goods_info.icon_url || it.goods_info.icon_url_large);
    const image = imagePath
      ? imagePath.startsWith("http")
        ? imagePath
        : `https://g.fp.ps.netease.com/${imagePath}`
      : "https://via.placeholder.com/64";

    return {
      id: it.id,
      name: it.name,
      wear: extractWear(it.name || ""),
      image,
      buffPriceCny: priceCny,
      buffUsd: +(priceCny * FX_CNY_USD).toFixed(4),
      quantity,
    };
  });

  return items;
}

async function fetchBuffItems(limit) {
  const pageSize = Math.min(limit, BUFF_PAGE_SIZE);
  let page = 1;
  const results = [];

  while (results.length < limit) {
    const pageItems = await fetchBuffPage(page, pageSize);
    if (!pageItems.length) break;
    results.push(...pageItems);
    if (pageItems.length < pageSize) break;
    page += 1;
  }

  return results.slice(0, limit);
}

// ---- MarketCSGO integration --------------------------------------------

// This function is intentionally defensive. Once you see a real JSON
// response from /api/v2/bid-ask in your Network tab, adjust the field
// extraction in here if needed.
async function fetchMarketBuyOrder(marketHashName) {
  requireEnv("MCSGO_API_KEY");

  const params = new URLSearchParams({
    key: MCSGO_API_KEY,
    market_hash_name: marketHashName,
  });

  const url = `https://market.csgo.com/api/v2/bid-ask?${params.toString()}`;
  console.log("MarketCSGO URL:", url);

  const res = await fetch(url);

  if (!res.ok) {
    const txt = await res.text();
    console.error(
      "MarketCSGO HTTP error",
      res.status,
      txt.slice(0, 500)
    );
    throw new Error(`MarketCSGO HTTP ${res.status}`);
  }

  const json = await res.json();
  if (!json.success) {
    console.warn("MarketCSGO non-success:", json);
    return {
      priceUsd: 0,
      orders: 0,
      apiNote: json.error || "No match in bid-ask",
    };
  }

  // ---- IMPORTANT: adjust this section to real JSON shape -------------
  // Try a few common patterns:
  const data = json.data || json.result || json;

  let bidObj =
    data.best_bid ||
    data.bid ||
    data.buy ||
    data.best_order ||
    (Array.isArray(data.bids) ? data.bids[0] : null);

  if (!bidObj && typeof data.price_bid !== "undefined") {
    bidObj = { price: data.price_bid, count: data.count_bid || 0 };
  }

  if (!bidObj) {
    console.warn("MarketCSGO: no bid object found for", marketHashName, data);
    return {
      priceUsd: 0,
      orders: 0,
      apiNote: "No buy orders / name mismatch",
    };
  }

  const priceUsd = Number(bidObj.price || bidObj.cost || bidObj.value || 0);
  const orders = Number(
    bidObj.count || bidObj.orders || bidObj.volume || 0
  );

  return {
    priceUsd: +priceUsd.toFixed(4),
    orders,
    apiNote: "",
  };
}

// Attach MarketCSGO data to Buff items
async function enrichWithMarketData(buffItems) {
  const enriched = await mapWithConcurrency(
    buffItems,
    4, // max 4 concurrent bid-ask calls
    async (item) => {
      try {
        const { priceUsd, orders, apiNote } = await fetchMarketBuyOrder(
          item.name
        );

        const mcsgPrice = priceUsd;
        const mcsgOrders = orders;

        const spreadPct =
          mcsgPrice > 0 && item.buffUsd > 0
            ? ((mcsgPrice - item.buffUsd) / item.buffUsd) * 100
            : -100;

        const netProfitUsd =
          mcsgPrice > 0 ? mcsgPrice - item.buffUsd : -item.buffUsd;

        return {
          id: item.id,
          name: item.name,
          wear: item.wear,
          image: item.image,

          buffPrice: item.buffPriceCny,
          buffUsd: item.buffUsd,

          mcsgPrice,
          mcsgOrders,

          spreadPct: +spreadPct.toFixed(2),
          netProfitUsd: +netProfitUsd.toFixed(2),
          quantity: item.quantity,

          note:
            apiNote ||
            (mcsgPrice > 0
              ? "OK"
              : "API: MCSGO: No match in price list (name mismatch or unavailable)"),
        };
      } catch (err) {
        console.error("Error enriching item", item.name, err);
        return {
          id: item.id,
          name: item.name,
          wear: item.wear,
          image: item.image,
          buffPrice: item.buffPriceCny,
          buffUsd: item.buffUsd,
          mcsgPrice: 0,
          mcsgOrders: 0,
          spreadPct: -100,
          netProfitUsd: -item.buffUsd,
          quantity: item.quantity,
          note: "Error calling MarketCSGO API",
        };
      }
    }
  );

  // filter out any nulls if something went really wrong
  return enriched.filter(Boolean);
}

// ---- Netlify handler ---------------------------------------------------

export async function handler(event) {
  try {
    const limitRaw =
      event.queryStringParameters &&
      event.queryStringParameters.limit;
    const limit = Math.min(
      limitRaw ? Number(limitRaw) || 10 : 10,
      MAX_ITEMS
    );

    console.log("Scan starting. Limit =", limit);

    if (!BUFF_COOKIE) {
      throw new Error("BUFF_COOKIE env var is not set");
    }
    if (!MCSGO_API_KEY) {
      throw new Error("MCSGO_API_KEY env var is not set");
    }

    const buffItems = await fetchBuffItems(limit);
    console.log("Fetched Buff items:", buffItems.length);

    const items = await enrichWithMarketData(buffItems);
    console.log("Enriched items:", items.length);

    return jsonResponse(200, {
      ok: true,
      fx: FX_CNY_USD,
      items,
    });
  } catch (err) {
    console.error("Scan error:", err);
    return jsonResponse(500, {
      ok: false,
      error: err.message || "Unknown error in scan function",
    });
  }
}
