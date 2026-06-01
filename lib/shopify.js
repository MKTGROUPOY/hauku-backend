// lib/shopify.js — Hakee tuotteet metafieldeistä

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
            {namespace:"custom", key:"kaupat"}
            {namespace:"custom", key:"rajatut_raaka_aineet"}
            {namespace:"custom", key:"ruoan_tyyppi"}
          ]) { key value }
        }
      }
    }
  }
`;

// Parsi arvo listaksi — tukee JSON, " • " ja rivinvaihtoerotinta
function parseJson(val) {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // " • " -erotin (Shopifyn bullet-formaatti)
    if (val.includes(' • ')) return val.split(' • ').map(s => s.trim()).filter(Boolean);
    // Rivinvaihto
    return val.split('\n').map(s => s.trim()).filter(Boolean);
  }
}

function normalizeProduct(node) {
  if (!node) return null;
  const meta = {};
  for (const mf of (node.metafields || [])) {
    if (mf && mf.key) meta[mf.key] = mf.value || '';
  }

  // Allergeenitieto: lista allergeeneista joista tuote ON VAPAA
  const vapaa = parseJson(meta['allergiat']);
  const ika   = parseJson(meta['koiran_ika']);
  const koko  = parseJson(meta['koiran_koko']);

  // KRIITTINEN: kauppalinkit ASEMAPAIKKAKOHTAISESTI
  // kauppa_1 = AINA Peten Koiratarvike
  // kauppa_2 = AINA Koiratarvike Haukkula
  // kauppa_3 = AINA Zooplus
  // Ei fallback-logiikkaa — tyhjä linkki tarkoittaa ettei tuotetta myydä siellä
  const l1 = meta['kauppa_1_linkki'] || '';
  const l2 = meta['kauppa_2_linkki'] || '';
  const l3 = meta['kauppa_3_linkki'] || '';
  const n1 = meta['kauppa_1_nimi']   || (l1 ? 'Peten Koiratarvike' : '');
  const n2 = meta['kauppa_2_nimi']   || (l2 ? 'Koiratarvike Haukkula' : '');
  const n3 = meta['kauppa_3_nimi']   || (l3 ? 'Zooplus' : '');

  return {
    n:  node.title  || '',
    m:  node.vendor || '',
    tt: meta['ruoan_tyyppi'] || '',
    p:  parseJson(meta['proteiinit']),
    v:  vapaa,
    i:  ika.length  ? ika  : ['Aikuinen'],
    k:  koko.length ? koko : ['Kaikki'],
    a:  meta['ainesosat']      || '',
    rv: meta['ravintoaineet']  || '',
    la: meta['lisaaineet']     || '',
    rf: parseJson(meta['rasvat_ja_oljyt']),
    rl: meta['raakarasva']     || '',
    er: parseJson(meta['erikoisruoat']),
    hh: parseJson(meta['hiilihydraatit']),
    rr: meta['rajatut_raaka_aineet'] || '',
    // Kauppalinkit — asema on kiinteä
    l:  l1, kp:  n1,   // Peten Koiratarvike
    l2: l2, kp2: n2,   // Koiratarvike Haukkula
    l3: l3, kp3: n3,   // Zooplus
    // Kaikki linkit ja kaupat listana (taaksepäin yhteensopivuus)
    _allLinks:  [l1, l2, l3].filter(Boolean),
    _allKaupat: [n1, n2, n3].filter(Boolean),
    // kaupat-kenttä suoraan Shopifysta
    kaupat: meta['kaupat'] || '',
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
