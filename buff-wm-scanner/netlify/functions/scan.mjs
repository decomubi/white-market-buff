// netlify/functions/scan.mjs
// Buff163 -> WhiteMarket scanner (Netlify Function, ESM)
//
// Env needed on Netlify:
// - BUFF_COOKIE   (your buff cookie string, incl Device-Id etc)
// - WM_PARTNER_TOKEN
// - FX_CNYUSD     (example: 0.14)
//
// Optional env:
// - WM_GRAPHQL_URL (default: https://api.white.market/graphql)
// - BUFF_PAGE_SIZE (default: 50)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Partner-Token, x-partner-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (statusCode, bodyObj) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  body: JSON.stringify(bodyObj),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

async function safeFetch(url, options = {}, timeoutMs = 15000) {
  const { controller, timer } = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function parseWearFromNameHash(nameHash = "") {
  // "Tec-9 | Cracked Opal (Field-Tested)" => wear "Field-Tested"
  const m = nameHash.match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : "-";
}

function parseDisplayName(nameHash = "") {
  // Keep as-is; frontend shows "Sticker | Bolt Charge" etc.
  return nameHash || "-";
}

function parseIconUrlFromBuff(goodsInfo) {
  // Buff returns several icon fields depending on endpoint
  return (
    goodsInfo?.goods_info?.icon_url ||
    goodsInfo?.goods_info?.icon_url_large ||
    goodsInfo?.goods_info?.original_icon_url ||
    goodsInfo?.goods_info?.image_url ||
    ""
  );
}

/**
 * -------- BUFF163 --------
 * We use the public market goods list API (requires your cookie).
 * Endpoint used widely:
 * https://buff.163.com/api/market/goods?game=csgo&page_num=1&page_size=...
 */
async function buffFetchGoods({ limit = 30, pageNum = 1 }) {
  const cookie = process.env.BUFF_COOKIE;
  if (!cookie) throw new Error("Missing BUFF_COOKIE env var");

  const pageSize = Number(process.env.BUFF_PAGE_SIZE || 50);
  const take = Math.max(1, Math.min(limit, pageSize));

  const url =
    `https://buff.163.com/api/market/goods?game=csgo` +
    `&page_num=${encodeURIComponent(pageNum)}` +
    `&page_size=${encodeURIComponent(take)}` +
    `&sort_by=price.desc`;

  const res = await safeFetch(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://buff.163.com/market/csgo",
        Cookie: cookie,
      },
    },
    20000
  );

  if (res.status === 429) {
    const t = await res.text().catch(() => "");
    throw new Error(`BUFF HTTP 429: ${t}`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`BUFF HTTP ${res.status}: ${t}`);
  }

  const data = await res.json();
  const items = data?.data?.items || [];

  // Normalize to what we need
  return items
    .map((x) => {
      const gi = x?.goods_info || {};
      const nameHash = gi?.market_hash_name || gi?.name || "";
      const buffPriceCny = Number(x?.sell_min_price ?? x?.min_price ?? 0);
      const quantity = Number(x?.sell_num ?? x?.sell_num ?? 0);

      return {
        buffGoodsId: gi?.id ?? x?.id ?? null,
        nameHash,
        name: parseDisplayName(nameHash),
        wear: parseWearFromNameHash(nameHash),
        image: parseIconUrlFromBuff(x),
        buffPriceCny,
        quantity,
      };
    })
    .filter((x) => x.nameHash && x.buffPriceCny > 0);
}

/**
 * -------- WHITE.MARKET --------
 * We query buy offers (bids).
 * If WM API fails, we return 0 (but we also surface the error so you can see it).
 *
 * Default GraphQL endpoint (NO trailing slash):
 * https://api.white.market/graphql  :contentReference[oaicite:1]{index=1}
 */
async function wmGraphql(query, variables) {
  const token = process.env.WM_PARTNER_TOKEN;
  if (!token) throw new Error("Missing WM_PARTNER_TOKEN env var");

  const url = (process.env.WM_GRAPHQL_URL || "https://api.white.market/graphql").replace(/\/+$/, "");

  // Try multiple header styles to match partner setups
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "X-Partner-Token": token,
    "x-partner-token": token,
  };

  const res = await safeFetch(
    url,
    { method: "POST", headers, body: JSON.stringify({ query, variables }) },
    20000
  );

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`WM HTTP ${res.status} at ${url}: ${text}`);
  }

  let jsonData;
  try {
    jsonData = JSON.parse(text);
  } catch {
    throw new Error(`WM invalid JSON: ${text.slice(0, 200)}`);
  }

  if (jsonData.errors?.length) {
    throw new Error(`WM GraphQL errors: ${JSON.stringify(jsonData.errors)}`);
  }

  return jsonData.data;
}

/**
 * IMPORTANT:
 * WhiteMarket schema can differ depending on partner access.
 * So we:
 * 1) Find product by nameHash
 * 2) Pull BUY offers list and take top price + total qty
 *
 * This query is written defensively (we try to read multiple possible fields).
 */
async function wmGetBestBuyOfferUsd(nameHash) {
  // Step 1: find product by nameHash
  const qProduct = `
    query FindProduct($search: MarketProductSearchInput, $first: Int) {
      marketProducts(search: $search, first: $first) {
        edges {
          node {
            id
            nameHash
            slug
          }
        }
      }
    }
  `;

  // many schemas use MarketProductSearchInput { nameHash: "..." }
  let productId = null;
  let slug = null;

  const data1 = await wmGraphql(qProduct, { search: { nameHash }, first: 1 });
  const node1 = data1?.marketProducts?.edges?.[0]?.node;
  if (node1?.id) {
    productId = node1.id;
    slug = node1.slug || null;
  }

  if (!productId) {
    return { bestUsd: 0, totalQty: 0, wmUrl: slug ? `https://white.market/item/${slug}` : `https://white.market/market?search=${encodeURIComponent(nameHash)}` };
  }

  // Step 2: buy offers (bids)
  // Some schemas expose order books as "orders" or "orderList" with offerType BUY.
  const qBuy = `
    query BuyOffers($first: Int, $search: OrderSearchInput, $sort: OrderSortInput) {
      orderList(first: $first, search: $search, sort: $sort) {
        edges {
          node {
            id
            offerType
            price
            quantity
            amount
            value
          }
        }
      }
    }
  `;

  // We try: offerType BUY + productId
  const data2 = await wmGraphql(qBuy, {
    first: 50,
    search: { productId, offerType: "BUY" },
    sort: { field: "PRICE", direction: "DESC" },
  });

  const edges = data2?.orderList?.edges || [];
  const offers = edges
    .map((e) => e?.node || null)
    .filter(Boolean)
    .map((n) => {
      const price = Number(n.price ?? n.amount ?? n.value ?? 0);
      const qty = Number(n.quantity ?? 0);
      return { price, qty };
    })
    .filter((x) => x.price > 0 && x.qty > 0);

  let bestUsd = 0;
  let totalQty = 0;

  for (const o of offers) {
    if (o.price > bestUsd) bestUsd = o.price;
    totalQty += o.qty;
  }

  const wmUrl = slug ? `https://white.market/item/${slug}` : `https://white.market/market?search=${encodeURIComponent(nameHash)}`;
  return { bestUsd, totalQty, wmUrl };
}

export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

    const limit = Math.max(1, Math.min(Number(event.queryStringParameters?.limit || 30), 200));
    const fx = Number(process.env.FX_CNYUSD || 0.14);

    // 1) BUFF goods (CNY)
    const buffGoods = await buffFetchGoods({ limit });

    // 2) For each, fetch WM buy offers (USD)
    const items = [];
    for (const g of buffGoods) {
      let wm = { bestUsd: 0, totalQty: 0, wmUrl: `https://white.market/market?search=${encodeURIComponent(g.nameHash)}` };
      let wmErr = null;

      try {
        wm = await wmGetBestBuyOfferUsd(g.nameHash);
      } catch (e) {
        wmErr = String(e?.message || e);
      }

      // Convert BUFF CNY => USD (simple FX; you can refine later)
      const buffUsd = g.buffPriceCny * fx;

      items.push({
        id: g.buffGoodsId || g.nameHash,
        name: g.name,
        wear: g.wear,
        image: g.image,
        buffPrice: Number(g.buffPriceCny.toFixed(2)), // CNY in UI (¥)
        wmPrice: Number((wm.bestUsd || 0).toFixed(2)), // USD in UI ($) - best BUY OFFER
        quantity: g.quantity,
        wmQty: wm.totalQty,
        wmUrl: wm.wmUrl,
        fx,
        wmError: wmErr, // shown only if you want to debug
      });

      // avoid rate spikes
      await sleep(120);
    }

    return json(200, { ok: true, fx, items });
  } catch (err) {
    return json(500, { ok: false, error: String(err?.message || err) });
  }
}
