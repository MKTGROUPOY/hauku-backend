// lib/shopify.js — Hakee tuotteet Shopify Storefront API:sta
// Cachettaa muistiin 1 tunniksi (Edge runtime context)

let cache = { products: null, ts: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 tunti

// Shopify Storefront API GraphQL-kysely
// Hakee kaikki tuotteet metafield-tietoineen
const PRODUCTS_QUERY = `
  query GetProducts($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          vendor
          productType
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
            {namespace:"custom", key:"kauppa_1_nimi"}
            {namespace:"custom", key:"kauppa_1_linkki"}
          ]) {
            key
            value
          }
        }
      }
    }
  }
`;

// Muunna Shopify-tuote filtteröitävään muotoon
function normalizeProduct(node) {
  const meta = {};
  for (const mf of node.metafields || []) {
    if (mf) meta[mf.key] = mf.value;
  }

  // Parsi listat (rivinvaihdolla erotettu)
  const splitList = (val) => val ? val.split('\n').map(s => s.trim()).filter(Boolean) : [];

  // Vapaa-lista (allergeenit joita EI sisällä) tulee tags-kentästä tai metafieldistä
  // Shopifyssa: tagit voivat olla "vapaa:Kana", "vapaa:Lohi" jne.
  const vapaaFromTags = node.tags
    .filter(t => t.startsWith('vapaa:'))
    .map(t => t.replace('vapaa:', ''));

  // Ikäluokat tagiinä: "ika:Pentu", "ika:Aikuinen" jne.
  const ikaFromTags = node.tags
    .filter(t => t.startsWith('ika:'))
    .map(t => t.replace('ika:', ''));

  // Koko tagiinä: "koko:Pieni", "koko:Suuri" jne.
  const kokoFromTags = node.tags
    .filter(t => t.startsWith('koko:'))
    .map(t => t.replace('koko:', ''));

  return {
    n: node.title,
    m: node.vendor,
    p: splitList(meta['proteiinit']),
    v: vapaaFromTags,
    i: ikaFromTags,
    k: kokoFromTags,
    a: meta['ainesosat'] || '',
    rv: meta['ravintoaineet'] || '',
    la: meta['lisaaineet'] || '',
    rf: splitList(meta['rasvat_ja_oljyt']),
    rl: meta['raakarasva'] || '',
    er: splitList(meta['erikoisruoat']),
    hh: splitList(meta['hiilihydraatit']),
    kp: meta['kauppa_1_nimi'] || '',
    l: meta['kauppa_1_linkki'] || '',
  };
}

export async function getProducts() {
  // Palauta cache jos alle tunnin vanha
  if (cache.products && Date.now() - cache.ts < CACHE_TTL) {
    return cache.products;
  }

  const shopDomain = process.env.SHOPIFY_DOMAIN; // esim. "ruokakoiralle.myshopify.com"
  const token = process.env.SHOPIFY_STOREFRONT_API;
  const apiVersion = '2024-04';

  const url = `https://${shopDomain}/api/${apiVersion}/graphql.json`;
  const allProducts = [];
  let cursor = null;
  let hasNextPage = true;

  // Paginated fetch (250 kerrallaan)
  while (hasNextPage) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': token,
      },
      body: JSON.stringify({
        query: PRODUCTS_QUERY,
        variables: { cursor },
      }),
    });

    if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
    const data = await res.json();

    const { edges, pageInfo } = data.data.products;
    for (const { node } of edges) {
      allProducts.push(normalizeProduct(node));
    }

    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  cache = { products: allProducts, ts: Date.now() };
  console.log(`Shopify: ladattu ${allProducts.length} tuotetta`);
  return allProducts;
}
