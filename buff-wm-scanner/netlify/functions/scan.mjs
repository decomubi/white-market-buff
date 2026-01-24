const BUFF_BASE = "https://buff.163.com";
const WM_GQL_ENDPOINT = "https://api.white.market/graphql/partner";

let wmCache = { token: null, exp: 0 };

function resp(status, body) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function buffFetch(path, params = {}) {
  const cookie = mustEnv("BUFF_COOKIE");

  const url = new URL(BUFF_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  });

  const r = await fetch(url.toString(), {
    headers: {
      cookie,
      "user-agent": "Mozilla/5.0",
      referer: "https://buff.163.com/market/csgo",
      accept: "application/json, text/plain, */*"
    }
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`BUFF HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function buffGoodsList({ search = "", pageNum = 1, pageSize = 20 } = {}) {
  const data = await buffFetch("/api/market/goods", {
    game: "csgo",
    page_num: pageNum,
    page_size: pageSize,
    search
  });

  return data?.data?.items || [];
}

async function buffLowestSell(goodsId) {
  const data = await buffFetch("/api/market/goods/sell_order", {
    game: "csgo",
    goods_id: goodsId,
    page_num: 1,
    page_size: 1
  });

  const first = data?.data?.items?.[0];
  const total = data?.data?.total_count ?? 0;
  const price = first?.price != null ? Number(first.price) : null;

  return { price, total };
}

async function wmGetAccessToken() {
  const partnerToken = mustEnv("WM_PARTNER_TOKEN");
  const now = Date.now();
  if (wmCache.token && wmCache.exp > now) return wmCache.token;

  const r = await fetch(WM_GQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-partner-token": partnerToken
    },
    body: JSON.stringify({
      query: `mutation { auth_token { accessToken } }`
    })
  });

  const j = await r.json().catch(() => ({}));
  const token = j?.data?.auth_token?.accessToken;
  if (!token) throw new Error("White.Market: failed to get accessToken");

  wmCache.token = token;
  wmCache.exp = now + 23 * 60 * 60 * 1000;
  return token;
}

async function wmHighestBuyOrder(nameHash) {
  const accessToken = await wmGetAccessToken();

  const query = `
    query($nameHash: String!) {
      order_list(
        search: {
          appId: CSGO
          nameHash: $nameHash
          nameStrict: true
          sort: { field: PRICE, type: DESC }
        }
        forwardPagination: { first: 1 }
      ) {
        edges {
          node {
            quantity
            price { value currency }
          }
        }
      }
    }
  `;

  const r = await fetch(WM_GQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ query, variables: { nameHash } })
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.errors?.length) {
    const msg = j?.errors?.[0]?.message || `White.Market HTTP ${r.status}`;
    throw new Error(msg);
  }

  const node = j?.data?.order_list?.edges?.[0]?.node;
  return {
    priceUsd: node?.price?.value != null ? Number(node.price.value) : null,
    quantity: node?.quantity != null ? Number(node.quantity) : 0
  };
}

export async function handler(event) {
  try {
    const limit = Math.min(Math.max(parseInt(event.queryStringParameters?.limit || "20", 10), 1), 50);
    const search = (event.queryStringParameters?.search || "").trim();

    const fx = Number(process.env.FX_CNYUSD || "0.14"); // set for accurate profit/spread
    const buffItems = await buffGoodsList({ search, pageNum: 1, pageSize: limit });

    const out = [];

    for (const it of buffItems) {
      const goodsId = it?.id;
      const nameHash = it?.market_hash_name || it?.name || it?.short_name;
      if (!goodsId || !nameHash) continue;

      const sell = await buffLowestSell(goodsId);
      const buffPriceCny = sell.price ?? (it?.sell_min_price != null ? Number(it.sell_min_price) : null);

      const wm = await wmHighestBuyOrder(nameHash);

      const image =
        it?.goods_info?.icon_url ||
        it?.icon_url ||
        it?.img ||
        "";

      out.push({
        id: goodsId,
        name: nameHash,
        wear: it?.goods_info?.info?.wear_name || it?.goods_info?.tags?.exterior || "—",
        image,
        buffPrice: buffPriceCny ?? 0,     // CNY
        wmPrice: wm.priceUsd ?? 0,        // USD
        quantity: sell.total ?? wm.quantity ?? 0,
        fx,
        wmUrl: "https://white.market" // you can later build a deep link if you want
      });
    }

    return resp(200, { ok: true, items: out });
  } catch (e) {
    return resp(500, { ok: false, error: String(e?.message || e) });
  }
}

