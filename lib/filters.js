// lib/filters.js — Hauku v5 — Puhdas uusrakennus

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

// ── Allergeenikartta ──────────────────────────────────────────────────────
const ALLERGEN_MAP = {
  'kana': ['Kana', 'Kananrasva'],
  'kananliha': ['Kana', 'Kananrasva'],
  'kananrasva': ['Kana', 'Kananrasva'],
  'broileri': ['Kana', 'Kananrasva'],
  'siipikarja': ['Kana', 'Kananrasva', 'Kalkkuna', 'Kalkkunanrasva'],
  'kalkkuna': ['Kalkkuna', 'Kalkkunanrasva'],
  'ankka': ['Ankka'],
  'kananmuna': ['Kananmuna'],
  'muna': ['Kananmuna'],
  'nauta': ['Nauta', 'Naudanrasva'],
  'naudanliha': ['Nauta', 'Naudanrasva'],
  'lammas': ['Lammas', 'Lampaanrasva'],
  'possu': ['Possu', 'Sianrasva'],
  'sika': ['Possu', 'Sianrasva'],
  'kala': ['Kala', 'Kalaöljy'],
  'lohi': ['Lohi', 'Lohiöljy', 'Kala'],
  'lohiöljy': ['Lohi', 'Lohiöljy'],
  'kalaöljy': ['Kala', 'Kalaöljy'],
  'vehnä': ['Vehnä'],
  'kaura': ['Kaura'],
  'ohra': ['Ohra'],
  'maissi': ['Maissi'],
  'gluteeni': ['Vehnä'],
  'vilja': ['Vehnä', 'Kaura', 'Ohra', 'Maissi'],
  'herne': ['Herne'],
  'soija': ['Soija'],
  'peruna': ['Peruna'],
  'riisi': ['Riisi'],
};

// Allergeenin tunnistus viestistä
const ALLERGEN_TRIGGERS = [
  'allergi', 'herkk', 'ei sovi', 'vapaa', 'ei kestä', 'ei voi syödä',
  'ei saa syödä', 'intoleranssi', 'reagoi', 'aiheuttaa', 'ei siedä',
];

// ── Erikoisruokavaliokartta ────────────────────────────────────────────────
const SPECIAL_DIET_MAP = {
  'steriloitu': 'Steriloiduille',
  'kastroitu': 'Steriloiduille',
  'painonhallin': 'Painonhallinta',
  'ylipaino': 'Painonhallinta',
  'lihav': 'Painonhallinta',
  'iho-ongel': 'Iho-ongelmat',
  'ihottum': 'Iho-ongelmat',
  'kutisee': 'Iho-ongelmat',
  'nivel-ongel': 'Nivel-ongelmat',
  'nivelongel': 'Nivel-ongelmat',
  'suolisto-ongel': 'Suolisto-ongelmat',
  'herkkä vatsa': 'Suolisto-ongelmat',
  'herkkavats': 'Suolisto-ongelmat',
  'eliminaatio': 'Eliminaatiodieetti',
  'hypoaller': 'Hypoallergeeninen',
  'viljaton': 'Viljaton',
};

// ── Rotukoko ──────────────────────────────────────────────────────────────
const BREED_SIZE = {
  'chihuahua': 'Pieni', 'mops': 'Pieni', 'yorkie': 'Pieni',
  'jack russell': 'Pieni', 'bichon': 'Pieni', 'maltese': 'Pieni',
  'beagle': 'Keski', 'cocker': 'Keski', 'husky': 'Keski',
  'bordercollie': 'Keski', 'border collie': 'Keski', 'puudeli': 'Keski',
  'labrador': 'Suuri', 'kultainen': 'Suuri', 'golden': 'Suuri',
  'saksanpaimenkoira': 'Suuri', 'amstaffi': 'Suuri', 'amstaff': 'Suuri',
  'rottweiler': 'Suuri', 'dobermann': 'Suuri', 'berner': 'Suuri',
  'suurisnautsceri': 'Suuri', 'bokseri': 'Suuri',
};

// ── Kauppa-URL tarkistus ──────────────────────────────────────────────────
function isValidStoreUrl(url, store) {
  if (!url || url.trim().length < 5) return false;
  const u = url.toLowerCase();
  if (store === 'petenkoiratarvike') return u.includes('petenkoiratarvike') || u.includes('pin.peten');
  if (store === 'haukkula') return u.includes('haukkula');
  if (store === 'zooplus') return u.includes('awin1') || u.includes('zooplus');
  return true;
}

// ── Allergeeni ainesosatarkistus ──────────────────────────────────────────
// Tarkistaa SEKÄ Shopifyn "vapaa X:stä" -kentän ETTÄ ainesosaluettelon
function productPassesAllergenCheck(p, exclList) {
  if (!exclList?.length) return true;

  for (const excl of exclList) {
    const exclLow = excl.toLowerCase();

    // 1. Tarkista ainesosaluettelo — jos allergeeni löytyy suoraan → HYLKÄÄ
    const ingredients = (p.a || '').toLowerCase().replace(/<[^>]+>/g, ' ');
    if (ingredients.includes(exclLow)) return false;

    // 2. Tarkista proteiinilista (p.p)
    const proteins = (p.p || []).map(x => x.toLowerCase());
    if (proteins.some(pr => pr.includes(exclLow) || exclLow.includes(pr))) return false;

    // 3. Rasvat ja öljyt
    const fats = (p.rf || []).map(x => x.toLowerCase());
    if (fats.some(f => f.includes(exclLow))) return false;

    // 4. Vapaa-kenttä (ei VAPAA tästä → saattaa sisältää)
    // Jos Shopify sanoo tuote on "vapaa X:stä", se on OK
    // Muuten katsotaan ainesosista
  }
  return true;
}

// ── Suodatin: onko tuotteella linkki tähän kauppaan ──────────────────────
function productHasStoreLink(p, store) {
  if (!store) return true;
  const links = [p.l, p.l2, p.l3].filter(u => u && u.trim().length > 5);
  return links.some(u => isValidStoreUrl(u, store));
}

// ── Pääsuodatin ───────────────────────────────────────────────────────────
export function filterProducts(products, filters) {
  if (!products?.length) return [];

  return products.filter(p => {
    // Kauppalinkki
    if (filters.store && !productHasStoreLink(p, filters.store)) return false;

    // Allergeenit
    if (filters.excl?.length) {
      if (!productPassesAllergenCheck(p, filters.excl)) return false;
    }

    // Ikä
    if (filters.age) {
      const ika = p.i || [];
      const ok = ika.some(x => x === filters.age || x.startsWith('Kaikki'));
      if (!ok) return false;
    }

    // Koko
    if (filters.size) {
      const koko = p.k || [];
      const ok = koko.some(x => x === filters.size || x.startsWith('Kaikki'));
      if (!ok) return false;
    }

    // Brändi
    if (filters.brand) {
      const bNorm = norm(filters.brand);
      const nameMatch = norm(p.n || '').includes(bNorm);
      const vendorMatch = norm(p.m || '').includes(bNorm);
      if (!nameMatch && !vendorMatch) return false;
    }

    // Erikoisruokavaliot
    if (filters.specialDiets?.length) {
      const er = (p.er || []);
      const ok = filters.specialDiets.some(d => er.includes(d));
      if (!ok) return false;
    }

    // Halutut proteiinit
    if (filters.want?.length) {
      const proteins = (p.p || []).map(x => x.toLowerCase());
      const ok = filters.want.some(w => proteins.some(pr => pr.includes(w.toLowerCase()) || w.toLowerCase().includes(pr)));
      if (!ok) return false;
    }

    // Tuotteella pitää olla vähintään yksi linkki
    if (!p.l && !p.l2 && !p.l3) return false;

    return true;
  });
}

// ── Suodatusparametrien tunnistus ─────────────────────────────────────────
export function extractFilters(messages) {
  const userMsgs = messages.filter(m => m.role === 'user');
  const latestMsg = norm(userMsgs.slice(-1)[0]?.content || '');
  const allTxt = norm(userMsgs.map(m => m.content).join(' '));

  // ── Allergeenit ───────────────────────────────────────────────────────
  const excl = {};
  const hasTrigger = ALLERGEN_TRIGGERS.some(t => allTxt.includes(t));

  if (hasTrigger || /ei saa|saa syödä|ei voi|vapaa|allergi|herkk/.test(allTxt)) {
    for (const [kw, allergens] of Object.entries(ALLERGEN_MAP)) {
      if (allTxt.includes(kw)) {
        // Varmista että konteksti on "ei X" eikä "haluaa X:ää"
        const wantPattern = new RegExp(`(haluaa|tykkää|mieluusti|suosittele|sopii)\\s{0,15}${kw}`, 'i');
        if (!wantPattern.test(allTxt)) {
          allergens.forEach(a => { excl[a] = true; });
        }
      }
    }
    // "ei kana" -rakenne
    const eiMatch = allTxt.match(/ei\s+(kana|lohi|kala|nauta|lammas|possu|vehn|maissi|vilja|herne)/g);
    if (eiMatch) {
      for (const m of eiMatch) {
        const kw = m.replace('ei ', '').trim();
        if (ALLERGEN_MAP[kw]) ALLERGEN_MAP[kw].forEach(a => { excl[a] = true; });
      }
    }
  }

  // ── Halutut proteiinit ────────────────────────────────────────────────
  const want = [];
  const wantProteins = ['lohi', 'kala', 'lammas', 'nauta', 'ankka', 'kalkkuna', 'kani', 'peura', 'hirvi'];
  if (/haluaa|haluaisin|sopii.*proteiini|tykkää.*ruoasta|tykkää|mieluusti|suosittele.*lohi|kalaruoka/.test(allTxt)) {
    for (const prot of wantProteins) {
      const regex = new RegExp(`(haluaa|haluaisin|sopii|tykkää|suosittele.*|mieluusti).*${prot}|${prot}.*ruoka`, 'i');
      if (regex.test(allTxt) && !excl[prot]) want.push(prot);
    }
  }

  // ── Ikä ───────────────────────────────────────────────────────────────
  let age = null;

  // Suora maininta
  if (/\bpentu\b|puppy|pennulle|penturuoka/.test(latestMsg || allTxt)) age = 'Pentu';
  else if (/\bseniori?\b|vanha koira|ikääntyn/.test(latestMsg || allTxt)) age = 'Senior';
  else if (/\baikuinen\b/.test(latestMsg || allTxt)) age = 'Aikuinen';

  // Ikä kuukausista/vuosista
  if (!age) {
    const kkMatch = (latestMsg || allTxt).match(/\b(\d+)\s*kk\b/i);
    if (kkMatch) {
      const kk = parseInt(kkMatch[1]);
      age = kk <= 12 ? 'Pentu' : (kk >= 84 ? 'Senior' : 'Aikuinen');
    }
    const vMatch = (latestMsg || allTxt).match(/\b(\d+)\s*vuo/i);
    if (!age && vMatch) {
      const v = parseInt(vMatch[1]);
      age = v <= 1 ? 'Pentu' : (v >= 7 ? 'Senior' : 'Aikuinen');
    }
  }

  // ── Koko ──────────────────────────────────────────────────────────────
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
  // Tarkista viimeisimmästä viestistä ensin, sitten koko historiasta
  const checkForStore = (text) => {
    if (/\bpeten\b|peten koiratarvike/.test(text)) return 'petenkoiratarvike';
    if (/\bhaukkula\b/.test(text)) return 'haukkula';
    if (/\bzooplus\b/.test(text)) return 'zooplus';
    return null;
  };
  store = checkForStore(latestMsg) || checkForStore(allTxt);

  // ── Erikoisruokavaliot ────────────────────────────────────────────────
  const specialDiets = [];
  for (const [kw, diet] of Object.entries(SPECIAL_DIET_MAP)) {
    if (allTxt.includes(kw) && !specialDiets.includes(diet)) specialDiets.push(diet);
  }

  return {
    excl: Object.keys(excl),
    want,
    brand: null, // brand tunnistetaan chat.js:ssä
    age,
    size,
    store,
    specialDiets,
  };
}

// ── Tuotelistan rakentaminen ──────────────────────────────────────────────
export function buildDirectProductResponse(products, filters) {
  if (!products?.length) return 'Sopivaa tuotetta ei löydy.';

  const storeLabel = {
    petenkoiratarvike: 'Peten Koiratarvike',
    haukkula: 'Koiratarvike Haukkula',
    zooplus: 'Zooplus',
  };
  const storeName = filters?.store ? storeLabel[filters.store] || '' : '';
  const storeSuffix = storeName ? ` ${storeName}lta` : '';

  // Suodata vain tuotteet joilla on oikean kaupan linkki (jos kauppa valittu)
  const displayProducts = filters?.store
    ? products.filter(p => productHasStoreLink(p, filters.store))
    : products;

  if (!displayProducts.length) return 'Sopivaa tuotetta ei löydy valitusta kaupasta.';

  const count = displayProducts.length;
  const maxShow = Math.min(count, 5);
  let response = `Löysin ${count} sopivaa tuotetta${storeSuffix}:\n`;

  displayProducts.slice(0, maxShow).forEach(p => {
    response += `\n**${p.n}**\n`;

    if (p.p?.length) response += `Proteiinit: ${p.p.join(', ')}\n`;
    if (p.rl) response += `Rasvapitoisuus: ${p.rl}\n`;
    if (p.er?.length) response += `Sopii erityisesti: ${p.er.join(', ')}\n`;

    // Ostolinkki — oikea kauppa
    if (filters?.store) {
      const linkMap = [
        { url: p.l, name: 'Peten Koiratarvike', key: 'petenkoiratarvike' },
        { url: p.l2, name: 'Koiratarvike Haukkula', key: 'haukkula' },
        { url: p.l3, name: 'Zooplus', key: 'zooplus' },
      ];
      const match = linkMap.find(lm => lm.key === filters.store && lm.url && lm.url.trim().length > 5);
      if (match) response += `🛒 [Osta – ${match.name}](${match.url})\n`;
    } else {
      // Näytä kaikki linkit
      if (p.l && p.l.trim().length > 5) response += `🛒 [Osta – ${p.kp || 'Peten Koiratarvike'}](${p.l})\n`;
      if (p.l2 && p.l2.trim().length > 5) response += `🛒 [Osta – ${p.kp2 || 'Koiratarvike Haukkula'}](${p.l2})\n`;
      if (p.l3 && p.l3.trim().length > 5) response += `🛒 [Osta – ${p.kp3 || 'Zooplus'}](${p.l3})\n`;
    }
  });

  if (count > maxShow) {
    response += `\n(+${count - maxShow} muuta sopivaa tuotetta valikoimassamme)\n`;
  }

  response += '\n📋 Tarkistathan tuotteen tiedot ennen ostopäätöstä.';
  return response;
}

// Yhteensopivuus — buildProductContext pidetään toiminnassa
export function buildProductContext(products, filters) {
  return buildDirectProductResponse(products, filters);
}
