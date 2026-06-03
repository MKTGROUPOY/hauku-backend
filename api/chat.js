// api/chat.js — Hauku backend v4 (Vercel serverless)

import { extractFilters, filterProducts, buildProductContext, buildDirectProductResponse } from '../lib/filters.js';

// Inline sessiomuisti — ei erillistä importtia
const _sessions = new Map();
const _SESSION_TTL = 60 * 60 * 1000;
async function saveSession(id, products) {
  if (!id || !products?.length) return;
  _sessions.set(id, { data: products.slice(0, 5), ts: Date.now() });
}
async function loadSession(id) {
  if (!id) return null;
  const e = _sessions.get(id);
  if (!e) return null;
  if (Date.now() - e.ts > _SESSION_TTL) { _sessions.delete(id); return null; }
  return e.data;
}
import { getProducts } from '../lib/shopify.js';
import { SYSTEM_PROMPT as HARDCODED_PROMPT } from '../lib/system-prompt.js';

function norm(s) {
  return s.toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

// ── Gemini API ───────────────────────────────────────────────────────────
async function callGemini(systemPrompt, messages, apiKey, maxTokens = 2048) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: messages,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.0 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ── Diagnostiset kysymykset ──────────────────────────────────────────────
function detectDiagnosticQuestion(messages) {
  const t = (messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '').toLowerCase();
  const isDiag = /miksi|mistä johtuu|mitä tarkoittaa|onko normaalia|voiko koira|onko vaarall|syö ruohoa|nuolee|raapii|oksentaa|ripuli|kutisee|aivastaa|yskii|hengittää|juoksuttaa|korvat haisee|täit|kirput|madot|loiset|miten.*ruokinta/.test(t);
  const hasBuy = /sopii|suosittele|etsin|löytyykö|mikä ruoka|mitä ruokaa|ostan|haen/.test(t);
  return isDiag && !hasBuy;
}

// ── Hintakysymykset ──────────────────────────────────────────────────────
function detectPriceQuestion(messages) {
  const t = (messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '').toLowerCase();
  return /edullisi|edullinen|halvin|halvempi|hinta|hinnat|paljonko.*maks|mitä maksaa|paljonko maksaa/.test(t);
}

// ── Lääketieteelliset estot ──────────────────────────────────────────────
const MEDICAL_BLOCKS = ['munuain', 'munuais', 'maksan vajaa', 'hepatic', 'haimatuleh', 'pankreatiit', 'diabetes', 'sydänsaira', 'epilepsi', 'kasvain', 'syöpä', 'hypotyreoosi', 'cushingin'];

function detectMedicalBlock(messages) {
  const allText = norm(messages.filter(m => m.role === 'user').map(m => m.content).join(' '));
  return MEDICAL_BLOCKS.find(kw => allText.includes(kw)) || null;
}

// ── KORJAUS 3: Context Locking (ketjutetut jatkokysymykset) ─────────────────
// Skannaa historiaa TAAKSEPÄIN → etsi ensimmäinen viesti jossa on tuotelista
// Näin konteksti säilyy vaikka käyttäjä kysyy viisi jatkokysymystä putkeen
function extractProductsFromLastAssistant(messages, allProducts) {
  // Prioriteetti 1: hauku_data-blokki (luotettavin lähde)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const content = m.content || '';
    if (content.includes('<hauku_data>')) {
      const match = content.match(/<hauku_data>([\s\S]*?)<\/hauku_data>/);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // Hae täysi data Shopifysta tuotenimillä
            const found = [];
            for (const item of parsed) {
              const fullProduct = allProducts.find(p => norm(p.n) === norm(item.n || ''));
              found.push(fullProduct || item); // fallback: käytä hauku_data:n tietoja
            }
            return found.filter(Boolean).slice(0, 5);
          }
        } catch {}
      }
    }
  }

  // Prioriteetti 2: Skannaa taaksepäin → etsi viesti jossa on tuotelista
  // Tunnistetaan tuotelista: sisältää "Löysin" tai "🛒" (ostolinkkiä)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const content = m.content || '';

    const isProductList = content.includes('Löysin') || content.includes('löysin') ||
      content.includes('🛒') || content.includes('sopivaa tuotetta');
    if (!isProductList) continue;

    const cleanedContent = content.replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '');

    // Poimi tuotenimet riveiltä jotka edeltävät "Proteiinit:" tai "Rasvapitoisuus:" tai "🛒"
    const productNames = [];
    const lines = cleanedContent.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      const nextLine = lines[j + 1] || '';
      // Tuotenimi on rivillä jota seuraa proteiini/rasvapitoisuus/ostolinkki-rivi
      if (/Proteiinit:|Rasvapitoisuus:|🛒/.test(nextLine)) {
        // Poista markdown-muotoilu (**tuotenimi**)
        const name = line.replace(/\*\*/g, '').trim();
        if (name.length >= 5) productNames.push(name);
      }
    }

    // Hae täsmälliset tuotteet Shopifysta nimillä
    const found = [];
    for (const name of productNames) {
      const nameNorm = norm(name);
      const match = allProducts.find(p => norm(p.n || '') === nameNorm);
      if (match) found.push(match);
    }

    // Fallback: skannaa koko teksti tuotenimillä
    if (found.length === 0) {
      const contentNorm = norm(cleanedContent);
      for (const p of allProducts) {
        const pNorm = norm(p.n || '');
        if (pNorm.length >= 10 && contentNorm.includes(pNorm)) found.push(p);
      }
      found.sort((a, b) => norm(cleanedContent).indexOf(norm(a.n)) - norm(cleanedContent).indexOf(norm(b.n)));
    }

    if (found.length > 0) return found.slice(0, 5);
  }

  return [];
}

// ── KORJAUS 2: Follow-up tunnistus ──────────────────────────────────────
// KRIITTINEN: Follow-up tunnistus — \b ei toimi suomen ä/ö kanssa, käytetään norm()+padding
function detectFollowUp(latestUserMsg) {
  const t = norm(latestUserMsg);

  // Selkeät UUDEN HAUN signaalit — ohittavat follow-upin
  const isNewSearch = /loytyykö|etsi |suosittele|nayta|hae |mita ruokaa|sopivaa ruokaa|onko teilla|vaihtoehto.{0,20}allergi/.test(t);
  if (isNewSearch) return false;

  // Padding-tekniikka + ASCII-normalisointi ä→a, ö→o (\b ei toimi ä:n kanssa)
  const tAscii = t.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/å/g, 'a');
  const p = ' ' + tAscii + ' ';
  const REFS = [
    ' eka ',' toka ',' kolmas ',' neljas ',' viides ',' vika ',
    ' ensimmainen ',' toinen ',
    ' tuossa ',' tuohon ',' tassa ',' tahan ',' siina ',' siihen ',' siita ',' silla ',
    ' niissa ',' noissa ',' naissa ',' niilla ',' niilta ',' niista ',
    ' enta ',' entas ',' miten ',' mites ',' kuinka ',
    ' tuo ',' tama '
  ];
  const hasRef = REFS.some(w => p.includes(w));
  // Stem + lyhyet jatkokysymykset (esim. 'Kuinka paljon?', 'Entäs?')
  const ordinalStems = ['eka', 'toka', 'kolma', 'viime', 'vika', 'toinen', 'ensimmai'];
  const hasOrdinalStem = tAscii.split(' ').some(word => ordinalStems.some(stem => word.startsWith(stem) && word.length > stem.length));
  const startsFollowUp = /^(enta|miten|mites|entas|kuinka)[ ,!?]/.test(tAscii);
  // 'enemmän' on vertailu vain vertailukontekstissa, ei 'kerro enemmän' -fraasissa
  const isComparison = /kummassa|kumpi|vahemman|parempi|vertaa/.test(tAscii) ||
    (/enemman|vahemman/.test(tAscii) && !/kertoa|kerro|tietoa|lisaa/.test(tAscii));
  const isShortFollowUp = tAscii.split(' ').filter(Boolean).length <= 3 && /^(kuinka|mika|miten|onko|sopiiko)/.test(tAscii);

  return hasRef || hasOrdinalStem || startsFollowUp || isComparison || isShortFollowUp;
}

function resolveOrdinalProduct(text, prods) {
  if (!prods?.length) return null;
  const tRaw = norm(text);
  const t = ' ' + tRaw.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/å/g, 'a') + ' ';
  if (/ eka | ensimm | yks /.test(t)) return prods[0];
  if (/ toka | toinen | toisess|toiseen/.test(t)) return prods[1] || null;
  if (/ kolm/.test(t)) return prods[2] || null;
  if (/ nelj/.test(t)) return prods[3] || null;
  if (/ viid/.test(t)) return prods[4] || null;
  if (/ vik[ao]| viimei/.test(t)) return prods[prods.length - 1];
  return null;
}

// ── Pääkäsittelijä ───────────────────────────────────────────────────────
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
    const products = await getProducts();
    const latestUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const latestUserNorm = norm(latestUserMsg);

    // ══════════════════════════════════════════════════════════════════════
    // KILL SWITCH — JATKOKYSYMYSLUKKO
    // Jos isFollowUp = true, extractFilters ja filterProducts EIVÄT AJA
    // ══════════════════════════════════════════════════════════════════════

    // Kapea isNewSearch: vain eksplisiittiset uudet haut
    const isNewSearch = /(etsin\b|näytä|suosittele|mitä löytyy|mita loytyy|vaihtoehtoja|uusi haku|löytyykö|loytyykö|etsi ruokaa|onko teillä.*ruokaa)/i.test(latestUserMsg);

    // Laaja isFollowUp: ASCII-normalisointi + alkuperäinen teksti (ä/ö ongelma kierretty)
    const _ua = latestUserMsg.toLowerCase().replace(/ä/g,'a').replace(/ö/g,'o').replace(/å/g,'a');
    const isFollowUp = !isNewSearch && (
      /\b(eka|ekassa|ekaan|ekalla|toka|tokassa|tokaan|kolmas|vika|vikassa|ensimmainen|toinen|toisessa|tuossa|tassa|siina|niissa|noissa|tuo|tama|se|enta|miten|mites|sisaltaako|sisaltaa|entas)\b/.test(_ua) ||
      /\b(ensimmäinen|tässä|siinä|näissä|niissä|entä|sisältääkö|tämä)\b/i.test(latestUserMsg) ||
      (/kummassa|kumpi|vahemman|vähemmän|parempi|vertaa/.test(_ua) || (/enemman|vahemman/.test(_ua) && !/kertoa|kerro|tietoa|lisaa/.test(_ua)))
    );

    if (isFollowUp) {
      // ══ PUHDAS KONTEKSTIRUISKUTUS ══════════════════════════════════════
      // filterProducts() ja extractFilters() EIVÄT AJA tässä haarassa

      // 1. Yritä ladata sessio Vercel KV:sta (luotettavin lähde)
      let sessionProducts = conversationId ? await loadSession(conversationId) : null;
      let enriched = [];
      let listedNames = [];

      if (sessionProducts?.length > 0) {
        // KV löytyi — käytä suoraan
        listedNames = sessionProducts.map(p => p.n);
        enriched = sessionProducts.map(p => {
          let rv = p.rv || '';
          try { const x = JSON.parse(rv); rv = Array.isArray(x) ? x[0] : String(x); } catch {}
          rv = rv.replace(/^\["|"\]$/g, '').trim();
          return [
            `Tuote: ${p.n}`,
            p.p?.length  ? `Proteiinit: ${p.p.join(', ')}` : '',
            p.rl         ? `Rasvapitoisuus: ${p.rl}` : '',
            p.a          ? `Ainesosat: ${p.a}` : '',
            rv           ? `Ravintoarvot: ${rv}` : '',
            p.er?.length ? `Sopii: ${p.er.join(', ')}` : '',
          ].filter(Boolean).join('\n');
        });
      } else {
        // KV ei saatavilla tai tyhjä → skannaa historia (fallback)
        let productListText = '';
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role !== 'assistant') continue;
          const c = (m.content || '').replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '');
          if (c.includes('Löysin') || c.includes('löysin') || c.includes('🛒')) {
            productListText = c.trim(); break;
          }
        }
        productListText.split('\n').forEach((line, i, arr) => {
          const next = (arr[i + 1] || '').toLowerCase();
          if (/proteiinit:|rasvapitoisuus:|🛒/.test(next)) {
            const name = line.replace(/\*\*/g, '').trim();
            if (name.length >= 5) listedNames.push(name);
          }
        });
        enriched = listedNames.map(name => {
          const nameLow = name.toLowerCase();
          const p = products.find(prod =>
            nameLow.includes((prod.n || '').toLowerCase()) ||
            (prod.n || '').toLowerCase().includes(nameLow)
          );
          if (!p) return `Tuote: ${name}`;
          let rv = p.rv || '';
          try { const x = JSON.parse(rv); rv = Array.isArray(x) ? x[0] : String(x); } catch {}
          rv = rv.replace(/^\["|"\]$/g, '').trim();
          return [
            `Tuote: ${p.n}`,
            p.p?.length  ? `Proteiinit: ${p.p.join(', ')}` : '',
            p.rl         ? `Rasvapitoisuus: ${p.rl}` : '',
            p.a          ? `Ainesosat: ${p.a}` : '',
            rv           ? `Ravintoarvot: ${rv}` : '',
            p.er?.length ? `Sopii: ${p.er.join(', ')}` : '',
          ].filter(Boolean).join('\n');
        });
      }

      // Numeroitu järjestys
      const numberedList = listedNames.map((n, i) =>
        `${i + 1} = ${n} (eka=1, toka=2, kolmas=3, vika=viimeinen)`
      ).join('\n');

      const contextBlock =
        '\n\n[KONTEKSTI — käytä vain tätä, älä etsi tietokannasta]\n' +
        (enriched.length > 0
          ? 'TUOTTEIDEN TÄYDET TIEDOT:\n' + enriched.join('\n---\n') + '\n'
          : '[Ei tuotedataa — vastaa keskusteluhistorian perusteella]\n') +
        (numberedList ? '\nJÄRJESTYS: ' + numberedList + '\n' : '');

      const followUpSystemPrompt = (HARDCODED_PROMPT || '') +
        '\n\nJATKOKYSYMYS:\n' +
        '- ÄLÄ generoi uutta tuotelistaa\n' +
        '- ÄLÄ pahoittele\n' +
        '- Vastaa pelkästään yllä olevan kontekstin ja keskusteluhistorian perusteella\n' +
        '- Jos tieto puuttuu kontekstista, kerro se suoraan ja kehota tarkistamaan pakkaus\n' +
        contextBlock;

      const chatHistory = messages
        .filter((m, i) => !(i === 0 && m.role === 'assistant'))
        .slice(-8)
        .map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: (m.content || '').replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }],
        }));

      const reply = await callGemini(followUpSystemPrompt, chatHistory, apiKey, 800);
      return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });
    }

    // ── INTERCEPTORIT ────────────────────────────────────────────────────
    // Diagnostinen kysymys
    if (detectDiagnosticQuestion(messages)) {
      const diagPrompt = (HARDCODED_PROMPT || '') + '\n\n[OHJE: Vastaa asiantuntijana koiran terveydestä. ÄLÄ suosittele tuotteita ellei asiakas pyydä.]';
      const filteredMsgs = messages.filter((m, i) => !(i === 0 && m.role === 'assistant'))
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const reply = await callGemini(diagPrompt, filteredMsgs, apiKey, 1500);
      return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });
    }

    // Hintakysymys
    if (detectPriceQuestion(messages)) {
      return res.status(200).json({ reply: 'Palvelussamme ei ole hintatietoja. Näet hinnat suoraan ostolinkistä verkkokauppaan.' });
    }

    // Lääketieteellinen esto
    const medicalBlock = detectMedicalBlock(messages);
    if (medicalBlock) {
      const medPrompt = (HARDCODED_PROMPT || '') + `\n\n[ESTO: Sairaus (${medicalBlock}). Ohjaa eläinlääkäriin. Ei tuotelistoja.]`;
      const filteredMsgs = messages.filter((m, i) => !(i === 0 && m.role === 'assistant'))
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const reply = await callGemini(medPrompt, filteredMsgs, apiKey, 400);
      return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });
    }

    // ── BRÄNDITUNNISTUS ──────────────────────────────────────────────────
    const filters = extractFilters(messages);
    if (products.length > 0) {
      const BLACKLIST = ['hauku', 'ruokakoiralle', 'koiralle', 'koira', 'ruoka', 'peten', 'zooplus', 'haukkula'];
      const vendors = [...new Set(products.map(p => norm(p.m || '')).filter(v => v.length >= 4 && !BLACKLIST.includes(v)))].sort((a, b) => b.length - a.length);
      let detectedBrand = null;
      for (const vendor of vendors) {
        const base = vendor.replace(/[^a-zäöå]/g, '');
        const directMatch = latestUserNorm.includes(vendor) ||
          latestUserNorm.includes(base + 'in') || latestUserNorm.includes(base + 'ia') ||
          latestUserNorm.includes(base + 'lla') || latestUserNorm.includes(base + 'sta') || latestUserNorm.includes(base + 'n');
        const prefixLen = Math.max(5, base.length - 2);
        const prefixMatch = base.length >= 5 && latestUserNorm.split(' ').some(w => w.length >= prefixLen && base.startsWith(w.substring(0, prefixLen)));
        if (directMatch || prefixMatch) { detectedBrand = vendor; break; }
      }
      filters.brand = detectedBrand;

      if (detectedBrand && /vai|vs|versus|vertaa/.test(latestUserNorm)) {
        for (const vendor of vendors) {
          if (vendor === detectedBrand) continue;
          const base2 = vendor.replace(/[^a-zäöå]/g, '');
          if (latestUserNorm.includes(vendor) || latestUserNorm.includes(base2 + 'in') || latestUserNorm.includes(base2 + 'ia') || latestUserNorm.includes(base2 + 'lla') || latestUserNorm.includes(base2 + 'sta')) {
            filters.brand2 = vendor; break;
          }
        }
      }
    }

    // ── TUOTEMÄÄRÄ & DOUBT ───────────────────────────────────────────────
    const isProductQuestion = /raakaproteiini|ainesosa|sisältää|rasvapitoisuus|ravintoarvo|paljonko.*ruoassa|sopii|minkä ikä|minkä koko/.test(latestUserNorm);

    // Doubt: asiakas kyseenalaistaa tuotemäärän
    const doubtQuestion = !isProductQuestion && (
      /eik[öo]|oletko varma|todellakin|onhan.*enemmän|kyll[äa] on|on niit[äa]|pitäisi olla|ei ole niin|ei vitussa/.test(latestUserNorm) ||
      /en usko.*tuotett|en usko.*merkk|sekoilet|väärää tietoa|ei täsmää|ei pidä paikk/.test(latestUserNorm) ||
      /olin katsovinani|mielestäni.*enemmän|pitäisi olla enemmän/.test(latestUserNorm)
    );

    if (doubtQuestion) {
      const BLACKLIST2 = ['hauku', 'ruokakoiralle', 'koiralle', 'koira', 'ruoka', 'peten', 'zooplus', 'haukkula'];
      const vendors2 = [...new Set(products.map(p => norm(p.m || '')).filter(v => v.length >= 4 && !BLACKLIST2.includes(v)))].sort((a,b) => b.length - a.length);
      let doubtBrand = filters.brand;
      if (!doubtBrand) {
        const recentUserText = norm(messages.filter(m => m.role === 'user').slice(-3).map(m => m.content).join(' '));
        for (const v of vendors2) {
          const base = v.replace(/[^a-zäöå]/g, '');
          if (recentUserText.includes(v) || recentUserText.includes(base + 'in') || recentUserText.includes(base + 'n')) { doubtBrand = v; break; }
        }
      }
      if (!doubtBrand) {
        const lastAssist = messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
        const assistMatches = vendors2.filter(v => norm(lastAssist).includes(v));
        if (assistMatches.length === 1) doubtBrand = assistMatches[0];
      }
      if (doubtBrand) {
        const bNorm2 = norm(doubtBrand);
        const brandCount = products.filter(p => (p.l || p.l2 || p.l3) && (norm(p.m || '').includes(bNorm2) || norm(p.n || '').includes(bNorm2))).length;
        const brandDisplay2 = doubtBrand.charAt(0).toUpperCase() + doubtBrand.slice(1);
        if (brandCount === 0) return res.status(200).json({ reply: `${brandDisplay2}-tuotteita ei löydy valikoimastamme.` });
        return res.status(200).json({ reply: `Tietokantamme mukaan valikoimassamme on **tasan ${brandCount}** ${brandDisplay2}-tuotetta. Tämä luku tulee suoraan Shopify-tietokannastamme.` });
      }
    }

    // Tuotemäärä
    let countBrand = filters.brand;
    if (!countBrand && /montako|kuinka monta|paljonko.*tuotett/.test(latestUserNorm)) {
      const BLACKLIST3 = ['hauku', 'ruokakoiralle', 'koiralle', 'koira', 'ruoka', 'peten', 'zooplus', 'haukkula'];
      const vendors3 = [...new Set(products.map(p => norm(p.m || '')).filter(v => v.length >= 4 && !BLACKLIST3.includes(v)))].sort((a,b) => b.length - a.length);
      const recentUserText2 = norm(messages.filter(m => m.role === 'user').slice(-3).map(m => m.content).join(' '));
      for (const v of vendors3) {
        const base2 = v.replace(/[^a-zäöå]/g, '');
        if (recentUserText2.includes(v) || recentUserText2.includes(base2 + 'in') || recentUserText2.includes(base2 + 'ia') || recentUserText2.includes(base2 + 'n')) { countBrand = v; break; }
      }
    }
    if (/montako|kuinka monta|paljonko.*tuotett/.test(latestUserNorm) && countBrand) {
      const bNorm = norm(countBrand);
      const brandProducts = products.filter(p => {
        if (!p.l && !p.l2 && !p.l3) return false;
        if (norm(p.m || '').includes(bNorm)) return true;
        if (norm(p.n || '').includes(bNorm)) return true;
        const firstWord = norm(p.n || '').split(' ')[0];
        return firstWord.length >= 4 && bNorm.includes(firstWord);
      });
      const brandDisplay = countBrand.charAt(0).toUpperCase() + countBrand.slice(1);
      if (brandProducts.length === 0) return res.status(200).json({ reply: `${brandDisplay}-tuotteita ei löydy valikoimastamme.` });
      return res.status(200).json({ reply: `Valikoimassamme on tällä hetkellä **${brandProducts.length}** ${brandDisplay}-tuotetta.` });
    }

    // ── TUOTESUODATUS ────────────────────────────────────────────────────
    const lastUserText = norm(latestUserMsg);
    const lastAssistantText = norm(messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content?.replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') || '');
    const searchText = lastUserText + ' ' + lastAssistantText;
    let exactProduct = null;
    let exactProducts = [];
    for (const p of products) {
      const pNorm = norm(p.n || '');
      if (pNorm.length >= 10 && searchText.includes(pNorm)) {
        exactProducts.push(p);
        if (!exactProduct || pNorm.length > norm(exactProduct.n).length) exactProduct = p;
      }
    }

    // Tunnista "kerro enemmän X-ruoasta" -kysymykset → hae paras osuma, älä listaa kaikkia
    // Tunnista "kerro enemmän / kertoa lisää X-ruoasta" → yksittäisen tuotteen tiedot
    const INFO_STOP = ['kertoa','kerro','lisaa','tietoa','tietoja','osaatko','ruoasta',
                       'ruoalle','enemmän','enemman','paljon','paljonko','mita','mitä'];
    const isInfoRequest = /kertoa|kerro|lisaa|tietoa|osaatko|enemman|enemmän/.test(latestUserNorm);
    if (isInfoRequest) {
      // Etsi paras osuma SUORAAN tuotenimistä — ei riipu filters.brand-arvosta
      const infoWords = latestUserNorm.split(' ').filter(w => w.length >= 4 && !INFO_STOP.includes(w));
      if (infoWords.length >= 1) {
        const scoredAll = products
          .filter(p => p.l || p.l2 || p.l3)
          .map(p => {
            const pn = norm(p.n || '');
            const score = infoWords.filter(w => pn.includes(w)).length;
            return { p, score };
          })
          .filter(x => x.score >= Math.min(2, infoWords.length))
          .sort((a, b) => b.score - a.score);

        if (scoredAll.length > 0) {
          const bestMatch = scoredAll[0].p;
          const ctx = buildProductContext([bestMatch], {});

          // Lisää allergeenivaroitus jos tuote sisältää poissuljetun ainesosan
          let allergenWarning = '';
          if (filters.excl.length > 0) {
            const pAinesosat = (bestMatch.a || '').toLowerCase();
            const foundExcl = filters.excl.filter(e => pAinesosat.includes(e.toLowerCase()));
            if (foundExcl.length > 0) {
              allergenWarning = '\n\n⚠️ HUOM: Tämä tuote sisältää koirallesi sopimattoman ainesosan: ' + foundExcl.join(', ') + '. Tuote ei sovi allergeenirajoituksillesi.';
            }
          }

          const infoPrompt = (HARDCODED_PROMPT || '') +
            '\n\nKäyttäjä kysyy lisätietoja tästä tuotteesta. Anna kattava kuvaus: ainesosat, ravintoarvot, kenelle sopii.\n' +
            'ÄLÄ generoi tuotelistaa. Kerro vain tästä yhdestä tuotteesta.\n' + ctx;
          const chatHistory = messages
            .filter((m, i) => !(i === 0 && m.role === 'assistant'))
            .slice(-4)
            .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content.replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }] }));
          const reply = await callGemini(infoPrompt, chatHistory, apiKey, 1000);
          return res.status(200).json({ reply: (reply || 'Yritä uudelleen.') + allergenWarning });
        }
      }
    }

    const hasFilters = !!(filters.excl.length || filters.want.length || filters.brand || filters.age || filters.size || filters.specialDiets?.length || filters.store || exactProduct);

    // Kun käyttäjä kysyy nimetystä tuotteesta tai brändistä suoraan → ohita want-filtteri
    // "kerro Grandorf Lammas -ruoasta" ei saa epäonnistua vaikka want=['Nauta']
    // Brändikyselyissä käyttäjä haluaa KAIKKI brändin tuotteet, ei vain aiemman proteiinisuodatuksen mukaiset
    const isBrandOrProductQuery = !!(exactProduct || filters.brand);
    const filtersForSearch = isBrandOrProductQuery
      ? { ...filters, want: [], specialDiets: [], size: null, age: null }
      : filters;

    let matched = hasFilters ? filterProducts(products, filtersForSearch) : [];

    if (filters.brand2) {
      const matched2 = filterProducts(products, { ...filters, brand: filters.brand2 });
      matched = [...matched.slice(0, 5), ...matched2.slice(0, 5)];
    }

    // Jos exactProduct löytyi → nosta se listan kärkeen
    if (exactProducts.length > 0) {
      const exactNotInMatched = exactProducts.filter(p => !matched.some(m => m.n === p.n));
      if (exactNotInMatched.length > 0) {
        matched = [...exactNotInMatched, ...matched.filter(p => !exactNotInMatched.find(ep => ep.n === p.n)).slice(0, 4)];
      } else {
        const rest = matched.filter(p => !exactProducts.find(ep => ep.n === p.n)).slice(0, 4);
        matched = [...exactProducts, ...rest];
      }
    }

    console.log('filters:', JSON.stringify({ excl: filters.excl, store: filters.store, brand: filters.brand, size: filters.size }));
    console.log('matched:', matched.length);

    // ── REITTI A: TUOTEHAKU ──────────────────────────────────────────────
    if (hasFilters) {
      if (filters.brand && matched.length === 0 && !exactProduct) {
        const brandDisplay = filters.brand.charAt(0).toUpperCase() + filters.brand.slice(1);
        // Tarkista löytyykö brändi ylipäätään (ennen allergeenisuodatusta)
        const bNormCheck = norm(filters.brand);
        const brandExistsInDb = products.some(p =>
          norm(p.m || '').includes(bNormCheck) || norm(p.n || '').includes(bNormCheck)
        );
        if (brandExistsInDb && filters.excl.length > 0) {
          // Brändi löytyy mutta allergeenisuodatus poisti kaikki tuotteet
          return res.status(200).json({ reply: `${brandDisplay}-tuotteita löytyy valikoimastamme, mutta ne sisältävät yhden tai useamman poissuljetun allergeenin (${filters.excl.join(', ')}). Siksi ne eivät sovi koirallesi näillä rajoituksilla.` });
        }
        return res.status(200).json({ reply: `${brandDisplay}-merkkiä ei löydy valikoimastamme.` });
      }
      if (matched.length === 0) {
        if (filters.specialDiets?.length > 0) {
          const fallbackMatched = filterProducts(products, { ...filters, specialDiets: [] });
          if (fallbackMatched.length > 0) {
            const storeNames = { petenkoiratarvike: 'Peten Koiratarvike', haukkula: 'Koiratarvike Haukkula', zooplus: 'Zooplus' };
            const storeName = filters.store ? storeNames[filters.store] || filters.store : '';
            const note = storeName
              ? `${storeName}lta ei löydy painonhallintaan merkittyjä tuotteita näillä suodatuksilla. Muita sopivia vaihtoehtoja:`
              : 'Painonhallintaan merkittyjä vaihtoehtoja ei löydy. Muita sopivia tuotteita:';
            const productList = buildDirectProductResponse(fallbackMatched, filters);
            const contextProducts = fallbackMatched.slice(0, 5).map(p => ({
              n: p.n, m: p.m, p: p.p,
              a: (p.a || '').substring(0, 600),
              rv: (() => { let r = p.rv || ''; try { const parsed = JSON.parse(r); r = Array.isArray(parsed) ? parsed[0] : String(parsed); } catch {} return r; })(),
              v: (p.v || []).slice(0, 20), er: p.er || [], rl: p.rl || ''
            }));
            const hiddenData = '\n<hauku_data>' + JSON.stringify(contextProducts) + '</hauku_data>';
            return res.status(200).json({ reply: note + '\n\n' + productList + hiddenData });
          }
        }
        return res.status(200).json({ reply: 'Valikoimastamme ei löydy näillä kriteereillä sopivia tuotteita. Haluatko löyhentää jotain rajoitusta?' });
      }

      // Backend generoi tuotelistan — 100% Shopify-data
      const productList = buildDirectProductResponse(matched, filters);

      // Gemini kirjoittaa vain lyhyen intron — EI tuotenimiä
      const storeNames = { petenkoiratarvike: 'Peten Koiratarvike', haukkula: 'Koiratarvike Haukkula', zooplus: 'Zooplus' };
      const introCtxParts = [];
      if (filters.excl?.length)       introCtxParts.push(`allergeenit poissuljettu: ${filters.excl.join(', ')}`);
      if (filters.store)              introCtxParts.push(`kauppa: ${storeNames[filters.store] || filters.store}`);
      if (filters.age && filters.age !== 'Kaikki') introCtxParts.push(`koiran ikä: ${filters.age}`);
      if (filters.size && filters.size !== 'Kaikki') introCtxParts.push(`koiran koko: ${filters.size}`);
      if (filters.specialDiets?.length) introCtxParts.push(`erityistarpeet: ${filters.specialDiets.join(', ')}`);
      const introCtx = introCtxParts.length > 0 ? `[${introCtxParts.join(', ')}]` : '';

      const introSystemPrompt = `Olet Hauku, koira-asiantuntija. Kirjoita 1-2 lauseen intro-teksti suomeksi.
SALLITTU: Yleinen toteamus tilanteesta. Voit mainita löydettyjen tuotteiden lukumäärän (${matched.length} kpl).
KIELLETTY: tuotenimet, brändit, ainesosat, ravintoarvot, linkit, prosenttiluvut.
Palauta VAIN JSON: {"intro":"teksti tähän"}`;

      let intro = '';
      try {
        const introRes = await callGemini(introSystemPrompt,
          [{ role: 'user', parts: [{ text: latestUserMsg + (introCtx ? ' ' + introCtx : '') }] }],
          apiKey, 150);
        const clean = introRes.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (typeof parsed.intro === 'string' && parsed.intro.length > 5) intro = parsed.intro;
      } catch {}

      // Piilotettu kontekstidata follow-up kysymyksiä varten
      const contextProducts = matched.slice(0, 5).map(p => ({
        n: p.n, m: p.m, p: p.p,
        a: (p.a || '').substring(0, 600),
        rv: (() => { let r = p.rv || ''; try { const parsed = JSON.parse(r); r = Array.isArray(parsed) ? parsed[0] : String(parsed); } catch {} return r; })(),
        v: (p.v || []).slice(0, 20), er: p.er || [], rl: p.rl || ''
      }));
      const hiddenData = '\n<hauku_data>' + JSON.stringify(contextProducts) + '</hauku_data>';
      const reply = (intro ? intro + '\n\n' + productList : productList) + hiddenData;
      // Tallenna sessio KV:hen jatkokysymyksiä varten
      if (conversationId) {
        saveSession(conversationId, matched.slice(0, 5)).catch(e => console.warn('KV save:', e.message));
      }
      return res.status(200).json({ reply });
    }

    // ── REITTI B: YLEINEN KOIRAKYSYMYS ──────────────────────────────────
    const brands = [...new Set(products.map(p => p.m || '').filter(Boolean))];
    const catalogSummary = `\n\n[VALIKOIMAN TIEDOT: ${products.length} tuotetta, ${brands.length} merkkiä. ÄLÄ mainitse tuotenimiä ilman tietokantahakua — kysy ensin koiran tiedot.]`;
    const systemPrompt = (HARDCODED_PROMPT || '') + catalogSummary;

    const filteredMessages = messages.filter((m, i) => !(i === 0 && m.role === 'assistant'));
    const lastUserIdx = filteredMessages.map(m => m.role).lastIndexOf('user');
    if (lastUserIdx === -1) return res.status(200).json({ reply: 'Moikka!' });

    const msgsForGemini = filteredMessages.slice(0, lastUserIdx + 1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content.replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }],
    }));

    const reply = await callGemini(systemPrompt, msgsForGemini, apiKey, 2048);
    return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
