// api/chat.js — Hauku backend v5 — Puhdas uusrakennus

import { extractFilters, filterProducts, buildDirectProductResponse } from '../lib/filters.js';
import { getProducts } from '../lib/shopify.js';
import { SYSTEM_PROMPT } from '../lib/system-prompt.js';

// ── Sessiomuisti ──────────────────────────────────────────────────────────
const sessions = new Map();
function saveSession(id, products) {
  if (!id || !products?.length) return;
  sessions.set(id, { data: products.slice(0, 5), ts: Date.now() });
}
function loadSession(id) {
  if (!id) return null;
  const e = sessions.get(id);
  if (!e || Date.now() - e.ts > 3600000) { sessions.delete(id); return null; }
  return e.data;
}

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

// ── Gemini kutsu ──────────────────────────────────────────────────────────
async function callGemini(system, msgs, apiKey, maxTokens = 1500) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: msgs,
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.0 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ── Onko tämä jatkokysymys aiemmasta tuotelistasta? ───────────────────────
// TIUKKA: jatkokysymys vain kun käyttäjä viittaa aiempaan listaan numerolla/järjestyksellä
// EI triggeroidu tavallisista suomen sanoista kuten "se", "miten", "tuo"
function detectFollowUp(msg, sessionProducts) {
  // Jos ei ole aiempaa sessiota, ei voi olla jatkokysymys
  if (!sessionProducts?.length) return false;

  const t = norm(msg);
  const ta = t.replace(/ä/g, 'a').replace(/ö/g, 'o'); // ASCII-versio

  // Uuden haun signaalit — ei ole jatkokysymys
  const isNewSearch = /etsi|etsin|suosittele|loytyykö|löytyykö|haen|sopivaa ruokaa|mita ruokaa|mitä ruokaa|nayta|näytä/.test(ta);
  if (isNewSearch) return false;

  // Uuden haun konteksti — allergeeni, ikä, rotu, kauppa viestissä
  const hasNewContext = /kana.allergi|kallergi|ei sovi|allergi|kk ikain|vuotias|pentu|seniori|peten|haukkula|zooplus|amstaff|labrador|beagle|husky/.test(ta);
  if (hasNewContext) return false;

  // Selkeät viittaukset aiempaan listaan
  const hasOrdinalRef =
    /\beka\b|\bekaan\b|\bekass|\btoka\b|\btokaan\b|\btokass|\bkolmas\b|\bkolmatt|\bensimmai|\bensimm\b|\btoinen\b|\bviime|\bvika\b|\bviimeinen/.test(ta) ||
    /\b1\.\b|\b2\.\b|\b3\.\b/.test(msg); // numerot kuten "1. tuote"

  // Suorat ainesosa/ravintoarvo kysymykset ilman uutta kontekstia
  const isNutrientQuestion =
    /paljonko rasva|paljonko proteiini|sisältääkö|sisaltaako|sopiiko|mika ero|mikä ero/.test(ta) &&
    t.split(' ').length <= 8; // lyhyt kysymys

  return hasOrdinalRef || isNutrientQuestion;
}

// ── Hae tuotteet aiemmasta historiasta ────────────────────────────────────
function getProductsFromHistory(messages, allProducts) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const c = m.content || '';

    // Hae hauku_data blokista
    const dataMatch = c.match(/<hauku_data>([\s\S]*?)<\/hauku_data>/);
    if (dataMatch) {
      try {
        const parsed = JSON.parse(dataMatch[1]);
        if (Array.isArray(parsed) && parsed.length) {
          return parsed.map(item => allProducts.find(p => norm(p.n) === norm(item.n)) || item);
        }
      } catch {}
    }

    // Fallback: etsi tuotenimet tekstistä
    if (c.includes('🛒') || c.includes('Löysin')) {
      const found = allProducts.filter(p => {
        const pn = norm(p.n);
        return pn.length > 8 && norm(c).includes(pn);
      });
      if (found.length > 0) return found.slice(0, 5);
    }
  }
  return [];
}

// ── Pääkäsittelijä ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { messages, conversationId } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });

    const apiKey = process.env.GEMINI_API_KEY;
    const allProducts = await getProducts();

    const latestMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const latestNorm = norm(latestMsg);

    // ── 1. TURVALLISUUSTARKISTUKSET ──────────────────────────────────────

    // Lääketieteellinen esto
    const medKeywords = ['munuaissairaus', 'maksasairaus', 'haimatulehdus', 'pankreatiitti',
      'diabetes', 'sydänsairaus', 'epilepsia', 'syöpä', 'kasvain', 'hypotyreoosi'];
    const allUserText = norm(messages.filter(m => m.role === 'user').map(m => m.content).join(' '));
    const medBlock = medKeywords.find(kw => allUserText.includes(kw));
    if (medBlock) {
      const reply = await callGemini(
        SYSTEM_PROMPT + '\n\n[OHJE: Koiralla on vakava sairaus. Ohjaa eläinlääkäriin. Älä suosittele ruokaa.]',
        messages.filter((m, i) => !(i === 0 && m.role === 'assistant'))
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        apiKey, 300
      );
      return res.status(200).json({ reply: reply || 'Vakavassa sairaudessa ruokavaliomuutos tehdään aina eläinlääkärin ohjauksessa.' });
    }

    // Myrkytysepäily
    if (/suklaa|ksylitoli|rusinat|viinirypäleet|sipuli söi|valkosipuli söi|myrkyty/.test(latestNorm)) {
      return res.status(200).json({ reply: '⚠️ **Mene välittömästi eläinlääkäriin.** Älä odota oireiden pahenemista.' });
    }

    // ── 2. TUNNISTA JATKOKYSYMYS ─────────────────────────────────────────
    const sessionProducts = loadSession(conversationId) || getProductsFromHistory(messages, allProducts);
    // "Miksi X?" tai "Eihän X" → asiakas kyseenalaistaa edellisen vastauksen → jatkokysymys
    const isChallengeQuestion = /^miksi|^miks|eihän|eikö|oletko varma|ei vitussa|miten niin|se on väärä|ne ei ole|nuo ei ole/.test(latestNorm);
    const isFollowUp = isChallengeQuestion || detectFollowUp(latestMsg, sessionProducts);

    if (isFollowUp && sessionProducts.length > 0) {
      // Rakenna konteksti aiemmista tuotteista
      const productContext = sessionProducts.map((p, i) => {
        let rv = p.rv || '';
        try { const x = JSON.parse(rv); rv = Array.isArray(x) ? x[0] : String(x); } catch {}
        return [
          `${i + 1}. ${p.n}`,
          p.p?.length ? `Proteiinit: ${p.p.join(', ')}` : '',
          p.rl ? `Rasvapitoisuus: ${p.rl}` : '',
          p.a ? `Ainesosat: ${p.a.substring(0, 500)}` : '',
          rv ? `Ravintoarvot: ${rv}` : '',
          p.er?.length ? `Sopii: ${p.er.join(', ')}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n---\n');

      const followUpPrompt = SYSTEM_PROMPT +
        '\n\n[JATKOKYSYMYS - ÄLÄ generoi uutta tuotelistaa]\n' +
        'Aiemmin löydetyt tuotteet (käytä vain näitä):\n' + productContext;

      const chatMsgs = messages
        .filter((m, i) => !(i === 0 && m.role === 'assistant'))
        .slice(-6)
        .map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: (m.content || '').replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }],
        }));

      const reply = await callGemini(followUpPrompt, chatMsgs, apiKey, 600);
      return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });
    }

    // ── 3. TUOTTEIDEN SUODATUS JA HAKU ───────────────────────────────────
    const filters = extractFilters(messages);

    // Tunnista brändi — EI tunnisteta "syö nyt X" tai "käyttää X" kontekstista
    // Poistetaan nykyinen ruoka lauseesta ennen bränditunnistusta
    const currentFoodCtx = latestNorm.replace(/syö\s+nyt\s+\S+(\s+\S+){0,4}|syö\s+tällä\s+hetkellä\s+\S+(\s+\S+){0,4}|käyttää\s+nyt\s+\S+(\s+\S+){0,4}|ostaa\s+nyt\s+\S+(\s+\S+){0,4}/g, ' ');
    const brandBlacklist = new Set(['hauku', 'ruokakoiralle', 'koiralle', 'koira', 'ruoka', 'peten', 'zooplus', 'haukkula']);
    const vendors = [...new Set(allProducts.map(p => norm(p.m || '')).filter(v => v.length >= 4 && !brandBlacklist.has(v)))]
      .sort((a, b) => b.length - a.length);
    for (const v of vendors) {
      const base = v.replace(/[^a-zäöå]/g, '');
      if (currentFoodCtx.includes(v) || currentFoodCtx.includes(base + 'in') || currentFoodCtx.includes(base + 'ia') ||
          currentFoodCtx.includes(base + 'lla') || currentFoodCtx.includes(base + 'sta') || currentFoodCtx.includes(base + 'n')) {
        filters.brand = v;
        break;
      }
    }

    const hasFilters = !!(
      filters.excl?.length || filters.want?.length || filters.brand ||
      filters.age || filters.size || filters.specialDiets?.length || filters.store
    );

    if (hasFilters) {
      // Brändikyselyissä: säilytä ikä/koko mutta löyhennä want/specialDiets
      const searchFilters = filters.brand
        ? { ...filters, want: [], specialDiets: [] }
        : filters;

      let matched = filterProducts(allProducts, searchFilters);

      // Jos ei tuloksia ja on erikoisruokavalio → yritä ilman sitä
      if (matched.length === 0 && filters.specialDiets?.length > 0) {
        matched = filterProducts(allProducts, { ...searchFilters, specialDiets: [] });
      }

      // Brändi löytyy mutta allergeeni blokkaa
      if (matched.length === 0 && filters.brand) {
        const bNorm = norm(filters.brand);
        const brandExists = allProducts.some(p => norm(p.m || '').includes(bNorm));
        const brandName = filters.brand.charAt(0).toUpperCase() + filters.brand.slice(1);
        if (brandExists && filters.excl?.length) {
          return res.status(200).json({
            reply: `${brandName}-tuotteita löytyy valikoimastamme, mutta ne sisältävät koirallesi sopimattoman ainesosan (${filters.excl.join(', ')}). Voisin etsiä muita merkkejä?`
          });
        }
        if (!brandExists) {
          return res.status(200).json({ reply: `${brandName}-merkkiä ei löydy valikoimastamme.` });
        }
      }

      if (matched.length === 0) {
        return res.status(200).json({ reply: 'Valikoimastamme ei löydy näillä kriteereillä sopivia tuotteita. Haluatko kokeilla löyhemmillä rajoituksilla?' });
      }

      // Backend rakentaa tuotelistan — 100% Shopify-data
      const productList = buildDirectProductResponse(matched, filters);

      // Gemini kirjoittaa lyhyen intron
      const storeLabel = { petenkoiratarvike: 'Peten Koiratarvike', haukkula: 'Koiratarvike Haukkula', zooplus: 'Zooplus' };
      const ctxParts = [];
      if (filters.store) ctxParts.push(`kauppa: ${storeLabel[filters.store] || filters.store}`);
      if (filters.age) ctxParts.push(`ikä: ${filters.age}`);
      if (filters.size) ctxParts.push(`koko: ${filters.size}`);
      if (filters.excl?.length) ctxParts.push(`ei: ${filters.excl.join(', ')}`);

      let intro = '';
      try {
        const introRes = await callGemini(
          'Olet Hauku. Kirjoita 1 lyhyt lause suomeksi. ÄLÄ aloita "Hienoa", "Loistava" tai muulla ylistyksellä. ÄLÄ mainitse tuotenimiä, brändejä tai ravintoarvoja. Palauta VAIN JSON: {"intro":"lause tähän"}',
          [{ role: 'user', parts: [{ text: `${matched.length} sopivaa tuotetta löytyi. ${ctxParts.join(', ')}` }] }],
          apiKey, 100
        );
        const clean = introRes.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (typeof parsed.intro === 'string' && parsed.intro.length > 5) intro = parsed.intro;
      } catch {}

      // Tallenna sessio jatkokysymyksiä varten
      const sessionData = matched.slice(0, 5).map(p => ({
        n: p.n, m: p.m, p: p.p,
        a: (p.a || '').substring(0, 600),
        rv: (() => { try { const r = JSON.parse(p.rv || ''); return Array.isArray(r) ? r[0] : String(r); } catch { return p.rv || ''; } })(),
        er: p.er || [], rl: p.rl || '', v: (p.v || []).slice(0, 20),
      }));
      if (conversationId) saveSession(conversationId, sessionData);

      const hiddenData = '\n<hauku_data>' + JSON.stringify(sessionData) + '</hauku_data>';
      const reply = (intro ? intro + '\n\n' : '') + productList + hiddenData;
      return res.status(200).json({ reply });
    }

    // ── 4. YLEINEN KOIRAKYSYMYS ───────────────────────────────────────────
    const generalPrompt = SYSTEM_PROMPT +
      `\n\n[Valikoimassa ${allProducts.length} tuotetta. Kysy koiran tiedot ennen tuotesuosituksia.]`;

    const chatMsgs = messages
      .filter((m, i) => !(i === 0 && m.role === 'assistant'))
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: (m.content || '').replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }],
      }));

    const reply = await callGemini(generalPrompt, chatMsgs, apiKey);
    return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });

  } catch (err) {
    console.error('Hauku error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
