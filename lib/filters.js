// lib/filters.js — Tuotesuodatus JSON-tietokannalle

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

// ── Allergeenikartta: käyttäjän sana → JSON-kenttien nimet ────────────────
// Huom: JSON:ssa "ei_sisalla_naita_ainesosia" käyttää isoa alkukirjainta
// ALLERGEN_MAP käyttää LYHYITÄ KANTAMUOTOJA jotka kattavat suomen taivutukset.
// Esim. "kanal" kattaa "kanalle/kanalla", "ankal/ankk/ankan" kattaa
// "ankalle/ankka/ankan", "lampa" kattaa "lampaalle/lampaan". Tämä on tärkeää
// koska asiakkaat kirjoittavat "allerginen ankalle", ei "allerginen ankka".
const ALLERGEN_MAP = {
  'kana':        ['Kana', 'Kananrasva'],   // kana, kanalle, kanaa (kana-alkuiset)
  'kanan':       ['Kana', 'Kananrasva'],
  'siipikarj':   ['Kana', 'Kananrasva', 'Kalkkuna', 'Kalkkunanrasva', 'Ankka', 'Ankanrasva'],
  'kalkkun':     ['Kalkkuna', 'Kalkkunanrasva'], // kalkkuna, kalkkunalle, kalkkunaa
  'kananmuna':   ['Kananmuna'],
  'muna':        ['Kananmuna'],
  'nauta':       ['Nauta', 'Naudanrasva'],
  'naudal':      ['Nauta', 'Naudanrasva'], // naudalle, naudalla
  'naudan':      ['Nauta', 'Naudanrasva'], // naudanliha, naudan
  'lammas':      ['Lammas', 'Lampaanrasva'],
  'lampa':       ['Lammas', 'Lampaanrasva'], // lampaalle, lampaan, lampaasta
  'possu':       ['Possu', 'Sianrasva'],
  'porsa':       ['Possu', 'Sianrasva'], // porsas, porsaalle
  'sika':        ['Possu', 'Sianrasva'],
  'sial':        ['Possu', 'Sianrasva'], // sialle, sianliha
  'kala':        ['Kala', 'Kalaöljy', 'Lohi'], // kala, kalalle, kalaa
  'lohi':        ['Lohi', 'Kala', 'Kalaöljy'],
  'lohel':       ['Lohi', 'Kala', 'Kalaöljy'], // lohelle
  'lohiöljy':    ['Lohi', 'Kalaöljy'],
  'kalaöljy':    ['Kala', 'Kalaöljy'],
  'vehnä':       ['Vehnä'],
  'kaura':       ['Kaura'],
  'ohra':        ['Ohra'],
  'maissi':      ['Maissi'],
  'vilja':       ['Vehnä', 'Kaura', 'Ohra', 'Maissi'],
  'gluteeni':    ['Vehnä'],
  'herne':       ['Herne'],
  'hernee':      ['Herne'], // herneelle, herneen
  'soija':       ['Soija', 'Soijaöljy'],
  'peruna':      ['Peruna'],
  'perunal':     ['Peruna'], // perunalle
  'riisi':       ['Riisi'],
  'riisil':      ['Riisi'], // riisille
  'ankka':       ['Ankka', 'Ankanrasva'],
  'ankal':       ['Ankka', 'Ankanrasva'], // ankalle, ankalla
  'ankan':       ['Ankka', 'Ankanrasva'], // ankanliha, ankan
  'ankk':        ['Ankka', 'Ankanrasva'], // ankkaa
};

const ALLERGEN_TRIGGERS = [
  'allergi', 'herkk', 'ei sovi', 'vapaa', 'ei kestä',
  'ei voi syödä', 'ei saa syödä', 'intoleranssi', 'reagoi', 'ei siedä',
  'ei sisällä', 'ei sisalla', 'ilman', 'ei saa olla', 'ei halua', 'älä suosittele',
  'ala suosittele', 'ei varmasti', 'ei missään', 'ei missaan', 'eikö ole jotain',
];

// ── Iän täsmäys — TARKKA vastaavuus tietokannan arvoihin ──────────────────
// Sallitut arvot (vastaavat Shopify-metafieldejä JA widgetin pudotusvalikkoa):
//   "Kaikille ikäluokille", "Pentu & emo", "Pentu", "Junior", "Aikuinen", "Senior"
//
// Säännöt:
//  - filterAge puuttuu TAI on "Kaikille ikäluokille" -> ei suodateta iän mukaan
//  - PENTU ja PENTU & EMO ovat RAVITSEMUKSELLISESTI KRIITTISIÄ elämänvaiheita
//    (kasvava pentu / imettävä emo tarvitsee enemmän proteiinia, kalsiumia ja
//    energiaa). Näihin VAADITAAN eksplisiittinen merkintä — "Kaikille ikäluokille"
//    EI riitä, koska tavallinen aikuisruoka ei tue näitä vaiheita oikein.
//  - Muut ikäluokat (Junior/Aikuinen/Senior): "Kaikille ikäluokille" kelpaa wildcardina.
function ageMatches(productIka, filterAge) {
  if (!filterAge || filterAge === 'Kaikille ikäluokille') return true;

  // Pentu / Pentu & emo: vaadi eksplisiittinen merkintä (ei wildcard-läpäisyä)
  if (filterAge === 'Pentu' || filterAge === 'Pentu & emo') {
    // "Pentu & emo" -merkitty tuote sopii myös pelkkä "Pentu" -hakuun ja päinvastoin
    return productIka.includes('Pentu') || productIka.includes('Pentu & emo');
  }

  // Muut: tarkka osuma TAI "Kaikille ikäluokille" -wildcard
  if (productIka.includes('Kaikille ikäluokille')) return true;
  return productIka.includes(filterAge);
}

// ── Koon täsmäys — TARKKA vastaavuus tietokannan arvoihin ─────────────────
// Sallitut arvot: "Kaikille kokoluokille", "Pieni", "Keskikokoinen", "Suuri", "Erittäin suuri"
// Samat säännöt kuin iässä.
function sizeMatches(productKoko, filterSize) {
  if (!filterSize || filterSize === 'Kaikille kokoluokille') return true;
  if (productKoko.includes('Kaikille kokoluokille')) return true;
  return productKoko.includes(filterSize);
}

// ── Kaupan tunnistus URL:sta ──────────────────────────────────────────────
function getStore(linkki) {
  if (!linkki) return null;
  if (linkki.includes('petenkoiratarvike') || linkki.includes('pin.peten')) return 'peten';
  if (linkki.includes('haukkula')) return 'haukkula';
  if (linkki.includes('awin') || linkki.includes('zooplus')) return 'zooplus';
  return 'muu';
}

// ── Pääsuodatin ───────────────────────────────────────────────────────────
// Reseptiruoat (Hill's Prescription Diet, Royal Canin Veterinary, Virbac
// Veterinary HPM, Calibra/Advance Veterinary Diet, Natural Greatness Diet Vet).
// Näitä EI näytetä KOSKAAN tämän botin yleisissä hauissa: ne on tarkoitettu
// DIAGNOSOITUUN sairauteen eläinlääkärin määräyksellä. Jos asiakkaalla olisi
// tällainen tarve, medBlock-turvatarkistus (chat.js) on JO ohjannut hänet
// eläinlääkäriin — botti ei koskaan suosittele näitä omasta aloitteestaan.
// Testattu: 122/122 reseptiruokaa täsmää, 0 väärää positiivista (Forza10,
// Natura Diet, Exclusion Diet, Rocco Diet Care, Hill's Science Plan eivät täsmää).
const VET_DIET_RX = /prescription diet|presciption diet|veterinary diet|diet vet|veterinary hpm|veterinary canine/i;

// KÄÄNTEINEN LOGIIKKA allergeeneille:
// Tuote läpäisee suodatuksen VAIN jos se listaa kyseisen allergeenin
// "ei_sisalla_naita_ainesosia" -kentässä (= tuote on vapaa siitä)
export function filterProducts(products, filters) {
  if (!products?.length) return [];

  // allowVetDiet: poikkeustilanteessa (asiakkaalla diagnosoitu sairaus + jo annettu
  // eläinlääkärimuistutus) sallitaan myös reseptiruoat, koska ne ovat juuri näihin
  // vaivoihin tarkoitettuja. Normaalissa haussa (oletus) ne suodatetaan pois.
  const allowVetDiet = filters?.allowVetDiet === true;

  let filtered = products.filter(p => {
    // Reseptiruoat pois AINA paitsi jos allowVetDiet (lääketieteellinen konteksti)
    if (!allowVetDiet && VET_DIET_RX.test(p.nimi)) return false;

    // Ruokatyyppi (raaka / kuiva) — jos käyttäjä rajasi tyypin
    if (filters.ruokatyyppi) {
      const t = (p.ruokatyyppi || 'Kuivaruoka').toLowerCase();
      if (filters.ruokatyyppi === 'raaka' && !t.startsWith('raaka')) return false;
      if (filters.ruokatyyppi === 'kuiva' && !t.startsWith('kuiva')) return false;
    }

    // Kauppa
    if (filters.store) {
      const storeMap = { petenkoiratarvike: 'peten', haukkula: 'haukkula', zooplus: 'zooplus' };
      const wanted = storeMap[filters.store] || filters.store;
      if (getStore(p.linkki) !== wanted) return false;
    }

    // Allergeenit/poissulku — tuote hylätään jos se SISÄLTÄÄ poissuljetun
    // raaka-aineen. Tarkistus on fail-closed allergeeneille: jos tuote LISTAA
    // raaka-aineen vapaa-listassaan (julistaa olevansa siitä vapaa), se on turvallinen;
    // muuten katsotaan sisältääkö se ainesosan proteiineissa tai ainesosaluettelossa.
    for (const allergen of (filters.excl || [])) {
      const a = allergen.toLowerCase();
      const inProteins = (p.proteiinit || []).some(pr => pr.toLowerCase() === a);
      if (filters.whitelistMode) {
        // WHITELIST: rajaus koskee VAIN pääproteiineja (esim. "saa syödä vain peuraa").
        // Hivenaineet kuten kalaöljy eivät diskvalifioi peuraruokaa.
        if (p.vapaa.includes(allergen)) continue;
        if (inProteins) return false;
        continue;
      }
      // ALLERGEENI (fail-closed): tarkista ainesosaluettelo sanarajalla.
      // Ainesosanäyttö VOITTAA "vapaa"-julistuksen: jos tuotteen ainesosissa lukee
      // esim. "kananmaksa", se EI ole kanaton, vaikka metafield niin väittäisi
      // (kaupan datassa on ristiriitoja — turvallisuus edellä).
      const ainesosatLow = (p.ainesosat || '').toLowerCase();
      const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wordRx = new RegExp(`(^|[^a-zäöå])${esc}`, 'i');
      // Erikoistapaus: "kana" EI saa osua sanaan "kananmuna" (muna ≠ liha) jos
      // käyttäjä on kieltänyt kanan muttei kananmunaa. Poistetaan kananmuna-sanat
      // ennen kana-tarkistusta.
      let checkText = ainesosatLow;
      if (a === 'kana' && !filters.excl.includes('Kananmuna')) {
        checkText = checkText.replace(/kananmuna\w*/g, '');
      }
      const inIngredients = wordRx.test(checkText);
      if (inProteins || inIngredients) return false;
      // Ei proteiineissa eikä ainesosissa -> tämän allergeenin osalta ok
      if (p.vapaa.includes(allergen)) continue;
    }

    // Ikä
    if (!ageMatches(p.ika, filters.age)) return false;

    // Koko
    if (!sizeMatches(p.koko, filters.size)) return false;

    // Erikoisominaisuudet
    if (filters.specialDiets?.length) {
      const erikoisStr = p.erikois.join(' ').toLowerCase();
      const hasAny = filters.specialDiets.some(d => erikoisStr.includes(d.toLowerCase()));
      if (!hasAny) return false;
    }

    // Rajatut raaka-aineet (yksiproteiininen / yksi hiilihydraatti)
    if (filters.monoProtein) {
      const r = (p.rajatut || []).join(' ').toLowerCase();
      if (!r.includes('yksi eläinproteiini') && !r.includes('yksi elainproteiini')) return false;
    }
    if (filters.singleCarb) {
      const r = (p.rajatut || []).join(' ').toLowerCase();
      if (!r.includes('yksi hiilihydraatti')) return false;
    }

    // Rasvataso
    if (filters.fatLevel) {
      const rasva = (p.rasva || '').toLowerCase();
      if (filters.fatLevel === 'low') {
        // vähärasvainen / kevyt -> Alhainen tai Erittäin alhainen
        if (!rasva.includes('alhainen')) return false;
      } else if (filters.fatLevel === 'high') {
        // korkearasvainen / energiapitoinen -> Korkea tai Erittäin korkea
        if (!rasva.includes('korkea')) return false;
      }
    }

    return true;
  });

  // Sorttaa: prioriteetti 1 ensin, sitten ikä/koko-osuvuus
  function score(p) {
    let s = p.prio === 1 ? 10 : 0;
    // Tarkka osuma (ei "Kaikille X" -wildcard) saa bonuksen — tuote on suunniteltu
    // JUURI tälle ikä/kokoluokalle, ei vain "sopii kaikille"
    if (filters.age && filters.age !== 'Kaikille ikäluokille' && p.ika.includes(filters.age)) s += 2;
    if (filters.size && filters.size !== 'Kaikille kokoluokille' && p.koko.includes(filters.size)) s += 1;
    return s;
  }

  // Satunnainen jitter (0-0.99) tasapelien sekoittamiseen joka haussa.
  // Lasketaan KERRAN per tuote ENNEN sorttausta, jotta comparator on
  // sisäisesti johdonmukainen (ei kutsuta Math.random() jokaisessa
  // vertailussa — se rikkoisi sortin). Sama tuote saa eri jitterin
  // joka kutsulla -> eri haku näyttää eri järjestyksen samalla pistemäärällä.
  const jitter = new Map();
  for (const p of filtered) jitter.set(p, Math.random());
  function scoreJ(p) { return score(p) + jitter.get(p); }

  filtered.sort((a, b) => scoreJ(b) - scoreJ(a));

  // Brändimonipuolisuus: estä saman brändin (tuotenimen 1. sana) dominointi kärjessä.
  // Poimitaan ensin paras edustaja eri brändeistä, sitten täytetään loput pisteytyksen mukaan.
  function brandOf(p) {
    return (p.nimi || '').split(/[\s,]+/)[0]?.toLowerCase() || '';
  }
  const seenBrands = new Set();
  const diverse = [];
  const rest = [];
  for (const p of filtered) {
    const b = brandOf(p);
    if (!seenBrands.has(b)) { seenBrands.add(b); diverse.push(p); }
    else rest.push(p);
  }
  // diverse on jo pisteytyksen mukaisessa (jitteröidyssä) järjestyksessä per brändin
  // paras tuote, ja brändien keskinäinen järjestys pitää myös pisteyttää samalla jitterillä
  diverse.sort((a, b) => scoreJ(b) - scoreJ(a));

  return [...diverse, ...rest];
}

// ── Tuotelistan muodostus ─────────────────────────────────────────────────
export function buildDirectProductResponse(products, filters) {
  if (!products?.length) return 'Sopivaa tuotetta ei löydy.';

  const storeLabel = {
    petenkoiratarvike: 'Peten Koiratarvike',
    haukkula: 'Koiratarvike Haukkula',
    zooplus: 'Zooplus',
  };
  const storeName = filters?.store ? storeLabel[filters.store] || '' : '';
  const storeSuffix = storeName ? ` ${storeName}lta` : '';

  // Näytä vain tuotteet joilla on linkki (prioriteetti 1) jos niitä on tarpeeksi
  const withLink = products.filter(p => p.linkki);
  const display = withLink.length >= 3 ? withLink : products;
  const count = display.length;
  const maxShow = Math.min(count, 5);

  let response = `Löysin ${count} sopivaa tuotetta${storeSuffix}:\n`;

  display.slice(0, maxShow).forEach(p => {
    response += `\n**${p.nimi}**\n`;
    if (p.proteiinit?.length) response += `Proteiini: ${p.proteiinit.join(', ')}\n`;
    if (p.hiilihydraatit?.length) response += `Hiilihydraatit: ${p.hiilihydraatit.join(', ')}\n`;
    if (p.rasva && p.rasva !== 'Tuntematon') response += `Rasvataso: ${p.rasva}\n`;
    if (p.erikois?.length) response += `Sopii: ${p.erikois.slice(0, 4).join(', ')}\n`;
    if (p.linkki) response += `🛒 [Osta](${p.linkki})\n`;
  });

  if (count > maxShow) {
    response += `\n(+${count - maxShow} muuta sopivaa tuotetta valikoimassamme)\n`;
    if (count <= 8) {
      // Pieni kokonaismäärä — kerro ettei enempää ole, ettei käyttäjä jää
      // pyytämään "lisää/uusia" tuotteita joita ei ole olemassa.
      response += `\nHuom: tämä on lähes koko valikoimamme näillä kriteereillä${storeSuffix} (yhteensä ${count} ${count === 1 ? 'tuote' : 'tuotetta'}). Laajemman valikoiman saat poistamalla joitakin rajauksia.\n`;
    }
  } else if (count <= maxShow && count > 0) {
    // Koko valikoima näillä kriteereillä on JO näytetty — kerro se selkeästi,
    // jotta käyttäjä ei jää pyytämään "lisää/uusia" tuotteita joita ei ole.
    response += `\nTämä on koko valikoimamme näillä kriteereillä${storeSuffix} (${count} ${count === 1 ? 'tuote' : 'tuotetta'}). Laajemman valikoiman saat poistamalla joitakin rajauksia (esim. kauppa tai kokoluokka).\n`;
  }

  response += '\n📋 Tarkistathan tuotteen tiedot ennen ostopäätöstä.';
  return response;
}

// ── Suodatusparametrien tunnistus käyttäjätekstistä ───────────────────────
export function extractFilters(messages) {
  const userMsgs = messages.filter(m => m.role === 'user');
  const latestMsg = norm(userMsgs.slice(-1)[0]?.content || '');
  const allTxt = norm(userMsgs.map(m => m.content).join(' '));
  // Alkuperäiset viestit numeroiden tunnistusta varten (norm() poistaa numerot)
  const latestRaw = (userMsgs.slice(-1)[0]?.content || '').toLowerCase();
  const allRaw = userMsgs.map(m => m.content).join(' ').toLowerCase();

  // ── Allergeenit ───────────────────────────────────────────────────────
  const excl = {};

  // Kerää mitä SAA syödä (whitelist)
  const okIngredients = new Set();
  const okMatches = allTxt.matchAll(/(?:saa syödä|voi syödä|sopii|kestää)\s+(\w+)/g);
  for (const m of okMatches) okIngredients.add(m[1].toLowerCase());

  // ── WHITELIST-RAJAUS: "saa syödä VAIN/AINOASTAAN X, Y, Z" ──────────────
  // Kun asiakas sanoo että koira saa syödä VAIN tiettyjä proteiineja, kaikki
  // MUUT proteiinit pitää sulkea pois (ei pelkkä toive). Tämä on turvallisuus-
  // kriittistä: rajattu ruokavalio tarkoittaa että muut proteiinit ovat kiellettyjä.
  // Tunnistetaan rajaussana (vain/ainoastaan/pelkästään/saa syödä ... eikä muuta).
  const PROTEIN_KEYWORDS = {
    'kana': 'Kana', 'broiler': 'Kana', 'siipikarja': 'Siipikarja',
    'kalkkuna': 'Kalkkuna', 'kananmuna': 'Kananmuna', 'kanamuna': 'Kananmuna',
    'nauta': 'Nauta', 'naudan': 'Nauta', 'härkä': 'Nauta', 'biisoni': 'Biisoni',
    'lammas': 'Lammas', 'lampaan': 'Lammas', 'karitsa': 'Lammas',
    'possu': 'Possu', 'sika': 'Possu', 'sian': 'Possu', 'porsas': 'Possu', 'porsaan': 'Possu',
    'kala': 'Kala', 'lohi': 'Lohi', 'silli': 'Kala', 'silakka': 'Kala', 'sardiini': 'Kala', 'anjovis': 'Kala', 'turska': 'Kala', 'kampela': 'Kala', 'merilevä': 'Kala',
    'ankka': 'Ankka', 'ankan': 'Ankka',
    'peura': 'Peura', 'hirvi': 'Hirvi', 'hirven': 'Hirvi', 'poro': 'Poro', 'poron': 'Poro',
    'jänis': 'Jänis', 'jäniksen': 'Jänis', 'kani': 'Jänis', 'kanin': 'Jänis',
    'villisika': 'Villisika', 'villisian': 'Villisika', 'strutsi': 'Strutsi', 'strutsin': 'Strutsi',
    'fasaani': 'Fasaani', 'hevonen': 'Hevonen', 'hevosen': 'Hevonen', 'vuohi': 'Vuohi',
    'hyönteinen': 'Hyönteiset', 'hyönteis': 'Hyönteiset', 'sirkka': 'Hyönteiset',
  };
  const ALL_PROTEINS = ['Kana','Siipikarja','Kalkkuna','Kananmuna','Nauta','Lammas','Possu','Kala','Lohi','Ankka','Peura','Hirvi','Poro','Jänis','Villisika','Strutsi','Fasaani','Hevonen','Vuohi','Biisoni','Hyönteiset','Eläinperäinen','Soija'];
  // Rajaussana viestissä?
  const restrictRx = /(?:saa syödä|voi syödä|sietää|syö)\s+(?:vain|ainoastaan|pelkästään|ainoita?|ainut)|(?:vain|ainoastaan|pelkästään)\s+(?:näit|seuraav|nämä)|rajattu ruokavali|rajoitettu ruokavali|eliminaatio/;
  // Myös muoto "...strutsia, peuraa, villisikaa, kania" rajaussanan jälkeen
  const hasRestrict = restrictRx.test(allTxt) || /\b(?:vain|ainoastaan|pelkästään)\b/.test(allTxt);
  if (hasRestrict) {
    // Mitkä proteiinit mainitaan sallittuina? Käytä sanarajaa, jottei
    // "villisika" osu "sika"-avaimeen (villisika ≠ possu).
    const allowedProteins = new Set();
    for (const [kw, canonical] of Object.entries(PROTEIN_KEYWORDS)) {
      const rx = new RegExp(`(^|[^a-zäöå])${kw}`, 'i');
      // erikoistapaus: "villisika"/"villisian" käsitellään ennen "sika"/"sian"
      if (rx.test(allTxt)) {
        // jos avain on 'sika' tai 'sian' mutta teksti on villisika, ohita
        if ((kw === 'sika' || kw === 'sian') && /villisi/.test(allTxt) && !/(^|[^a-zäöå])sika|(^|[^a-zäöå])sian/.test(allTxt.replace(/villisika|villisian/g, ''))) {
          continue;
        }
        allowedProteins.add(canonical);
      }
    }
    // Jos vähintään yksi sallittu proteiini tunnistettiin, sulje pois KAIKKI muut
    if (allowedProteins.size >= 1) {
      // Kananmuna on neutraali täydennys (ei pääliha) — ei suljeta pois ellei
      // käyttäjä erikseen kiellä sitä. Sallitaan myös "Eläinperäinen" (geneerinen).
      allowedProteins.add('Kananmuna');
      excl.__whitelistMode = true; // merkitse: rajaus koskee VAIN pääproteiineja
      for (const prot of ALL_PROTEINS) {
        if (prot === 'Eläinperäinen') continue; // geneeristä ei suljeta tällä
        if (!allowedProteins.has(prot)) excl[prot] = true;
      }
      // Lisää myös rasvajohdannaiset poissuljetuille
      if (!allowedProteins.has('Kana')) { excl['Kananrasva'] = true; }
      if (!allowedProteins.has('Kalkkuna')) { excl['Kalkkunanrasva'] = true; }
      if (!allowedProteins.has('Nauta')) { excl['Naudanrasva'] = true; }
      if (!allowedProteins.has('Lammas')) { excl['Lampaanrasva'] = true; }
      if (!allowedProteins.has('Possu')) { excl['Sianrasva'] = true; }
      if (!allowedProteins.has('Ankka')) { excl['Ankanrasva'] = true; }
      if (!allowedProteins.has('Kala') && !allowedProteins.has('Lohi')) { excl['Kalaöljy'] = true; }
    }
  }

  // TÄRKEÄÄ: allergeenit tunnistetaan VAIN viesteistä joissa on allergia-konteksti
  // (trigger-sana SAMASSA viestissä). Estää myöhempien tuotenimien (esim. "Kalkkuna")
  // vahingollisen tulkinnan allergeeneiksi.
  const userTexts = userMsgs.map(m => norm(m.content || ''));
  for (const msgTxt of userTexts) {
    // "X-ton/X-toon" -muoto = ilman raaka-ainetta (esim. "siipikarjaton",
    // "kanaton"). Itsessään poissulkusignaali — tarkistetaan ENNEN hasTrigger-porttia.
    const tonMatch0 = msgTxt.matchAll(/(kana|siipikarja|siipikarj|lohi|kala|nauta|naudat|lammas|lampaat|possu|sika|kalkkuna|herne|soija|peruna|riisi|ankka|maissi)t[oö]/g);
    for (const m of tonMatch0) {
      let kw = m[1];
      if (kw === 'siipikarja' || kw === 'siipikarj') kw = 'siipikarj';
      else if (kw === 'naudat') kw = 'nauta';
      else if (kw === 'lampaat') kw = 'lammas';
      else if (kw === 'kalkkuna') kw = 'kalkkun';
      if (ALLERGEN_MAP[kw]) ALLERGEN_MAP[kw].forEach(a => { excl[a] = true; });
    }
    // "ei/ilman/älä/eikä X" -rakenne laukaisee tunnistuksen itsenäisesti
    // (ei vaadi erillistä "allergi"-sanaa) — kattaa "ei kanaa eikä siipikarjaa"
    const eiPat = /(?:^|\s)(?:ei|eikä|eika|ilman|älä|ala)\s/;
    const hasTrigger = ALLERGEN_TRIGGERS.some(t => msgTxt.includes(t)) ||
      /ei saa|ei voi|vapaa|allergi|herkk/.test(msgTxt) || eiPat.test(msgTxt);
    if (!hasTrigger) continue;

    for (const [kw, allergens] of Object.entries(ALLERGEN_MAP)) {
      if (okIngredients.has(kw)) continue;
      if (msgTxt.includes(kw)) {
        // "Halua"-konteksti (asiakas HALUAA tätä raaka-ainetta) -> EI poissuljeta.
        // MUTTA: "älä suosittele", "en halua" yms negaatiot eivät ole halua-kontekstia.
        const wantPat = new RegExp(
          `(haluaa|haluan|tykkää|mieluusti|sopii|saa syödä|voi syödä)\\s{0,20}${kw}`, 'i'
        );
        const negatedWant = /älä|ala |en halua|ei halua|ilman|ei saa|ei voi|ei sisällä|ei sisalla|ei varmasti/.test(msgTxt);
        if (negatedWant || !wantPat.test(msgTxt)) {
          allergens.forEach(a => { excl[a] = true; });
        }
      }
    }
    // "ei/ilman X" -rakenne (kattaa myös siipikarjan)
    const eiMatch = msgTxt.matchAll(/(?:ei|eikä|eika|ilman|älä|ala)\s+\S{0,15}?(kana|siipikarj|lohi|kala|nauta|lammas|lampa|possu|sika|kalkkuna|vehn|kaura|ohra|maissi|vilja|herne|soija|peruna|riisi|ankka|muna)/g);
    for (const m of eiMatch) {
      const kw = m[1] === 'siipikarj' ? 'siipikarja' : (m[1] === 'lampa' ? 'lammas' : (m[1] === 'vehn' ? 'vehnä' : m[1]));
      if (ALLERGEN_MAP[kw]) ALLERGEN_MAP[kw].forEach(a => { excl[a] = true; });
    }
  }

  // ── Ikä ───────────────────────────────────────────────────────────────
  let age = null;
  // KÄYTETÄÄN allTxt (KOKO historia) — latestMsg on JO osa allTxt:ia, mutta
  // "latestMsg || allTxt" -muoto jätti allTxt:n KOKONAAN huomiotta aina kun
  // latestMsg ei ollut tyhjä (= aina). Tällöin esim. ohjatun aloituksen
  // "Koiran ikä: Aikuinen, koko: Keskikokoinen." -lause unohtui heti
  // seuraavassa viestissä.
  if (/tiine|kantava|odottav|imettä|imettav|emo.{0,15}(pentu|penikoi)|synnyttän|raskaana|pentue/.test(allTxt)) age = 'Pentu & emo';
  else if (/\bpentu|pennu|penikka|penska|puppy/.test(allTxt)) age = 'Pentu';
  else if (/seniori|vanha koira|vanhalle koira|vanha kaveri|ikääntyn|ikäänty|iäkk|vanhus|seniic|vanheneva/.test(allTxt)) age = 'Senior';
  else if (/aikuinen|aikuiselle|aikuisen|aikuisten|aikuiscoir|aikuiskoira|täysikasv/.test(allTxt)) age = 'Aikuinen';
  else if (/junior|juniori|nuorelle koira|nuori koira/.test(allTxt)) age = 'Junior';
  else if (/pentu.{0,3}emo|emo.{0,3}pentu/.test(allTxt)) age = 'Pentu & emo';

  if (!age) {
    // Käytä alkuperäistä tekstiä (ei normalisoitua) koska norm() poistaa numerot
    // Etsi KOKO historiasta (ei vain viimeisestä) jotta ikä löytyy aiemmista viesteistä
    const kkMatch = allRaw.match(/\b(\d+)\s*kk\b/i);
    if (kkMatch) {
      const kk = parseInt(kkMatch[1]);
      age = kk <= 12 ? 'Pentu' : (kk >= 84 ? 'Senior' : 'Aikuinen');
    }
    const vMatch = allRaw.match(/\b(\d+)\s*vuo/i);
    if (!age && vMatch) {
      const v = parseInt(vMatch[1]);
      age = v <= 1 ? 'Pentu' : (v >= 7 ? 'Senior' : 'Aikuinen');
    }
  }

  // ── Koko ──────────────────────────────────────────────────────────────
  const BREED_SIZE = {
    'chihuahua': 'Pieni', 'mops': 'Pieni', 'yorkie': 'Pieni',
    'jack russell': 'Pieni', 'bichon': 'Pieni', 'maltese': 'Pieni',
    'beagle': 'Keskikokoinen', 'cocker': 'Keskikokoinen', 'husky': 'Keskikokoinen',
    'bordercollie': 'Keskikokoinen', 'border collie': 'Keskikokoinen', 'puudeli': 'Keskikokoinen',
    'labrador': 'Suuri', 'kultainen': 'Suuri', 'golden': 'Suuri',
    'saksanpaimenkoira': 'Suuri', 'amstaffi': 'Suuri', 'amstaff': 'Suuri',
    'rottweiler': 'Suuri', 'dobermann': 'Suuri', 'berner': 'Suuri',
    'bokseri': 'Suuri', 'kultainennoutaja': 'Suuri',
  };

  let size = null;
  const txt = allTxt; // koko historia, ei vain viimeisin viesti (ks. yllä)
  for (const [breed, sz] of Object.entries(BREED_SIZE)) {
    if (txt.includes(breed)) { size = sz; break; }
  }
  if (!size) {
    if (/pieni|pienelle|pienille|pienirotui|pienikokoi|miniatyyri|miniature|\btoy\b|pikkukoira|pienen koira/.test(txt)) size = 'Pieni';
    else if (/suuri|suurelle|suurille|suurirotui|isolle|isoille|iso koira|isokokoi|jättikoko|jättiläis|jätti rotu|erittäin suuri|suurikokoi/.test(txt)) size = 'Suuri';
    else if (/keskikoko|keskikokoi|keskirotui|medium|kohtalaisen koko/.test(txt)) size = 'Keskikokoinen';
  }
  // Paino kiloina -> kokoluokka (esim. "5kg", "27 kg")
  if (!size) {
    const kgMatch = allRaw.match(/\b(\d+(?:[.,]\d+)?)\s*kg\b/i);
    if (kgMatch) {
      const kg = parseFloat(kgMatch[1].replace(',', '.'));
      if (kg < 10) size = 'Pieni';
      else if (kg <= 25) size = 'Keskikokoinen';
      else size = 'Suuri';
    }
  }

  // ── Kauppa ────────────────────────────────────────────────────────────
  // EI \b-sanarajoja: suomen taivutusmuodot ("Haukkulalta", "Haukkulasta",
  // "Peteniltä") eivät täsmäisi sanarajan kanssa. Nämä kauppanimet ovat
  // tarpeeksi erottuvia että substring-haku on turvallinen.
  let store = null;
  const checkStore = (text) => {
    if (text.includes('peten')) return 'petenkoiratarvike';
    if (text.includes('haukkula')) return 'haukkula';
    if (text.includes('zooplus')) return 'zooplus';
    return null;
  };
  store = checkStore(latestMsg) || checkStore(allTxt);

  // ── Erikoisominaisuudet ────────────────────────────────────────────────
  const SPECIAL_MAP = {
    'steriloi': 'Steriloiduille', 'kastroi': 'Steriloiduille', 'sterilisoi': 'Steriloiduille',
    'painonhallin': 'Painonhallinta', 'ylipaino': 'Painonhallinta', 'lihav': 'Painonhallinta',
    'iho ongel': 'Iho-ongelmat', // norm() muuttaa '-' -> ' ', siksi avain on välilyönnillä
    'ihottum': 'Iho-ongelmat',
    'nivel': 'Nivel-ongelmat',
    'herkkä vatsa': 'Suolisto-ongelmat', 'herkkavats': 'Suolisto-ongelmat',
    'suolisto': 'Suolisto-ongelmat',
    'viljaton': 'Viljaton', 'gluteeniton': 'Gluteeniton',
    'hypoaller': 'Hypoallergeeninen',
    'aktiivi': 'Aktiivisille', 'työskentelee': 'Aktiivisille', 'työkoira': 'Aktiivisille', 'metsäst': 'Aktiivisille', 'paljon energia': 'Aktiivisille', 'urheilukoira': 'Aktiivisille', 'agility': 'Aktiivisille',
    'kasvis': 'Kasvipohjainen', 'kasvipohjai': 'Kasvipohjainen', 'vegaani': 'Kasvipohjainen',
    'vegan': 'Kasvipohjainen', 'vegetar': 'Kasvipohjainen', 'lihaton': 'Kasvipohjainen',
    'eläinperäisi': 'Kasvipohjainen', 'ilman lihaa': 'Kasvipohjainen', 'ilman eläin': 'Kasvipohjainen',
    'hammaskiv': 'Hammaskivi', 'hampaat': 'Hammaskivi',
    'eliminaatio': 'Eliminaatiodieetti',
  };
  const specialDiets = [];
  for (const [kw, diet] of Object.entries(SPECIAL_MAP)) {
    if (allTxt.includes(kw) && !specialDiets.includes(diet)) specialDiets.push(diet);
  }

  // Rajatut raaka-aineet: yksiproteiininen / yksi hiilihydraatti.
  // Tunnistetaan monet kirjoitustavat: "yksiproteiininen", "yhden proteiinin",
  // "vain yksi proteiini", "yksittäinen proteiini", "single protein", "mono".
  const monoProtein = /yksiproteiin|yhden proteiin|yksi (eläin)?proteiin|yksi liha|yhden lihan|yksittäinen proteiin|single protein|mono.?protein|mono.?proteiin|vain yksi proteiin/.test(allTxt);
  const singleCarb = /yksi hiilihydraat|yhden hiilihydraatin|yksittäinen hiilihydraat|single carb|vain yksi hiilihydraat/.test(allTxt);

  // Rasvataso: vähärasvainen/kevyt -> low, korkearasvainen/energiapitoinen -> high
  let fatLevel = null;
  if (/vähärasva|vaharasva|vähärasva|kevyt|laiha|matalarasva|matala rasva|vähän rasva|painonhallin|laihdut/.test(allTxt)) fatLevel = 'low';
  else if (/korkearasva|korkea rasva|paljon rasva|energiapitois|runsasrasva|rasvainen ruoka/.test(allTxt)) fatLevel = 'high';

  // ── Ruokatyyppi (raaka / kuiva) ───────────────────────────────────────
  // "raakaruokaa" / "raakis" -> vain raakaruoat. "kuivaruokaa"/"nappula" -> vain
  // kuivaruoat. Ei lauke ainesosasanasta ("raaka-aine").
  let ruokatyyppi = null;
  if (/\braakaruok|\braaka ruok|\bbarf\b|raakaruokint|raakaruokavalio|\braakis\b/.test(allTxt) && !/raaka-?aine/.test(allTxt)) {
    ruokatyyppi = 'raaka';
  } else if (/\bkuivaruok|\bkuiva ruok|\bnappularuok|\bnappula\b|\bkuivamuon/.test(allTxt)) {
    ruokatyyppi = 'kuiva';
  }

  return {
    excl: Object.keys(excl).filter(k => k !== '__whitelistMode'),
    whitelistMode: !!excl.__whitelistMode,
    want: [],
    brand: null,
    age,
    size,
    store,
    specialDiets,
    monoProtein,
    singleCarb,
    fatLevel,
    ruokatyyppi,
  };
}

// Yhteensopivuus
export function buildProductContext(products, filters) {
  return buildDirectProductResponse(products, filters);
}
