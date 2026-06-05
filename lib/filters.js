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

// ── Iän normalisointi ─────────────────────────────────────────────────────
// JSON:ssa: "Aikuinen", "Pentu", "Junior", "Pentu & emo", "Senior", "Kaikille ikäluokille"
function ageMatches(productIka, filterAge, productNimi) {
  if (!filterAge) return true;
  const joined = productIka.join(' ').toLowerCase();
  const nimi = (productNimi || '').toLowerCase();

  // Tuotteen nimi kertoo iän selkeästi — käytä sitä ensin
  const isPuppyName  = /puppy|junior/.test(nimi);
  const isSeniorName = /senior/.test(nimi);

  if (filterAge === 'Pentu') {
    if (isSeniorName) return false;
    return /pentu|junior|kaikille ikäluokille/.test(joined) || isPuppyName;
  }
  if (filterAge === 'Aikuinen') {
    // Pentu/Junior -nimiset tuotteet eivät sovi aikuisille
    if (isPuppyName) return false;
    if (isSeniorName) return false;
    return /aikuinen|kaikille ikäluokille/.test(joined);
  }
  if (filterAge === 'Senior') {
    if (isPuppyName) return false;
    return /senior|aikuinen|kaikille ikäluokille/.test(joined) || isSeniorName;
  }
  return true;
}

// ── Koon normalisointi ────────────────────────────────────────────────────
// JSON:ssa: "Pieni", "Keskikokoinen", "Suuri", "Erittäin suuri", "Kaikille kokoluokille"
function sizeMatches(productKoko, filterSize) {
  if (!filterSize) return true;
  const joined = productKoko.join(' ').toLowerCase();
  if (filterSize === 'Pieni')  return /pieni|kaikille kokoluokille/.test(joined);
  if (filterSize === 'Keski')  return /keskikokoinen|kaikille kokoluokille/.test(joined);
  if (filterSize === 'Suuri')  return /suuri|erittäin suuri|kaikille kokoluokille/.test(joined);
  return true;
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
    if (!ageMatches(p.ika, filters.age, p.nimi)) return false;

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
  filtered.sort((a, b) => {
    let scoreA = a.prio === 1 ? 10 : 0;
    let scoreB = b.prio === 1 ? 10 : 0;
    if (filters.age) {
      if (a.ika.some(x => x.toLowerCase().includes(filters.age.toLowerCase()))) scoreA += 2;
      if (b.ika.some(x => x.toLowerCase().includes(filters.age.toLowerCase()))) scoreB += 2;
    }
    if (filters.size) {
      const sizeWord = filters.size === 'Keski' ? 'keskikokoinen' : filters.size.toLowerCase();
      if (a.koko.some(x => x.toLowerCase().includes(sizeWord))) scoreA += 1;
      if (b.koko.some(x => x.toLowerCase().includes(sizeWord))) scoreB += 1;
    }
    return scoreB - scoreA;
  });

  return filtered;
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

  const hasTrigger = ALLERGEN_TRIGGERS.some(t => allTxt.includes(t));
  if (hasTrigger || /ei saa|ei voi|vapaa|allergi|herkk/.test(allTxt)) {
    for (const [kw, allergens] of Object.entries(ALLERGEN_MAP)) {
      if (okIngredients.has(kw)) continue;
      if (allTxt.includes(kw)) {
        const wantPat = new RegExp(
          `(haluaa|tykkää|mieluusti|suosittele|sopii|saa syödä|voi syödä)\\s{0,20}${kw}`, 'i'
        );
        if (!wantPat.test(allTxt)) {
          allergens.forEach(a => { excl[a] = true; });
        }
      }
    }
    // "ei kana" -rakenne
    const eiMatch = allTxt.matchAll(/ei\s+(kana|lohi|kala|nauta|lammas|possu|vehn|maissi|vilja|herne)/g);
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
    const kkMatch = (latestRaw || allRaw).match(/\b(\d+)\s*kk\b/i);
    if (kkMatch) {
      const kk = parseInt(kkMatch[1]);
      age = kk <= 12 ? 'Pentu' : (kk >= 84 ? 'Senior' : 'Aikuinen');
    }
    const vMatch = (latestRaw || allRaw).match(/\b(\d+)\s*vuo/i);
    if (!age && vMatch) {
      const v = parseInt(vMatch[1]);
      age = v <= 1 ? 'Pentu' : (v >= 7 ? 'Senior' : 'Aikuinen');
    }
  }

  // ── Koko ──────────────────────────────────────────────────────────────
  const BREED_SIZE = {
    'chihuahua': 'Pieni', 'mops': 'Pieni', 'yorkie': 'Pieni',
    'jack russell': 'Pieni', 'bichon': 'Pieni', 'maltese': 'Pieni',
    'beagle': 'Keski', 'cocker': 'Keski', 'husky': 'Keski',
    'bordercollie': 'Keski', 'border collie': 'Keski', 'puudeli': 'Keski',
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
    else if (/\bkeski\b|keskikokoinen|medium/.test(txt)) size = 'Keski';
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
