// api/chat.js — Hauku backend (Vercel serverless) — Gemini API

import { extractFilters, filterProducts, buildProductContext } from '../lib/filters.js';
import { getProducts } from '../lib/shopify.js';
import { SYSTEM_PROMPT as HARDCODED_PROMPT } from '../lib/system-prompt.js';

function norm(s) {
  return s.toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { messages } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });

    // 1. Hae tuotteet Shopifysta
    const products = await getProducts();

    // 2. Tunnista filtterit
    const filters = extractFilters(messages);

    // 3. Bränditunnistus — VAIN viimeisin käyttäjäviesti
    // Näin "Entä Acana?" ei sekoitu edelliseen Riverwood-hakuun
    if (products.length > 0) {
      const BLACKLIST = ['hauku', 'ruokakoiralle', 'koiralle', 'koira', 'ruoka', 'peten', 'zooplus', 'haukkula'];
      const vendors = [...new Set(
        products.map(p => norm(p.m || '')).filter(v => v.length >= 4 && !BLACKLIST.includes(v))
      )].sort((a, b) => b.length - a.length);

      // Käytä VAIN viimeisintä käyttäjäviestiä bränditunnistukseen
      const userMsgs = messages.filter(m => m.role === 'user');
      const latestUserText = norm(userMsgs[userMsgs.length - 1]?.content || '');

      let detectedBrand = null;
      for (const vendor of vendors) {
        const base = vendor.replace(/[^a-zäöå]/g, '');
        if (
          latestUserText.includes(vendor) ||
          latestUserText.includes(base + 'in') ||
          latestUserText.includes(base + 'ia') ||
          latestUserText.includes(base + 'illa') ||
          latestUserText.includes(base + 'sta') ||
          latestUserText.includes(base + 'lla')
        ) {
          detectedBrand = vendor;
          break;
        }
      }
      // Ylikirjoita aina viimeisimmän viestin brändi (nollaa vanhan kontekstin)
      filters.brand = detectedBrand;
    }

    // 4. Tarkka tuotenimiehaku koko historiasta
    const allText = norm(messages.map(m => m.content).join(' '));
    let exactProduct = null;
    let bestLen = 0;
    for (const p of products) {
      const pNorm = norm(p.n || '');
      if (pNorm.length >= 10 && allText.includes(pNorm) && pNorm.length > bestLen) {
        exactProduct = p;
        bestLen = pNorm.length;
      }
    }

    const hasFilters = !!(
      filters.excl.length || filters.want.length ||
      filters.brand || filters.age || filters.size ||
      filters.specialDiets?.length || filters.store ||
      exactProduct
    );

    // 5. Suodata tuotteet
    let matched = hasFilters ? filterProducts(products, filters) : [];

    // Nosta tarkka tuote listan kärkeen
    if (exactProduct) {
      const rest = matched.filter(p => p.n !== exactProduct.n).slice(0, 4);
      matched = [exactProduct, ...rest];
    }

    const productCtx = (hasFilters || exactProduct) ? buildProductContext(matched, filters) : '';

    // 6. Rakenna valikoiman yhteenveto (dynaamisesti Shopify-datasta)
    const productTypes = [...new Set(products.map(p => p.tt || '').filter(Boolean))];
    const brands = [...new Set(products.map(p => p.m || '').filter(Boolean))];
    const catalogSummary = `\n\n[VALIKOIMAN TIEDOT: ${products.length} tuotetta, ${brands.length} merkkiä. Tuotetyypit: ${productTypes.length > 0 ? productTypes.join(', ') : 'kuivaruoka'}. Jos asiakas kysyy tuotetyypistä jota ei listalla ole, kerro rehellisesti ettei sitä ole valikoimassa.]`;

    // 7. Rakenna system prompt — EI tuotewhitelistiä erikseen, se on jo buildProductContext:issa
    const noProductInstruction = !productCtx
      ? '\n\nOHJE: Tässä viestissä ei ole tuotetietokantahakua. Et tiedä mitä tuotteita on valikoimassa. ÄLÄ mainitse yhtään tuotteen nimeä, merkkiä tai linkkiä. Kysy ensin lisätietoja koirasta.'
      : '';

    const systemPrompt = (HARDCODED_PROMPT || '') + catalogSummary + noProductInstruction;

    console.log('filters:', JSON.stringify({ brand: filters.brand, excl: filters.excl, want: filters.want, age: filters.age, size: filters.size }));
    console.log('hasFilters:', hasFilters, '| matched:', matched.length, '| exactProduct:', exactProduct?.n || null);

    // 8. Rakenna viestit Geminille
    const filteredMessages = messages.filter((m, i) => !(i === 0 && m.role === 'assistant'));
    const lastUserIdx = filteredMessages.map(m => m.role).lastIndexOf('user');
    const msgsForGemini = filteredMessages.slice(0, lastUserIdx + 1);

    if (msgsForGemini.length === 0 || !msgsForGemini.some(m => m.role === 'user')) {
      return res.status(200).json({ reply: 'Moikka! Miten voin auttaa koirasi kanssa?' });
    }

    const geminiMessages = msgsForGemini.map((m, i) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{
        text: (i === msgsForGemini.length - 1 && m.role === 'user' && productCtx)
          ? m.content + productCtx
          : m.content
      }]
    }));

    // 9. Kutsu Gemini API
    const apiKey = process.env.GEMINI_API_KEY;
    const model = 'gemini-2.5-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: geminiMessages,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.5 },
      }),
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, err.substring(0, 500));
      return res.status(502).json({ error: `Gemini error: ${geminiRes.status}` });
    }

    const data = await geminiRes.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Yritä uudelleen.';

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Handler error:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}
