// netlify/functions/scan.mjs
// Buff163 -> White.Market scanner (Netlify Function)
// - Reads BUFF_COOKIE, WM_PARTNER_TOKEN, FX_CNYUSD from env
// - Returns: { ok:true, fx, items:[{id,name,wear,image,buffPrice,wmPrice,quantity,wmUrl}] }
// Notes:
// - BUFF price is converted to USD using FX_CNYUSD.
// - WM "buy offer" is not always available via partner/public endpoints; if missing, wmPrice=0.

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function fetchRetry(url, options = {}, { retries = 3, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);

      // Retry on rate-limit / temp errors
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        const wait = 400 * Math.pow(2, i);
        await sleep(wait);
        continue;
      }

      return res;
    } catch (e) {
      lastErr = e;
      const wait = 400 * Math.pow(2, i);
      await sleep(wait);
    }
  }
  throw lastErr || new Error("fetchRetry failed");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------- BUFF ----------------
async function fetchBuffTop({ limit, buffCookie }) {
  // Common BUFF endpoint (public but cookie helps + reduces blocks):
  // Adjust sort_by if you want (sell_num.desc gives high-volume items).
  const url =
    `https://buff.163.com/api/market/goods?game=csgo&page_num=1&page_size=${encodeURIComponent(
      String(limit)
    )}&sort_by=sell_num.desc&use_suggestion=0`;

  const res = await fetchRetry(url, {
    method: "GET",
    headers: {
      cookie: buffCookie,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      referer: "https://buff.163.com/market/csgo",
      accept: "application/json, text/plain, */*",
    },
  });

  const text = await res.text();

  if (!res.ok) {
    // BUFF often returns Chinese message in JSON
    const j = safeJsonParse(text);
    const msg = j?.error?.message || j?.msg || text?.slice(0, 200);
    throw new Error(`BUFF HTTP ${res.status}: ${msg}`);
  }

  const data = safeJsonParse(text);
  const items = data?.data?.items || [];

  // Normalize into our shape
  return items.map((it) => {
    const name = it?.name || it?.goods_info?.name || "Unknown";
    const icon =
      it?.goods_info?.icon_url ||
      it?.goods_info?.original_icon_url ||
      it?.steam_market_url ||
      "";

    const sellMin = Number(it?.sell_min_price ?? it?.sell_min_price_cny ?? 0); // CNY string usually
    const quantity = Number(it?.sell_num ?? it?.sell_count ?? 0);

    // BUFF doesn't always carry wear for stickers/cases; keep "-" default
    const wear = it?.goods_info?.tags?.wear?.localized_name || it?.wear || "-";

    return {
      buffGoodsId: it?.id ?? it?.goods_id ?? it?.goods_info?.id ?? null,
      name,
      wear,
      image: icon,
      buffPriceCny: isFinite(sellMin) ? sellMin : 0,
      quantity: isFinite(quantity) ? quantity : 0,
    };
  });
}

// ---------------- WHITE.MARKET ----------------
//
// We use Partner GraphQL endpoint.
// Some users hit 404 when using the wrong path.
// We try multiple endpoints safely.
const WM_GRAPHQL_ENDPOINTS = [
  "https://api.white.market/graphql",
  "https://api.white.market/api",
  "https://api.white.market/graphql/",
];

async function wmGraphQL(query, variables, partnerToken) {
  let last;
  for (const endpoint of WM_GRAPHQL_ENDPOINTS) {
    try {
      const res = await fetchRetry(
        endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${partnerToken}`,
          },
          body: JSON.stringify({ query, variables }),
        },
        { retries: 1, timeoutMs: 15000 }
      );

      const text = await res.text();
      if (res.status === 404) {
        last = new Error(`WM HTTP 404 at ${endpoint}`);
        continue;
      }
      if (!res.ok) {
        const j = safeJsonParse(text);
        const msg = j?.errors?.[0]?.message || text?.slice(0, 200);
        throw new Error(`WM HTTP ${res.status}: ${msg}`);
      }

      const json = safeJsonParse(text);
      if (!json) throw new Error("WM invalid JSON");
      if (json.errors?.length) {
        throw new Error(json.errors[0]?.message || "WM GraphQL error");
      }
      return json.data;
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error("WM GraphQL failed");
}

// 1) Find a matching product on WM by name
async function wmFindByName(name, partnerToken) {
  // This query shape works on the partner schema where market_list exists.
  // If your schema differs, the function will throw a GraphQL error.
  const query = `
    query MarketList($search: MarketProductSearchInput!, $pagination: MarketPaginationInput!) {
      market_list(search: $search, pagination: $pagination) {
        nodes {
          id
          name
          count
          iconUrl
          order {
            price { value }
            quantity
          }
        }
      }
    }
  `;

  const variables = {
    search: {
      // Many schemas accept name. If yours needs "title" instead, tell me.
      name,
      // game is often required; harmless if ignored by schema
      game: "csgo",
    },
    pagination: { limit: 1, offset: 0 },
  };

  const data = await wmGraphQL(query, variables, partnerToken);
  const node = data?.market_list?.nodes?.[0];
  if (!node) return null;

  const wmSellOrFallback = Number(node?.order?.price?.value ?? 0);
  const wmQty = Number(node?.order?.quantity ?? node?.count ?? 0);

  return {
    wmProductId: node.id,
    wmName: node.name,
    wmImage: node.iconUrl || "",
    wmSellFallback: isFinite(wmSellOrFallback) ? wmSellOrFallback : 0,
    wmQty: isFinite(wmQty) ? wmQty : 0,
  };
}

// 2) Try to fetch BUY OFFERS (order book). Not always exposed.
// We attempt a “best effort” query. If schema doesn’t support it -> return null.
async function wmBestBuyOffer(wmProductId, partnerToken) {
  // This is a best-effort query (some schemas provide market_order_book / buyOffers).
  // If it fails, we safely return null (wmPrice becomes 0).
  const candidates = [
    {
      name: "market_order_book",
      query: `
        query OrderBook($id: ID!) {
          market_order_book(productId: $id) {
            buy {
              price
              quantity
            }
          }
        }
      `,
      pick: (d) => {
        const buy = d?.market_order_book?.buy;
        if (!Array.isArray(buy) || !buy.length) return null;
        const best = buy[0]; // usually sorted best-first
        const p = Number(best?.price ?? 0);
        return isFinite(p) && p > 0 ? p : null;
      },
    },
    {
      name: "market_product_buyOffers",
      query: `
        query Product($id: ID!) {
          market_product(id: $id) {
            buyOffers {
              price
              quantity
            }
          }
        }
      `,
      pick: (d) => {
        const buy = d?.market_product?.buyOffers;
        if (!Array.isArray(buy) || !buy.length) return null;
        const best = buy[0];
        const p = Number(best?.price ?? 0);
        return isFinite(p) && p > 0 ? p : null;
      },
    },
  ];

  for (const c of candidates) {
    try {
      const data = await wmGraphQL(c.query, { id: wmProductId }, partnerToken);
      const price = c.pick(data);
      if (price) return price;
    } catch {
      // ignore and try next
    }
  }
  return null;
}

function makeWmSearchUrl(name) {
  return `https://white.market/market?search=${encodeURIComponent(name)}`;
}

// ---------------- Handler ----------------
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    const buffCookie = process.env.BUFF_COOKIE;
    const partnerToken = process.env.WM_PARTNER_TOKEN;
    const fx = Number(process.env.FX_CNYUSD || "0.14");

    if (!buffCookie) {
      return {
        statusCode: 500,
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing env BUFF_COOKIE" }),
      };
    }
    if (!partnerToken) {
      return {
        statusCode: 500,
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing env WM_PARTNER_TOKEN" }),
      };
    }

    const url = new URL(event.rawUrl);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || "30")));

    // 1) BUFF items
    const buffItems = await fetchBuffTop({ limit, buffCookie });

    // 2) WM mapping + buy offer (best effort)
    const out = [];
    for (const it of buffItems) {
      const wm = await wmFindByName(it.name, partnerToken);

      const buffUsd = isFinite(it.buffPriceCny * fx) ? it.buffPriceCny * fx : 0;

      // Prefer WM buy offer if available; otherwise wmPrice = 0 (so UI can filter it out).
      let wmBuy = 0;
      let wmQty = 0;
      let wmImg = "";

      if (wm) {
        wmQty = wm.wmQty || 0;
        wmImg = wm.wmImage || "";
        const bestBuy = await wmBestBuyOffer(wm.wmProductId, partnerToken);
        wmBuy = bestBuy ? bestBuy : 0;
      }

      out.push({
        id: it.buffGoodsId || it.name, // stable id fallback
        name: it.name,
        wear: it.wear || "-",
        image: it.image || wmImg || "",
        buffPrice: Number(buffUsd.toFixed(2)),
        wmPrice: Number(wmBuy.toFixed(2)),
        quantity: it.quantity || wmQty || 0,
        wmUrl: makeWmSearchUrl(it.name),
      });
    }

    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        "content-type": "application/json",
        // small cache to reduce BUFF 429
        "cache-control": "public, max-age=20",
      },
      body: JSON.stringify({ ok: true, fx, items: out }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ ok: false, error: String(e?.message || e) }),
    };
  }
}
