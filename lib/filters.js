// lib/filters.js — Tuotesuodatus JSON-tietokannalle
// v7 — turvallisuuskorjaukset:
//  - Allergeenivertailu normalisoitu (isot/pienet kirjaimet, välilyönnit eivät riko suodatusta)
//  - "kanaton", "viljaton", "ilman kanaa", "kanavapaa" tunnistetaan ILMAN trigger-sanaa
//  - Kieltosanat: "ei tykkää kanasta" ei enää tulkitse kanaa halutuksi
//  - "X-allergia" / "allerginen X:lle" lähekkäin → aina kova poissulku, ohittaa whitelistin
//  - "viljaton"-toive lisää myös viljat allergeenipoissulkuun (ei vain erikoisominaisuudeksi)

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

// ── Allergeenikartta: käyttäjän sana → JSON-kenttien nimet ────────────────
// Huom: JSON:ssa "ei_sisalla_naita_ainesosia" käyttää isoa alkukirjainta,
// mutta vertailu tehdään nyt normalisoituna joten kirjainkoko ei riko mitään.
const ALLERGEN_MAP = {
  'kana':        ['Kana', 'Kananrasva'],
  'kananliha':   ['Kana', 'Kananrasva'],
  'kananrasva':  ['Kananrasva'],
  'siipikarja':  ['Kana', 'Kananrasva', 'Kalkkuna', 'Kalkkunanrasva'],
  'kalkkuna':    ['Kalkkuna', 'Kalkkunanrasva'],
  'kananmuna':   ['Kananmuna'],
  'muna':        ['Kananmuna'],
  'nauta':       ['Nauta', 'Naudanrasva'],
  'nauda':       ['Nauta', 'Naudanrasva'],         // taivutus: naudalle, naudan, naudasta
  'naudanliha':  ['Nauta', 'Naudanrasva'],
  'lammas':      ['Lammas', 'Lampaanrasva'],
  'lampaa':      ['Lammas', 'Lampaanrasva'],       // taivutus: lampaalle, lampaanliha
  'possu':       ['Possu', 'Sianrasva'],
  'sika':        ['Possu', 'Sianrasva'],
  'sian':        ['Possu', 'Sianrasva'],           // taivutus: sianliha, sianrasva
  'kala':        ['Kala', 'Kalaöljy', 'Lohi'],
  'lohi':        ['Lohi', 'Kala', 'Kalaöljy'],
  'lohe':        ['Lohi', 'Kala', 'Kalaöljy'],     // taivutus: lohelle, lohesta
  'ankan':       ['Ankka', 'Ankanrasva'],          // taivutus: ankanliha, ankanrasva
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
function ageMatches(productIka, filterAge, productNimi) {
  if (!filterAge) return true;
  const joined = productIka.join(' ').toLowerCase();
  const nimi = (productNimi || '').toLowerCase();

  const isPuppyName  = /puppy|junior/.test(nimi);
  const isSeniorName = /senior/.test(nimi);

  if (filterAge === 'Pentu') {
    if (isSeniorName) return false;
    return /pentu|junior|kaikille ikäluokille/.test(joined) || isPuppyName;
  }
  if (filterAge === 'Aikuinen') {
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
function sizeMatches(productKoko, filterSize) {
  if (!filterSize) return true;
  const joined = productKoko.join(' ').toLowerCase();
  if (filterSize === 'Pieni')  return /pieni|kaikille kokoluokille/.test(joined);
  if (filterSize === 'Keski')  return /keskikokoinen|kaikille kokoluokille/.test(joined);
  if (filterSize === 'Suuri')  return /suuri|erittäin suuri|kaikille kokoluokille/.test(joined);
  return true;
}

// ── Kaupan tunnistus ──────────────────────────────────────────────────────
// Ensisijaisesti kaupan NIMESTÄ (Shopify-metafieldit kauppa_1..3_nimi),
// fallbackina vanha URL-tunnistus JSON-datalle.
function getStore(linkki) {
  if (!linkki) return null;
  if (linkki.includes('petenkoiratarvike') || linkki.includes('pin.peten')) return 'peten';
  if (linkki.includes('haukkula')) return 'haukkula';
  if (linkki.includes('awin') || linkki.includes('zooplus')) return 'zooplus';
  return 'muu';
}

const STORE_KEY = { petenkoiratarvike: 'peten', haukkula: 'haukkula', zooplus: 'zooplus' };

function matchesStore(p, wantedStore) {
  const key = STORE_KEY[wantedStore] || wantedStore;
  // 1) Kauppojen nimet metafieldeistä
  const names = (p.kaupat || []).map(k => (k.nimi || '').toLowerCase());
  if (names.some(n => n.includes(key))) return true;
  // 2) Fallback: päälinkin URL
  return getStore(p.linkki) === key;
}

// Palauta oikean kaupan linkki kun kauppasuodatus on käytössä
export function storeLink(p, wantedStore) {
  if (wantedStore && p.kaupat?.length) {
    const key = STORE_KEY[wantedStore] || wantedStore;
    const hit = p.kaupat.find(k => (k.nimi || '').toLowerCase().includes(key));
    if (hit?.linkki) return hit.linkki;
  }
  return p.linkki;
}

// ── Pääsuodatin ───────────────────────────────────────────────────────────
// KÄÄNTEINEN LOGIIKKA allergeeneille (FAIL-CLOSED):
// Tuote läpäisee suodatuksen VAIN jos se listaa kyseisen allergeenin
// "ei_sisalla_naita_ainesosia" -kentässä (= tuote on todistetusti vapaa siitä).
// Jos tieto puuttuu → tuote EI mene läpi. Epävarma tuote ei koskaan päädy
// allergiselle koiralle.
export function filterProducts(products, filters) {
  if (!products?.length) return [];

  // Normalisoidut poissulut kerran, ei joka tuotteelle uudelleen
  const exclNorm = (filters.excl || []).map(norm);

  let filtered = products.filter(p => {
    // Kauppa — nimipohjainen tunnistus metafieldeistä, URL fallbackina
    if (filters.store) {
      if (!matchesStore(p, filters.store)) return false;
    }

    // Allergeenit — KÄÄNTEINEN, NORMALISOITU vertailu.
    // MUUTOS: aiemmin p.vapaa.includes(allergen) vaati merkilleen täsmäävän
    // merkkijonon ("Kana" ≠ "kana" ≠ "Kana "). Nyt vertailu on normalisoitu,
    // joten kirjainkoko/välilyönnit datassa eivät aiheuta vääriä tuloksia.
    if (exclNorm.length) {
      const vapaaNorm = (p.vapaa || []).map(norm);
      for (const allergen of exclNorm) {
        if (!vapaaNorm.includes(allergen)) return false;
      }
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

  // Kun kauppasuodatus on käytössä, näytä juuri sen kaupan linkki
  const linkOf = p => storeLink(p, filters?.store);

  const withLink = products.filter(p => linkOf(p));
  const display = withLink.length >= 3 ? withLink : products;
  const count = display.length;
  const maxShow = Math.min(count, 4);

  let response = `Löysin ${count} sopivaa tuotetta${storeSuffix}:\n`;

  display.slice(0, maxShow).forEach(p => {
    response += `\n**${p.nimi}**\n`;
    if (p.rasva && p.rasva !== 'Tuntematon') response += `Rasvataso: ${p.rasva}\n`;
    if (p.erikois?.length) response += `Sopii: ${p.erikois.slice(0, 4).join(', ')}\n`;
    const link = linkOf(p);
    if (link) response += `🛒 [Osta](${link})\n`;
  });

  if (count > maxShow) {
    response += `\n(+${count - maxShow} muuta sopivaa tuotetta valikoimassamme)\n`;
  }

  response += '\n📋 Tarkistathan tuotteen tiedot ennen ostopäätöstä.';
  return response;
}

// ── Allergeenien tunnistus tekstistä ──────────────────────────────────────
// MUUTOS: kokonaan uusittu. Kolme tasoa, turvallisin ensin:
//  TASO 1 (kova, ei triggeriä tarvita): "kanaton", "kanavapaa", "ilman kanaa"
//  TASO 2 (kova, ohittaa whitelistin): allergeeni lähellä sanaa "allergia",
//          "herkkä", "ei siedä" tms. → "lohiallergia, haluaisi kanaa" sulkee
//          lohen mutta ei kanaa
//  TASO 3 (trigger + maininta): poissulku, PAITSI jos eksplisiittisesti
//          positiivinen ILMAN edeltävää kieltosanaa ("saa syödä kanaa" ok,
//          "ei saa syödä kanaa" EI vapauta)
function detectAllergens(allTxt) {
  const excl = {};
  const add = kw => (ALLERGEN_MAP[kw] || []).forEach(a => { excl[a] = true; });
  const hard = new Set(); // kovalla säännöllä poissuljetut avainsanat

  // TASO 1: "X-ton/tön", "X-vapaa", "ilman X" — aina poissulku
  for (const kw of Object.keys(ALLERGEN_MAP)) {
    const re = new RegExp(`${kw}t[oö]n|${kw}\\w{0,3}vapaa|ilman ${kw}`);
    if (re.test(allTxt)) { add(kw); hard.add(kw); }
  }

  // TASO 2: allergeeni ja negatiivinen sana lähekkäin (max 2 sanaa välissä)
  // Kattaa: "kana-allergia" (norm → "kana allergia"), "allerginen kanalle",
  // "herkkä kanalle", "ei siedä kanaa", "reagoi kanaan"
  const NEG = '(?:allergi\\w*|herkk\\w*|intoleranssi\\w*|reagoi\\w*|ei sovi|ei käy|ei siedä|ei saa syödä|ei voi syödä|ei kestä)';
  for (const kw of Object.keys(ALLERGEN_MAP)) {
    if (hard.has(kw)) continue;
    const near = new RegExp(
      `${kw}\\w*\\s+(?:\\w+\\s+){0,2}?${NEG}|${NEG}\\s+(?:\\w+\\s+){0,2}?${kw}`
    );
    if (near.test(allTxt)) { add(kw); hard.add(kw); }
  }

  // TASO 3: yleinen trigger + allergeenin maininta
  const hasTrigger =
    ALLERGEN_TRIGGERS.some(t => allTxt.includes(t)) || /ei saa|ei voi/.test(allTxt);

  if (hasTrigger) {
    for (const kw of Object.keys(ALLERGEN_MAP)) {
      if (hard.has(kw)) continue;
      if (!allTxt.includes(kw)) continue;

      // Onko allergeeni eksplisiittisesti SALLITTU — ja ILMAN kieltosanaa edessä?
      // "saa syödä kanaa" → sallittu. "ei saa syödä kanaa" → EI sallittu.
      // "tykkää kanasta" → sallittu. "ei tykkää kanasta" → EI sallittu.
      const wantRe = new RegExp(
        `(ei\\s+|eikä\\s+)?(haluaa|haluaisi|haluan|tykkää|tykkäisi|mieluusti|suosii|toivoo|saa syödä|saa syöd|voi syödä|voi syöd|sietää|kestää|sopii)\\s+(?:\\w+\\s+){0,2}?${kw}`
      );
      const m = allTxt.match(wantRe);
      const explicitlyWanted = !!(m && !m[1]);

      if (!explicitlyWanted) add(kw);
    }

    // "ei kanaa" / "ei sisällä kanaa" -rakenne
    for (const m of allTxt.matchAll(
      /\bei(?:kä)?\s+(?:\w+\s+){0,1}?(kana\w*|lohi\w*|kala\w*|nauta\w*|lammas\w*|lampaa\w*|possu\w*|sika\w*|sia\w*|vehn\w*|kaura\w*|ohra\w*|maissi\w*|vilj\w*|herne\w*|soija\w*|muna\w*|ankk\w*|kalkkun\w*)/g
    )) {
      const word = m[1];
      const kw = Object.keys(ALLERGEN_MAP).find(k => word.startsWith(k));
      if (kw) add(kw);
    }
  }

  return excl;
}

// ── Suodatusparametrien tunnistus käyttäjätekstistä ───────────────────────
export function extractFilters(messages) {
  const userMsgs = messages.filter(m => m.role === 'user');
  const latestMsg = norm(userMsgs.slice(-1)[0]?.content || '');
  const allTxt = norm(userMsgs.map(m => m.content).join(' '));
  const allRaw = userMsgs.map(m => m.content).join(' ').toLowerCase();

  // ── Allergeenit (uusi kolmitasoinen tunnistus) ────────────────────────
  const excl = detectAllergens(allTxt);

  // ── Ikä ───────────────────────────────────────────────────────────────
  let age = null;
  if (/\bpentu\b|puppy|pennulle/.test(latestMsg || allTxt)) age = 'Pentu';
  else if (/\bseniori?\b|vanha koira|ikääntyn/.test(latestMsg || allTxt)) age = 'Senior';
  else if (/\baikuinen\b/.test(latestMsg || allTxt)) age = 'Aikuinen';

  if (!age) {
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
    // Etsi myös koko historiasta, ei vain viimeisestä viestistä
    const both = txt + ' ' + allTxt;
    for (const [breed, sz] of Object.entries(BREED_SIZE)) {
      if (both.includes(breed)) { size = sz; break; }
    }
    if (!size) {
      if (/\bpieni\b|pienirotuinen|miniatur|toy\b/.test(both)) size = 'Pieni';
      else if (/\bsuuri\b|suurirotuinen|iso koira|isokokoinen/.test(both)) size = 'Suuri';
      else if (/\bkeski\b|keskikokoinen|medium/.test(both)) size = 'Keski';
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
