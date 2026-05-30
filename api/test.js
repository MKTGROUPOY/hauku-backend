import { getProducts } from '../lib/shopify.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const products = await getProducts();
  const norm = s => s.toLowerCase().replace(/[^a-zäöå ]/g,' ').replace(/ +/g,' ').trim();
  
  const riverwood = products.filter(p => norm(p.m||'').includes('riverwood'));
  const grandorf = products.filter(p => norm(p.m||'').includes('grandorf'));
  
  res.status(200).json({
    riverwoodCount: riverwood.length,
    riverwoodNames: riverwood.map(p => p.n),
    grandorfCount: grandorf.length,
    grandorfNames: grandorf.map(p => p.n)
  });
}
