// Netlify function: Buff163 (CS2) -> MarketCSGO (lowest sell offer)
//
// This keeps the same response shape your UI already expects.
//
// Modes:
//
//   1) Dummy mode (for testing): set USE_DUMMY=1 in Netlify
//   2) Live mode (real APIs):   set USE_DUMMY=0 (or unset)
//
// Required env vars for LIVE mode:
//
//   BUFF163_COOKIE        – your Buff cookies string
//   BUFF163_REFERER       – (optional) referer, default Buff CS2 market
//   FX_CNY_USD            – CNY → USD rate (e.g. 0.14)
//   MARKETCSGO_API_KEY    – API key from https://market.csgo.com/en/api
//
// NOTE: MarketCSGO part uses `search-item-by-hash-name` to get the
// *lowest SELL price* for that hash_name. UI still says “buy order”,
// but technically this is the best SELL. Later you can swap to the
// `bid-ask` endpoint if you want actual buy orders.

const BUFF_BASE = "https://buff.163.com";
const MCSGO_BASE = "https://market.csgo.com/api/v2";

// -------- small helpers --------

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}

function ok(payload) {
  return jsonResponse(200, payload);
}

function fail(status, message, extra = {}) {
  return jsonResponse(status, {
    ok: false,
    error: message,
    ...extra,
  });
}

// -------- BUFF163 client --------

const BUFF_COOKIE = process.env.BUFF163_COOKIE || "";
const BUFF_REFERER =
  process.env.BUFF163_REFERER || "https://buff.163.com/market/cs2";

/**
 * Low-level BUFF fetch with query params + debug logging.
 * Logs status and first 200 chars of the response body to Netlify logs.
 */
async function buffFetch(path, params = {}) {
  const url = new URL(BUFF_BASE + path);

  // Attach query params
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Cookie: BUFF_COOKIE,
      Referer: BUFF_REFERER,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
    },
  });

  const text = await res.text();

  // DEBUG: see exactly what BUFF returns
  console.log("BUFF DEBUG", {
    url: url.toString(),
    status: res.status,
    snippet: text.slice(0, 200),
  });

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON (probably HTML error page)
  }

  // BUFF success is usually either { code: "OK" } or { code: 0 }
  const code = json && (json.code ?? json.data?.code);
  const isOkCode = code === "OK" || code === 0;

  if (!res.ok || !isOkCode) {
    const msg =
      (json && (json.error || json.msg || json.message)) ||
      text.slice(0, 120);

    throw new Error(
      `BUFF HTTP ${res.status}, code=${code ?? "?"}, msg=${msg}`
    );
  }

  return json;
}

// Fetch top N items sorted by Buff price (CNY, highest first)
async function fetchBuffItems(limit, fxCnyUsd) {
  const pageSize = Math.min(Math.max(1, limit), 60);

  // Using query params instead of building the string manually
  const data = await buffFetch("/api/market/goods", {
    game: "csgo", // or "csgo" if that works better for your BUFF account
    page_num: 1,
    page_size: pageSize,
    sort_by: "price.desc",
  });

  const goodsInfos = data.data?.goods_infos || {};
  const items = data.data?.items || [];

  return items.slice(0, limit).map((row, idx) => {
    const goods = goodsInfos[row.goods_id] || {};
    const name =
      goods.market_hash_name || goods.name || row.name || `Unknown #${idx + 1}`;
    const wear = goods.goods_info?.wear || "-";

    const icon = goods.icon_url || "";
    const image = icon.startsWith("http")
      ? icon
      : icon
      ? `https://g.fp.ps.netease.com/${icon}`
      : "https://via.placeholder.com/64";

    const buffPriceCny = Number(row.sell_min_price || 0);
    const buffUsd = buffPriceCny * fxCnyUsd;
    const quantity = Number(row.sell_num || 0);

    return {
      id: Number(row.goods_id || goods.id || idx + 1),
      name,
      wear,
      image,
      buffPrice: buffPriceCny,
      buffUsd: Number(buffUsd.toFixed(2)),
      quantity,
    };
  });
}

// -------- MarketCSGO client --------

const MCSGO_KEY = process.env.MARKETCSGO_API_KEY || "";

async function mcsgoFetch(pathWithQuery) {
  if (!MCSGO_KEY) {
    throw new Error("Missing MARKETCSGO_API_KEY env var");
  }

  const sep = pathWithQuery.includes("?") ? "&" : "?";
  const url = `${MCSGO_BASE}${pathWithQuery}${sep}key=${encodeURIComponent(
    MCSGO_KEY
  )}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`MarketCSGO HTTP ${res.status} at ${url}`);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`MarketCSGO bad JSON at ${url}: ${String(err)}`);
  }

  // MarketCSGO examples: { success: true, data: [...] } or
  // { success: false, error: "..." }
  if (json.success === false) {
    throw new Error(
      `MarketCSGO API error at ${url}: ${json.error || "Unknown"}`
    );
  }

  return json;
}

// Get lowest SELL price + number of listings for given hash_name
async function mcsgoBestSell(hashName) {
  if (!hashName) {
    return {
      priceUsd: 0,
      orders: 0,
      note: "Missing hash name",
    };
  }

  try {
    const data = await mcsgoFetch(
      `/search-item-by-hash-name?hash_name=${encodeURIComponent(hashName)}`
    );

    const list = Array.isArray(data.data) ? data.data : [];

    if (!list.length) {
      return {
        priceUsd: 0,
        orders: 0,
        note: "No MarketCSGO listings",
      };
    }

    // examples show `price` field on each entry
    const best = list.reduce(
      (min, item) => (Number(item.price) < Number(min.price) ? item : min),
      list[0]
    );

    const bestPrice = Number(best.price || 0);

    return {
      priceUsd: Number(bestPrice.toFixed(2)),
      orders: list.length,
      note: "",
    };
  } catch (err) {
    return {
      priceUsd: 0,
      orders: 0,
      note: `API error: ${String(err.message || err).slice(0, 80)}`,
    };
  }
}

// -------- Dummy data (for testing / when APIs are broken) --------

function buildDummyItems(limit, fxCnyUsd) {
  const items = [];
  for (let i = 1; i <= limit; i++) {
    const buffPrice = 10 + i;
    const buffUsd = Number((buffPrice * fxCnyUsd).toFixed(2));
    const mcsgoPrice = buffUsd * 1.25;
    const netProfit = Number((mcsgoPrice - buffUsd).toFixed(2));
    const spreadPct =
      buffUsd > 0 ? Number(((mcsgoPrice / buffUsd - 1) * 100).toFixed(2)) : 0;

    items.push({
      id: i,
      name: `TEST ITEM #${i}`,
      wear: "Field-Tested",
      image: "https://via.placeholder.com/64",
      buffPrice,
      buffUsd,
      mcsgoPrice,
      mcsgoOrders: 3 + i,
      spreadPct,
      netProfitUsd: netProfit,
      quantity: 123,
      note: "Dummy data from scan.mjs",
    });
  }
  return items;
}

// -------- Netlify handler --------

export async function handler(event) {
  const useDummy = process.env.USE_DUMMY === "1";

  const qs = event.queryStringParameters || {};
  const limit = Math.min(
    60,
    Math.max(1, parseInt(qs.limit || "30", 10) || 30)
  );

  const fx = Number(process.env.FX_CNY_USD || "0.14");

  if (useDummy) {
    const items = buildDummyItems(limit, fx);
    return ok({
      ok: true,
      fx,
      items,
    });
  }

  try {
    // 1) Buff items
    const buffItems = await fetchBuffItems(limit, fx);

    // 2) Attach MarketCSGO quotes in parallel
    const enriched = await Promise.all(
      buffItems.map(async (item) => {
        const quote = await mcsgoBestSell(item.name);

        const mcsgoPrice = quote.priceUsd || 0;
        const netProfit = Number((mcsgoPrice - item.buffUsd).toFixed(2));
        const spreadPct =
          item.buffUsd > 0
            ? Number(((mcsgoPrice / item.buffUsd - 1) * 100).toFixed(2))
            : 0;

        return {
          id: item.id,
          name: item.name,
          wear: item.wear,
          image: item.image,
          buffPrice: item.buffPrice,
          buffUsd: item.buffUsd,
          mcsgoPrice,
          mcsgoOrders: quote.orders || 0,
          spreadPct,
          netProfitUsd: netProfit,
          quantity: item.quantity,
          note: quote.note ? `API: ${quote.note}` : "",
        };
      })
    );

    return ok({
      ok: true,
      fx,
      items: enriched,
    });
  } catch (err) {
    console.error("scan.mjs top-level error:", err);
    return fail(500, "Scan failed", { detail: String(err.message || err) });
  }
}
