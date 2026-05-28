import { getProducts } from '../lib/shopify.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const products = await getProducts();
  
  const hasLa = products.filter(p => p.la && p.la.length > 5).length;
  const hasRv = products.filter(p => p.rv && p.rv.length > 5).length;
  const hasA = products.filter(p => p.a && p.a.length > 5).length;
  
  res.status(200).json({
    total: products.length,
    hasLisaaineet: hasLa,
    hasRavintoaineet: hasRv,
    hasAinesosat: hasA,
    pctLisaaineet: Math.round(100*hasLa/products.length) + '%'
  });
}
