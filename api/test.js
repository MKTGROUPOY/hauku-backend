import { extractFilters, filterProducts } from '../lib/filters.js';
import { getProducts } from '../lib/shopify.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const products = await getProducts();
  
  // Simuloi "kana ei sovi" -hakua
  const fakeMessages = [{role:'user', content:'Minulla on koira jolle ei sovi kana. Mitä suosittelet?'}];
  const filters = extractFilters(fakeMessages);
  const matched = filterProducts(products, filters);
  
  // Näytä Alpha Spirit tulokset
  const alphaSpiritMatched = matched.filter(p => p.m === 'Alpha Spirit' || (p.n||'').includes('Alpha'));
  const alphaSpiritAll = products.filter(p => p.m === 'Alpha Spirit' || (p.n||'').includes('Alpha'));
  
  // Tarkista muutama tuote
  const sample = products.slice(0,3).map(p => ({n:p.n, v_count: (p.v||[]).length, v_sample: (p.v||[]).slice(0,3)}));
  
  res.status(200).json({
    filters,
    totalProducts: products.length,
    matchedCount: matched.length,
    alphaSpiritAll: alphaSpiritAll.length,
    alphaSpiritMatched: alphaSpiritMatched.length,
    alphaSpiritMatchedNames: alphaSpiritMatched.map(p => p.n),
    sampleVapaaData: sample
  });
}
