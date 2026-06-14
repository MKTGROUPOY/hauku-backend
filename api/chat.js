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
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const cand = data.candidates?.[0];
  const text = cand?.content?.parts?.[0]?.text;
  if (text) return text;

  // Tyhjä vastaus — selvitä syy ja heitä virhe jotta se näkyy lokeissa/widgetissä
  const reason = cand?.finishReason || data.promptFeedback?.blockReason || 'UNKNOWN';
  throw new Error(`Gemini empty response (reason: ${reason})`);
}

// ── Onko jatkokysymys? ────────────────────────────────────────────────────
// Vain selkeät viittaukset aiempiin tuotteisiin — ei tavalliset suomen sanat
function detectFollowUp(msg, sessionProducts) {
  // Ei aiempaa tuotelistaa -> ei voi olla jatkokysymys, tehdään uusi haku
  if (!sessionProducts?.length) return false;
  const t = norm(msg);

  // Eksplisiittinen uusi hakupyyntö -> ei jatkokysymys
  // "Ehdota/näytä muita" tms = käyttäjä haluaa ERI tuotteita samoilla kriteereillä.
  // Tämä laukaisee UUDEN haun (uusi jitter -> eri satunnaisvalinta samasta poolista)
  // sen sijaan että jäädään selittämään 5 cachetun tuotteen pohjalta.
  const wantsOthers = /ehdota muita|näytä muita|nayta muita|anna muita|hae muita|toisia vaihtoehto|muita vaihtoehto|eri vaihtoehto|jotain muuta|muut vaihtoehdot|lisää vaihtoehtoja|lisaa vaihtoehtoja|muita tuotteita|toisia tuotteita|muita ehdotuksia|uusia vaihtoehto|uudet vaihtoehdot|uusia ehdotuksia|uusia tuotteita|täysin uudet|taysin uudet|kokonaan uudet|toisenlaisia|eri tuotteita|eri merke|toiselta merk|toiselta valmistaj|vaihda tuotteet|näytä toiset|nayta toiset|anna uudet|anna uusia|anna lisää|anna lisaa/;
  const isNewSearch = /etsi|etsin|suosittele|löytyykö|loytyykö|löytyisikö|loytyisiko|haen|sopivaa ruokaa|mita ruokaa|onko teilla/.test(t) || wantsOthers.test(t);
  if (isNewSearch) return false;

  // Uusi tieto koirasta (rotu/ikä/kauppa/uusi allergiailmoitus) -> uusi haku
  const hasNewContext = /vuotias|\bkk\b|\bpentu\b|seniori|peten|haukkula|zooplus|allergi/.test(t);
  if (hasNewContext) return false;

  // OLETUS: kun sessiossa on tuotteita ja viesti ei sisällä yllä olevia signaaleja,
  // käsitellään jatkokysymyksenä (esim. "paljonko rasvaa", "oletko varma",
  // "kerro lisää", "sisältääkö X", "entä Y" — riippumatta lauseen pituudesta)
  return true;
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

    let allProducts;
    try {
      allProducts = getProducts();
    } catch (err) {
      console.error('Hauku: tuotetietokannan lataus epäonnistui:', err.message);
      return res.status(200).json({
        reply: 'Tekninen häiriö tuotetietokannan lataamisessa. Yritä hetken päästä uudelleen.',
        error: 'products_load_failed: ' + err.message,
      });
    }
    if (!Array.isArray(allProducts) || allProducts.length === 0) {
      console.error('Hauku: allProducts tyhjä tai ei array. Tyyppi:', typeof allProducts, 'Pituus:', allProducts?.length);
      return res.status(200).json({
        reply: 'Tuotetietokanta on tilapäisesti tyhjä. Yritä hetken päästä uudelleen.',
        error: 'products_empty',
      });
    }

    const latestMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const latestNorm = norm(latestMsg);

    // ── 1. TURVALLISUUSTARKISTUKSET ──────────────────────────────────────
    // VAKAVAT SAIRAUDET: elin + sairaustermi -YHDISTELMÄ (ei tarkkoja yhdyssanoja,
    // koska "munuaistulehdus" != "munuaissairaus" eikä vanha lista kattanut sitä).
    // Tarkistetaan KAIKKI käyttäjän viestit (ei vain viimeisin) ja KERRAN mainittu
    // sairaus pysyy voimassa koko keskustelun ajan — botti ei saa "unohtaa" sitä
    // ja alkaa suositella ruokaa myöhemmissä viesteissä.
    const ORGAN_RX = /munuais|maksa|haima|sydän|virtsa|kilpirauhas|eturauhas|\bperna/;
    const DISEASE_RX = /tulehdus|sairaus|vajaatoiminta|\btauti|kasvain|ongelm|kivet|\bkivi|vika|krooninen|akuutti|koholla|kohon|heikentynyt|toimintahäiriö|diagnos|todettu|todennut/;
    const STANDALONE_RX = /diabetes|epilepsia|syöpä|kasvain|pankreatiitti|anemia|autoimmuuni|kardiomyopatia|\bdcm\b/;

    const userMsgsNorm = messages.filter(m => m.role === 'user').map(m => norm(m.content || ''));
    const medBlock = userMsgsNorm.some(m =>
      (ORGAN_RX.test(m) && DISEASE_RX.test(m)) || STANDALONE_RX.test(m)
    );

    if (medBlock) {
      return res.status(200).json({
        reply: '🏥 Tämä kuulostaa lääketieteelliseltä tilalta, joka vaatii eläinlääkärin arvion. En voi suositella ruokia tässä tilanteessa — väärä ruokavalio voi olla suoraan haitallinen tämän tyyppisissä sairauksissa.\n\nOta yhteyttä eläinlääkäriin, joka voi tarvittaessa määrätä erikoisruokavalion koirasi tilanteeseen sopivaksi.'
      });
    }
    if (/suklaa|ksylitoli|rusinat|viinirypäleet|sipuli söi|valkosipuli söi/.test(latestNorm)) {
      return res.status(200).json({ reply: '⚠️ **Mene välittömästi eläinlääkäriin.** Älä odota oireiden pahenemista.' });
    }

    // ── 2. JATKOKYSYMYS / TUOTEKOHTAINEN KYSYMYS ─────────────────────────
    const sessionProducts = loadSession(conversationId) || getProductsFromHistory(messages, allProducts);

    // Mainitseeko viesti suoraan jonkin tuotteen nimen? (esim. "kerro tästä: GRANDORF FRESH...")
    let mentionedProduct = null;
    const msgLow = latestMsg.toLowerCase();
    for (const p of allProducts) {
      if (p.nimi && p.nimi.length > 6 && msgLow.includes(p.nimi.toLowerCase())) {
        mentionedProduct = p;
        break;
      }
    }

    const isFollowUp = detectFollowUp(latestMsg, sessionProducts) || !!mentionedProduct;

    if (isFollowUp) {
      // TÄYDET tiedot JOKAISESTA session-tuotteesta JOKA KERTA — myös "ei sisällä" -lista.
      // Tämä on PAKOLLISTA: keskusteluhistoria rajataan (slice -8), joten aiemman
      // viestin sisältämä "ei sisällä" -lista voi pudota pois kontekstista.
      // Jos tätä ei toisteta jokaisessa jatkokysymyksessä, botti vastaa "ei tietoa"
      // vaikka tieto olisi olemassa — eli näyttää epäjohdonmukaiselta/hallusinoivalta.
      const ctx = sessionProducts.map((p, i) =>
        `${i + 1}. ${p.nimi}\n   Rasvataso: ${p.rasva || '-'}\n   Ikä: ${(p.ika||[]).join(', ') || '-'}\n   Koko: ${(p.koko||[]).join(', ') || '-'}\n   Erikoisominaisuudet: ${(p.erikois || []).join(', ') || '-'}\n   Tämä tuote EI sisällä: ${(p.vapaa||[]).join(', ') || '(ei tietoa)'}\n   Ostolinkki: ${p.linkki || '-'}`
      ).join('\n\n');

      const followUpPrompt = SYSTEM_PROMPT +
        '\n\n[JATKOKYSYMYS — vastaa käyttäjän kysymykseen alla olevan datan perusteella.]' +
        '\n\nAiemmin löydetyt tuotteet (TÄYDELLISET TIEDOT):\n' + (ctx || '(ei aiempaa listaa)') +
        '\n\nHUOM 1: "Tämä tuote EI sisällä" -lista on KÄÄNTEINEN — jos kysytty raaka-aine ON tässä listassa, tuote EI sisällä sitä (vastaa "Ei, ei sisällä X:ää").' +
        '\nHUOM 2: Jos kysytty ainesosa (esim. tarkka mauste kuten oregano) EI ole listassa eikä muuallakaan annetussa datassa, sano rehellisesti että tätä ei ole eritelty tietokannassa ja kehota tarkistamaan pakkauksesta. ÄLÄ arvaa.' +
        '\nHUOM 3: Tuotteen NIMI voi paljastaa pääraaka-aineen (esim. "...Lohi" = lohi/kala on pääproteiini) — voit käyttää tätä vastatessasi.' +
        '\nHUOM 4: "Viljaton" on ERI ASIA kuin yksittäinen vilja "ei sisällä" -listassa. ÄLÄ päättele "viljaton" sen perusteella että esim. Riisi on listassa — tarkista "Viljaton" AINOASTAAN Erikoisominaisuudet-kentästä.' +
        '\nHUOM 5 — KRIITTINEN: "Kaikille kokoluokille" tarkoittaa että tuote sopii KAIKKIIN kokoluokkiin MUKAAN LUKIEN "Erittäin suuri", "Suuri", "Keskikokoinen" ja "Pieni". Samoin "Kaikille ikäluokille" sopii KAIKKIIN ikäluokkiin (Pentu, Junior, Aikuinen, Senior). ÄLÄ KOSKAAN väitä tuotteen "ei sopivan" jollekin koko- tai ikäluokalle jos sen Koko/Ikä-kentässä lukee "Kaikille kokoluokille"/"Kaikille ikäluokille" — se sopii. Jos käyttäjä kyseenalaistaa tuotteen soveltuvuuden, tarkista annettu data: jos data sanoo tuotteen sopivan, VAHVISTA se, ÄLÄ pahoittele olematonta virhettä. Peräänny VAIN jos data oikeasti osoittaa ettei tuote sovi (Koko/Ikä-kenttä ei sisällä kysyttyä luokkaa eikä "Kaikille X" -merkintää).' +
        '\n\nKRIITTINEN MUOTOILUOHJE — TÄRKEÄ:' +
        '\n- Vastaa LYHYESTI, 1-4 lauseella PROOSANA. ÄLÄ toista tuotekortteja (ei "Rasvataso:", "Sopii:", "🛒 Osta" -rivejä) — ne näkyvät käyttäjälle JO edellisessä viestissä.' +
        '\n- ÄLÄ kirjoita ostolinkkejä uudelleen tässä vastauksessa.' +
        '\n- Jos käyttäjä sanoo aiemman valinnan olleen väärä (esim. tuote sisältää allergeenin, väärä koko/ikäluokka, "light"-ruoka vaikka ei pyydetty) — MYÖNNÄ virhe lyhyesti ja kehota painamaan "🔍 Etsi sopivat ruoat" -painiketta uudelleen jos haluaa uuden hakukierroksen (botti arpoo uudet vaihtoehdot samoilla kriteereillä).' +
        '\n- Jos käyttäjä pyytää "muita/toisia/eri vaihtoehtoja" — kerro lyhyesti että voit hakea uudet vaihtoehdot ja kehota painamaan hakupainiketta uudelleen, ÄLÄ keksi yksittäisiä tuotteita itse tähän vastaukseen.';

      const reply = await callGemini(
        followUpPrompt,
        messages.filter((m, i) => !(i === 0 && m.role === 'assistant')).slice(-8)
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: (m.content || '').replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }] })),
        apiKey, 350
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
        ? 'Aiemmin löydetyt tuotteet: ' + prevProds.map((p, i) => `${i + 1}. ${p.nimi}`).join(', ')
        : '';
      const reply = await callGemini(
        SYSTEM_PROMPT + (ctx ? '\n\n[Konteksti]\n' + ctx : '') + '\n\n[Selitä lyhyesti mitä tarkoitit. ÄLÄ generoi uutta tuotelistaa.]',
        messages.filter((m, i) => !(i === 0 && m.role === 'assistant'))
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: (m.content || '').replace(/<hauku_data>[\s\S]*?<\/hauku_data>/g, '') }] })),
        apiKey, 400
      );
      return res.status(200).json({ reply: reply || 'Yritä uudelleen.' });
    }

    // ── 4. SUODATUS JA TUOTEHAKU ─────────────────────────────────────────
    // Yhdistä pudotusvalikot (preFilters) + extractFilters (vapaa teksti).
    // Pudotusvalikko VOITTAA jos käyttäjä valitsi JOTAIN MUUTA kuin oletuksen
    // ("Kaikille ikäluokille" / "Kaikille kokoluokille") — silloin se on
    // eksplisiittinen valinta. Jos pudotusvalikko on oletuksessa, vapaa teksti
    // saa täydentää (esim. "3kk pentu" mainittu vain tekstikentässä).
    const extracted = extractFilters(messages);
    const pre = preFilters || {};

    const ageIsDefault  = !pre.age  || pre.age  === 'Kaikille ikäluokille';
    const sizeIsDefault = !pre.size || pre.size === 'Kaikille kokoluokille';

    const filters = {
      ...extracted,
      age:   ageIsDefault  ? (extracted.age  || pre.age  || null) : pre.age,
      size:  sizeIsDefault ? (extracted.size || pre.size || null) : pre.size,
      store: pre.store || extracted.store,
      excl:  (pre.excl?.length ? pre.excl : null) || extracted.excl,
      brand: null,
    };

    const hasFilters = !!(
      filters.excl?.length || filters.age || filters.size ||
      filters.store || filters.specialDiets?.length
    );

    if (hasFilters) {
      let matched = filterProducts(allProducts, filters);
      let droppedSpecialDiets = false;

      // Fallback: jos ei tuloksia, löyhennä erikoisruokavalioita — KERTO tästä käyttäjälle
      if (matched.length === 0 && filters.specialDiets?.length) {
        matched = filterProducts(allProducts, { ...filters, specialDiets: [] });
        droppedSpecialDiets = true;
      }

      if (matched.length === 0) {
        return res.status(200).json({
          reply: 'Näillä kriteereillä ei löydy sopivia tuotteita valikoimastamme. Haluatko kokeilla löyhemmillä rajoituksilla?'
        });
      }

      const productList = buildDirectProductResponse(matched, filters);
      const fallbackNote = droppedSpecialDiets
        ? `\n\n⚠️ Huom: täysin kriteerit (${filters.specialDiets.join(', ')}) täyttäviä tuotteita ei löytynyt muiden rajoitusten kanssa, joten näytän tuotteita ilman tätä rajausta — tarkista soveltuvuus erikseen.`
        : '';

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
      return res.status(200).json({ reply: (intro ? intro + '\n\n' : '') + productList + fallbackNote + hidden });
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
