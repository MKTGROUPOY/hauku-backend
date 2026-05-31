// api/chat.js — Hauku backend (Vercel serverless) — Gemini API

import { extractFilters, filterProducts, buildProductContext } from '../lib/filters.js';
import { getProducts } from '../lib/shopify.js';
import { SYSTEM_PROMPT as HARDCODED_PROMPT } from '../lib/system-prompt.js';

function norm(s) {
  return s.toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

// ── Sairaudet jotka vaativat eläinlääkäriä – backend estää tuotekontekstin ──
const MEDICAL_BLOCKS = [
  'munuain', 'munuais', 'renal', 'maksan vajaa', 'hepatic',
  'haimatuleh', 'pankreatiit', 'diabetes', 'sydänsaira', 'sydänvika',
  'epilepsi', 'kasvain', 'syöpä', 'hypotyreoosi', 'hypertyreoosi',
  'cushingin', 'addisonin',
];

function detectMedicalBlock(messages) {
  const allText = norm(messages.filter(m => m.role === 'user').map(m => m.content).join(' '));
  return MEDICAL_BLOCKS.find(kw => allText.includes(kw)) || null;
}

// ── Brändi mainittu mutta ei löydy valikoimasta ───────────────────────────────
function buildBrandNotFoundMsg(brandName) {
  return `\n\n[TIETOKANTATIETO: Brändiä "${brandName}" ei löydy valikoimastamme. Kerro tämä asiakkaalle suoraan. ÄLÄ suosittele muita tuotteita ellei asiakas pyydä.]`;
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
    let askedBrand = null; // mitä brändiä käyttäjä kysyi (myös jos ei löydy)
    if (products.length > 0) {
      const BLACKLIST = ['hauku', 'ruokakoiralle', 'koiralle', 'koira', 'ruoka', 'peten', 'zooplus', 'haukkula'];
      const vendors = [...new Set(
        products.map(p => norm(p.m || '')).filter(v => v.length >= 4 && !BLACKLIST.includes(v))
      )].sort((a, b) => b.length - a.length);

      const userMsgs = messages.filter(m => m.role === 'user');
      const latestUserText = norm(userMsgs[userMsgs.length - 1]?.content || '');

      // Tunnista valikoimasta löytyvä brändi
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
      filters.brand = detectedBrand;

      // Tunnista kysytty brändi vaikka ei löytyisi valikoimasta
      // Heuristic: iso kirjain tai tunnettu pattern brändikysymyksessä
      if (!detectedBrand) {
        const brandQuestionMatch = latestUserText.match(/(?:löytyykö|onko|entä|löytyy|haen|etsin)\s+([a-zäöå]{4,})/i);
        if (brandQuestionMatch) {
          askedBrand = brandQuestionMatch[1];
        }
      }
    }

    // 4. Tarkka tuotenimiehaku viimeisestä käyttäjäviestistä
    const lastUserText = norm(messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '');
    let exactProduct = null;
    let bestLen = 0;
    for (const p of products) {
      const pNorm = norm(p.n || '');
      if (pNorm.length >= 10 && lastUserText.includes(pNorm) && pNorm.length > bestLen) {
        exactProduct = p;
        bestLen = pNorm.length;
      }
    }

        // 5a. Tuotemäärä-kysymys — vastaa suoraan backendistä, ei Geminiltä
    const userMsgsAll = messages.filter(m => m.role === 'user');
    const latestUserMsg = norm(userMsgsAll[userMsgsAll.length - 1]?.content || '');
    const isCountQuestion = /montako|kuinka monta|paljonko.*tuotett|monta.*tuotett/.test(latestUserMsg);
    // "Oletko varma?" tuotemäärästä — tarkista onko edellinen assistant-vastaus sisältänyt luvun
    const isDoubtQuestion = /oletko varma|oletko.*varma|oletko.*oikein|varmistaisitko|tarkista|tarkistat|ihan varma|täysin varma/.test(latestUserMsg);
    const lastAssistantMsg = messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
    const prevCountMatch = lastAssistantMsg.match(/\*\*(\d+)\*\*.*-tuotetta|on (\d+) .{1,20}-tuotetta/);
    if (isDoubtQuestion && prevCountMatch && filters.brand) {
      const confirmedCount = prevCountMatch[1] || prevCountMatch[2];
      const brandDisplay = filters.brand.charAt(0).toUpperCase() + filters.brand.slice(1);
      console.log('DOUBT QUERY: confirming count:', confirmedCount, 'for brand:', filters.brand);
      return res.status(200).json({
        reply: `Kyllä, tietokantamme mukaan valikoimassamme on **${confirmedCount}** ${brandDisplay}-tuotetta. Voit tarkistaa valikoiman suoraan [ruokakoiralle.fi](https://www.ruokakoiralle.fi):stä.`
      });
    }
    if (isCountQuestion && filters.brand) {
      const brandProducts = products.filter(p =>
        norm(p.m || '').includes(norm(filters.brand)) || norm(p.n || '').includes(norm(filters.brand))
      );
      console.log('COUNT QUERY: brand:', filters.brand, 'count:', brandProducts.length);
      const brandDisplay = filters.brand.charAt(0).toUpperCase() + filters.brand.slice(1);
      if (brandProducts.length > 0) {
        return res.status(200).json({
          reply: `Valikoimassamme on tällä hetkellä **${brandProducts.length}** ${brandDisplay}-tuotetta.`
        });
      } else {
        return res.status(200).json({
          reply: `${brandDisplay}-merkkiä ei löydy valikoimastamme.`
        });
      }
    }

    // 5. Lääketieteellinen esto — jos sairaus tunnistettu, EI tuotekontekstia
    const medicalBlock = detectMedicalBlock(messages);
    if (medicalBlock) {
      const medicalInstruction = `\n\n[BACKEND-ESTO AKTIIVINEN: Käyttäjä on maininnut sairauden (tunnistettu: "${medicalBlock}"). ÄLÄ suosittele yhtään tuotetta. Vastaa VAIN: kerro että ruokavaliomuutos tähän sairauteen on tehtävä eläinlääkärin ohjeiden mukaan. Kun asiakas saa eläinlääkäriltä tarkat ravitsemusohjeet, voit auttaa sopivan tuotteen löytämisessä. LOPETA TÄHÄN – ei tuotelistoja, ei ravintoarvovertailuja.]`;

      const systemPrompt = (HARDCODED_PROMPT || '') + medicalInstruction;
      const filteredMessages = messages.filter((m, i) => !(i === 0 && m.role === 'assistant'));
      const lastUserIdx = filteredMessages.map(m => m.role).lastIndexOf('user');
      const msgsForGemini = filteredMessages.slice(0, lastUserIdx + 1);
      const geminiMessages = msgsForGemini.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      const apiKey = process.env.GEMINI_API_KEY;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: geminiMessages,
          generationConfig: { maxOutputTokens: 512, temperature: 0.3 },
        }),
      });
      const data = await geminiRes.json();
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Yritä uudelleen.';
      console.log('MEDICAL BLOCK active:', medicalBlock);
      return res.status(200).json({ reply });
    }

    const hasFilters = !!(
      filters.excl.length || filters.want.length ||
      filters.brand || filters.age || filters.size ||
      filters.specialDiets?.length || filters.store ||
      exactProduct
    );

    // 6. Suodata tuotteet
    let matched = hasFilters ? filterProducts(products, filters) : [];
    if (exactProduct) {
      const rest = matched.filter(p => p.n !== exactProduct.n).slice(0, 4);
      matched = [exactProduct, ...rest];
    }

    // 7. Rakenna tuotekonteksti
    // Jos käyttäjä kysyi brändiä jota ei löydy → kerro se selvästi
    let productCtx = '';
    if (filters.brand && matched.length === 0 && !exactProduct) {
      productCtx = buildBrandNotFoundMsg(filters.brand);
    } else if (hasFilters || exactProduct) {
      productCtx = buildProductContext(matched, filters);
    }

    // Jos käyttäjä kysyi brändiä jota ei tunnistettu valikoimasta
    if (!filters.brand && askedBrand) {
      productCtx = buildBrandNotFoundMsg(askedBrand);
    }

    // 8. Valikoiman yhteenveto
    const productTypes = [...new Set(products.map(p => p.tt || '').filter(Boolean))];
    const brands = [...new Set(products.map(p => p.m || '').filter(Boolean))];
    const catalogSummary = `\n\n[VALIKOIMAN TIEDOT: ${products.length} tuotetta, ${brands.length} merkkiä. Tuotetyypit: ${productTypes.length > 0 ? productTypes.join(', ') : 'kuivaruoka'}. Jos asiakas kysyy tuotetyypistä jota ei listalla ole, kerro rehellisesti ettei sitä ole valikoimassa.]`;

    const noProductInstruction = !productCtx
      ? '\n\nOHJE: Tässä viestissä ei ole tuotetietokantahakua. Et tiedä mitä tuotteita on valikoimassa. ÄLÄ mainitse yhtään tuotteen nimeä, merkkiä tai linkkiä. Kysy ensin lisätietoja koirasta.'
      : '';

    const systemPrompt = (HARDCODED_PROMPT || '') + catalogSummary + noProductInstruction;

    console.log('filters:', JSON.stringify({ brand: filters.brand, excl: filters.excl, want: filters.want, age: filters.age, size: filters.size }));
    console.log('hasFilters:', hasFilters, '| matched:', matched.length, '| exactProduct:', exactProduct?.n || null, '| askedBrand:', askedBrand);

    // 9. Rakenna viestit Geminille
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
          : m.content,
      }],
    }));

    // 10. Kutsu Gemini API
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: geminiMessages,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.1 },
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
