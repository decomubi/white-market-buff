// netlify/functions/scan.mjs (DEBUG + correct WM buy offers)

const BUFF_COOKIE = process.env.BUFF_COOKIE || "";
const WM_PARTNER_TOKEN = process.env.WM_PARTNER_TOKEN || "";
const FX_CNYUSD = Number(process.env.FX_CNYUSD || "0.14");
const WM_FEE = Number(process.env.WM_FEE || "0.00");

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

async function fetchJson(url, opts = {}, timeoutMs = 20000, label = "fetch") {
  const { signal, cancel } = withTimeout(timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { ...opts, signal });
    } catch (e) {
      // ✅ THIS is the “fetch failed” root — now we expose where it happened
      throw new Error(`${label}: fetch() failed for ${url} -> ${e?.message || e}`);
    }

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

// ---------------- BUFF ----------------

function extractWear(name = "") {
  const m = name.match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : "";
}

function normalizeBuffIcon(url) {
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http")) return url;
  return "https://buff.163.com" + url;
}

function parseBuffItems(payload) {
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
  if (!BUFF_COOKIE) throw new Error("Missing BUFF_COOKIE env var");

  const url = new URL("https://buff.163.com/api/market/goods");
  url.searchParams.set("game", "csgo");
  url.searchParams.set("page_num", "1");
  url.searchParams.set("page_size", String(limit));

  for (let attempt = 1; attempt <= 4; attempt++) {
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
      20000,
      "BUFF"
    );

    if (r.status === 429) {
      await sleep(800 * attempt);
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

// ---------------- WHITE.MARKET ----------------

async function wmGraphql(query, variables) {
  if (!WM_PARTNER_TOKEN) throw new Error("Missing WM_PARTNER_TOKEN env var");

  // ✅ Try both endpoints (some accounts behave differently)
  const endpoints = [
    "https://api.white.market/graphql/",
    "https://api.white.market/graphql",
  ];

  let lastErr = null;

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetchJson(
          endpoint,
          {
            method: "POST",
            headers: {
              ...JSON_HEADERS,
              accept: "application/json",
              authorization: `Bearer ${WM_PARTNER_TOKEN}`,
              "x-partner-token": WM_PARTNER_TOKEN,
            },
            body: JSON.stringify({ query, variables }),
          },
          20000,
          "WHITE.MARKET"
        );

        if (!r.ok || !r.json) {
          // retry on 502/503/504
          if ([502, 503, 504].includes(r.status) && attempt < 3) {
            await sleep(600 * attempt);
            continue;
          }
          throw new Error(`WM HTTP ${r.status}: ${r.text || "Unknown"}`);
        }

        if (r.json.errors?.length) {
          throw new Error(`WM GraphQL: ${r.json.errors[0]?.message || "Unknown error"}`);
        }

        return r.json.data;
      } catch (e) {
        lastErr = e;
        // small backoff then retry
        await sleep(300 * attempt);
      }
    }
  }

  throw new Error(lastErr?.message || String(lastErr));
}

async function wmResolveProductByName(name) {
  const query = `
    query MarketList($search: MarketProductSearchInput!, $first: Int!) {
      market_list(search: $search, forwardPagination: { first: $first }) {
        edges {
          node {
            slug
            item { order { nameHash } }
            description { marketHashName }
          }
        }
      }
    }
  `;

  const data = await wmGraphql(query, {
    search: {
      appId: "CSGO",
      name,
      nameStrict: true,
      distinctValues: true,
      sort: { field: "CREATED", type: "DESC" },
    },
    first: 3,
  });

  const node = data?.market_list?.edges?.[0]?.node;
  if (!node) return null;

  const slug = node.slug;
  const nameHash = node?.item?.order?.nameHash || node?.description?.marketHashName || name;

  return {
    slug,
    nameHash,
    wmUrl: slug ? `https://white.market/item/${slug}` : "https://white.market/",
  };
}

async function wmBestBuyOfferByNameHash(nameHash) {
  // ✅ Correct Buy Offer = best price (DESC)
  const query = `
    query BestBuy($search: MarketOrderPublicSearchInput!) {
      order_list(search: $search, forwardPagination: { first: 1 }) {
        edges {
          node {
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

  return {
    wmPrice: Number(node?.price?.value || 0) || 0,
    wmQty: Number(node?.quantity || 0) || 0,
  };
}

// ---------------- MAIN HANDLER ----------------

export const handler = async (event) => {
  try {
    const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit || 30), 1), 100);

    const buffItems = await fetchBuffTopList(limit);

    const out = [];
    for (const it of buffItems) {
      const wmProduct = await wmResolveProductByName(it.name);

      let wmPrice = 0;
      let wmQty = 0;
      let wmUrl = "https://white.market/";

      if (wmProduct?.nameHash) {
        wmUrl = wmProduct.wmUrl;
        const best = await wmBestBuyOfferByNameHash(wmProduct.nameHash);
        wmPrice = best.wmPrice;
        wmQty = best.wmQty;
      }

      const buffUsd = it.buffPrice * FX_CNYUSD;
      const wmNet = wmPrice * (1 - WM_FEE);

      const profit = wmNet - buffUsd;
      const spread = buffUsd > 0 ? (profit / buffUsd) * 100 : 0;

      out.push({
        id: it.id,
        name: it.name,
        wear: it.wear || "",
        image: it.image || "",
        buffPrice: it.buffPrice, // CNY
        wmPrice, // USD buy offer
        wmQty,
        fx: FX_CNYUSD,
        wmUrl,
        profit,
        spread,
        quantity: it.quantity ?? 0,
      });

      await sleep(80);
    }

    return {
      statusCode: 200,
      headers: { ...JSON_HEADERS, "access-control-allow-origin": "*", "cache-control": "no-store" },
      body: JSON.stringify({ ok: true, items: out }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { ...JSON_HEADERS, "access-control-allow-origin": "*", "cache-control": "no-store" },
      body: JSON.stringify({ ok: false, error: String(e?.message || e) }),
    };
  }
};
