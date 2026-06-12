// api/chat.js — Hauku v7 — JSON-tietokanta
// MUUTOKSET v6 → v7:
//  - sessionData sisältää nyt myös "vapaa"-listan (mitä tuote EI sisällä)
//    → jatkokysymyksissä malli näkee allergiadatan eikä joudu arvaamaan
//  - detectFollowUp: selkeä viittaus aiempaan tuotteeseen ("sisältääkö eka
//    kanaa?") menee nyt jatkokysymyspolkuun, vaikka viestissä on allergeenisana
//  - Jatkokysymys- ja meta-polut saavat eksplisiittisen ohjeen: jos kysyttyä
//    tietoa ei ole annetussa datassa, vastaa "en voi vahvistaa" — EI arvailua
//  - Yleinen polku (5): malli ei saa mainita yhtään tuotenimeä, koska sille
//    ei anneta tuotedataa

import { extractFilters, filterProducts, buildDirectProductResponse } from '../lib/filters.js';
import { getProducts } from '../lib/products.js';
import { SYSTEM_PROMPT } from '../lib/system-prompt.js';

// ── Sessiomuisti ──────────────────────────────────────────────────────────
// HUOM: Vercelin serverless-ympäristössä tämä Map ei säily kutsujen välillä
// luotettavasti (jokainen kylmäkäynnistys tyhjentää sen). Varsinainen
// pysyvyys tulee getProductsFromHistory-funktiosta, joka lukee tuotteet
// viestihistorian <hauku_data>-blokeista.
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
function detectFollowUp(msg, sessionProducts) {
  if (!sessionProducts?.length) return false;
  const t = norm(msg);

  // Uuden haun signaalit ohittavat kaiken
  if (/etsi|etsin|suosittele|löytyykö|loytyyko|haen|sopivaa ruokaa|mita ruokaa|mitä ruokaa/.test(t)) return false;

  // MUUTOS: selkeä viittaus aiempaan tuotteeseen tarkistetaan ENNEN
  // allergeenisanoja. "Sisältääkö eka kanaa?" on jatkokysymys aiemmasta
  // tuotteesta — ei uusi haku — ja se pitää vastata tuotedatalla,
  // ei arvaamalla.
  const hasRef =
    /\beka\b|\btoka\b|\bkolmas\b|\bensimmäinen\b|\btoinen\b|\bviimeinen\b|\bse\b|\btuo\b|\btoi\b|\btämä\b|\btää\b/.test(t) ||
    /\b1\.\b|\b2\.\b|\b3\.\b/.test(msg) ||
    (/paljonko|sisältääkö|sisaltaako|sopiiko|mikä ero|mika ero|miten ero/.test(t) && t.split(' ').length <= 10);

  const isChallenge = /^miksi|^miks|eihän|eikö|oletko varma|ne on väärä|nuo ei|mitä tarkoitat|mita tarkoitat|mitä se|mita se|selitä|selita/.test(t);

  if (hasRef || isChallenge) return true;

  // Uutta tietoa koirasta ilman viittausta aiempaan = uusi haku
  if (/kk ikain|vuotias|pentu|seniori|peten|haukkula|zooplus|allergi|kana|nauta|lammas|kala/.test(t)) return false;

  return false;
}

// ── Tuotekontekstin rakennus mallille ─────────────────────────────────────
// MUUTOS: sisältää nyt "Ei sisällä" -listan, joka on ainoa allergiadata
// jonka tietokanta tarjoaa. Malli ohjeistetaan vastaamaan VAIN tällä datalla.
function buildProductCtx(products) {
  return products.map((p, i) => {
    const vapaa = (p.vapaa || []).slice(0, 25);
    const aines = (p.ainesosat || '').trim();
    return `${i + 1}. ${p.nimi}
   Ainesosat: ${aines ? aines.slice(0, 600) : 'EI SAATAVILLA'}
   Ravintoaineet: ${(p.ravinto || '').trim() ? (p.ravinto || '').slice(0, 300) : 'EI SAATAVILLA'}
   Ei sisällä (vahvistettu): ${vapaa.length ? vapaa.join(', ') : 'EI TIETOA'}
   Rasvataso: ${p.rasva || 'ei tietoa'}
   Erikoisominaisuudet: ${(p.erikois || []).join(', ') || '-'}
   Linkki: ${p.linkki || '-'}`;
  }).join('\n');
}

const NO_GUESS_RULE = `
KRIITTINEN TURVALLISUUSSÄÄNTÖ — LUE TARKKAAN:
- Jos tuotteella on "Ainesosat"-lista yllä: kun kysytään sisältääkö tuote
  jotain, lue lista SANA SANALTA, huomioi myös osittaiset osumat
  ("kananrasva" sisältää kanaa). Vastaa vain listan perusteella.
- Jos tuotteen kohdalla lukee "Ainesosat: EI SAATAVILLA": tiedät VAIN mitä
  tuote EI sisällä ("Ei sisällä" -lista). Jos kysytty ainesosa on listalla →
  tuote ei sisällä sitä. Jos EI ole listalla → vastaa: "En voi vahvistaa
  tätä varmasti — tarkistathan tuotesivulta tai pakkauksesta."
- ÄLÄ KOSKAAN päättele, arvaa tai oleta. Väärä vastaus allergiakysymykseen
  voi olla koiralle hengenvaarallinen.
- Sama sääntö ravintoarvoille, annosmäärille ja kaikelle datalle jota yllä
  ei ole.`;

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
          // Yhdistä takaisin täyteen tuotedataan nimellä → saadaan koko
          // vapaa-lista vaikka vanha hauku_data olisi suppea
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
    const allProducts = await getProducts(); // Shopify-haku on async
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
      const followUpPrompt = SYSTEM_PROMPT +
        '\n\n[JATKOKYSYMYS — vastaa lyhyesti, ÄLÄ generoi uutta tuotelistaa]' +
        '\nAiemmin löydetyt tuotteet ja niiden AINOA käytettävissä oleva data:\n' +
        buildProductCtx(sessionProducts) +
        '\n' + NO_GUESS_RULE;

      const reply = await callGemini(
        followUpPrompt,
        messages.filter((m, i) => !(i === 0 && m.role === 'assistant')).slice(-6)
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: (m.content || '').replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }] })),
        apiKey, 600
      );
      return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });
    }

    // ── 3. META-KYSYMYS (käyttäjä kysyy edellisestä vastauksesta) ──────────
    const isMetaQ =
      /tarkoittaa|tarkoitat|selitä|selita/.test(latestNorm) ||
      /löydettyjä tuotteita|loydettyja|kappaletta|sopivaa tuotetta/.test(latestNorm);
    if (isMetaQ) {
      const prevProds = loadSession(conversationId) || getProductsFromHistory(messages, allProducts);
      const ctx = prevProds.length
        ? '\n\n[Konteksti — aiemmin löydetyt tuotteet]\n' + buildProductCtx(prevProds) + '\n' + NO_GUESS_RULE
        : '';
      const reply = await callGemini(
        SYSTEM_PROMPT + ctx + '\n\n[Selitä lyhyesti mitä tarkoitit. ÄLÄ generoi uutta tuotelistaa.]',
        messages.filter((m, i) => !(i === 0 && m.role === 'assistant'))
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: (m.content || '').replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }] })),
        apiKey, 400
      );
      return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });
    }

    // ── 4. SUODATUS JA TUOTEHAKU ─────────────────────────────────────────
    const extracted = extractFilters(messages);
    const pre = preFilters || {};
    const filters = {
      ...extracted,
      age:   pre.age   || extracted.age,
      store: pre.store || extracted.store,
      size:  pre.size  || extracted.size,
      // MUUTOS: allergeenit YHDISTETÄÄN, ei korvata. Jos ohjattu flow antaa
      // "Kana" ja käyttäjä kirjoittaa lisäksi "myös nauta-allergia",
      // molemmat pysyvät voimassa.
      excl:  [...new Set([...(pre.excl || []), ...(extracted.excl || [])])],
      brand: null,
    };

    const hasFilters = !!(
      filters.excl?.length || filters.age || filters.size ||
      filters.store || filters.specialDiets?.length
    );

    if (hasFilters) {
      let matched = filterProducts(allProducts, filters);

      // Fallback: jos ei tuloksia, löyhennä erikoisruokavalioita.
      // HUOM: allergeenipoissulkuja (excl) EI koskaan löyhennetä.
      if (matched.length === 0 && filters.specialDiets?.length) {
        matched = filterProducts(allProducts, { ...filters, specialDiets: [] });
      }

      if (matched.length === 0) {
        return res.status(200).json({
          reply: 'Näillä kriteereillä ei löydy sopivia tuotteita valikoimastamme. Haluatko kokeilla löyhemmillä rajoituksilla? (Allergiarajoituksista en jousta turvallisuussyistä.)'
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

      // Tallenna sessio — MUUTOS: vapaa-lista mukaan, jotta jatkokysymykset
      // allergioista voidaan vastata datalla eikä arvaamalla
      const sessionData = matched.slice(0, 5).map(p => ({
        nimi: p.nimi,
        rasva: p.rasva,
        erikois: p.erikois?.slice(0, 4),
        vapaa: (p.vapaa || []).slice(0, 25),
        ainesosat: (p.ainesosat || '').slice(0, 400),
        ravinto: (p.ravinto || '').slice(0, 300),
        linkki: p.linkki,
      }));
      if (conversationId) saveSession(conversationId, sessionData);

      const hidden = '\n<hauku_data>' + JSON.stringify(sessionData) + '</hauku_data>';
      return res.status(200).json({ reply: (intro ? intro + '\n\n' : '') + productList + hidden });
    }

    // ── 5. YLEINEN KOIRAKYSYMYS ───────────────────────────────────────────
    // MUUTOS: mallille kerrotaan eksplisiittisesti ettei sillä ole tuotedataa
    // tässä tilassa, joten se EI saa mainita yhtään tuotenimeä. Tämä poistaa
    // suurimman hallusinaatiolähteen.
    const reply = await callGemini(
      SYSTEM_PROMPT + `\n\n[TILA: YLEINEN KESKUSTELU — sinulle EI ole annettu tuotedataa tässä viestissä. ÄLÄ mainitse, suosittele tai nimeä YHTÄÄN yksittäistä tuotetta tai tuotemerkkiä. Jos asiakas haluaa tuotesuosituksia, kysy koiran tiedot (ikä, koko/rotu, allergiat) — haku tehdään niiden perusteella automaattisesti.]`,
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
