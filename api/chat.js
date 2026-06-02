// api/chat.js — Hauku backend v4 (Vercel serverless)

import { extractFilters, filterProducts, buildProductContext, buildDirectProductResponse } from '../lib/filters.js';
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

// ── KORJAUS 3: Context Locking ────────────────────────────────────────────
// Skannaa viimeisin assistant-viesti → löydä tuotenimet → hae täysi data Shopifysta
function extractProductsFromLastAssistant(messages, allProducts) {
  const lastAssist = messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
  if (!lastAssist) return [];

  // Poista hauku_data-blokki ennen skannausta
  const cleanedAssist = lastAssist.replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '');
  const assistNorm = norm(cleanedAssist);

  const found = [];
  for (const p of allProducts) {
    const pNorm = norm(p.n || '');
    if (pNorm.length >= 10 && assistNorm.includes(pNorm)) {
      found.push(p);
    }
  }
  // Järjestä löydetyt siinä järjestyksessä kuin ne esiintyvät tekstissä
  found.sort((a, b) => assistNorm.indexOf(norm(a.n)) - assistNorm.indexOf(norm(b.n)));
  return found.slice(0, 5);
}

// ── KORJAUS 2: Follow-up tunnistus ──────────────────────────────────────
function isFollowUpQuestion(latestUserMsg, lockedProducts) {
  if (!lockedProducts?.length) return false;
  const t = norm(latestUserMsg);

  // Suoran viittauksen sanat
  const hasOrdinal = /(eka|tois|kolm|nelj|viid|vika|viimei|listalla|listattu|ehdottamasi|suosittelemasi)/.test(t);
  const hasPronoun = /\b(se|toi|siinä|tässä|noissa|näistä|niistä|sillä|siitä|niillä|niistä)\b/.test(t);

  // Selkeät uuden haun signaalit — NÄMÄ ohittavat follow-up tunnistuksen
  const isNewSearch = /löytyykö|etsi|suosittele|näytä|hae|mitä ruokaa|sopivaa ruokaa|onko teillä|löytyy.*allergi|vaihtoehto.*allergi/.test(t);

  if (isNewSearch) return false;
  return hasOrdinal || hasPronoun;
}

function resolveOrdinalProduct(text, prods) {
  if (!prods?.length) return null;
  const t = norm(text);
  if (/eka|ensimm|yhd[ea]/.test(t)) return prods[0];
  if (/tois/.test(t)) return prods[1] || null;
  if (/kolm/.test(t)) return prods[2] || null;
  if (/nelj/.test(t)) return prods[3] || null;
  if (/viid/.test(t)) return prods[4] || null;
  if (/vik[ao]|viimei/.test(t)) return prods[prods.length - 1];
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
    const { messages } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });

    const apiKey = process.env.GEMINI_API_KEY;
    const products = await getProducts();
    const latestUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const latestUserNorm = norm(latestUserMsg);

    // ── KORJAUS 2+3: FOLLOW-UP REITTI ────────────────────────────────────
    // Ennen kaikkea muuta: onko tämä jatkokysymys aiemmasta listasta?
    const lockedProducts = extractProductsFromLastAssistant(messages, products);
    if (isFollowUpQuestion(latestUserMsg, lockedProducts)) {
      const ordinalProduct = resolveOrdinalProduct(latestUserMsg, lockedProducts);
      const contextProds = ordinalProduct ? [ordinalProduct] : lockedProducts;

      // Rakenna täysi product context Shopify-datasta
      const productCtx = buildProductContext(contextProds, {});

      const followUpSystemPrompt = (HARDCODED_PROMPT || '') +
        `\n\nJATKOKYSYMYS — KÄYTÄ VAIN ALLA OLEVAA SHOPIFY-DATAA. ÄLÄ ARVAA MITÄÄN.\n` +
        `Jos datassa ei ole kysyttyä tietoa, sano rehellisesti "ei löydy tietokannastamme" ja ohjaa tarkistamaan pakkaus.\n` +
        productCtx;

      const filteredMsgs = messages
        .filter((m, i) => !(i === 0 && m.role === 'assistant'))
        .slice(-6)
        .map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content.replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }],
        }));

      const reply = await callGemini(followUpSystemPrompt, filteredMsgs, apiKey, 800);
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

    const hasFilters = !!(filters.excl.length || filters.want.length || filters.brand || filters.age || filters.size || filters.specialDiets?.length || filters.store || exactProduct);
    let matched = hasFilters ? filterProducts(products, filters) : [];

    if (filters.brand2) {
      const matched2 = filterProducts(products, { ...filters, brand: filters.brand2 });
      matched = [...matched.slice(0, 5), ...matched2.slice(0, 5)];
    }

    if (exactProducts.length > 1) {
      const validExact = exactProducts.filter(p => matched.some(m => m.n === p.n));
      if (validExact.length > 0) {
        const rest = matched.filter(p => !validExact.find(ep => ep.n === p.n)).slice(0, 3);
        matched = [...validExact, ...rest];
      }
    } else if (exactProduct && matched.some(p => p.n === exactProduct.n)) {
      const rest = matched.filter(p => p.n !== exactProduct.n).slice(0, 4);
      matched = [exactProduct, ...rest];
    }

    console.log('filters:', JSON.stringify({ excl: filters.excl, store: filters.store, brand: filters.brand, size: filters.size }));
    console.log('matched:', matched.length);

    // ── REITTI A: TUOTEHAKU ──────────────────────────────────────────────
    if (hasFilters) {
      if (filters.brand && matched.length === 0 && !exactProduct) {
        const brandDisplay = filters.brand.charAt(0).toUpperCase() + filters.brand.slice(1);
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
