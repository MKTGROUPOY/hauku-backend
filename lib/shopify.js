// lib/shopify.js — Hakee tuotteet metafieldeistä (ei tageista)

let cache = { products: null, ts: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 tunti

const PRODUCTS_QUERY = `
  query GetProducts($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title
          vendor
          tags
          metafields(identifiers: [
            {namespace:"custom", key:"ainesosat"}
            {namespace:"custom", key:"ravintoaineet"}
            {namespace:"custom", key:"lisaaineet"}
            {namespace:"custom", key:"proteiinit"}
            {namespace:"custom", key:"erikoisruoat"}
            {namespace:"custom", key:"raakarasva"}
            {namespace:"custom", key:"rasvat_ja_oljyt"}
            {namespace:"custom", key:"hiilihydraatit"}
            {namespace:"custom", key:"koiran_ika"}
            {namespace:"custom", key:"koiran_koko"}
            {namespace:"custom", key:"allergiat"}
            {namespace:"custom", key:"kauppa_1_nimi"}
            {namespace:"custom", key:"kauppa_1_linkki"}
            {namespace:"custom", key:"kauppa_2_nimi"}
            {namespace:"custom", key:"kauppa_2_linkki"}
            {namespace:"custom", key:"kauppa_3_nimi"}
            {namespace:"custom", key:"kauppa_3_linkki"}
          ]) { key value }
        }
      }
    }
  }
`;

function parseJson(val) {
  if (!val) return [];
  try { return JSON.parse(val); } catch { return val.split('\n').map(s => s.trim()).filter(Boolean); }
}

function normalizeProduct(node) {
  if (!node) return null;
  const meta = {};
  for (const mf of (node.metafields || [])) {
    if (mf && mf.key) meta[mf.key] = mf.value || '';
  }

  // Vapaa-lista metafieldistä tai tyhjä (suodatus ohitetaan jos tyhjä)
  const vapaa = parseJson(meta['allergiat']);
  const ika = parseJson(meta['koiran_ika']);
  const koko = parseJson(meta['koiran_koko']);

  return {
    n: node.title || '',
    m: node.vendor || '',
    p: parseJson(meta['proteiinit']),
    v: vapaa,
    i: ika.length ? ika : ['Aikuinen'], // oletus: aikuinen
    k: koko.length ? koko : ['Kaikki'],  // oletus: kaikki
    a: meta['ainesosat'] || '',
    rv: meta['ravintoaineet'] || '',
    la: meta['lisaaineet'] || '',
    rf: parseJson(meta['rasvat_ja_oljyt']),
    rl: meta['raakarasva'] || '',
    er: parseJson(meta['erikoisruoat']),
    hh: parseJson(meta['hiilihydraatit']),
    // Kauppalinkit - käytä ensimmäistä saatavilla olevaa
    kp: meta['kauppa_1_nimi'] || meta['kauppa_2_nimi'] || meta['kauppa_3_nimi'] || '',
    l: meta['kauppa_1_linkki'] || meta['kauppa_2_linkki'] || meta['kauppa_3_linkki'] || '',
    kp2: meta['kauppa_1_nimi'] ? (meta['kauppa_2_nimi'] || '') : (meta['kauppa_3_nimi'] || ''),
    l2: meta['kauppa_1_nimi'] ? (meta['kauppa_2_linkki'] || '') : (meta['kauppa_3_linkki'] || ''),
    // Kaikki kaupat hakua varten
    kp3: meta['kauppa_3_nimi'] || '',
    l3: meta['kauppa_3_linkki'] || '',
    _allLinks: [meta['kauppa_1_linkki'],meta['kauppa_2_linkki'],meta['kauppa_3_linkki']].filter(Boolean),
    _allKaupat: [meta['kauppa_1_nimi'],meta['kauppa_2_nimi'],meta['kauppa_3_nimi']].filter(Boolean),
  };
}

export async function getProducts() {
  if (cache.products && Date.now() - cache.ts < CACHE_TTL) {
    return cache.products;
  }

  const shopDomain = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_PUBLIC_TOKEN || process.env.SHOPIFY_STOREFRONT_API;

  if (!shopDomain || !token) {
    console.error('Shopify env vars missing');
    return [];
  }

  const url = `https://${shopDomain}/api/2025-07/graphql.json`;
  const allProducts = [];
  let cursor = null;
  let hasNextPage = true;

  try {
    while (hasNextPage) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': token,
        },
        body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
      });

      if (!res.ok) {
        console.error(`Shopify error ${res.status}`);
        return [];
      }

      const data = await res.json();
      if (data.errors) {
        console.error('GraphQL errors:', JSON.stringify(data.errors));
        return [];
      }

      const { edges, pageInfo } = data.data.products;
      for (const { node } of edges) {
        const p = normalizeProduct(node);
        if (p) allProducts.push(p);
      }

      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
    }

    cache = { products: allProducts, ts: Date.now() };
    console.log(`Shopify: ${allProducts.length} tuotetta ladattu`);
    return allProducts;

  } catch (err) {
    console.error('Shopify error:', err.message);
    return [];
  }
}
