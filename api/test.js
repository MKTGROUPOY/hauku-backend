import { getProducts } from '../lib/shopify.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const products = await getProducts();
  
  // Check store link coverage
  const hasPeten = products.filter(p => 
    (p.l && p.l.includes('petenkoiratarvike')) || 
    (p.l2 && p.l2.includes('petenkoiratarvike'))
  ).length;
  
  const hasHaukkula = products.filter(p => 
    (p.l && p.l.includes('haukkula')) || 
    (p.l2 && p.l2.includes('haukkula'))
  ).length;

  // Sample product with links
  const sample = products.filter(p => p.l || p.l2).slice(0,3).map(p => ({
    n: p.n,
    kp: p.kp, l: p.l?.substring(0,60),
    kp2: p.kp2, l2: p.l2?.substring(0,60)
  }));

  res.status(200).json({ 
    total: products.length,
    hasPetenLink: hasPeten,
    hasHaukkulaLink: hasHaukkula,
    noLinks: products.filter(p => !p.l && !p.l2).length,
    sample
  });
}
