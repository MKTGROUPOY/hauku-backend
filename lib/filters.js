// lib/filters.js — Tuotesuodatus JSON-tietokannalle

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

// ── Allergeenikartta: käyttäjän sana → JSON-kenttien nimet ────────────────
// Huom: JSON:ssa "ei_sisalla_naita_ainesosia" käyttää isoa alkukirjainta
const ALLERGEN_MAP = {
  'kana':        ['Kana', 'Kananrasva'],
  'kananliha':   ['Kana', 'Kananrasva'],
  'kananrasva':  ['Kananrasva'],
  'siipikarja':  ['Kana', 'Kananrasva', 'Kalkkuna', 'Kalkkunanrasva'],
  'kalkkuna':    ['Kalkkuna', 'Kalkkunanrasva'],
  'kananmuna':   ['Kananmuna'],
  'muna':        ['Kananmuna'],
  'nauta':       ['Nauta', 'Naudanrasva'],
  'naudanliha':  ['Nauta', 'Naudanrasva'],
  'lammas':      ['Lammas', 'Lampaanrasva'],
  'possu':       ['Possu', 'Sianrasva'],
  'sika':        ['Possu', 'Sianrasva'],
  'kala':        ['Kala', 'Kalaöljy', 'Lohi'],
  'lohi':        ['Lohi', 'Kala', 'Kalaöljy'],
  'lohiöljy':    ['Lohi', 'Kalaöljy'],
  'kalaöljy':    ['Kala', 'Kalaöljy'],
  'vehnä':       ['Vehnä'],
  'kaura':       ['Kaura'],
  'ohra':        ['Ohra'],
  'maissi':      ['Maissi'],
  'vilja':       ['Vehnä', 'Kaura', 'Ohra', 'Maissi'],
  'gluteeni':    ['Vehnä'],
  'herne':       ['Herne'],
  'soija':       ['Soija', 'Soijaöljy'],
  'peruna':      ['Peruna'],
  'riisi':       ['Riisi'],
  'ankka':       ['Ankka', 'Ankanrasva'],
};

const ALLERGEN_TRIGGERS = [
  'allergi', 'herkk', 'ei sovi', 'vapaa', 'ei kestä',
  'ei voi syödä', 'ei saa syödä', 'intoleranssi', 'reagoi', 'ei siedä',
];

// ── Iän täsmäys — TARKKA vastaavuus tietokannan arvoihin ──────────────────
// Sallitut arvot (vastaavat Shopify-metafieldejä JA widgetin pudotusvalikkoa):
//   "Kaikille ikäluokille", "Pentu & emo", "Pentu", "Junior", "Aikuinen", "Senior"
//
// Säännöt:
//  - filterAge puuttuu TAI on "Kaikille ikäluokille" -> ei suodateta iän mukaan (kaikki läpi)
//  - muuten: tuote läpäisee JOS sen ika-lista sisältää TARKALLEEN filterAge:n,
//    TAI tuote on itse merkitty "Kaikille ikäluokille" (sopii kaikille)
function ageMatches(productIka, filterAge) {
  if (!filterAge || filterAge === 'Kaikille ikäluokille') return true;
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
// KÄÄNTEINEN LOGIIKKA allergeeneille:
// Tuote läpäisee suodatuksen VAIN jos se listaa kyseisen allergeenin
// "ei_sisalla_naita_ainesosia" -kentässä (= tuote on vapaa siitä)
export function filterProducts(products, filters) {
  if (!products?.length) return [];

  let filtered = products.filter(p => {
    // Kauppa
    if (filters.store) {
      const storeMap = { petenkoiratarvike: 'peten', haukkula: 'haukkula', zooplus: 'zooplus' };
      const wanted = storeMap[filters.store] || filters.store;
      if (getStore(p.linkki) !== wanted) return false;
    }

    // Allergeenit — KÄÄNTEINEN: tuotteen "vapaa"-listasta pitää löytyä
    for (const allergen of (filters.excl || [])) {
      if (!p.vapaa.includes(allergen)) return false;
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
  const maxShow = Math.min(count, 4);

  let response = `Löysin ${count} sopivaa tuotetta${storeSuffix}:\n`;

  display.slice(0, maxShow).forEach(p => {
    response += `\n**${p.nimi}**\n`;
    if (p.rasva && p.rasva !== 'Tuntematon') response += `Rasvataso: ${p.rasva}\n`;
    if (p.erikois?.length) response += `Sopii: ${p.erikois.slice(0, 4).join(', ')}\n`;
    if (p.linkki) response += `🛒 [Osta](${p.linkki})\n`;
  });

  if (count > maxShow) {
    response += `\n(+${count - maxShow} muuta sopivaa tuotetta valikoimassamme)\n`;
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

  // TÄRKEÄÄ: allergeenit tunnistetaan VAIN viesteistä joissa on allergia-konteksti
  // (trigger-sana SAMASSA viestissä). Estää myöhempien tuotenimien (esim. "Kalkkuna")
  // vahingollisen tulkinnan allergeeneiksi.
  const userTexts = userMsgs.map(m => norm(m.content || ''));
  for (const msgTxt of userTexts) {
    const hasTrigger = ALLERGEN_TRIGGERS.some(t => msgTxt.includes(t)) ||
      /ei saa|ei voi|vapaa|allergi|herkk/.test(msgTxt);
    if (!hasTrigger) continue;

    for (const [kw, allergens] of Object.entries(ALLERGEN_MAP)) {
      if (okIngredients.has(kw)) continue;
      if (msgTxt.includes(kw)) {
        const wantPat = new RegExp(
          `(haluaa|tykkää|mieluusti|suosittele|sopii|saa syödä|voi syödä)\\s{0,20}${kw}`, 'i'
        );
        if (!wantPat.test(msgTxt)) {
          allergens.forEach(a => { excl[a] = true; });
        }
      }
    }
    // "ei kana" -rakenne
    const eiMatch = msgTxt.matchAll(/ei\s+(kana|lohi|kala|nauta|lammas|possu|vehn|maissi|vilja|herne)/g);
    for (const m of eiMatch) {
      const kw = m[1];
      if (ALLERGEN_MAP[kw]) ALLERGEN_MAP[kw].forEach(a => { excl[a] = true; });
    }
  }

  // ── Ikä ───────────────────────────────────────────────────────────────
  let age = null;
  if (/\bpentu\b|puppy|pennulle/.test(latestMsg || allTxt)) age = 'Pentu';
  else if (/\bseniori?\b|vanha koira|ikääntyn/.test(latestMsg || allTxt)) age = 'Senior';
  else if (/\baikuinen\b/.test(latestMsg || allTxt)) age = 'Aikuinen';

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
  const txt = latestMsg || allTxt;
  for (const [breed, sz] of Object.entries(BREED_SIZE)) {
    if (txt.includes(breed)) { size = sz; break; }
  }
  if (!size) {
    if (/\bpieni\b|pienirotuinen|miniatur|toy\b/.test(txt)) size = 'Pieni';
    else if (/\bsuuri\b|suurirotuinen|iso koira|isokokoinen/.test(txt)) size = 'Suuri';
    else if (/\bkeski\b|keskikokoinen|medium/.test(txt)) size = 'Keskikokoinen';
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
  let store = null;
  const checkStore = (text) => {
    if (/\bpeten\b|peten koiratarvike/.test(text)) return 'petenkoiratarvike';
    if (/\bhaukkula\b/.test(text)) return 'haukkula';
    if (/\bzooplus\b/.test(text)) return 'zooplus';
    return null;
  };
  store = checkStore(latestMsg) || checkStore(allTxt);

  // ── Erikoisominaisuudet ────────────────────────────────────────────────
  const SPECIAL_MAP = {
    'steriloitu': 'Steriloiduille', 'kastroitu': 'Steriloiduille',
    'painonhallin': 'Painonhallinta', 'ylipaino': 'Painonhallinta', 'lihav': 'Painonhallinta',
    'iho-ongel': 'Iho-ongelmat', 'ihottum': 'Iho-ongelmat', 'kutisee': 'Iho-ongelmat',
    'nivel': 'Nivel-ongelmat',
    'herkkä vatsa': 'Suolisto-ongelmat', 'herkkavats': 'Suolisto-ongelmat',
    'suolisto': 'Suolisto-ongelmat',
    'viljaton': 'Viljaton', 'gluteeniton': 'Gluteeniton',
    'hypoaller': 'Hypoallergeeninen',
    'aktiivinen': 'Aktiivisille', 'työskentelee': 'Aktiivisille',
  };
  const specialDiets = [];
  for (const [kw, diet] of Object.entries(SPECIAL_MAP)) {
    if (allTxt.includes(kw) && !specialDiets.includes(diet)) specialDiets.push(diet);
  }

  return {
    excl: Object.keys(excl),
    want: [],
    brand: null,
    age,
    size,
    store,
    specialDiets,
  };
}

// Yhteensopivuus
export function buildProductContext(products, filters) {
  return buildDirectProductResponse(products, filters);
}
