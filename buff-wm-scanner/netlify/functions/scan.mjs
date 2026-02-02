// buff-wm-scanner/netlify/functions/scan.mjs
// Buff163 (CS2) → White.Market buy orders arbitrage scanner
//
// Env vars required:
//   BUFF_COOKIE          – full cookie string from buff.163.com
//   WM_PARTNER_TOKEN     – partner token from white.market profile
//   FX_CNYUSD            – CNY → USD rate (e.g. "0.14")

const BUFF_BASE = "https://buff.163.com";
const WM_GQL = "https://api.white.market/graphql/partner";

// --------------- in-memory caches ---------------
let wmCache = { token: null, exp: 0 };
let buffCache = { ts: 0, key: "", items: [] };

// --------------- helpers ---------------
function ok(body) {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function fail(statusCode, message) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "cache-control": "no-store",
    },
    body: JSON.stringify({ ok: false, error: message }),
  };
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function normalizeUrl(u) {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  return u;
}

// --------------- BUFF163 ---------------
async function buffFetch(path, params = {}) {
  const cookie = mustEnv("BUFF_COOKIE");
  const url = new URL(BUFF_BASE + path);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "")
      url.searchParams.set(k, String(v));
  }

  const r = await fetch(url.toString(), {
    headers: {
      cookie,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      referer: "https://buff.163.com/market/csgo",
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
    },
  });

  const text = await r.text().catch(() => "");
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  console.log("BUFF", { status: r.status, snippet: text.slice(0, 200) });

  // BUFF returns { code: "OK" } on success
  if (!r.ok || (json.code && json.code !== "OK")) {
    const msg = json.msg || json.message || json.error || text.slice(0, 120);
    throw new Error(`BUFF goods error: code=${json.code || r.status}, msg=${msg}`);
  }

  return json;
}

// Strip wear condition so White.Market nameHash matches.
// e.g. "AWP | Dragon Lore | Minimal Wear" → "AWP | Dragon Lore"
const WEAR_SUFFIXES = [
  "Factory New","Minimal Wear","Well-Worn","Field-Tested","Battle-Scarred",
];
function stripWear(name) {
  for (const w of WEAR_SUFFIXES) {
    if (name.endsWith(w)) return name.slice(0, -w.length).replace(/\s*\|\s*$/, "").trim();
  }
  return name;
}

// minPriceCny / maxPriceCny are in CNY fen (integer, 100 = 1 CNY).
// Undefined values are simply omitted from the request.
async function buffGoodsList({ search = "", pageNum = 1, pageSize = 20, minPriceCny, maxPriceCny } = {}) {
  const data = await buffFetch("/api/market/goods", {
    game: "csgo",
    page_num: pageNum,
    page_size: pageSize,
    search,
    sort_by: "sell_num.desc",   // sort by most-listed (liquidity) not price
    price_min: minPriceCny,     // undefined → skipped by buffFetch
    price_max: maxPriceCny,
  });
  return data?.data?.items || [];
}

// --------------- White.Market ---------------
async function wmGetAccessToken() {
  const partnerToken = mustEnv("WM_PARTNER_TOKEN");
  const now = Date.now();

  if (wmCache.token && wmCache.exp > now) return wmCache.token;

  const r = await fetch(WM_GQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-partner-token": partnerToken,
    },
    body: JSON.stringify({ query: `mutation { auth_token { accessToken } }` }),
  });

  const j = await r.json().catch(() => ({}));
  const token = j?.data?.auth_token?.accessToken;
  if (!token) throw new Error("White.Market: failed to get accessToken");

  wmCache.token = token;
  wmCache.exp = now + 23 * 60 * 60 * 1000; // refresh 1 hour before 24h expiry
  return token;
}

// --------------- White.Market order_list helpers ---------------
// order_list is WM's buy-orders endpoint.
// Docs: https://api.white.market/docs_partner/api/query/order_list.html
// Valid search fields: appId, nameHash, nameStrict, sort, price, distinctValues, personOwn, csgo* filters
// Valid sort fields (MarketOrderSortField): PRICE | CREATED_AT | POPULARITY

function wmOrderQuery(nameHash, count = 1) {
  return {
    query: `
      query($nameHash: String!) {
        order_list(
          search: {
            appId: CSGO
            nameHash: $nameHash
            nameStrict: true
            sort: { field: PRICE, type: DESC }
          }
          forwardPagination: { first: ${count} }
        ) {
          edges {
            node {
              quantity
              price { value currency }
            }
          }
          totalCount
        }
      }
    `,
    variables: { nameHash },
  };
}

async function wmFetchOrders(nameHash, count = 1) {
  const accessToken = await wmGetAccessToken();
  const r = await fetch(WM_GQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(wmOrderQuery(nameHash, count)),
  });
  const j = await r.json().catch(() => ({}));
  console.log("WM order_list", nameHash, JSON.stringify(j).slice(0, 500));

  if (j?.errors?.length) {
    console.error("WM GraphQL error for", nameHash, j.errors[0].message);
    return { edges: [], totalCount: 0 };
  }
  return j?.data?.order_list || { edges: [], totalCount: 0 };
}

// Returns { priceUsd, quantity, totalOrders } for the single highest buy order
async function wmHighestBuyOrder(nameHash) {
  const data = await wmFetchOrders(nameHash, 1);
  const node = data.edges?.[0]?.node;
  return {
    priceUsd: node?.price?.value != null ? Number(node.price.value) : 0,
    quantity: node?.quantity != null ? Number(node.quantity) : 0,
    totalOrders: data.totalCount || 0,
  };
}

// Returns array of { priceUsd, quantity } for up to N orders (for detail popup)
async function wmGetOrders(nameHash, count = 10) {
  const data = await wmFetchOrders(nameHash, count);
  return {
    totalCount: data.totalCount || 0,
    orders: (data.edges || []).map((e) => ({
      priceUsd: e.node?.price?.value != null ? Number(e.node.price.value) : 0,
      quantity: e.node?.quantity != null ? Number(e.node.quantity) : 0,
    })),
  };
}

// --------------- concurrency limiter ---------------
async function mapLimit(arr, limit, fn) {
  const ret = new Array(arr.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) {
      const idx = i++;
      ret[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return ret;
}

// --------------- main handler ---------------
// _built: used to confirm the correct version is deployed.
// Check this in Network tab response: { _built: "2026-02-02T01:00:00Z", ... }
const _BUILT = "2026-02-02T02:00:00Z";
export async function handler(event) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
      body: "",
    };
  }

  try {
    const qs = event.queryStringParameters || {};

    // --------------- introspection debug ---------------
    // Hit /.netlify/functions/scan?introspect=1 to dump the WM GraphQL schema
    if (qs.introspect === "1") {
      const accessToken = await wmGetAccessToken();
      const introQuery = `{
        __schema {
          queryType { fields { name, args { name, type { name, kind, ofType { name, kind } } } } }
        }
      }`;
      const r = await fetch(WM_GQL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query: introQuery }),
      });
      const j = await r.json().catch(() => ({}));
      return ok({ introspection: j });
    }
    // --------------- order detail endpoint ---------------
    // Hit /.netlify/functions/scan?orders=AK-47+|+Redline to get buy order list
    if (qs.orders) {
      const wmName = stripWear(qs.orders);
      const data = await wmGetOrders(wmName, 10);
      return ok({ ok: true, nameHash: wmName, ...data });
    }

    const search = (qs.search || "").trim();
    const limit = Math.max(1, Math.min(100, parseInt(qs.limit) || 20));
    const fx = Number(process.env.FX_CNYUSD || "0.14");

    // Price range: frontend sends USD, we convert to CNY fen for BUFF.
    // 1 USD = (1 / fx) CNY.  1 CNY = 100 fen.
    const minUsd = parseFloat(qs.minPrice);
    const maxUsd = parseFloat(qs.maxPrice);
    const minPriceCny = !isNaN(minUsd) && minUsd > 0 ? Math.round((minUsd / fx) * 100) : undefined;
    const maxPriceCny = !isNaN(maxUsd) && maxUsd > 0 ? Math.round((maxUsd / fx) * 100) : undefined;

    // --- BUFF cache (60s) ---
    const cacheKey = `${search}|${limit}|${minPriceCny ?? ""}|${maxPriceCny ?? ""}`;
    const now = Date.now();
    let buffItems;

    if (buffCache.items?.length && buffCache.key === cacheKey && now - buffCache.ts < 60000) {
      buffItems = buffCache.items;
    } else {
      buffItems = await buffGoodsList({ search, pageNum: 1, pageSize: limit, minPriceCny, maxPriceCny });
      buffCache = { ts: now, key: cacheKey, items: buffItems };
    }

    // --- parse BUFF items ---
    const rows = buffItems
      .map((it, idx) => {
        const nameHash = it?.market_hash_name || it?.name || it?.short_name;
        if (!nameHash) return null;

        const buffPriceCny =
          it?.sell_min_price != null
            ? Number(it.sell_min_price)
            : it?.sell_min_price_cny != null
            ? Number(it.sell_min_price_cny)
            : 0;

        const buffPriceUsd = Number((buffPriceCny * fx).toFixed(2));

        const quantity = it?.sell_num ?? it?.sell_count ?? it?.goods_info?.sell_num ?? 0;

        const image =
          normalizeUrl(it?.goods_info?.icon_url) ||
          normalizeUrl(it?.icon_url) ||
          normalizeUrl(it?.img) ||
          "";

        return {
          id: it?.id || idx + 1,
          name: nameHash,
          image,
          buffPriceCny,
          buffPriceUsd,
          buffQuantity: Number(quantity) || 0,
        };
      })
      .filter(Boolean);

    // --- fetch White.Market buy orders (4 concurrent) ---
    // stripWear removes e.g. "| Minimal Wear" so WM's nameHash matches
    const enriched = await mapLimit(rows, 4, async (row) => {
      try {
        const wmName = stripWear(row.name);
        const wm = await wmHighestBuyOrder(wmName);
        const wmBuyOrderUsd = wm.priceUsd || 0;
        const spreadPct =
          row.buffPriceUsd > 0
            ? Number(((wmBuyOrderUsd / row.buffPriceUsd - 1) * 100).toFixed(2))
            : 0;
        const profitUsd = Number((wmBuyOrderUsd - row.buffPriceUsd).toFixed(2));

        return {
          ...row,
          wmBuyOrderUsd,
          wmOrderCount: wm.totalOrders || 0,
          spreadPct,
          profitUsd,
        };
      } catch (e) {
        console.error(`WM error for "${stripWear(row.name)}":`, e.message);
        return { ...row, wmBuyOrderUsd: 0, wmOrderCount: 0, spreadPct: 0, profitUsd: 0 };
      }
    });

    return ok({ ok: true, _built: _BUILT, fx, items: enriched });
  } catch (e) {
    console.error("scan.mjs top-level error:", e);
    return fail(500, String(e?.message || e));
  }
}
