export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const shopDomain = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_PUBLIC_TOKEN;

  const query = `{
    products(first: 1, query: "title:\\"Riverwood Adult Skotlantilainen\\"") {
      edges {
        node {
          title
          metafields(identifiers: [
            {namespace:"custom", key:"ravintoaineet"}
            {namespace:"custom", key:"lisaaineet"}
            {namespace:"custom", key:"ainesosat"}
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
