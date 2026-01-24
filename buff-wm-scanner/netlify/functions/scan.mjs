// netlify/functions/scan.mjs
export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 30)));

    const BUFF_COOKIE = process.env.BUFF_COOKIE || "";
    const WM_PARTNER_TOKEN = process.env.WM_PARTNER_TOKEN || "";
    const FX_CNYUSD = Number(process.env.FX_CNYUSD || "0.14");

    if (!BUFF_COOKIE) {
      return json({ ok: false, error: "Missing BUFF_COOKIE env var" }, 400);
    }
    if (!WM_PARTNER_TOKEN) {
      return json({ ok: false, error: "Missing WM_PARTNER_TOKEN env var" }, 400);
    }

    // -------------
    // 1) Fetch BUFF list
    // -------------
    const buffItems = await fetchBuffList({ limit, cookie: BUFF_COOKIE });

    // -------------
    // 2) For each BUFF item, fetch WM best BUY OFFER (best bid) using order_list
    // -------------
    const results = await mapWithConcurrency(
      buffItems,
      4,
      async (it) => {
        const bestBid = await fetchWMBestBid({
          nameHash: it.name, // Buff market_hash_name matches WM nameHash for most items
          token: WM_PARTNER_TOKEN,
        });

        return {
          id: it.id,
          name: it.name,
          wear: it.wear || "-",
          image: it.image,
          // BUFF price is in CNY
          buffPrice: it.buffPriceCny,
          quantity: it.quantity,

          // WM best buy offer in USD
          wmPrice: bestBid.priceUsd,
          wmQty: bestBid.qty,

          // helpful
          fx: FX_CNYUSD,
          wmUrl: it.wmUrl,
        };
      }
    );

    return json({ ok: true, fx: FX_CNYUSD, items: results }, 200);
  } catch (err) {
    return json({ ok: false, error: `Server error: ${err?.message || String(err)}` }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function fetchBuffList({ limit, cookie }) {
  // BUFF endpoint (works with your Device-Id cookie setup)
  // This returns market_hash_name, sell_min_price (CNY), sell_num, goods_id, etc.
  const buffUrl =
    `https://buff.163.com/api/market/goods?game=csgo&page_num=1&page_size=${limit}&sort_by=price.asc`;

  const data = await fetchJsonWithRetry(buffUrl, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      Referer: "https://buff.163.com/",
      Cookie: cookie,
    },
  });

  const items = data?.data?.items || [];
  return items.map((x) => {
    const name = x.market_hash_name || x.name || "";
    const priceCny = Number(x.sell_min_price || x.price || 0);
    const qty = Number(x.sell_num || x.goods_num || x.quantity || 0);

    // image field differs; use what BUFF gives; fallback to steam CDN if missing
    const image =
      x.goods_info?.icon_url ||
      x.icon_url ||
      x.goods_info?.original_icon_url ||
      x.img ||
      "";

    // "wear" not always present (stickers/cases)
    const wear = x.goods_info?.info?.weapon_info?.exterior || x.wear || "-";

    // build WM URL using encoded name (works as a generic fallback)
    const wmUrl = `https://white.market/`;

    return {
      id: x.id || x.goods_id || x.goods_info?.goods_id || Math.random().toString(36).slice(2),
      name,
      wear,
      image,
      buffPriceCny: priceCny,
      quantity: qty,
      wmUrl,
    };
  });
}

async function fetchWMBestBid({ nameHash, token }) {
  // WM GraphQL order_list = BUY OFFERS (bids). We want BEST bid => PRICE DESC
  const endpoint = "https://api.white.market/graphql";

  const query = `
    query GetBestBid($search: MarketOrderSearchInput!, $sort: MarketOrderSortInput!, $first: Int!) {
      order_list(search: $search, sort: $sort, first: $first) {
        edges {
          node {
            price { value currency }
            quantity
          }
        }
      }
    }
  `;

  const variables = {
    first: 3,
    search: {
      appId: "CSGO",
      nameHash: nameHash,
      nameStrict: true,
      distinctValues: true,
    },
    sort: {
      field: "PRICE",
      type: "DESC",
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Partner token you stored in Netlify env
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`WM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const payload = JSON.parse(text);
  if (payload.errors?.length) {
    throw new Error(`WM GraphQL error: ${payload.errors[0]?.message || "Unknown"}`);
  }

  const edges = payload?.data?.order_list?.edges || [];
  const best = edges[0]?.node;

  return {
    priceUsd: Number(best?.price?.value || 0),
    qty: Number(best?.quantity || 0),
  };
}

async function fetchJsonWithRetry(url, options, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      if (!res.ok) {
        // BUFF rate limit often 429
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      // backoff
      await sleep(400 * (i + 1) * (i + 1));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mapWithConcurrency(arr, concurrency, fn) {
  const out = new Array(arr.length);
  let idx = 0;

  const workers = new Array(concurrency).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= arr.length) break;
      out[i] = await fn(arr[i]);
      // tiny delay to reduce WM/Buff throttling
      await sleep(80);
    }
  });

  await Promise.all(workers);
  return out;
}
