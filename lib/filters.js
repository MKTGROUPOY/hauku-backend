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
  'lampa':       ['Lammas', 'Lampaanrasva'], // taivutusmuodot: lampaalle, lampaan, lampaasta...
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

  let filtered = products.filter(p => {
    // Reseptiruoat pois AINA — ks. perustelu yllä
    if (VET_DIET_RX.test(p.nimi)) return false;

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

  // TÄRKEÄÄ: allergeenit tunnistetaan VAIN viesteistä joissa on allergia-konteksti
  // (trigger-sana SAMASSA viestissä). Estää myöhempien tuotenimien (esim. "Kalkkuna")
  // vahingollisen tulkinnan allergeeneiksi.
  const userTexts = userMsgs.map(m => norm(m.content || ''));
  for (const msgTxt of userTexts) {
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
  if (/\bpentu\b|puppy|pennulle/.test(allTxt)) age = 'Pentu';
  else if (/\bseniori?\b|vanha koira|ikääntyn/.test(allTxt)) age = 'Senior';
  else if (/\baikuinen\b/.test(allTxt)) age = 'Aikuinen';
  else if (/\bjunior\b/.test(allTxt)) age = 'Junior';
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
    'steriloitu': 'Steriloiduille', 'kastroitu': 'Steriloiduille',
    'painonhallin': 'Painonhallinta', 'ylipaino': 'Painonhallinta', 'lihav': 'Painonhallinta',
    'iho ongel': 'Iho-ongelmat', // norm() muuttaa '-' -> ' ', siksi avain on välilyönnillä 'ihottum': 'Iho-ongelmat', 'kutisee': 'Iho-ongelmat',
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
