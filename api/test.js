import { getProducts } from '../lib/shopify.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const products = await getProducts();
  
  const norm = s => s.toLowerCase().replace(/[^a-zäöå ]/g,' ').replace(/ +/g,' ').trim();
  
  // Find all vendors
  const vendors = [...new Set(products.map(p => p.m).filter(Boolean))].sort();
  const grandorfVendors = vendors.filter(v => v.toLowerCase().includes('grandorf'));
  const grandorfProducts = products.filter(p => norm(p.m||'').includes('grandorf'));
  
  res.status(200).json({
    grandorfVendors,
    grandorfProductCount: grandorfProducts.length,
    sampleNames: grandorfProducts.slice(0,3).map(p => p.n),
    normTest: norm('GRANDORF'),
    normTest2: norm('Grandorf')
  });
}
