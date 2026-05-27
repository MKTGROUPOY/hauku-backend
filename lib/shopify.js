// lib/shopify.js

let cache = { products: null, ts: 0 };
const CACHE_TTL = 60 * 60 * 1000;

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
          ]) { key value }
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
  return {
    n: node.title || '',
    m: node.vendor || '',
    p: splitList(meta['proteiinit']),
    v: tags.filter(t => t?.startsWith('vapaa:')).map(t => t.replace('vapaa:', '')),
    i: tags.filter(t => t?.startsWith('ika:')).map(t => t.replace('ika:', '')),
    k: tags.filter(t => t?.startsWith('koko:')).map(t => t.replace('koko:', '')),
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
  const privateToken = process.env.SHOPIFY_STOREFRONT_API;
  const publicToken = process.env.SHOPIFY_PUBLIC_TOKEN;

  if (!shopDomain) {
    console.error('SHOPIFY_DOMAIN missing');
    return [];
  }

  const token = privateToken || publicToken;
  if (!token) {
    console.error('No Shopify token found');
    return [];
  }

  const apiVersion = '2025-01';
  const url = `https://${shopDomain}/api/${apiVersion}/graphql.json`;
  
  // Yksityinen token (shpat_) käyttää eri headeria kuin julkinen
  const tokenHeader = token.startsWith('shpat_') 
    ? 'Shopify-Storefront-Private-Token'
    : 'X-Shopify-Storefront-Access-Token';

  console.log(`Shopify: ${url}, header: ${tokenHeader}, token: ${token.substring(0,12)}...`);

  const allProducts = [];
  let cursor = null;
  let hasNextPage = true;

  try {
    while (hasNextPage) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [tokenHeader]: token,
        },
        body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`Shopify error ${res.status}: ${errText.substring(0, 200)}`);
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
    console.error('Shopify fetch error:', err.message);
    return [];
  }
}
