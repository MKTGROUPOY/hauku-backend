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

    // 2a. Rakenna valikoiman yhteenveto Shopify-datasta (päivittyy automaattisesti)
    const productTypes = [...new Set(products.map(p => p.tt || '').filter(Boolean))];
    const brands = [...new Set(products.map(p => p.m || '').filter(Boolean))];
    const catalogSummary = `\n\n[VALIKOIMAN YHTEENVETO - päivitetty automaattisesti Shopifysta:\n- Tuotteita yhteensä: ${products.length}\n- Merkkejä: ${brands.length}\n- Tuotetyypit valikoimassa: ${productTypes.length > 0 ? productTypes.join(', ') : 'kuivaruoka'}\n- Jos asiakas kysyy tuottetyypistä jota ei yllä ole, kerro rehellisesti ettei sitä vielä ole valikoimassa]`;

    // 2b. Tarkka tuotenimiehaku - priorisoi täsmäävä tuote
    const userText = norm(messages.filter(m => m.role === 'user').map(m => m.content).join(' '));
    let exactProduct = null;
    if (products.length > 0) {
      // Etsi tuote jonka nimi löytyy käyttäjän viestistä (min 10 merkkiä)
      for (const p of products) {
        const pNorm = norm(p.n || '');
        if (pNorm.length >= 10 && userText.includes(pNorm)) {
          exactProduct = p;
          break;
        }
      }
    }

    // 3. Bränditunnistus tuotelistan perusteella
    if (!filters.brand && products.length > 0) {
      // Mustat lista - nämä sanat eivät ole brändejä
      const BLACKLIST = ['hauku','ruokakoiralle','koiralle','koira','ruoka','peten','zooplus','haukkula'];
      const vendors = [...new Set(products.map(p => norm(p.m || '')).filter(v => v.length >= 4 && !BLACKLIST.includes(v)))];
      vendors.sort((a, b) => b.length - a.length);
      // Hae vain USER-viesteistä, ei botin omista viesteistä
      const userOnlyText = norm(messages.filter(m => m.role === 'user').map(m => m.content).join(' '));
      console.log('userOnlyText:', userOnlyText.substring(0, 80));
      for (const vendor of vendors) {
        if (userOnlyText.includes(vendor)) {
          filters.brand = vendor;
          console.log('Brand found:', vendor);
          break;
        }
      }
    }

    console.log('filters:', JSON.stringify({brand:filters.brand,excl:filters.excl,want:filters.want}));
    console.log('hasFilters will be:', !!(filters.excl.length||filters.want.length||filters.brand||filters.age||filters.size));
    console.log('allUserText sample:', norm(messages.map(m=>m.content).join(' ')).substring(0,100));
    const hasFilters = !!(
      filters.excl.length || filters.want.length ||
      filters.brand || filters.age || filters.size || filters.specialDiets?.length || filters.store
    );
    let matched = hasFilters ? filterProducts(products, filters) : [];
    // Jos löytyi tarkka tuote, varmista että se on kontekstissa
    if (exactProduct && !matched.find(p => p.n === exactProduct.n)) {
      matched = [exactProduct, ...matched.slice(0, 4)];
    } else if (exactProduct) {
      // Nosta tarkka tuote listan ensimmäiseksi
      matched = [exactProduct, ...matched.filter(p => p.n !== exactProduct.n).slice(0, 4)];
    }
    const productCtx = (hasFilters || exactProduct) ? buildProductContext(matched, filters) : '';
    
    console.log('brand:', filters.brand, 'hasFilters:', hasFilters, 'matched:', matched.length);
    
    console.log('brand:', filters.brand, 'hasFilters:', hasFilters, 'matched:', matched.length);

    // 4. Jos ei filttereitä eikä tuotekontekstia, käytä Geminiä vain keskusteluun
    // Lisää ohje olla suosittelematta tuotteita
    const noProductInstruction = !productCtx ? 
      '\n\nTÄRKEÄ OHJE: Tässä viestissä ei ole <tuotteet_tietokannasta>-osiota. Et tiedä mitä tuotteita on valikoimassa. ÄLÄ mainitse yhtään tuotteen nimeä, merkkiä tai linkkiä. Kysy vain lisätietoja koirasta (rotu, ikä, tarpeet).' : '';

    // Rakenna koodissa tuotelista jota Gemini EI voi muuttaa
    const matchedProductNames = matched.map(p => p.n);
    const productWhitelistInstruction = productCtx && matchedProductNames.length > 0 ? 
      `\n\nKRIITTINEN TURVALLISUUSOHJE – ALLERGEENIT: Saat suositella VAIN näitä ${matchedProductNames.length} tuotetta: [${matchedProductNames.join(' | ')}]. ÄLÄ KOSKAAN mainitse muita tuotteita. Tämä on hengenvaarallinen turvallisuusvaatimus allergikoirille.` : '';

    // 4. Rakenna viestit Geminille
    const basePrompt = (HARDCODED_PROMPT || process.env.SYSTEM_PROMPT || '') + noProductInstruction;
    // Gemini vaatii: ensimmäinen viesti user, viimeinen user, ei peräkkäisiä samoja rooleja
    const systemPrompt = basePrompt + catalogSummary + productWhitelistInstruction;
    // Suodata viestit Geminille: poista johtavat assistant-viestit, varmista user-viesti lopussa
    const filteredMessages = messages.filter((m, i) => {
      // Poista ensimmäinen assistant-viesti (botin tervetulotoivotus)
      if (i === 0 && m.role === 'assistant') return false;
      return true;
    });
    // Varmista että viimeinen viesti on user
    const lastUserIdx = filteredMessages.map(m => m.role).lastIndexOf('user');
    const msgsForGemini = filteredMessages.slice(0, lastUserIdx + 1);
    
    // Jos ei ole user-viestejä, palauta tyhjä vastaus
    if (msgsForGemini.length === 0 || !msgsForGemini.some(m => m.role === 'user')) {
      return res.status(200).json({ reply: 'Moikka! Miten voin auttaa koirasi kanssa?' });
    }

    const geminiMessages = msgsForGemini.map((m, i) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: i === msgsForGemini.length - 1 && m.role === 'user' && productCtx
        ? m.content + productCtx
        : m.content }]
    }));

    // 5. Kutsu Gemini API
    const apiKey = process.env.GEMINI_API_KEY;
    const model = 'gemini-2.5-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: geminiMessages,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
      }),
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, err.substring(0, 500));
      return res.status(502).json({ error: `Gemini error: ${geminiRes.status} - ${err.substring(0, 200)}` });
    }

    const data = await geminiRes.json();
    let reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Yritä uudelleen.';
    


    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
