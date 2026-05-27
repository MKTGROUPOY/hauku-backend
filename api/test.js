// api/test.js — Shopify-yhteyden testaus
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const shopDomain = process.env.SHOPIFY_DOMAIN;
  const privateToken = process.env.SHOPIFY_STOREFRONT_API;
  const publicToken = process.env.SHOPIFY_PUBLIC_TOKEN;

  const results = {};

  // Testi 1: julkinen token, versio 2025-07
  for (const version of ['2025-07', '2025-04', '2026-01']) {
    for (const [name, token, header] of [
      ['public', publicToken, 'X-Shopify-Storefront-Access-Token'],
      ['private', privateToken, 'Shopify-Storefront-Private-Token'],
    ]) {
      const url = `https://${shopDomain}/api/${version}/graphql.json`;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [header]: token },
          body: JSON.stringify({ query: '{ shop { name } }' }),
        });
        const text = await r.text();
        results[`${version}_${name}`] = { status: r.status, body: text.substring(0, 200) };
      } catch (e) {
        results[`${version}_${name}`] = { error: e.message };
      }
    }
  }

  res.status(200).json({ shopDomain, results });
}
