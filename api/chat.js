// api/chat.js — Hauku backend (Vercel serverless) — Gemini API

import { extractFilters, filterProducts, buildProductContext } from '../lib/filters.js';
import { getProducts } from '../lib/shopify.js';
import { SYSTEM_PROMPT as HARDCODED_PROMPT } from '../lib/system-prompt.js';

function norm(s) {
  return s.toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

// ── Suora allergeeni/ainesosa -tarkistus — ohittaa Geminin ────────────────────
function checkIngredientQuestion(messages, products) {
  const userMsgs = messages.filter(m => m.role === 'user');
  const lastMsg = userMsgs[userMsgs.length - 1]?.content || '';
  const t = lastMsg.toLowerCase();

  // Tunnista "sisältääkö X tuote Y ainesosaa" -kysymykset
  // Vaatii SEKÄ tuote- että ainesosaviittauksen — yleinen kysymys ei laukaise
  const isIngredientCheck = /sisältääkö|onko siinä|löytyykö siitä|onko.*ainesosissa|sisältyykö|onko.*mukana/.test(t);
  if (!isIngredientCheck) return null;
  // Jos kysymyksessä on "jokin" tai "mikään" — yleinen kysymys, ei tuotekohtainen
  if (/jokin|mikään|jotkut|kaikki/.test(t)) return null;

  // Etsi mainittu tuote — ensin viimeisimmästä käyttäjäviestistä
  let targetProduct = null;
  for (const p of products) {
    const pNorm = p.n.toLowerCase();
    if (pNorm.length >= 8 && t.includes(pNorm)) {
      if (!targetProduct || pNorm.length > targetProduct.n.length) {
        targetProduct = p;
      }
    }
  }
  
  // Pronominien ratkaisu: "sisältääkö SE" → hae edellisestä assistant-vastauksesta
  if (!targetProduct && /\bse\b|\bsiinä\b|\bsitä\b|\bsillä\b/.test(t)) {
    const lastAssist = messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
    for (const p of products) {
      const pNorm = p.n.toLowerCase();
      if (pNorm.length >= 8 && lastAssist.toLowerCase().includes(pNorm)) {
        if (!targetProduct || pNorm.length > targetProduct.n.length) {
          targetProduct = p;
        }
      }
    }
  }
  
  if (!targetProduct) return null;

  // Etsi kysytty ainesosa
  const ingredientPatterns = [
    { words: ['kana', 'kanaa', 'kanalle', 'kanasta', 'kananliha', 'kananrasva', 'broileri', 'siipikarja', 'siipikarjanliha'], name: 'kana' },
    { words: ['kananmuna', 'kananmunaa', 'munanvalkuainen', 'munankeltuainen'], name: 'kananmuna' },
    { words: ['lohi', 'lohta', 'lohelle', 'lohesta', 'lohiöljy', 'lohiöljyä'], name: 'lohi' },
    { words: ['kala', 'kalaa', 'kalaöljy', 'kalajauho'], name: 'kala' },
    { words: ['nauta', 'nautaa', 'naudanliha'], name: 'nauta' },
    { words: ['lammas', 'lammasta', 'lampaanliha'], name: 'lammas' },
    { words: ['peruna', 'perunaa', 'perunat'], name: 'peruna' },
    { words: ['vehnä', 'vehnää', 'gluteeni'], name: 'vehnä' },
    { words: ['maissi', 'maissista', 'maissitärkkelys'], name: 'maissi' },
    { words: ['herne', 'hernettä', 'herneet'], name: 'herne' },
    { words: ['soija', 'soijaa', 'soijaproteiini'], name: 'soija' },
    { words: ['bataatti', 'bataattia'], name: 'bataatti' },
    { words: ['maksa', 'maksaa', 'kananmaksa', 'naudanmaksa'], name: 'maksa' },
    { words: ['sardiini', 'sardiinia'], name: 'sardiini' },
    { words: ['sipuli', 'sipulia', 'valkosipuli'], name: 'sipuli' },
    { words: ['ankka', 'ankkaa', 'ankanliha'], name: 'ankka' },
  ];

  let askedIngredient = null;
  for (const pat of ingredientPatterns) {
    if (pat.words.some(w => t.includes(w))) {
      askedIngredient = pat;
      break;
    }
  }
  if (!askedIngredient) return null;

  // Tarkista ainesosat suoraan datasta
  const ainesosat = (targetProduct.a || '').toLowerCase();
  const vapaa = (targetProduct.v || []).map(x => x.toLowerCase());
  
  const foundInAinesosat = askedIngredient.words.some(w => ainesosat.includes(w));
  const freeFromVapaa = vapaa.includes(askedIngredient.name);
  
  if (!ainesosat && vapaa.length === 0) {
    return `Ainesosatietoja ei ole saatavilla tuotteelle **${targetProduct.n}**. Tarkistathan tiedot tuotteen pakkauksesta tai ostolinkistä ennen ostopäätöstä.`;
  }
  
  if (foundInAinesosat) {
    // Erityistapaus: kana-allergiakysymys mutta löytyi vain kananmuna
    if (askedIngredient.name === 'kana') {
      const hasActualChicken = ['kanaliha', 'kananliha', 'kananrasva', 'broileri', 'siipikarja', 'tuore kana', 'kuivattu kana', 'kana ('].some(w => ainesosat.includes(w));
      const hasEgg = ['kananmuna', 'kananmunia'].some(w => ainesosat.includes(w));
      if (!hasActualChicken && hasEgg) {
        return `**${targetProduct.n}** ei sisällä kananlihaa tai kananrasvaa, mutta sisältää **kananmunaa**.

⚠️ Huom: Kana-allergia ja kananmuna-allergia ovat eri asioita. Koira voi olla allerginen kanalle mutta sietää kananmunan — tai päinvastoin. Tarkistathan eläinlääkäriltä sopiiko kananmuna koirallesi.

Ainesosat: "${ainesosat.substring(0, 150)}..."`;
      }
    }
    return `**${targetProduct.n}** sisältää **${askedIngredient.name}a** — se löytyy ainesosaluettelosta: "${ainesosat.substring(0, 150)}..."`;
  } else if (freeFromVapaa) {
    // Tarkista silti onko kananmunaa jos kysyttiin kana-allergiasta
    const hasEggNote = (askedIngredient.name === 'kana' && ['kananmuna', 'kananmunia'].some(w => ainesosat.includes(w))) ? '\n\n⚠️ Huomasin kuitenkin että tuote sisältää **kananmunaa**. Kana-allergia ja kananmuna-allergia ovat eri asioita — tarkistathan eläinlääkäriltä sopiiko kananmuna koirallesi.' : '';
    return `**${targetProduct.n}** on merkitty vapaaksi **${askedIngredient.name}sta** allergeenilistassamme, eikä kanaa löydy ainesosaluettelosta.${hasEggNote}`;
  } else if (ainesosat.length > 0) {
    // Tarkista kananmuna myös tässä
        const hasEggNote2 = (askedIngredient.name === 'kana' && ['kananmuna', 'kananmunia'].some(w => ainesosat.includes(w))) ? '\n\n⚠️ Huomasin kuitenkin että tuote sisältää **kananmunaa**. Kana-allergia ja kananmuna-allergia ovat eri asioita — tarkistathan eläinlääkäriltä sopiiko kananmuna koirallesi.' : '';
    return `**${targetProduct.n}** ei sisällä **${askedIngredient.name}a** ainesosaluettelonsa perusteella. Ainesosat: ${ainesosat.substring(0, 200)}${ainesosat.length > 200 ? '...' : ''}

📋 Tarkistathan tiedot tuotteen pakkauksesta varmuuden vuoksi.${hasEggNote2}`;
  }
  return null;
}

// ── Diagnostiset kysymykset – ei tuotekontekstia ─────────────────────────────
function detectDiagnosticQuestion(messages) {
  const lastMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const t = lastMsg.toLowerCase();
  // Tunnista puhtaat diagnostiset kysymykset joissa ei ole ostoaietta
  const isDiagnostic = /miksi|mistä johtuu|mitä tarkoittaa|onko normaalia|voiko koira|onko vaarall|syö ruohoa|nuolee|raapii|oksentaa|ripuli|kutisee|aivastaa|yskii|hengittää|juoksuttaa|silmät vuotaa|korvat haisee|täit|kirput|madot|loiset|mitä.*huomioida|mitä.*ottaa huomioon|miten.*ruokinta|miten.*syöttää/.test(t);
  const hasBuyIntent = /sopii|suosittele|etsin|löytyykö|mikä ruoka|mitä ruokaa|ostan|haen|tilaan/.test(t);
  return isDiagnostic && !hasBuyIntent;
}

// ── Hintakysymykset – backend vastaa suoraan ──────────────────────────────────
function detectPriceQuestion(messages) {
  const lastMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const t = lastMsg.toLowerCase();
  return /edullisi|edullinen|edullista|edullisia|halvin|halvempi|halvat|halpa|hinta|hinnat|budjetti|budget|paljonko.*maks|miten.*hintaan|mikä.*hinta|hintavin|kalliimpi|kallein|maksaa paljon|paljonko maksaa|mitä maksaa/.test(t);
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

      // Tunnista toinen brändi vertailukysymyksissä ("Acana vai Grandorf", "Acana vs Grandorf")
      if (detectedBrand && /vai|vs|versus|vertaa|verrattuna/.test(latestUserText)) {
        for (const vendor of vendors) {
          if (vendor === detectedBrand) continue;
          const base2 = vendor.replace(/[^a-zäöå]/g, '');
          if (
            latestUserText.includes(vendor) ||
            latestUserText.includes(base2 + 'in') ||
            latestUserText.includes(base2 + 'ia') ||
            latestUserText.includes(base2 + 'lla') ||
            latestUserText.includes(base2 + 'sta')
          ) {
            filters.brand2 = vendor;
            break;
          }
        }
      }

      // Tunnista kysytty brändi vaikka ei löytyisi valikoimasta
      // Laajempi pattern: kaikki brändiviittaukset
      // askedBrand-tunnistus poistettu — aiheutti liian paljon vääriä positiivisia
      // Jos brändi ei löydy vendor-listasta, Gemini käsittelee sen normaalisti
    }

    // 4. Tarkka tuotenimiehaku — viimeisin käyttäjäviesti JA viimeisin assistant-viesti (follow-up)
    const lastUserText = norm(messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '');
    const lastAssistantText = norm(messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '');
    // Yhdistä: hae tuotenimi käyttäjältä TAI assistentin edellisestä vastauksesta
    const searchText = lastUserText + ' ' + lastAssistantText;
    let exactProduct = null;
    let exactProducts = []; // kaikki mainitut tuotteet
    for (const p of products) {
      const pNorm = norm(p.n || '');
      if (pNorm.length >= 10 && searchText.includes(pNorm)) {
        exactProducts.push(p);
        if (!exactProduct || pNorm.length > norm(exactProduct.n).length) {
          exactProduct = p;
        }
      }
    }

        // 5d. Suora ainesosa/allergeeni -tarkistus — ohittaa Geminin täysin
    const ingredientAnswer = checkIngredientQuestion(messages, products);
    if (ingredientAnswer) {
      console.log('INGREDIENT CHECK: direct answer bypassing Gemini');
      return res.status(200).json({ reply: ingredientAnswer });
    }

    // 5e. Yleinen ainesosahaku kaikista tuotteista — "sisältääkö jokin ruoka X?"
    const lastUserMsgText = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const generalIngCheck = /sisältääkö jokin|onko teillä.*sisältää|löytyykö.*jossa on|löytyykö.*joka sisältää/.test(lastUserMsgText.toLowerCase());
    if (generalIngCheck) {
      const ingredientPatternsList = [
        { words: ['bataatti', 'bataattia'], name: 'bataatti' },
        { words: ['kana', 'kanaa'], name: 'kana' },
        { words: ['lohi', 'lohta'], name: 'lohi' },
        { words: ['peruna', 'perunaa'], name: 'peruna' },
        { words: ['lammas', 'lammasta'], name: 'lammas' },
        { words: ['ankka', 'ankkaa'], name: 'ankka' },
        { words: ['hirvi', 'hirveä'], name: 'hirvi' },
        { words: ['peura', 'peuraa'], name: 'peura' },
      ];
      const tLow = lastUserMsgText.toLowerCase();
      const matchedPat = ingredientPatternsList.find(p => p.words.some(w => tLow.includes(w)));
      if (matchedPat) {
        const found = products.filter(p => {
          const a = (p.a || '').toLowerCase();
          return matchedPat.words.some(w => a.includes(w));
        }).slice(0, 5);
        if (found.length > 0) {
          const list = found.map(p => `**${p.n}** (${p.m})`).join('\n');
          return res.status(200).json({ reply: `Valikoimastamme löytyy ${found.length > 5 ? 'mm.' : ''} seuraavat tuotteet joiden ainesosissa mainitaan **${matchedPat.name}**:

${list}

📋 Tarkistathan ainesosat tuotekorteista.` });
        } else {
          return res.status(200).json({ reply: `Tarkistamieni tuotetietojen perusteella valikoimastamme ei löydy tuotteita joiden ainesosissa mainitaan **${matchedPat.name}**. 📋 Tarkistathan kuitenkin tuotekorteista varmuuden vuoksi.` });
        }
      }
    }

    // 5c. Diagnostinen kysymys — ei tuotekontekstia
    if (detectDiagnosticQuestion(messages)) {
      console.log('DIAGNOSTIC QUESTION detected — no product context');
      // Poista tuotekonteksti kokonaan — Gemini vastaa asiantuntijana ilman tuotesuosituksia
      const systemPromptDiag = (HARDCODED_PROMPT || '') + '\n\n[OHJE: Tämä on diagnostinen kysymys. Vastaa asiantuntijana koiran terveydestä/käyttäytymisestä. ÄLÄ suosittele tuotteita ellei asiakas erikseen pyydä.]';
      const filteredMsgs = messages.filter((m, i) => !(i === 0 && m.role === 'assistant'));
      const lastUserIdx = filteredMsgs.map(m => m.role).lastIndexOf('user');
      const msgsForGemini = filteredMsgs.slice(0, lastUserIdx + 1);
      const geminiMsgs = msgsForGemini.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      const apiKey = process.env.GEMINI_API_KEY;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
      const gRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPromptDiag }] },
          contents: geminiMsgs,
          generationConfig: { maxOutputTokens: 2048, temperature: 0.3 }
        })
      });
      const gData = await gRes.json();
      const reply = gData.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Yritä uudelleen.';
      return res.status(200).json({ reply });
    }

    // 5b. Hintakysymys — vastaa suoraan backendistä
    if (detectPriceQuestion(messages)) {
      console.log('PRICE QUESTION detected');
      return res.status(200).json({
        reply: 'Palvelussamme ei ole hintatietoja, joten emme voi vertailla hintoja tai kertoa mikä on edullisin. Näet tuotteiden hinnat suoraan ostolinkistä verkkokauppaan. Voin sen sijaan auttaa löytämään koirallesi sopivimman ruoan muin kriteerein — kerro koirasi rotu, ikä ja mahdolliset erityistarpeet!'
      });
    }

    // 5a. Tuotemäärä-kysymys — vastaa suoraan backendistä, ei Geminiltä
    const userMsgsAll = messages.filter(m => m.role === 'user');
    const latestUserMsg = norm(userMsgsAll[userMsgsAll.length - 1]?.content || '');
    const isCountQuestion = /montako|kuinka monta|paljonko.*tuotett|monta.*tuotett/.test(latestUserMsg);
    // "Oletko varma?" tuotemäärästä — tarkista onko edellinen assistant-vastaus sisältänyt luvun
    const isDoubtQuestion = /oletko varma|ihan varma|täysin varma|oletko oikein|oletko.*oikein|varmista|tarkistat|pitääkö paikkansa|onko se oikein/.test(latestUserMsg);
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
      console.log('COUNT QUERY product names:', brandProducts.map(p => p.n).join(' | '));
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
          generationConfig: { maxOutputTokens: 2048, temperature: 0.3 },
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

    // Vertailuhaku: jos kaksi brändiä, hae molempien tuotteet
    if (filters.brand2) {
      const filters2 = { ...filters, brand: filters.brand2 };
      const matched2 = filterProducts(products, filters2);
      // Yhdistä: max 5 kummastakin
      matched = [...matched.slice(0, 5), ...matched2.slice(0, 5)];
      console.log('COMPARISON: brand1:', filters.brand, matched.length/2, '| brand2:', filters.brand2, matched2.length);
    }

    // Nosta tarkat tuotteet listan kärkeen (vertailukysymykset)
    if (exactProducts.length > 1) {
      const otherMatched = matched.filter(p => !exactProducts.find(ep => ep.n === p.n));
      matched = [...exactProducts, ...otherMatched.slice(0, 2)];
    } else if (exactProduct) {
      const rest = matched.filter(p => p.n !== exactProduct.n).slice(0, 4);
      matched = [exactProduct, ...rest];
    }

    // 7. Rakenna tuotekonteksti
    let productCtx = '';

    if (filters.brand && matched.length === 0 && !exactProduct) {
      productCtx = buildBrandNotFoundMsg(filters.brand);
    } else if (hasFilters || exactProduct) {
      productCtx = buildProductContext(matched, filters);
    }

    // 8. Valikoiman yhteenveto
    const productTypes = [...new Set(products.map(p => p.tt || '').filter(Boolean))];
    const brands = [...new Set(products.map(p => p.m || '').filter(Boolean))];
    const catalogSummary = `\n\n[VALIKOIMAN TIEDOT: ${products.length} tuotetta, ${brands.length} merkkiä. Tuotetyypit: ${productTypes.length > 0 ? productTypes.join(', ') : 'kuivaruoka'}. Jos asiakas kysyy tuotetyypistä jota ei listalla ole, kerro rehellisesti ettei sitä ole valikoimassa.]`;

    // Injektoi tarkka tuotemäärä system promptiin jos brändi tunnistettu
    // Näin Gemini tietää oikean luvun eikä voi keksiä uutta
    const brandCountInstruction = filters.brand ? (() => {
      const brandProducts = products.filter(p =>
        norm(p.m || '').includes(norm(filters.brand)) || norm(p.n || '').includes(norm(filters.brand))
      );
      const brandDisplay = filters.brand.charAt(0).toUpperCase() + filters.brand.slice(1);
      return `\n\n[TIETOKANTAFAKTA – ÄLÄ MUUTA: ${brandDisplay}-tuotteita on valikoimassamme TASAN ${brandProducts.length} kappaletta. Jos asiakas kysyy montako tai kyseenalaistaa luvun, vastaa AINA ${brandProducts.length}. Älä koskaan sano muuta lukua.]`;
    })() : '';

    const noProductInstruction = !productCtx
      ? '\n\nOHJE: Tässä viestissä ei ole tuotetietokantahakua. Et tiedä mitä tuotteita on valikoimassa. ÄLÄ mainitse yhtään tuotteen nimeä, merkkiä tai linkkiä. Kysy ensin lisätietoja koirasta.'
      : '';

    const systemPrompt = (HARDCODED_PROMPT || '') + catalogSummary + brandCountInstruction + noProductInstruction;

    console.log('filters:', JSON.stringify({ brand: filters.brand, excl: filters.excl, want: filters.want, age: filters.age, size: filters.size, store: filters.store }));
    console.log('hasFilters:', hasFilters, '| matched:', matched.length, '| exactProduct:', exactProduct?.n || null);
  

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
        generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
      }),
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, err.substring(0, 500));
      return res.status(502).json({ error: `Gemini error: ${geminiRes.status}` });
    }

    const data = await geminiRes.json();
    let reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Yritä uudelleen.';
    // Poista hallusinoituja väitteitä
    // Tauriini jota ei ole ainesosissa
    reply = reply.replace(/,?\s*kuten tauriini[^.]*\./gi, '.');
    reply = reply.replace(/,?\s*tauriini[a-zäöå]*[^.]*hermoston toiminta[^.]*\./gi, '.');
    reply = reply.replace(/\s*Se sisältää myös tauriinia[^.]*\./gi, '');
    // Energiapitoisuudet MJ/kg ja kcal jotka eivät tule tietokannasta
    reply = reply.replace(/\(käyttäen [^)]*energiamäärä on [\d.,]+ MJ\/kg\)/gi, '');
    reply = reply.replace(/jonka energiamäärä on [\d.,]+ MJ\/kg/gi, '');
    reply = reply.replace(/energiamäärä on [\d.,]+ MJ\/kg[^.]*\./gi, 'Tarkista annostus pakkauksen ohjeista.');
    reply = reply.replace(/noin [\d]+-[\d]+ kcal päivässä[^.]*\./gi, 'Tarkista annostus pakkauksen ohjeista.');
    reply = reply.replace(/tarvitsee noin [\d]+-[\d]+ kcal[^.]*\./gi, 'Tarkista annostus pakkauksen ohjeista.');
    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Handler error:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}
