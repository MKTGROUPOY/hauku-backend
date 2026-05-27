// lib/shopify.js — Hakee tuotteet Shopify Storefront API:sta

let cache = { products: null, ts: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 tunti

const PRODUCTS_QUERY = `
  query GetProducts($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
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

function normalizeProduct(node) {
  if (!node) return null;
  
  const meta = {};
  for (const mf of (node.metafields || [])) {
    if (mf && mf.key) meta[mf.key] = mf.value || '';
  }

  const splitList = (val) => val ? val.split('\n').map(s => s.trim()).filter(Boolean) : [];
  const tags = node.tags || [];
  
  const vapaaFromTags = tags
    .filter(t => t && t.startsWith('vapaa:'))
    .map(t => t.replace('vapaa:', ''));

  const ikaFromTags = tags
    .filter(t => t && t.startsWith('ika:'))
    .map(t => t.replace('ika:', ''));

  const kokoFromTags = tags
    .filter(t => t && t.startsWith('koko:'))
    .map(t => t.replace('koko:', ''));

  return {
    n: node.title || '',
    m: node.vendor || '',
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
  if (cache.products && Date.now() - cache.ts < CACHE_TTL) {
    return cache.products;
  }

  const shopDomain = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_STOREFRONT_API;

  if (!shopDomain || !token) {
    console.error('Shopify env vars missing:', { shopDomain: !!shopDomain, token: !!token });
    return [];
  }

  const apiVersion = '2024-04';
  const url = `https://${shopDomain}/api/${apiVersion}/graphql.json`;
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
        body: JSON.stringify({
          query: PRODUCTS_QUERY,
          variables: { cursor },
        }),
      });

      if (!res.ok) {
        console.error(`Shopify API error: ${res.status}`);
        return [];
      }
      
      const data = await res.json();
      
      if (data.errors) {
        console.error('Shopify GraphQL errors:', JSON.stringify(data.errors));
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
    console.log(`Shopify: ladattu ${allProducts.length} tuotetta`);
    return allProducts;
    
  } catch (err) {
    console.error('Shopify fetch error:', err.message);
    return [];
  }
}