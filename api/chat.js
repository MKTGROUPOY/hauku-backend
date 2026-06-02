// api/chat.js — Hauku backend (Vercel serverless)

import { extractFilters, filterProducts, buildProductContext, buildDirectProductResponse } from '../lib/filters.js';
import { getProducts } from '../lib/shopify.js';
import { SYSTEM_PROMPT as HARDCODED_PROMPT } from '../lib/system-prompt.js';

function norm(s) {
  return s.toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

// ── Suora allergeeni/ainesosa -tarkistus — ohittaa Geminin ────────────────
function checkIngredientQuestion(messages, products) {
  const userMsgs = messages.filter(m => m.role === 'user');
  const lastMsg = userMsgs[userMsgs.length - 1]?.content || '';
  const t = lastMsg.toLowerCase();

  const isIngredientCheck = /sisältääkö|onko siinä|löytyykö siitä|onko.*ainesosissa|sisältyykö|onko.*mukana/.test(t);
  if (!isIngredientCheck) return null;
  if (/jokin|mikään|jotkut|kaikki/.test(t)) return null;

  // Hae tuote ensin viimeisimmästä viestistä
  let targetProduct = null;
  for (const p of products) {
    const pNorm = p.n.toLowerCase();
    if (pNorm.length >= 8 && t.includes(pNorm)) {
      if (!targetProduct || pNorm.length > targetProduct.n.length) targetProduct = p;
    }
  }
  // Pronominit: "se", "siinä" → hae edellisestä assistant-vastauksesta
  if (!targetProduct && /\bse\b|\bsiinä\b|\bsitä\b|\bsillä\b|oletko varma|ihan varma|täysin varma|mutta kananmunaa|entä kananmuna/.test(t)) {
    const lastAssist = messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
    for (const p of products) {
      const pNorm = p.n.toLowerCase();
      if (pNorm.length >= 8 && lastAssist.toLowerCase().includes(pNorm)) {
        if (!targetProduct || pNorm.length > targetProduct.n.length) targetProduct = p;
      }
    }
  }
  if (!targetProduct) return null;

  const ingredientPatterns = [
    { words: ['kana', 'kanaa', 'kanalle', 'kanasta', 'kananliha', 'kananrasva', 'broileri', 'siipikarja'], name: 'kana' },
    { words: ['kananmuna', 'kananmunaa', 'munanvalkuainen'], name: 'kananmuna' },
    { words: ['lohi', 'lohta', 'lohiöljy'], name: 'lohi' },
    { words: ['kala', 'kalaa', 'kalaöljy', 'kalajauho'], name: 'kala' },
    { words: ['nauta', 'nautaa', 'naudanliha'], name: 'nauta' },
    { words: ['lammas', 'lammasta'], name: 'lammas' },
    { words: ['peruna', 'perunaa'], name: 'peruna' },
    { words: ['vehnä', 'vehnää', 'gluteeni'], name: 'vehnä' },
    { words: ['maissi', 'maissista'], name: 'maissi' },
    { words: ['herne', 'hernettä'], name: 'herne' },
    { words: ['soija', 'soijaa'], name: 'soija' },
    { words: ['bataatti', 'bataattia'], name: 'bataatti' },
    { words: ['maksa', 'maksaa', 'kananmaksa'], name: 'maksa' },
    { words: ['sardiini', 'sardiinia'], name: 'sardiini' },
    { words: ['ankka', 'ankkaa'], name: 'ankka' },
  ];

  let askedIngredient = null;
  for (const pat of ingredientPatterns) {
    if (pat.words.some(w => t.includes(w))) { askedIngredient = pat; break; }
  }
  if (!askedIngredient) return null;

  const ainesosat = (targetProduct.a || '').toLowerCase();
  const vapaa = (targetProduct.v || []).map(x => x.toLowerCase());
  const foundInAinesosat = askedIngredient.words.some(w => ainesosat.includes(w));
  const freeFromVapaa = vapaa.includes(askedIngredient.name);

  if (!ainesosat && vapaa.length === 0) {
    return `Ainesosatietoja ei ole saatavilla tuotteelle **${targetProduct.n}**. Tarkistathan pakkauksesta.`;
  }

  if (foundInAinesosat) {
    if (askedIngredient.name === 'kana') {
      const hasActualChicken = ['kanaliha', 'kananliha', 'kananrasva', 'broileri', 'siipikarja', 'tuore kana', 'kuivattu kana', 'kana ('].some(w => ainesosat.includes(w));
      const hasEgg = ['kananmuna', 'kananmunia'].some(w => ainesosat.includes(w));
      if (!hasActualChicken && hasEgg) {
        return `**${targetProduct.n}** ei sisällä kananlihaa tai kananrasvaa, mutta sisältää **kananmunaa**.\n\n⚠️ Kana-allergia ja kananmuna-allergia ovat eri asioita — tarkistathan eläinlääkäriltä sopiiko kananmuna koirallesi.`;
      }
    }
    return `**${targetProduct.n}** sisältää **${askedIngredient.name}a** — se löytyy ainesosaluettelosta: "${ainesosat.substring(0, 150)}..."`;
  } else if (freeFromVapaa) {
    const hasEggNote = (askedIngredient.name === 'kana' && ['kananmuna', 'kananmunia'].some(w => ainesosat.includes(w)))
      ? '\n\n⚠️ Huomasin kuitenkin että tuote sisältää **kananmunaa**. Kana-allergia ja kananmuna-allergia ovat eri asioita — tarkistathan eläinlääkäriltä.' : '';
    return `**${targetProduct.n}** on merkitty vapaaksi **${askedIngredient.name}sta** allergeenilistassamme, eikä sitä löydy ainesosaluettelosta.${hasEggNote}`;
  } else if (ainesosat.length > 0) {
    const hasEggNote2 = (askedIngredient.name === 'kana' && ['kananmuna', 'kananmunia'].some(w => ainesosat.includes(w)))
      ? '\n\n⚠️ Huomasin kuitenkin että tuote sisältää **kananmunaa**. Kana-allergia ja kananmuna-allergia ovat eri asioita — tarkistathan eläinlääkäriltä.' : '';
    return `**${targetProduct.n}** ei sisällä **${askedIngredient.name}a** ainesosaluettelonsa perusteella.\n\n📋 Tarkistathan tiedot varmuuden vuoksi.${hasEggNote2}`;
  }
  return null;
}

// ── Diagnostiset kysymykset ──────────────────────────────────────────────
function detectDiagnosticQuestion(messages) {
  const lastMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const t = lastMsg.toLowerCase();
  const isDiagnostic = /miksi|mistä johtuu|mitä tarkoittaa|onko normaalia|voiko koira|onko vaarall|syö ruohoa|nuolee|raapii|oksentaa|ripuli|kutisee|aivastaa|yskii|hengittää|juoksuttaa|korvat haisee|täit|kirput|madot|loiset|mitä.*huomioida|miten.*ruokinta/.test(t);
  const hasBuyIntent = /sopii|suosittele|etsin|löytyykö|mikä ruoka|mitä ruokaa|ostan|haen/.test(t);
  return isDiagnostic && !hasBuyIntent;
}

// ── Hintakysymykset ──────────────────────────────────────────────────────
function detectPriceQuestion(messages) {
  const lastMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const t = lastMsg.toLowerCase();
  return /edullisi|edullinen|halvin|halvempi|hinta|hinnat|paljonko.*maks|mitä maksaa|paljonko maksaa/.test(t);
}

// ── Sairauksien esto ─────────────────────────────────────────────────────
const MEDICAL_BLOCKS = ['munuain', 'munuais', 'maksan vajaa', 'hepatic', 'haimatuleh', 'pankreatiit', 'diabetes', 'sydänsaira', 'epilepsi', 'kasvain', 'syöpä', 'hypotyreoosi', 'cushingin'];

function detectMedicalBlock(messages) {
  const allText = norm(messages.filter(m => m.role === 'user').map(m => m.content).join(' '));
  return MEDICAL_BLOCKS.find(kw => allText.includes(kw)) || null;
}

// ── Gemini API kutsu ─────────────────────────────────────────────────────
async function callGemini(systemPrompt, messages, apiKey, maxTokens = 2048) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: messages,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
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
    const filters = extractFilters(messages);

    // Bränditunnistus — vain viimeisin käyttäjäviesti
    if (products.length > 0) {
      const BLACKLIST = ['hauku', 'ruokakoiralle', 'koiralle', 'koira', 'ruoka', 'peten', 'zooplus', 'haukkula'];
      const vendors = [...new Set(products.map(p => norm(p.m || '')).filter(v => v.length >= 4 && !BLACKLIST.includes(v)))].sort((a, b) => b.length - a.length);
      const latestUserText = norm(messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '');
      let detectedBrand = null;
      for (const vendor of vendors) {
        const base = vendor.replace(/[^a-zäöå]/g, '');
        // Tarkista suorat osumat ja yleisimmät taivutusmuodot
        const directMatch = latestUserText.includes(vendor) ||
          latestUserText.includes(base + 'in') ||
          latestUserText.includes(base + 'ia') ||
          latestUserText.includes(base + 'lla') ||
          latestUserText.includes(base + 'sta') ||
          latestUserText.includes(base + 'n');
        // Prefix-osuma: f→d muunnos (esim. "grandorf" → "grandordi")
        // Tarkista pitkä yhteinen prefix (≥5 merkkiä)
        const prefixLen = Math.max(5, base.length - 2);
        const prefixMatch = base.length >= 5 && (() => {
          const words = latestUserText.split(' ');
          return words.some(w => w.length >= prefixLen && base.startsWith(w.substring(0, prefixLen)));
        })();
        if (directMatch || prefixMatch) {
          detectedBrand = vendor; break;
        }
      }
      filters.brand = detectedBrand;

      if (detectedBrand && /vai|vs|versus|vertaa/.test(latestUserText)) {
        for (const vendor of vendors) {
          if (vendor === detectedBrand) continue;
          const base2 = vendor.replace(/[^a-zäöå]/g, '');
          if (latestUserText.includes(vendor) || latestUserText.includes(base2 + 'in') || latestUserText.includes(base2 + 'ia') || latestUserText.includes(base2 + 'lla') || latestUserText.includes(base2 + 'sta')) {
            filters.brand2 = vendor; break;
          }
        }
      }
    }

    // Tarkka tuotenimiehaku — käyttäjäviesti + viimeisin assistant-viesti
    const lastUserText = norm(messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '');
    const lastAssistantText = norm(messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '');
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

    // 0. Suora ravintoarvo-/tuotekysymys — hae arvo suoraan Shopifysta
    function checkNutritionQuestion(messages, products) {
      const userMsgs = messages.filter(m => m.role === 'user');
      const lastMsg = userMsgs[userMsgs.length - 1]?.content || '';
      const t = lastMsg.toLowerCase();

      // Tunnista ravintoarvo- tai tuotetietokysymykset
      const isNutritionQ = /raakaproteiini|raakarasva|raakakuitu|paljonko.*sisältää|kuinka paljon|minkä ikä|minkä koko|mille koiralle|kenelle sopii/.test(t);
      if (!isNutritionQ) return null;

      // Etsi tuote viimeisestä viestistä tai assistentin vastauksesta (pronominit)
      let targetProduct = null;
      for (const p of products) {
        const pNorm = p.n.toLowerCase();
        if (pNorm.length >= 8 && t.includes(pNorm)) {
          if (!targetProduct || pNorm.length > targetProduct.n.length) targetProduct = p;
        }
      }
      const isFollowUp = /\bse\b|\bsiinä\b|\bsitä\b|\bsillä\b|^entä|^entäs|^entäpä|^no entä|^ja entä/.test(t) || (t.length < 30 && !t.includes(' '));
      if (!targetProduct && isFollowUp) {
        const lastAssist = messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
        for (const p of products) {
          const pNorm = p.n.toLowerCase();
          if (pNorm.length >= 8 && lastAssist.toLowerCase().includes(pNorm)) {
            if (!targetProduct || pNorm.length > targetProduct.n.length) targetProduct = p;
          }
        }
      }
      if (!targetProduct) return null;

      // rv-kenttä voi olla JSON-array ["..."] tai tavallinen teksti
      let rv = targetProduct.rv || '';
      try {
        const parsed = JSON.parse(rv);
        rv = Array.isArray(parsed) ? parsed[0] : String(parsed);
      } catch {}
      rv = String(rv).replace(/^\["|"\]$|^\[|\]$/g, '').trim();
      const p = targetProduct;

      // Yleinen ravintoarvoparsinki — joustava formaatti
      function parseNutrient(rvStr, keywords) {
        for (const kw of keywords) {
          const m = rvStr.match(new RegExp(kw + '[^\\d]*([\\d.,]+)\\s*%', 'i'));
          if (m) return m[1].replace(',', '.');
        }
        return null;
      }

      // Raakaproteiini
      if (/raakaproteiini/.test(t)) {
        const val = parseNutrient(rv, ['raakaproteiini']);
        if (val) return `**${targetProduct.n}** sisältää raakaproteiinia **${val} %**.`;
        return `**${targetProduct.n}** — raakaproteiinia ei ole ilmoitettu tietokannassamme. 📋 Tarkistathan pakkauksen.`;
      }
      // Raakarasva
      if (/raakarasva/.test(t)) {
        const val = parseNutrient(rv, ['raakarasva']);
        if (val) return `**${targetProduct.n}** sisältää raakarasvaa **${val} %**.`;
        if (p.rl) return `**${targetProduct.n}** rasvapitoisuus: **${p.rl}**.`;
        return `**${targetProduct.n}** — raakarasvaa ei ole ilmoitettu tietokannassamme. 📋 Tarkistathan pakkauksen.`;
      }
      // Raakakuitu
      if (/raakakuitu/.test(t)) {
        const val = parseNutrient(rv, ['raakakuitu']);
        if (val) return `**${targetProduct.n}** sisältää raakakuitua **${val} %**.`;
        return `**${targetProduct.n}** — raakakuitua ei ole ilmoitettu tietokannassamme. 📋 Tarkistathan pakkauksen.`;
      }
      // Omega-3, omega-6, kalsium, fosfori
      if (/omega.?3|omega.?6|kalsium|fosfori|tuhka|kosteus|energia|kcal/.test(t)) {
        const nutrientMap = [
          { keys: ['omega.?3'], labels: ['omega-3'] },
          { keys: ['omega.?6'], labels: ['omega-6'] },
          { keys: ['kalsium'], labels: ['kalsium'] },
          { keys: ['fosfori'], labels: ['fosfori'] },
          { keys: ['tuhka'], labels: ['tuhka'] },
          { keys: ['kosteus'], labels: ['kosteus'] },
          { keys: ['energia', 'kcal'], labels: ['energia', 'kcal'] },
        ];
        for (const n of nutrientMap) {
          if (n.keys.some(k => new RegExp(k).test(t))) {
            const val = parseNutrient(rv, n.labels);
            if (val) return `**${targetProduct.n}** — ${n.labels[0]}: **${val} %** (tai vastaava yksikkö).`;
            // Hae myös kcal erikseen
            if (n.labels.includes('kcal')) {
              const mKcal = rv.match(/(\d+)\s*kcal/i);
              if (mKcal) return `**${targetProduct.n}** — energiapitoisuus: **${mKcal[1]} kcal/100g**.`;
            }
            return `**${targetProduct.n}** — ${n.labels[0]}-tietoa ei ole ilmoitettu tietokannassamme. 📋 Tarkistathan pakkauksen.`;
          }
        }
      }

      // Ikä/koko/kenelle sopii
      if (/minkä ikä|minkä koko|mille koiralle|kenelle sopii/.test(t)) {
        const age = p.i?.join(', ') || 'Ei tietoa';
        const size = p.k?.join(', ') || 'Ei tietoa';
        return `**${targetProduct.n}** on tarkoitettu:
- Ikä: ${age}
- Koko: ${size}`;
      }
      return null;
    }

    const nutritionAnswer = checkNutritionQuestion(messages, products);
    if (nutritionAnswer) {
      return res.status(200).json({ reply: nutritionAnswer });
    }

    // 1. Suora ainesosatarkistus
    const ingredientAnswer = checkIngredientQuestion(messages, products);
    if (ingredientAnswer) {
      return res.status(200).json({ reply: ingredientAnswer });
    }

    // 2. Yleinen ainesosahaku
    const lastUserMsgText = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const generalIngCheck = /sisältääkö jokin|löytyykö.*jossa on|löytyykö.*joka sisältää/.test(lastUserMsgText.toLowerCase());
    if (generalIngCheck) {
      const ingPatterns = [
        { words: ['bataatti', 'bataattia'], name: 'bataatti' },
        { words: ['kana', 'kanaa'], name: 'kana' },
        { words: ['lohi', 'lohta'], name: 'lohi' },
        { words: ['peruna', 'perunaa'], name: 'peruna' },
        { words: ['lammas', 'lammasta'], name: 'lammas' },
        { words: ['ankka', 'ankkaa'], name: 'ankka' },
        { words: ['hirvi', 'hirveä'], name: 'hirvi' },
      ];
      const tLow = lastUserMsgText.toLowerCase();
      const matchedPat = ingPatterns.find(p => p.words.some(w => tLow.includes(w)));
      if (matchedPat) {
        const found = products.filter(p => matchedPat.words.some(w => (p.a || '').toLowerCase().includes(w))).slice(0, 5);
        if (found.length > 0) {
          return res.status(200).json({ reply: `Valikoimastamme löytyy seuraavat tuotteet joiden ainesosissa mainitaan **${matchedPat.name}**:\n\n${found.map(p => `**${p.n}** (${p.m})`).join('\n')}\n\n📋 Tarkistathan ainesosat tuotekorteista.` });
        } else {
          return res.status(200).json({ reply: `Valikoimastamme ei löydy tuotteita joiden ainesosissa mainitaan **${matchedPat.name}**.` });
        }
      }
    }

    // 3. Diagnostinen kysymys
    if (detectDiagnosticQuestion(messages)) {
      const diagPrompt = (HARDCODED_PROMPT || '') + '\n\n[OHJE: Vastaa asiantuntijana koiran terveydestä. ÄLÄ suosittele tuotteita ellei asiakas pyydä.]';
      const filteredMsgs = messages.filter((m, i) => !(i === 0 && m.role === 'assistant'));
      const geminiMsgs = filteredMsgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const reply = await callGemini(diagPrompt, geminiMsgs, apiKey, 1500);
      return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });
    }

    // 4. Hintakysymys
    if (detectPriceQuestion(messages)) {
      return res.status(200).json({ reply: 'Palvelussamme ei ole hintatietoja. Näet hinnat suoraan ostolinkistä verkkokauppaan.' });
    }

    // 5b. Epäilyviesti — asiakas kyseenalaistaa lukumäärän tai olemassaoloa
    const latestUserMsg = norm(messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '');
    // Doubt = kyseenalaistaa LUKUMÄÄRÄN — ei tuotekysymystä tai korjausta
    const isProductQuestion = /raakaproteiini|ainesosa|sisältää|rasvapitoisuus|ravintoarvo|paljonko.*ruoassa|kuinka paljon.*ruoa|sopii|minkä ikä|minkä koko|mille koiralle/.test(latestUserMsg);
    const doubtQuestion = !isProductQuestion && (
      /eik[öo]|oletko varma|todellakin|onhan.*enemmän|kyll[äa] on|on niit[äa]|pitäisi olla|pitää olla|ei ole niin|ei vitussa|eivät ole|eivät löydy/.test(latestUserMsg) ||
      /en usko.*tuotett|en usko.*merkk|sekoilet|sekoilee|sekaisin|väärää tietoa|virheellist|anna väärää|ei täsmää|ei pidä paikk/.test(latestUserMsg) ||
      /montako.*oikeasti|oikeasti.*montako|onko oikeasti|oikeasti niitä|kuinka monta oikeasti/.test(latestUserMsg) ||
      /olin katsovinani|luulin että.*tuotett|mielestäni.*enemmän|pitäisi olla enemmän/.test(latestUserMsg)
    );

    if (doubtQuestion) {
      // Hae brändi prioriteettijärjestyksessä:
      // 1. Nykyinen viesti (filters.brand)
      // 2. Edelliset käyttäjäviestit (viimeiset 3)
      // 3. Edellinen assistant-viesti (viimeisenä — voi olla sekava)
      const BLACKLIST2 = ['hauku', 'ruokakoiralle', 'koiralle', 'koira', 'ruoka', 'peten', 'zooplus', 'haukkula'];
      const vendors2 = products.length > 0
        ? [...new Set(products.map(p => norm(p.m || '')).filter(v => v.length >= 4 && !BLACKLIST2.includes(v)))].sort((a,b) => b.length - a.length)
        : [];

      let doubtBrand = filters.brand;

      // 2. Etsi brändi viimeisimmistä käyttäjäviesteistä
      if (!doubtBrand) {
        const recentUserText = norm(messages.filter(m => m.role === 'user').slice(-3).map(m => m.content).join(' '));
        for (const v of vendors2) {
          const base = v.replace(/[^a-zäöå]/g, '');
          if (recentUserText.includes(v) || recentUserText.includes(base + 'in') || recentUserText.includes(base + 'ia') || recentUserText.includes(base + 'n')) {
            doubtBrand = v; break;
          }
        }
      }

      // 3. Vasta sitten assistant-viesti (mutta käytä vain jos yksiselitteinen)
      if (!doubtBrand) {
        const lastAssist = messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
        const assistMatches = vendors2.filter(v => norm(lastAssist).includes(v));
        // Käytä assistant-viestin brändiä vain jos se on yksiselitteinen (ei useita brändejä)
        if (assistMatches.length === 1) doubtBrand = assistMatches[0];
      }

      if (doubtBrand) {
        const bNorm2 = norm(doubtBrand);
        const brandCount = products.filter(p =>
          (p.l || p.l2 || p.l3) &&
          (norm(p.m || '').includes(bNorm2) || norm(p.n || '').includes(bNorm2))
        ).length;
        const brandDisplay2 = doubtBrand.charAt(0).toUpperCase() + doubtBrand.slice(1);
        if (brandCount === 0) {
          return res.status(200).json({ reply: `${brandDisplay2}-tuotteita ei löydy valikoimastamme. Tämä tieto tulee suoraan tietokannastamme eikä muutu.` });
        }
        return res.status(200).json({ reply: `Tietokantamme mukaan valikoimassamme on **tasan ${brandCount}** ${brandDisplay2}-tuotetta. Tämä luku tulee suoraan Shopify-tietokannastamme eikä muutu vaikka sitä kyseenalaistetaan.` });
      }
    }

    // 5. Tuotemäärä — käytä samaa normalisointia kuin bränditunnistus
    // Hae brändi nykyisestä tai viimeisistä viesteistä
    let countBrand = filters.brand;
    if (!countBrand && /montako|kuinka monta|paljonko.*tuotett/.test(latestUserMsg)) {
      const BLACKLIST3 = ['hauku', 'ruokakoiralle', 'koiralle', 'koira', 'ruoka', 'peten', 'zooplus', 'haukkula'];
      const vendors3 = products.length > 0
        ? [...new Set(products.map(p => norm(p.m || '')).filter(v => v.length >= 4 && !BLACKLIST3.includes(v)))].sort((a,b) => b.length - a.length)
        : [];
      const recentUserText2 = norm(messages.filter(m => m.role === 'user').slice(-3).map(m => m.content).join(' '));
      for (const v of vendors3) {
        const base2 = v.replace(/[^a-zäöå]/g, '');
        if (recentUserText2.includes(v) || recentUserText2.includes(base2 + 'in') || recentUserText2.includes(base2 + 'ia') || recentUserText2.includes(base2 + 'n')) {
          countBrand = v; break;
        }
      }
    }

    if (/montako|kuinka monta|paljonko.*tuotett/.test(latestUserMsg) && countBrand) {
      const bNorm = norm(countBrand);
      const brandProducts = products.filter(p => {
        // Vaadi vähintään yksi ostolinkki — muuten tuote ei ole saatavilla
        if (!p.l && !p.l2 && !p.l3) return false;
        if (norm(p.m || '').includes(bNorm)) return true;
        if (norm(p.n || '').includes(bNorm)) return true;
        const firstWord = norm(p.n || '').split(' ')[0];
        if (firstWord.length >= 4 && bNorm.includes(firstWord)) return true;
        return false;
      });
      const brandDisplay = countBrand.charAt(0).toUpperCase() + countBrand.slice(1);
      if (brandProducts.length === 0) {
        return res.status(200).json({ reply: `${brandDisplay}-tuotteita ei löydy valikoimastamme.` });
      }
      return res.status(200).json({ reply: `Valikoimassamme on tällä hetkellä **${brandProducts.length}** ${brandDisplay}-tuotetta.` });
    }

    // 6. Lääketieteellinen esto
    const medicalBlock = detectMedicalBlock(messages);
    if (medicalBlock) {
      const medPrompt = (HARDCODED_PROMPT || '') + `\n\n[BACKEND-ESTO: Sairaus tunnistettu (${medicalBlock}). Vastaa VAIN: ruokavaliomuutos tehdään eläinlääkärin ohjeiden mukaan. Ei tuotelistoja.]`;
      const filteredMsgs = messages.filter((m, i) => !(i === 0 && m.role === 'assistant'));
      const geminiMsgs = filteredMsgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const reply = await callGemini(medPrompt, geminiMsgs, apiKey, 400);
      return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });
    }

    // 7. Suodata tuotteet
    const hasFilters = !!(filters.excl.length || filters.want.length || filters.brand || filters.age || filters.size || filters.specialDiets?.length || filters.store || exactProduct);
    let matched = hasFilters ? filterProducts(products, filters) : [];

    if (filters.brand2) {
      const matched2 = filterProducts(products, { ...filters, brand: filters.brand2 });
      matched = [...matched.slice(0, 5), ...matched2.slice(0, 5)];
    }

    // exactProduct vain jos läpäisi suodatukset
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

    // 8. Rakenna konteksti ja kutsu Gemini
    let productCtx = '';
    if (filters.brand && matched.length === 0 && !exactProduct) {
      productCtx = `\n\n[TIETOKANTATIETO: Brändiä "${filters.brand}" ei löydy valikoimastamme. Kerro tämä suoraan.]`;
    } else if (hasFilters || exactProduct) {
      productCtx = buildProductContext(matched, filters);
    }

    console.log('filters:', JSON.stringify({ excl: filters.excl, store: filters.store, brand: filters.brand, size: filters.size }));
    console.log('matched:', matched.length);

    const brands = [...new Set(products.map(p => p.m || '').filter(Boolean))];
    const catalogSummary = `\n\n[VALIKOIMAN TIEDOT: ${products.length} tuotetta, ${brands.length} merkkiä. ÄLÄ mainitse tuotenimiä ilman tietokantahakua.]`;
    const systemPrompt = (HARDCODED_PROMPT || '') + catalogSummary;

    const filteredMessages = messages.filter((m, i) => !(i === 0 && m.role === 'assistant'));
    const lastUserIdx = filteredMessages.map(m => m.role).lastIndexOf('user');
    if (lastUserIdx === -1) return res.status(200).json({ reply: 'Moikka!' });

    const msgsForGemini = filteredMessages.slice(0, lastUserIdx + 1).map((m, i) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: (i === filteredMessages.slice(0, lastUserIdx + 1).length - 1 && m.role === 'user' && productCtx) ? m.content + productCtx : m.content }],
    }));

    let reply = await callGemini(systemPrompt, msgsForGemini, apiKey, 4096);
    if (!reply) reply = 'Yritä uudelleen.';

    // Poista hallusinoituja väitteitä
    reply = reply.replace(/,?\s*kuten tauriini[^.]*\./gi, '.');
    reply = reply.replace(/energiamäärä on [\d.,]+ MJ\/kg[^.]*\./gi, 'Tarkista annostus pakkauksesta.');
    reply = reply.replace(/noin [\d]+-[\d]+ kcal päivässä[^.]*\./gi, 'Tarkista annostus pakkauksesta.');

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
