// netlify/functions/scan.mjs
// Buff163 -> White.Market scanner (Netlify Function, ESM)

const BUFF_COOKIE = process.env.BUFF_COOKIE || "";
const WM_PARTNER_TOKEN = process.env.WM_PARTNER_TOKEN || "";
const FX_CNYUSD = Number(process.env.FX_CNYUSD || "0.14"); // 1 CNY -> USD
const WM_FEE = Number(process.env.WM_FEE || "0.00"); // optional fee, e.g. 0.05 for 5%

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const { signal, cancel } = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    cancel();
  }
}

// ---------- BUFF (best-effort parser; works with common Buff endpoints) ----------

function normalizeBuffIcon(url) {
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http")) return url;
  return "https://buff.163.com" + url;
}

function extractWear(name = "") {
  // e.g. "AK-47 | Jaguar (Field-Tested)"
  const m = name.match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : "";
}

function parseBuffItems(payload) {
  // Buff responses vary; try common shapes:
  const candidates =
    payload?.data?.items ||
    payload?.data?.goods ||
    payload?.data?.data?.items ||
    payload?.data?.data ||
    [];

  const arr = Array.isArray(candidates) ? candidates : [];

  return arr
    .map((it) => {
      const id = it.id ?? it.goods_id ?? it.goodsId ?? it?.goods?.id;
      const name =
        it.name ??
        it.market_hash_name ??
        it?.goods_info?.name ??
        it?.goods?.name ??
        "";
      const buffPriceRaw =
        it.sell_min_price ??
        it?.sell_min_price?.value ??
        it.price ??
        it?.goods_info?.sell_min_price ??
        it?.goods?.sell_min_price ??
        null;

      const buffPrice = buffPriceRaw != null ? Number(buffPriceRaw) : NaN;

      const quantity =
        it.sell_num ??
        it?.sell_num?.value ??
        it?.goods_info?.sell_num ??
        it?.goods?.sell_num ??
        it?.sellCount ??
        0;

      const icon =
        it?.goods_info?.icon_url ||
        it?.goods_info?.iconUrl ||
        it?.icon_url ||
        it?.iconUrl ||
        it?.goods?.icon_url ||
        "";

      const image = normalizeBuffIcon(icon);
      const wear = it.wear || extractWear(name);

      if (!id || !name || !Number.isFinite(buffPrice)) return null;

      return {
        id,
        name,
        wear,
        image,
        buffPrice, // CNY
        quantity: Number(quantity || 0),
      };
    })
    .filter(Boolean);
}

async function fetchBuffTopList(limit) {
  if (!BUFF_COOKIE) {
    throw new Error("Missing BUFF_COOKIE env var");
  }

  // Common Buff listing endpoint:
  // NOTE: If your current project uses a different Buff endpoint, replace ONLY this URL,
  // keep the rest unchanged.
  const url = new URL("https://buff.163.com/api/market/goods");
  url.searchParams.set("game", "csgo");
  url.searchParams.set("page_num", "1");
  url.searchParams.set("page_size", String(limit));
  // You can change sort_by if you want:
  // url.searchParams.set("sort_by", "price.desc");

  // Retry on 429
  let attempt = 0;
  while (attempt < 4) {
    attempt++;

    const r = await fetchJson(
      url.toString(),
      {
        method: "GET",
        headers: {
          cookie: BUFF_COOKIE,
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          accept: "application/json, text/plain, */*",
          referer: "https://buff.163.com/",
        },
      },
      20000
    );

    if (r.status === 429) {
      // backoff
      await sleep(600 * attempt);
      continue;
    }

    if (!r.ok || !r.json) {
      throw new Error(
        `BUFF HTTP ${r.status}: ${r.json?.error?.message || r.text || "Unknown"}`
      );
    }

    const items = parseBuffItems(r.json);
    return items;
  }

  throw new Error("BUFF HTTP 429: rate limited");
}

// ---------- WHITE.MARKET (correct BUY OFFERS) ----------

async function wmGraphql(query, variables) {
  if (!WM_PARTNER_TOKEN) {
    throw new Error("Missing WM_PARTNER_TOKEN env var");
  }

  const r = await fetchJson(
    "https://api.white.market/graphql",
    {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        // Some partner setups accept Authorization; some accept x-partner-token.
        // Sending both is safe.
        authorization: `Bearer ${WM_PARTNER_TOKEN}`,
        "x-partner-token": WM_PARTNER_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    },
    20000
  );

  if (!r.ok || !r.json) {
    throw new Error(`WM HTTP ${r.status}: ${r.text || "Unknown"}`);
  }
  if (r.json.errors?.length) {
    throw new Error(`WM GraphQL: ${r.json.errors[0]?.message || "Unknown error"}`);
  }
  return r.json.data;
}

async function wmResolveProductByName(name) {
  // Resolve the correct slug + strict nameHash by searching market_list with nameStrict
  const query = `
    query MarketList($search: MarketProductSearchInput!, $first: Int!) {
      market_list(search: $search, forwardPagination: { first: $first }) {
        edges {
          node {
            slug
            item {
              order { nameHash }  # sometimes present
            }
            description {
              marketHashName
              iconUrl
            }
          }
        }
      }
    }
  `;

  // For CS2, appId enum is usually CSGO in their docs.
  const data = await wmGraphql(query, {
    search: {
      appId: "CSGO",
      name: name,
      nameStrict: true,
      distinctValues: true,
      sort: { field: "CREATED", type: "DESC" },
    },
    first: 3,
  });

  const node = data?.market_list?.edges?.[0]?.node;
  if (!node) return null;

  const slug = node.slug;
  const nameHash =
    node?.item?.order?.nameHash || node?.description?.marketHashName || name;

  return {
    slug,
    nameHash,
    wmUrl: slug ? `https://white.market/item/${slug}` : "https://white.market/",
  };
}

async function wmBestBuyOfferByNameHash(nameHash) {
  // ✅ Correct: order_list sorted by PRICE DESC to get BEST buy offer (like the website)
  const query = `
    query BestBuy($search: MarketOrderPublicSearchInput!) {
      order_list(search: $search, forwardPagination: { first: 1 }) {
        edges {
          node {
            nameHash
            quantity
            price { value currency }
          }
        }
      }
    }
  `;

  const data = await wmGraphql(query, {
    search: {
      appId: "CSGO",
      nameHash,
      distinctValues: false,
      sort: { field: "PRICE", type: "DESC" },
    },
  });

  const node = data?.order_list?.edges?.[0]?.node;
  if (!node) return { wmPrice: 0, wmQty: 0 };

  const value = Number(node?.price?.value || 0);
  const currency = node?.price?.currency || "USD";

  // If you ever get non-USD here, you can filter currency === "USD"
  // (Most partners receive USD already.)
  const wmPrice = Number.isFinite(value) ? value : 0;

  return { wmPrice, wmQty: Number(node?.quantity || 0), currency };
}

// ---------- MAIN HANDLER ----------

export const handler = async (event) => {
  try {
    const limit = Math.min(
      Math.max(Number(event.queryStringParameters?.limit || 30), 1),
      100
    );

    const buffItems = await fetchBuffTopList(limit);

    // Small delay helps reduce 429 spikes
    const out = [];
    for (const it of buffItems) {
      // Resolve WM product for correct slug + nameHash
      const wmProduct = await wmResolveProductByName(it.name);
      await sleep(120);

      let wmPrice = 0;
      let wmQty = 0;
      let wmUrl = "https://white.market/";
      let nameHash = it.name;

      if (wmProduct?.nameHash) {
        nameHash = wmProduct.nameHash;
        wmUrl = wmProduct.wmUrl;
        const best = await wmBestBuyOfferByNameHash(nameHash);
        wmPrice = best.wmPrice || 0;
        wmQty = best.wmQty || 0;
      }

      // Convert buff CNY -> USD for comparison
      const buffUsd = it.buffPrice * FX_CNYUSD;

      // Profit is WM buy offer minus Buff cost (optionally subtract WM fee)
      const wmNet = wmPrice * (1 - WM_FEE);
      const profit = wmNet - buffUsd;
      const spread = buffUsd > 0 ? (profit / buffUsd) * 100 : 0;

      out.push({
        id: it.id,
        name: it.name,
        wear: it.wear || "",
        image: it.image || "",
        buffPrice: it.buffPrice, // CNY
        wmPrice: wmPrice, // USD (BUY OFFER)
        wmQty: wmQty,
        fx: FX_CNYUSD,
        wmUrl,
        profit,
        spread,
        quantity: it.quantity ?? 0,
      });

      await sleep(120);
    }

    return {
      statusCode: 200,
      headers: {
        ...JSON_HEADERS,
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ ok: true, items: out }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: {
        ...JSON_HEADERS,
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
      body: JSON.stringify({
        ok: false,
        error: String(e?.message || e),
      }),
    };
  }
};
