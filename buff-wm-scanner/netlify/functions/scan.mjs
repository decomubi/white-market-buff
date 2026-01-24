// netlify/functions/scan.mjs
// FIXED:
// - WM auth: removed accessTokenExpiredAt (schema changed)
// - WM endpoint: /graphql/partner (works)
// - BUFF price normalization: fixes x100 prices

const WM_GQL = "https://api.white.market/graphql/partner";

let wmCached = {
  accessToken: null,
  expiresAt: 0,
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
    },
    body: JSON.stringify(obj),
  };
}

// Heuristic to fix BUFF returning price * 100 sometimes.
// If price is insanely large, divide by 100.
function normalizeBuffPriceCNY(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n)) return 0;

  // If BUFF gave an integer like 3499985 for a 34999.85 item, fix it.
  // Anything > 200000 is almost surely "cents" (>= 2000 CNY * 100).
  if (n > 200000) n = n / 100;

  return n;
}

async function wmGetAccessToken() {
  const partnerToken = process.env.WM_PARTNER_TOKEN;
  if (!partnerToken) throw new Error("Missing env: WM_PARTNER_TOKEN");

  const now = Date.now();
  if (wmCached.accessToken && wmCached.expiresAt > now + 60_000) {
    return wmCached.accessToken;
  }

  // IMPORTANT: WM schema no longer has accessTokenExpiredAt.
  const query = `
    mutation AuthToken {
      auth_token {
        accessToken
      }
    }
  `;

  const res = await fetch(WM_GQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-partner-token": partnerToken,
    },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`WM auth HTTP ${res.status}: ${text.slice(0, 300)}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`WM auth invalid JSON: ${text.slice(0, 300)}`);
  }

  if (data?.errors?.length) {
    throw new Error(`WM auth error: ${data.errors[0]?.message || "unknown"}`);
  }

  const token = data?.data?.auth_token?.accessToken;
  if (!token) throw new Error("WM auth: no accessToken returned");

  // Cache token for 20 minutes (safe + simple)
  wmCached.accessToken = token;
  wmCached.expiresAt = Date.now() + 20 * 60 * 1000;

  return token;
}

async function wmFetchBestOffer(nameHash) {
  const accessToken = await wmGetAccessToken();

  // offerMinPrice = best buy offer price (matches “Buy offers”)
  const query = `
    query MarketList($search: MarketProductSearchInput) {
      market_list(search: $search, pagination: { first: 1 }) {
        edges {
          node {
            nameHash
            slug
            offerMinPrice { value currency }
          }
        }
      }
    }
  `;

  const variables = {
    search: {
      appId: "CSGO",
      nameHash,
      nameStrict: true,
      distinctValues: true,
    },
  };

  const res = await fetch(WM_GQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`WM HTTP ${res.status}: ${text.slice(0, 300)}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`WM invalid JSON: ${text.slice(0, 300)}`);
  }

  if (data?.errors?.length) {
    throw new Error(`WM gql error: ${data.errors[0]?.message || "unknown"}`);
  }

  const node = data?.data?.market_list?.edges?.[0]?.node;
  if (!node) return { wmPrice: 0, wmUrl: "", wmCurrency: "USD" };

  const wmPrice = Number(node?.offerMinPrice?.value ?? 0);
  const wmCurrency = node?.offerMinPrice?.currency ?? "USD";
  const wmUrl = node?.slug ? `https://white.market/item/${node.slug}` : "";

  return {
    wmPrice: Number.isFinite(wmPrice) ? wmPrice : 0,
    wmUrl,
    wmCurrency,
  };
}

async function buffFetchTop(limit) {
  const cookie = process.env.BUFF_COOKIE;
  if (!cookie) throw new Error("Missing env: BUFF_COOKIE");

  const url =
    `https://buff.163.com/api/market/goods?game=csgo` +
    `&page_num=1&page_size=${encodeURIComponent(limit)}` +
    `&sort_by=price.desc&use_suggestion=0&_=${Date.now()}`;

  const res = await fetch(url, {
    headers: {
      cookie,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      referer: "https://buff.163.com/market/csgo",
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json, text/javascript, */*; q=0.01",
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`BUFF HTTP ${res.status}: ${text.slice(0, 200)}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`BUFF invalid JSON: ${text.slice(0, 200)}`);
  }

  const items = data?.data?.items || [];
  return items.map((it) => {
    const name = it?.name || it?.market_hash_name || "Unknown";
    const image =
      it?.goods_info?.icon_url ||
      it?.icon_url ||
      it?.img_src ||
      it?.goods_info?.original_icon_url ||
      "";

    const rawPrice =
      it?.sell_min_price ?? it?.min_price ?? it?.price ?? 0;

    const priceCny = normalizeBuffPriceCNY(rawPrice);

    const quantity = Number(it?.sell_num ?? it?.num ?? it?.market_count ?? 0) || 0;

    return {
      id: it?.id ?? it?.goods_id ?? null,
      name,
      wear: "-",
      image,
      buffPrice: priceCny,
      quantity,
    };
  });
}

export async function handler(event) {
  try {
    const limit = Math.min(
      Math.max(parseInt(event.queryStringParameters?.limit || "30", 10) || 30, 1),
      100
    );

    const fx = Number(process.env.FX_CNYUSD || "0.14");

    const buffItems = await buffFetchTop(limit);

    const out = [];
    for (const item of buffItems) {
      let wm = { wmPrice: 0, wmUrl: "", wmCurrency: "USD" };
      try {
        wm = await wmFetchBestOffer(item.name);
      } catch (e) {
        wm = {
          wmPrice: 0,
          wmUrl: "",
          wmCurrency: "USD",
          wmError: String(e?.message || e),
        };
      }

      out.push({
        ...item,
        fx,
        wmPrice: wm.wmPrice,
        wmUrl: wm.wmUrl,
        wmCurrency: wm.wmCurrency,
        wmError: wm.wmError || "",
      });
    }

    return json(200, { ok: true, fx, items: out });
  } catch (e) {
    return json(200, { ok: false, error: String(e?.message || e) });
  }
}
