// api/chat.js — Hauku v6 — JSON-tietokanta

import { extractFilters, filterProducts, buildDirectProductResponse } from '../lib/filters.js';
import { getProducts } from '../lib/products.js';
import { SYSTEM_PROMPT } from '../lib/system-prompt.js';

// ── Sessiomuisti ──────────────────────────────────────────────────────────
const sessions = new Map();
function saveSession(id, products) {
  if (!id || !products?.length) return;
  sessions.set(id, { data: products.slice(0, 30), ts: Date.now() });
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
  const wantsOthers = /ehdota muita|näytä muita|nayta muita|anna muita|hae muita|toisia vaihtoehto|muita vaihtoehto|eri vaihtoehto|jotain muuta|uusia vaihtoehto|uudet vaihtoehdot|uusia ehdotuksia|uusia tuotteita|täysin uudet|taysin uudet|kokonaan uudet|toisenlaisia|eri tuotteita|eri merke|toiselta merk|toiselta valmistaj|vaihda tuotteet|anna uudet|anna uusia/;
  const isNewSearch = /etsi|etsin|suosittele|löytyykö|loytyykö|löytyisikö|loytyisiko|haen|sopivaa ruokaa|mita ruokaa|onko teilla/.test(t) || wantsOthers.test(t);
  if (isNewSearch) return false;

  // Uusi tieto koirasta (rotu/ikä/kauppa/uusi allergiailmoitus) -> uusi haku
  // Uusi tieto koirasta (rotu/ikä/kauppa/uusi allergia tai rajaus) -> uusi haku.
  // "ei sisällä X", "ilman X", "ei kanaa" jne ovat uusia rajauksia -> uusi haku
  // (jotta filterProducts oikeasti poistaa allergeenin, ei jää follow-upiin
  // jossa Gemini vain "selittää" vanhaa listaa ja voi hallusinoida).
  const hasNewContext =
    /vuotias|\bkk\b|\bpentu\b|seniori|peten|haukkula|zooplus|allergi/.test(t) ||
    /ei sisäll|ei sisall|ilman|ei saa olla|ei varmasti|ei kana|ei lohi|ei kala|ei nauta|ei lamma|ei possu|ei vilja|ei herne|ei soija|ei peruna|ei riisi|ei ankka|ei kalkkuna|ei siipikarj|eikä|älä suosittele|ala suosittele/.test(t) ||
    // Tarkennukset jotka tarkoittavat UUTTA, tiukempaa hakua (ei vanhan selittämistä):
    /suunniteltu|suunnattu|tarkoitettu (nimenomaan|erityisesti|varsinaisesti)|nimenomaan.{0,20}(pennuille|pennulle|junioreille|senioreille|aikuisille)|varsinaisesti|oikeasti.{0,15}(pentu|penn)|ihan.{0,15}(pentu|penn)|haluan.{0,30}(suunniteltu|pennuille|pennulle|junioreille)|suurille pennuil|pienille pennuil|isoille pennuil/.test(t);
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

    // ── 0. PELKKÄ TERVEHDYS / JUTUSTELU ──────────────────────────────────
    // Jos käyttäjä kirjoittaa vain tervehdyksen tai lyhyttä jutustelua ilman
    // mitään hakukriteeriä (ei ikää, kokoa, allergiaa, kauppaa, ainesosaa eikä
    // sairautta), EI haeta tuotteita — vastataan keskustellen ja pyydetään
    // kertomaan koirasta. Tämä estää sen, että "moikka" laukaisisi koko valikoiman.
    const GREETING_RX = /^(moi|moikka|hei|heipä|heippa|terve|morjens|moro|hei vaan|huomenta|päivää|iltaa|hello|hi|tervehdys|moikkelis|moikkis|jelou|jou|no moi|yo|moimoi)[\s!.,?]*$/i;
    // Erota vapaa teksti rakenteellisesta ikä/koko-liitteestä (jonka widget lisää).
    // Tervehdys tunnistetaan VAIN vapaasta tekstistä, JOS liite on pelkät oletukset
    // ("Kaikille ikäluokille/kokoluokille"). Jos käyttäjä valitsi oikean ikä/koon,
    // se on hakukriteeri eikä tervehdys.
    // HUOM: norm() poistaa kaksoispisteet/pilkut, joten tarkistetaan normalisoitu muoto.
    const usedDefaultsOnly = /koiran ikä kaikille ikäluokille koko kaikille kokoluokille/i.test(latestNorm);
    const freeText = latestNorm.replace(/koiran ikä.*$/is, '').trim();
    const greetTarget = usedDefaultsOnly ? freeText : latestNorm.trim();
    const isPureGreeting = GREETING_RX.test(greetTarget);
    // Onko viestissä mitään hakuun viittaavaa?
    const searchScan = usedDefaultsOnly ? freeText : latestNorm;
    const hasAnySearchSignal = /pentu|junior|aikuinen|seniori|senior|vuotias|\bkk\b|pieni|keski|suuri|iso|rotu|allergi|herkk|vehnä|vilja|kana|nauta|kala|lohi|possu|lammas|ankka|kalkkuna|riisi|peruna|herne|soija|maissi|kaura|peten|haukkula|zooplus|ruoka|ruoki|sisält|vähärasva|korkearasva|rasva|nivel|iho|suolisto|hammas|paino|ruokavalio|merkki|brändi|brandi/.test(searchScan);
    const sessionAlready = (loadSession(conversationId) || []).length > 0;

    if (isPureGreeting && !hasAnySearchSignal && !sessionAlready) {
      return res.status(200).json({
        reply: 'Moikka! 🐾 Kerro koirastasi, niin etsin sopivia ruokia. Voit mainita esimerkiksi ikäluokan (pentu, aikuinen, senior), koon, mahdolliset allergiat tai erityistoiveet — vaikkapa "3-vuotias keskikokoinen, kana-allergia" tai "viljaton ruoka seniorille".'
      });
    }

    // ── 0b. META / IDENTITEETTI / BOTTIA KOSKEVAT KYSYMYKSET ─────────────
    // "Kuka sinut teki", "mitä tekoälyä käytät", "miten toimit" jne. EIVÄT ole
    // tuotehakuja. Vastataan kiinteästi (ei haeta tuotteita, ei vuodeta teknisiä
    // yksityiskohtia). Tunnistetaan vain jos EI ole hakukriteeriä mukana.
    const isMetaIdentity = /miten.{0,15}(rakennettu|toimit|tehty)|kuka.{0,15}(rakentanut|tehnyt|loi|kehittän)|mitä tekoäly|mika tekoaly|oletko.{0,10}(botti|tekoäly|robotti|ihminen|ai\b)|mikä.{0,10}(malli|tekoäly).{0,10}(olet|käytät)|gpt|gemini|chatgpt|kielimalli|miten sinut|mistä.{0,10}(tiedät|saat tiedot)|miten.{0,10}suosittelet/.test(latestNorm);
    if (isMetaIdentity && !hasAnySearchSignal) {
      return res.status(200).json({
        reply: 'Olen Hauku, RuokaKoiralle.fi:n koiranruoka-assistentti. 🐾 Autan löytämään koirallesi sopivan ruoan valikoimastamme sen iän, koon, mahdollisten allergioiden ja erityistarpeiden perusteella. Kerro koirastasi, niin etsin sopivia vaihtoehtoja!'
      });
    }

    // ── 0b2. HINTA / KÖYHYYS — EI KOSKAAN TUOTESUOSITUKSIA ───────────────
    // Tietokannassamme EI ole hintatietoja. Jos asiakas kysyy hinnasta, halvasta/
    // edullisesta ruoasta, tarjouksista TAI mainitsee olevansa rahaton/köyhä/
    // opiskelija budjettisyistä, EMME saa suositella tuotteita (emme voi arvioida
    // hintaa emmekä halua antaa harhaanjohtavaa "halpa"-suositusta). Ohjataan
    // asiakas vertailemaan hintoja itse kaupasta.
    const PRICE_RX = /halpa|halvin|halvempi|halvemp|edullis|edullisin|hinta|hinnal|hinnat|maksaa|kallis|kallein|budjet|tarjous|alennus|alennuks|säästä|saasta|rahaton|vähävarainen|vahavarainen|köyh|koyh|ei.{0,10}varaa|pienell.{0,10}budjet/.test(latestNorm);
    if (PRICE_RX) {
      return res.status(200).json({
        reply: 'En valitettavasti pysty vertailemaan tuotteiden hintoja — tietokannassamme ei ole hintatietoja, joten en voi suositella ruokia hinnan perusteella. Hinnat näet suoraan kauppojen verkkosivuilta (esim. Peten Koiratarvike, Koiratarvike Haukkula), ja sieltä voit vertailla edullisimmat vaihtoehdot.\n\nVoin kuitenkin auttaa löytämään koirallesi ravitsemuksellisesti sopivia ruokia iän, koon ja mahdollisten allergioiden perusteella — kerro koirastasi, niin etsin sopivia vaihtoehtoja!'
      });
    }

    // ── 0c. "PARAS / ENITEN" -TYYPPISET ARVOTTAVAT KYSYMYKSET ────────────
    // "Mikä on paras penturuoka", "mikä sisältää eniten lihaa" — emme voi
    // objektiivisesti väittää mitään "parhaaksi" emmekä vertailla määriä
    // luotettavasti. Ohjataan tarkentamaan tarpeet konkreettisesti.
    const isSuperlative = /\b(paras|parhain|paras mahdollinen|laadukkain|terveellisin|suositelluin|ykkös)\b/.test(latestNorm) ||
                          /eniten|vähiten|korkein|matalin/.test(latestNorm);
    // "paras X" ilman MUITA rajauksia (allergia, tarkka ikä vuosina, erikoisruokavalio)
    // -> ohjaa tarkentamaan. Pelkkä ikäluokka ("paras penturuoka") EI riitä, koska
    // emme voi nimetä yhtä "parasta" — mutta jos mukana on konkreettisia rajauksia,
    // annetaan haun edetä.
    const hasConcreteCriteria = /allergi|vuotias|\bkk\b|viljaton|vähärasva|nivel-ongelm|iho-ongelm|suolisto-ongelm|herkk|aktiivi|painonhall|\bkana\b|\bnauta\b|lammas|kala|lohi|possu/.test(latestNorm);
    if (isSuperlative && !hasConcreteCriteria) {
      return res.status(200).json({
        reply: 'Hyvä kysymys! "Parasta" ruokaa ei ole yksiselitteisesti — sopivin riippuu koirasi iästä, koosta, mahdollisista allergioista ja erityistarpeista. Kerro näistä, niin suosittelen juuri sinun koirallesi sopivia laadukkaita vaihtoehtoja. Esimerkiksi: "iso 3kk pentu, ei allergioita" tai "aktiivinen aikuinen, viljaton".'
      });
    }

    // ── 1. TURVALLISUUSTARKISTUKSET ──────────────────────────────────────
    // VAKAVAT SAIRAUDET: elin + sairaustermi -YHDISTELMÄ (ei tarkkoja yhdyssanoja,
    // koska "munuaistulehdus" != "munuaissairaus" eikä vanha lista kattanut sitä).
    // Tarkistetaan KAIKKI käyttäjän viestit (ei vain viimeisin) ja KERRAN mainittu
    // sairaus pysyy voimassa koko keskustelun ajan — botti ei saa "unohtaa" sitä
    // ja alkaa suositella ruokaa myöhemmissä viesteissä.
    // Elin/kehonosa-juuret — laajennettu kattamaan suolisto, suoli, vatsa, iho, nivel,
    // korva, silmä, hampaat jne. "suolistotulehdus" EI lauennut aiemmin koska
    // "suolisto" puuttui listalta.
    const ORGAN_RX = /munuais|maksa|haima|sydän|virtsa|kilpirauhas|eturauhas|\bperna|suolisto|suoli|vatsa|maha|iho|nivel|luusto|korva|silmä|hammas|hampa|keuhko|umpisuoli|peräsuoli|paksusuol|sappi|lonkka/;
    // VAKAVA sairaustermi elimen kanssa — EI sisällä pelkkää "ongelm", koska se on
    // erikoisruokavaliotermimme ("iho-ongelmat", "nivel-ongelmat", "suolisto-ongelmat"
    // ovat normaaleja hakukriteereitä, eivät diagnosoituja sairauksia).
    const SERIOUS_DISEASE_RX = /tulehdus|tulehtun|sairaus|vajaatoiminta|\btauti|kasvai|kivet|\bkivi|krooninen|akuutti|koholla|kohon|heikentynyt|toimintahäiriö|infektio|vika\b/;
    const STANDALONE_RX = /diabet|epilep|syöp|kasvai|pankreatiit|anemia|autoimmuun|kardiomyopat|\bdcm\b|\bibd\b|haavain|colitis|koliitti|gastriitti|enteriitti|cushing|addison|hypotyre|hypertyre|mukoseele/;

    // DIAGNOOSISANASTO laukaisee YKSINÄÄN: "todettiin/diagnosoitiin/eläinlääkäri
    // totesi" tarkoittaa AINA eläinlääkärin toteamaa sairautta, riippumatta siitä
    // mikä sairaus on kyseessä (kattaa myös harvinaiset diagnoosit kuten Addison,
    // Cushing, mukoseele joita ei voi listata etukäteen). AINOA poikkeus: jos
    // diagnoosi koskee VAIN allergiaa/herkkyyttä, se hoidetaan allergiasuodatuksella
    // eikä estona.
    const DIAGNOSED_RX = /\btodett|\btodennut|diagnos|sairastaa|diagnosoi|eläinlääkäri.{0,40}(totesi|sanoi|määräs|löys|epäilee)|lääkäri.{0,30}(totesi|löys|määräs|sanoi)/;

    const userMsgsNorm = messages.filter(m => m.role === 'user').map(m => norm(m.content || ''));

    function isDiagnosedDisease(m) {
      if (!DIAGNOSED_RX.test(m)) return false;
      // Jos viesti mainitsee VAIN allergian/herkkyyden eikä mitään muuta sairautta,
      // älä estä — allergia käsitellään suodatuksella (esim. "todettu kana-allergia").
      const mentionsAllergy = /allergi|herkk|ruoka-aine|atooppi|atopia/.test(m);
      const mentionsOther =
        ORGAN_RX.test(m) || SERIOUS_DISEASE_RX.test(m) || STANDALONE_RX.test(m) ||
        /kysta|fibroosi|stenoosi|dysplasia|insuffisienssi|reflux|refluksi|ummetus|liikatoiminta|sivuään|nivelrikko|niverikko/.test(m);
      if (mentionsAllergy && !mentionsOther) return false;
      // "todettiin [mikä tahansa tila]" -> estä
      return true;
    }

    const medBlock = userMsgsNorm.some(m =>
      (ORGAN_RX.test(m) && SERIOUS_DISEASE_RX.test(m)) ||
      STANDALONE_RX.test(m) ||
      isDiagnosedDisease(m)
    );

    // Onko sairausmaininta VAIN aiemmissa viesteissä (ei tässä uusimmassa)?
    // Jos niin, JA sessiossa on jo tuotteita, kyseessä on jatkokysymys jo
    // käsiteltyyn sairaustapaukseen (esim. "paljonko rasvaa tuotteessa X?").
    // Tällöin EI toisteta sairauslistaa — annetaan jatkokysymyksen edetä normaalisti.
    const latestIsMed =
      (ORGAN_RX.test(latestNorm) && SERIOUS_DISEASE_RX.test(latestNorm)) ||
      STANDALONE_RX.test(latestNorm) ||
      isDiagnosedDisease(latestNorm);
    const sessionHasProducts = (loadSession(conversationId) || []).length > 0;
    const isMedFollowUp = medBlock && !latestIsMed && sessionHasProducts;

    if (medBlock && !isMedFollowUp) {
      // Onko sairaudelle olemassa OTC-erikoisruokavaliokategoria valikoimassamme?
      // Nämä vastaavat tietokannan erikoisominaisuus-arvoja. Jos vaiva osuu johonkin
      // näistä, NÄYTÄ ne tuotteet — AINA eläinlääkärimuistutuksen kanssa. Jos ei osu
      // (esim. syöpä, epilepsia, sappirakon mukoseele), pelkkä eläinlääkäriohjaus.
      const allMed = userMsgsNorm.join(' ');
      const DISEASE_DIET_MAP = [
        { rx: /munuais/,                          diet: 'Munuaisten vajaatoiminta' },
        { rx: /maksa/,                            diet: 'Maksan vajaatoiminta' },
        { rx: /haima|pankrea/,                    diet: 'Haiman vajaatoiminta' },
        { rx: /virtsa|rakkokiv|struvii|oksalaat/, diet: 'Virtsakivet' },
        { rx: /diabet/,                           diet: 'Diabetes' },
      ];
      const matchedDiet = DISEASE_DIET_MAP.find(d => d.rx.test(allMed));

      if (matchedDiet) {
        const dietProducts = filterProducts(allProducts, {
          excl: [], age: null, size: null, store: null, specialDiets: [matchedDiet.diet],
          allowVetDiet: true,
        });
        if (dietProducts.length > 0) {
          const list = buildDirectProductResponse(dietProducts, {});
          // Viittaa elimeen/aihealueeseen yleisesti — EI väitä tiettyä diagnoosia
          // jota asiakas ei maininnut (esim. asiakas sanoi "haimatulehdus", ei
          // "haiman vajaatoiminta"). Kategoria on vain sisäinen suodatusperuste.
          const dietArea = {
            'Munuaisten vajaatoiminta': 'munuaisten toimintaan',
            'Maksan vajaatoiminta': 'maksan toimintaan',
            'Haiman vajaatoiminta': 'haiman toimintaa tukemaan',
            'Virtsakivet': 'virtsateiden terveyteen',
            'Diabetes': 'diabeteksen hallintaan',
          }[matchedDiet.diet] || 'tähän vaivaan';
          const intro =
            `🏥 **Tärkeää:** Kuvailemasi tila on lääketieteellinen, ja ruokavaliosta on aina syytä keskustella eläinlääkärin kanssa ennen muutoksia — hän tuntee koirasi tilanteen ja voi tarvittaessa määrätä erityisruokavalion.\n\nValikoimastamme löytyy seuraavat ${dietArea} suunnitellut ruoat, jotka voit ottaa puheeksi eläinlääkärin kanssa:\n\n`;
          const sessionData = dietProducts.slice(0, 8).map(p => ({
            nimi: p.nimi, rasva: p.rasva, erikois: p.erikois?.slice(0, 4), linkki: p.linkki,
          }));
          const hidden = '\n<hauku_data>' + JSON.stringify(sessionData) + '</hauku_data>';
          saveSession(conversationId, dietProducts.slice(0, 30));
          return res.status(200).json({ reply: intro + list + hidden });
        }
      }

      // Ei sopivaa kategoriaa (tai ei tuotteita) -> pelkkä eläinlääkäriohjaus
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

    // ── "NÄYTÄ LOPUT" — paljasta session piilossa olevat tuotteet ─────────
    // "anna loput", "kerro ne 3 myös", "näytä loput", "loput vaihtoehdot" tarkoittaa
    // EDELLISEN haun piilotettuja tuotteita (+N muuta) — EI uutta hakua. Tämä estää
    // hallusinaation (ennen tämä laukaisi uuden haun jossa Gemini keksi tuotteita).
    const wantsRest = /\b(loput|loppu(t|jen)?|ne kolme|ne \d|kaikki vaihtoehdot|näytä kaikki|nayta kaikki|kerro ne|anna ne|näytä loput|nayta loput|muut \d|loput vaihtoehdo|näytä muutkin)\b/.test(latestNorm);
    if (wantsRest && sessionProducts.length > 5) {
      const rest = sessionProducts.slice(5); // 6. eteenpäin
      if (rest.length > 0) {
        // Muodosta lista suoraan session-tuotteista (ne ovat jo oikeita, suodatettuja)
        const lines = rest.slice(0, 10).map(p => {
          let s = `**${p.nimi}**\nRasvataso: ${p.rasva || '-'}`;
          if (p.erikois?.length) s += `\nSopii: ${p.erikois.slice(0, 4).join(', ')}`;
          if (p.linkki) s += `\n🛒 [Osta](${p.linkki})`;
          return s;
        });
        const intro = rest.length <= 10
          ? `Tässä loput ${rest.length} vaihtoehtoa:`
          : `Tässä lisää vaihtoehtoja:`;
        const visibleData = rest.slice(0, 10);
        const hidden = '\n<hauku_data>' + JSON.stringify(visibleData) + '</hauku_data>';
        return res.status(200).json({
          reply: intro + '\n\n' + lines.join('\n\n') + '\n\n📋 Tarkistathan tuotteen tiedot ennen ostopäätöstä.' + hidden,
        });
      }
    }

    const isFollowUp = detectFollowUp(latestMsg, sessionProducts) || !!mentionedProduct;

    if (isFollowUp) {
      // Jos viesti mainitsi tuotteen nimeltä jota EI ole vielä sessiossa, lisää se.
      // Tämä mahdollistaa että "Sisältääkö X ankkaa?" -> "Kuinka paljon?" -ketju
      // toimii: ensimmäinen kysymys tallentaa tuotteen sessioon, jolloin jatkokysymys
      // löytää sen (eikä putoa uuteen hakuun tyhjän session takia).
      let activeProducts = sessionProducts.slice();
      if (mentionedProduct && !activeProducts.some(p => p.nimi === mentionedProduct.nimi)) {
        activeProducts = [mentionedProduct, ...activeProducts];
      }
      // Säilytä KOKO sessio (max 30) jotta "näytä loput" toimii myös jatkokysymysten
      // jälkeen — ei kutisteta 8:aan.
      if (activeProducts.length) saveSession(conversationId, activeProducts.slice(0, 30));

      // TÄYDET tiedot session-tuotteista — mutta vain ENSIMMÄISET 8 promptiin, jotta
      // konteksti ei kasva liian suureksi. "ei sisällä" -lista mukana joka kerta.
      const ctxProducts = activeProducts.slice(0, 8);
      const ctx = ctxProducts.map((p, i) =>
        `${i + 1}. ${p.nimi}\n   Rasvataso: ${p.rasvaTarkka || p.rasva || '-'}\n   Ikä: ${(p.ika||[]).join(', ') || '-'}\n   Koko: ${(p.koko||[]).join(', ') || '-'}\n   Erikoisominaisuudet: ${(p.erikois || []).join(', ') || '-'}\n   Pääproteiinit: ${(p.proteiinit||[]).join(', ') || '-'}\n   Ainesosat: ${p.ainesosat || '(ei eritelty tietokannassa)'}\n   Ravintoarvot: ${p.ravintoaineet || '(ei eritelty tietokannassa)'}\n   Tämä tuote EI sisällä (allergeenit): ${(p.vapaa||[]).join(', ') || '(ei tietoa)'}\n   Ostolinkki: ${p.linkki || '-'}`
      ).join('\n\n');

      const followUpPrompt = SYSTEM_PROMPT +
        '\n\n[JATKOKYSYMYS — vastaa käyttäjän kysymykseen alla olevan datan perusteella.]' +
        '\n\nAiemmin löydetyt tuotteet (TÄYDELLISET TIEDOT):\n' + (ctx || '(ei aiempaa listaa)') +
        '\n\nHUOM 1: "Tämä tuote EI sisällä" -lista on KÄÄNTEINEN — jos kysytty raaka-aine ON tässä listassa, tuote EI sisällä sitä (vastaa "Ei, ei sisällä X:ää").' +
        '\nHUOM 2 — AINESOSAT: Yllä on useimmille tuotteille TÄYSI ainesosaluettelo ("Ainesosat:"), ravintoarvot ("Ravintoarvot:") JA pääproteiinit ("Pääproteiinit:"). Kun käyttäjä kysyy sisältääkö tuote jotain (esim. kala, oregano, kurkuma, vilja), LUE KOKO ainesosaluettelo ALUSTA LOPPUUN ja poimi KAIKKI osumat — ei vain ensimmäistä. Esimerkki: jos kysytään "sisältääkö kalaa" ja luettelossa on "kummeliturska", "silli" JA "kalaöljy", luettele KAIKKI kolme ("sisältää kummeliturskaa, silliä ja kalaöljyä"). ÄLÄ pysähdy ensimmäiseen osumaan. Voit myös käyttää Pääproteiinit-kenttää (esim. "Kala" siellä = tuote sisältää kalaa). Jos kysytty asia EI löydy luettelosta → "Ei, ainesosaluettelon mukaan ei sisällä X:ää". Vain jos ainesosat on "(ei eritelty tietokannassa)" → kehota tarkistamaan pakkauksesta. ÄLÄ KOSKAAN arvaa äläkä jätä osumia mainitsematta.' +
        '\nHUOM 2c — "MITÄ KALAA / MITÄ LIHAA / SISÄLTÄÄKÖ LOHTA": Kun kysytään mitä kalaa/lihaa tuote sisältää TAI sisältääkö se tiettyä lajia, etsi luettelosta KAIKKI kyseisen kategorian ainesosat nimeltä. Kalalajeja voivat olla mm.: turska, kummeliturska, silli, silakka, lohi, makrilli, sardiini, muikku, ahven, särki, lahna, kilohaili, kalaöljy, kalaliemi. Lihoja: kana, nauta, lammas, possu/sika, kalkkuna, ankka, riista, peura, hirvi, kani, hevonen. Luettele tuotteessa OLEVAT lajit nimeltä. Jos käyttäjä kysyy tiettyä lajia (esim. "sisältääkö lohta") jota EI luettelossa ole, vastaa "Ei sisällä lohta" ja KERRO mitä kalaa/lihaa se sen sijaan sisältää (esim. "ei lohta, mutta sisältää silakkaa, muikkua ja ahventa"). ÄLÄ sano "ei tarkempaa tietoa" jos luettelossa on nimettyjä lajeja.' +
        '\nHUOM 2b — RASVA%: Kun kysytään rasvaprosenttia, käytä "Rasvataso:" -kenttää joka sisältää nyt tarkan haarukan (esim. "Korkea (17-20%)"). Voit myös käyttää "Ravintoarvot:" -kenttää josta löytyy raakarasva tarkkana lukuna. Jos näitä ei ole eritelty, kehota tarkistamaan pakkauksesta.' +
        '\nHUOM 3: Tuotteen NIMI voi paljastaa pääraaka-aineen (esim. "...Lohi" = lohi/kala on pääproteiini) — voit käyttää tätä vastatessasi.' +
        '\nHUOM 4: "Viljaton" on ERI ASIA kuin yksittäinen vilja "ei sisällä" -listassa. ÄLÄ päättele "viljaton" sen perusteella että esim. Riisi on listassa — tarkista "Viljaton" AINOASTAAN Erikoisominaisuudet-kentästä.' +
        '\nHUOM 5 — KRIITTINEN: "Kaikille kokoluokille" tarkoittaa että tuote sopii KAIKKIIN kokoluokkiin MUKAAN LUKIEN "Erittäin suuri", "Suuri", "Keskikokoinen" ja "Pieni". Samoin "Kaikille ikäluokille" sopii KAIKKIIN ikäluokkiin (Pentu, Junior, Aikuinen, Senior). ÄLÄ KOSKAAN väitä tuotteen "ei sopivan" jollekin koko- tai ikäluokalle jos sen Koko/Ikä-kentässä lukee "Kaikille kokoluokille"/"Kaikille ikäluokille" — se sopii. Jos käyttäjä kyseenalaistaa tuotteen soveltuvuuden, tarkista annettu data: jos data sanoo tuotteen sopivan, VAHVISTA se, ÄLÄ pahoittele olematonta virhettä. Peräänny VAIN jos data oikeasti osoittaa ettei tuote sovi (Koko/Ikä-kenttä ei sisällä kysyttyä luokkaa eikä "Kaikille X" -merkintää).' +
        '\n\nKRIITTINEN MUOTOILUOHJE — TÄRKEÄ:' +
        '\n- Vastaa LYHYESTI, 1-4 lauseella PROOSANA. ÄLÄ toista tuotekortteja (ei "Rasvataso:", "Sopii:", "🛒 Osta" -rivejä) — ne näkyvät käyttäjälle JO edellisessä viestissä.' +
        '\n- ÄLÄ kirjoita ostolinkkejä uudelleen tässä vastauksessa.' +
        '\n- Jos käyttäjä sanoo aiemman valinnan olleen väärä (esim. tuote sisältää allergeenin, väärä koko/ikäluokka, "light"-ruoka vaikka ei pyydetty) — MYÖNNÄ virhe lyhyesti ja kehota painamaan "🔍 Etsi sopivat ruoat" -painiketta uudelleen jos haluaa uuden hakukierroksen (botti arpoo uudet vaihtoehdot samoilla kriteereillä).' +
        '\n- Jos käyttäjä pyytää "muita/toisia/eri vaihtoehtoja" tai tarkentaa hakuaan (esim. "haluan suurille pennuille suunnitellun"), ÄLÄ keksi yksittäisiä tuotteita itse äläkä viittaa mihinkään "hakupainikkeeseen" (sellaista EI ole). Sano lyhyesti että haet uudet vaihtoehdot — järjestelmä tekee uuden haun automaattisesti.';

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

    // ── 3b. AINESOSAHAKU ("onko ruokia jotka sisältävät X") ──────────────
    // Kun käyttäjä kysyy tiettyä ainesosaa SISÄLTÄVIÄ ruokia (ei allergiaa eli
    // poissulkua, vaan nimenomaan "sisältää"), haetaan suoraan ainesosakentästä.
    // Tämä estää hallusinaation: ennen Gemini "keksi" tuotteen joka ei edes ollut
    // valikoimassa. Nyt haetaan oikeasti datasta.
    const wantsIngredient = /sisält(ää|yy|ävi)|joissa on|jossa on|löytyykö.*sisält|onko.*joissa|jotka sisält/.test(latestNorm);
    if (wantsIngredient && !sessionHasProducts) {
      // Poimi mahdollinen ainesosa. HUOM: JS:n \w EI matchaa ä/ö, joten käytetään
      // eksplisiittistä suomalaista merkkiluokkaa [a-zäöå]+.
      const W = '[a-zäöå]+';
      const m = latestNorm.match(new RegExp(`sisält${W}?\\s+(${W})|joissa on\\s+(${W})|jossa on\\s+(${W})`));
      let term = m ? (m[1] || m[2] || m[3] || '').trim() : '';
      // Karsi yleiset täytesanat
      if (term && term.length >= 3 && !/ruoki|ruoka|tuott|niit|sit|tät/.test(term)) {
        // Suomen taivutus: pudota loppu-vokaali/pääte ("silliä"->"silli", "lohta"->"loh")
        const stem = term.replace(/(aa|ää|ta|tä|lle|lla|llä|ssa|ssä|a|ä|n)$/u, '');
        const matches = allProducts.filter(p =>
          p.ainesosat && (p.ainesosat.toLowerCase().includes(term) ||
                          (stem.length >= 4 && p.ainesosat.toLowerCase().includes(stem)))
        );
        if (matches.length > 0) {
          const list = buildDirectProductResponse(matches, {});
          const sessionData = matches.slice(0, 8).map(p => ({
            nimi: p.nimi, rasva: p.rasva, erikois: p.erikois?.slice(0, 4), linkki: p.linkki,
          }));
          const hidden = '\n<hauku_data>' + JSON.stringify(sessionData) + '</hauku_data>';
          saveSession(conversationId, matches.slice(0, 30));
          return res.status(200).json({ reply: list + hidden });
        } else {
          return res.status(200).json({
            reply: `En löytänyt valikoimastamme tuotteita joiden ainesosaluettelossa mainitaan "${term}". Voit kokeilla eri hakusanaa tai kertoa koirasi tarpeista, niin etsin sopivia ruokia.`,
          });
        }
      }
    }

    // ── 4. SUODATUS JA TUOTEHAKU ─────────────────────────────────────────
    // Yhdistä pudotusvalikot (preFilters) + extractFilters (vapaa teksti).
    // Pudotusvalikko VOITTAA jos käyttäjä valitsi JOTAIN MUUTA kuin oletuksen
    // ("Kaikille ikäluokille" / "Kaikille kokoluokille") — silloin se on
    // eksplisiittinen valinta. Jos pudotusvalikko on oletuksessa, vapaa teksti
    // saa täydentää (esim. "3kk pentu" mainittu vain tekstikentässä).
    const extracted = extractFilters(messages);
    const pre = preFilters || {};

    // OIRE -> ERIKOISOMINAISUUS -kartoitus: jos käyttäjä kuvaa oiretta mutta ei anna
    // muuta hakukriteeriä, ohjataan haku relevantteihin erikoisruokiin (esim. kutina
    // -> iho-ongelmat, ripuli/ei syö -> suolisto-ongelmat/herkkä). Näin oirekysymys
    // löytää oikeasti sopivia tuotteita eikä näytä satunnaista koko valikoimaa.
    const symptomDiets = [];
    if (/kutis|kutin|raapi|kläm|iho|hilse|karva läht|karvanlähtö|punoit|näppyl/.test(latestNorm)) symptomDiets.push('Iho-ongelmat');
    if (/ripuli|löysä ulost|loysa ulost|oksent|näräst|kakkaa paljon|paljon kakka|ilmavaiv|röyht|vatsa|maha|suolist/.test(latestNorm)) symptomDiets.push('Suolisto-ongelmat');
    if (/ei syö|ei suostu syö|kieltäyty|nirso|maistuv/.test(latestNorm)) symptomDiets.push('Herkkä');

    const ageIsDefault  = !pre.age  || pre.age  === 'Kaikille ikäluokille';
    const sizeIsDefault = !pre.size || pre.size === 'Kaikille kokoluokille';

    const filters = {
      ...extracted,
      age:   ageIsDefault  ? (extracted.age  || pre.age  || null) : pre.age,
      size:  sizeIsDefault ? (extracted.size || pre.size || null) : pre.size,
      store: pre.store || extracted.store,
      excl:  (pre.excl?.length ? pre.excl : null) || extracted.excl,
      specialDiets: [...new Set([...(extracted.specialDiets || []), ...symptomDiets])],
      brand: null,
    };

    const hasFilters = !!(
      filters.excl?.length || filters.age || filters.size ||
      filters.store || filters.specialDiets?.length ||
      filters.monoProtein || filters.singleCarb
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

      // Oire-varauma: jos käyttäjä kuvaa OIRETTA (kutina, ripuli, oksentelu, ei syö,
      // laihtuminen), muistutetaan että oire ei välttämättä johdu ruoasta ja että
      // pitkittyneissä oireissa kannattaa konsultoida eläinlääkäriä. Ruoka voi silti
      // auttaa, joten näytetään vaihtoehtoja.
      const SYMPTOM_RX = /kutis|kutin|kläm|raapi|ripuli|löysä ulost|loysa ulost|oksent|näräst|naras|ei syö|ei suostu syö|kieltäyty|laiht|laihtu|nuhruinen turkki|hilse|karva läht|karvanlähtö|kakkaa paljon|paljon kakka|ilmavaiv|röyht/;
      const symptomNote = SYMPTOM_RX.test(latestNorm)
        ? '\n\n💡 Huom: kuvailemasi oire voi johtua monesta syystä eikä välttämättä ruoasta. Jos oire on pitkittynyt tai voimakas, kannattaa konsultoida eläinlääkäriä. Ruokavalio voi silti auttaa — alla vaihtoehtoja, jotka usein sopivat herkille tai oireileville koirille:'
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

      // Tallenna sessio: KOKO suodatettu lista (max 30) jotta "näytä loput" voi
      // näyttää oikeat piilossa olevat tuotteet ilman uutta hakua/hallusinaatiota.
      const sessionData = matched.slice(0, 30).map(p => ({
        nimi: p.nimi, rasva: p.rasva, erikois: p.erikois?.slice(0, 4), linkki: p.linkki,
      }));
      if (conversationId) saveSession(conversationId, sessionData);

      // Näkyvät tuotteet (hauku_data) = vain ensimmäiset, jotta widget ei näytä kaikkia
      const visibleData = sessionData.slice(0, 5);
      const hidden = '\n<hauku_data>' + JSON.stringify(visibleData) + '</hauku_data>';
      // Oire-varauma korvaa Geminin geneerisen intron (se on informatiivisempi)
      const leadIn = symptomNote ? symptomNote.trim() : (intro ? intro : '');
      return res.status(200).json({ reply: (leadIn ? leadIn + '\n\n' : '') + productList + fallbackNote + hidden });
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
