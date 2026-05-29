export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const shopDomain = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_PUBLIC_TOKEN;

  // Check YDOLO which we know has Haukkula links
  const query = `{
    products(first: 2, query: "vendor:YDOLO") {
      edges {
        node {
          title
          metafields(identifiers: [
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
  }`;

  const r = await fetch(`https://${shopDomain}/api/2025-07/graphql.json`, {
    method: 'POST',
    headers: {'Content-Type':'application/json','X-Shopify-Storefront-Access-Token':token},
    body: JSON.stringify({query}),
  });
  const data = await r.json();
  res.status(200).json(data);
}
