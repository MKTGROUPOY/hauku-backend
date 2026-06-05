// api/chat.js — Hauku v6 — JSON-tietokanta

import { extractFilters, filterProducts, buildDirectProductResponse } from '../lib/filters.js';
import { getProducts } from '../lib/products.js';
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

// ── Onko jatkokysymys? ────────────────────────────────────────────────────
// Vain selkeät viittaukset aiempiin tuotteisiin — ei tavalliset suomen sanat
function detectFollowUp(msg, sessionProducts) {
  if (!sessionProducts?.length) return false;
  const t = norm(msg);

  // Uuden haun signaalit ohittavat follow-up tunnistuksen
  if (/etsi|etsin|suosittele|löytyykö|loytyykö|haen|sopivaa ruokaa|mita ruokaa/.test(t)) return false;

  // Uutta tietoa koirasta = uusi haku
  if (/kk ikain|vuotias|pentu|seniori|peten|haukkula|zooplus|allergi|kana|nauta|lammas|kala/.test(t)) return false;

  // Selkeät viittaukset aiempaan listaan
  const hasRef =
    /\beka\b|\btoka\b|\bkolmas\b|\bensimmäinen\b|\btoinen\b|\bviimeinen\b/.test(t) ||
    /\b1\.\b|\b2\.\b|\b3\.\b/.test(msg) ||
    (/paljonko|sisältääkö|sopiiko|mikä ero|miten ero/.test(t) && t.split(' ').length <= 8);

  // Kyseenalaistaa tai kysyy edellisestä vastauksesta
  const isChallenge = /^miksi|^miks|eihän|eikö|oletko varma|ne on väärä|nuo ei|mitä tarkoitat|mita tarkoitat|mitä se|mita se|selitä|selita/.test(t);

  return hasRef || isChallenge;
}

// ── Etsi aiemmat tuotteet historiasta ────────────────────────────────────
function getProductsFromHistory(messages, allProducts) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content || '';
    if (messages[i].role !== 'assistant') continue;
    const dataMatch = c.match(/<hauku_data>([\s\S]*?)<\/hauku_data>/);
    if (dataMatch) {
      try {
        const parsed = JSON.parse(dataMatch[1]);
        if (Array.isArray(parsed) && parsed.length) {
          return parsed.map(item =>
            allProducts.find(p => norm(p.nimi) === norm(item.nimi)) || item
          );
        }
      } catch {}
    }
    if (c.includes('Löysin') && c.includes('**')) {
      const found = allProducts.filter(p =>
        p.nimi.length > 5 && c.includes(p.nimi)
      );
      if (found.length) return found.slice(0, 5);
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
    const { messages, conversationId, preFilters } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });

    const apiKey = process.env.GEMINI_API_KEY;
    const allProducts = getProducts();
    const latestMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const latestNorm = norm(latestMsg);

    // ── 1. TURVALLISUUSTARKISTUKSET ──────────────────────────────────────
    if (/munuaissairaus|maksasairaus|haimatulehdus|pankreatiitti|diabetes|sydänsairaus|epilepsia|syöpä|kasvain/.test(latestNorm)) {
      return res.status(200).json({
        reply: 'Vakavassa sairaudessa ruokavaliomuutos tehdään aina eläinlääkärin ohjauksessa. En voi antaa ruokasuosituksia ilman eläinlääkärin arviota.'
      });
    }
    if (/suklaa|ksylitoli|rusinat|viinirypäleet|sipuli söi|valkosipuli söi/.test(latestNorm)) {
      return res.status(200).json({ reply: '⚠️ **Mene välittömästi eläinlääkäriin.** Älä odota oireiden pahenemista.' });
    }

    // ── 2. JATKOKYSYMYS ──────────────────────────────────────────────────
    const sessionProducts = loadSession(conversationId) || getProductsFromHistory(messages, allProducts);
    if (detectFollowUp(latestMsg, sessionProducts)) {
      const ctx = sessionProducts.map((p, i) =>
        `${i + 1}. ${p.nimi} | Rasva: ${p.rasva || '-'} | Erikois: ${(p.erikois || []).join(', ') || '-'}`
      ).join('\n');

      const followUpPrompt = SYSTEM_PROMPT +
        '\n\n[JATKOKYSYMYS — vastaa lyhyesti, ÄLÄ generoi uutta tuotelistaa]\nAiemmin löydetyt tuotteet:\n' + ctx;

      const reply = await callGemini(
        followUpPrompt,
        messages.filter((m, i) => !(i === 0 && m.role === 'assistant')).slice(-6)
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: (m.content || '').replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }] })),
        apiKey, 600
      );
      return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });
    }

    // ── 4. SUODATUS JA TUOTEHAKU ─────────────────────────────────────────
    // Yhdistä pre-set (ohjattu flow) + extractFilters (käyttäjäteksti)
    const extracted = extractFilters(messages);
    const pre = preFilters || {};
    const filters = {
      ...extracted,
      age:   pre.age   || extracted.age,
      store: pre.store || extracted.store,
      size:  pre.size  || extracted.size,
      excl:  (pre.excl?.length ? pre.excl : null) || extracted.excl,
      brand: null,
    };

    const hasFilters = !!(
      filters.excl?.length || filters.age || filters.size ||
      filters.store || filters.specialDiets?.length
    );

    if (hasFilters) {
      let matched = filterProducts(allProducts, filters);

      // Fallback: jos ei tuloksia, löyhennä erikoisruokavalioita
      if (matched.length === 0 && filters.specialDiets?.length) {
        matched = filterProducts(allProducts, { ...filters, specialDiets: [] });
      }

      if (matched.length === 0) {
        return res.status(200).json({
          reply: 'Näillä kriteereillä ei löydy sopivia tuotteita valikoimastamme. Haluatko kokeilla löyhemmillä rajoituksilla?'
        });
      }

      const productList = buildDirectProductResponse(matched, filters);

      // Gemini kirjoittaa lyhyen intron
      let intro = '';
      try {
        const introRes = await callGemini(
          'Olet Hauku. Kirjoita YKSI lyhyt lause suomeksi löydetyistä tuotteista. ÄLÄ aloita "Hienoa" tai ylistyssanoilla. ÄLÄ mainitse tuotenimiä. Palauta VAIN JSON: {"intro":"lause"}',
          [{ role: 'user', parts: [{ text: `${matched.length} sopivaa tuotetta löytyi.` }] }],
          apiKey, 80
        );
        const clean = introRes.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (parsed.intro?.length > 5) intro = parsed.intro;
      } catch {}

      // Tallenna sessio
      const sessionData = matched.slice(0, 5).map(p => ({
        nimi: p.nimi, rasva: p.rasva, erikois: p.erikois?.slice(0, 4), linkki: p.linkki,
      }));
      if (conversationId) saveSession(conversationId, sessionData);

      const hidden = '\n<hauku_data>' + JSON.stringify(sessionData) + '</hauku_data>';
      return res.status(200).json({ reply: (intro ? intro + '\n\n' : '') + productList + hidden });
    }

    // ── 5. YLEINEN KOIRAKYSYMYS ───────────────────────────────────────────
    const reply = await callGemini(
      SYSTEM_PROMPT + `\n\n[Valikoimassa ${allProducts.length} tuotetta. Kysy koiran tiedot ennen suosituksia.]`,
      messages.filter((m, i) => !(i === 0 && m.role === 'assistant'))
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: (m.content || '').replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }] })),
      apiKey
    );
    return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });

  } catch (err) {
    console.error('Hauku error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
