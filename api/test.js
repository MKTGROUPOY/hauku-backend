import { getProducts } from '../lib/shopify.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const products = await getProducts();
  
  const noAllergiat = products.filter(p => !p.v || p.v.length === 0);
  const hasAllergiat = products.filter(p => p.v && p.v.length > 0);
  
  // Tuotteista joilla ei ole allergiat-dataa - onko niillä ainesosat?
  const noAllergiButHasA = noAllergiat.filter(p => p.a && p.a.length > 10);
  
  res.status(200).json({
    total: products.length,
    hasAllergiatData: hasAllergiat.length,
    noAllergiatData: noAllergiat.length,
    noAllergiButHasIngredients: noAllergiButHasA.length,
    pctCovered: Math.round(100 * hasAllergiat.length / products.length) + '%',
    sampleNoAllergiat: noAllergiat.slice(0,5).map(p => ({n: p.n, m: p.m, hasA: !!p.a}))
  });
}
