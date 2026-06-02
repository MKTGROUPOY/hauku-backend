// lib/filters.js — Suodatuslogiikka v3 — turvallinen, auditoitu

function norm(s) {
  return s.toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

// ─── Allergeenikartta: käyttäjän sanat → Shopify-allergeeniavainsanat ──────
const ALLERGEN_MAP = {
  'kana': ['Kana', 'Kananrasva'],
  'kananliha': ['Kana', 'Kananrasva'],
  'kananrasva': ['Kananrasva'],
  'kananmuna': ['Kananmuna'],
  'muna': ['Kananmuna'],
  'kalkkuna': ['Kalkkuna', 'Kalkkunanrasva'],
  'kalkkunalle': ['Kalkkuna', 'Kalkkunanrasva'],
  'ankka': ['Ankka', 'Ankanrasva'],
  'siipikarja': ['Kana', 'Kananrasva', 'Kalkkuna', 'Kalkkunanrasva', 'Ankka', 'Ankanrasva'],
  'nauta': ['Nauta', 'Naudanrasva'],
  'naudanliha': ['Nauta', 'Naudanrasva'],
  'lammas': ['Lammas', 'Lampaanrasva'],
  'lampaanliha': ['Lammas', 'Lampaanrasva'],
  'possu': ['Possu', 'Sianrasva'],
  'sika': ['Possu', 'Sianrasva'],
  'hirvi': ['Hirvi'],
  'hirvenliha': ['Hirvi'],
  'peura': ['Peura'],
  'poro': ['Peura'],
  'jänis': ['Jänis'],
  'kani': ['Jänis'],
  'hevonen': ['Hevonen'],
  'kala': ['Kala', 'Kalaöljy'],
  'kalaöljy': ['Kala', 'Kalaöljy'],
  'lohi': ['Lohi', 'Lohiöljy', 'Kalaöljy', 'Kala', 'Silakka'],
  'lohiöljy': ['Lohi', 'Lohiöljy'],
  'silakka': ['Silakka'],
  'vehnä': ['Vehnä'],
  'kaura': ['Kaura'],
  'ohra': ['Ohra'],
  'maissi': ['Maissi'],
  'gluteeni': ['Vehnä'],
  'vilja': ['Vehnä', 'Kaura', 'Ohra', 'Maissi'],
  'viljat': ['Vehnä', 'Kaura', 'Ohra', 'Maissi'],
  'viljaton': ['Vehnä', 'Kaura', 'Ohra', 'Maissi'],
  'herne': ['Herne'],
  'soija': ['Soija', 'Soijaöljy'],
  'peruna': ['Peruna'],
  'bataatti': ['Bataatti'],
  'riisi': ['Riisi'],
};

const TRIGGERS = [
  'allergi', 'herkk', 'ei sovi', 'vapaa', 'ei kesta', 'ei voi',
  'oireilu', 'reagoi', 'ei sieda', 'ei saa', 'saa syoda',
  'intoleranssi', 'ongelma', 'aiheuttaa', 'reaktio',
  'rajoitus', 'kielletty', 'tulee oireita', 'tuli oireita',
  'tuli löysä', 'löysä vatsa', 'oireita', 'oireilee', 'ei pysty',
];

const SPECIAL_DIET_MAP = {
  'virtsakiv': ['Virtsakivet'],
  'virtsatei': ['Virtsakivet'],
  'urinary': ['Virtsakivet'],
  'steriloitu': ['Steriloiduille'],
  'kastroitu': ['Steriloiduille'],
  'painonhallin': ['Painonhallinta'],
  'ylipaino': ['Painonhallinta'],
  'lihav': ['Painonhallinta'],
  'iho-ongel': ['Iho-ongelmat', 'Hypoallergeeninen'],
  'ihottum': ['Iho-ongelmat', 'Hypoallergeeninen'],
  'atoop': ['Iho-ongelmat', 'Hypoallergeeninen'],
  'kutisee': ['Iho-ongelmat', 'Hypoallergeeninen'],
  'nivel-ongel': ['Nivel-ongelmat'],
  'nivelongel': ['Nivel-ongelmat'],
  'suolisto': ['Suolisto-ongelmat'],
  'gastro': ['Suolisto-ongelmat'],
  'ripuli': ['Suolisto-ongelmat'],
  'hypoaller': ['Hypoallergeeninen'],
};

const BREED_SIZE = {
  'chihuahua': 'Pieni', 'mops': 'Pieni', 'yorkie': 'Pieni', 'jack russell': 'Pieni',
  'villakoira': 'Keski', 'puudeli': 'Keski', 'beagle': 'Keski', 'cocker': 'Keski',
  'husky': 'Keski', 'border collie': 'Keski', 'bordercollie': 'Keski',
  'labrador': 'Suuri', 'labradorin': 'Suuri', 'kultainen noutaja': 'Suuri',
  'golden retriever': 'Suuri', 'saksanpaimenkoira': 'Suuri', 'amstaffi': 'Suuri',
  'amstaff': 'Suuri', 'rottweiler': 'Suuri', 'boxeri': 'Suuri',
  'dobermann': 'Suuri', 'berner': 'Suuri',
};

// ─── Kauppa-URL validointi ───────────────────────────────────────────────────
function isValidStoreUrl(url, store) {
  if (!url) return false;
  const u = url.toLowerCase();
  if (store === 'petenkoiratarvike') return u.includes('petenkoiratarvike') || u.includes('pin.peten');
  if (store === 'haukkula')          return u.includes('haukkula');
  if (store === 'zooplus')           return u.includes('awin1') || u.includes('zooplus');
  return !!url;
}

// ─── Allergeenipatternit ainesosatarkistukseen ─────────────────────────────
// Käytetään productPassesAllergenCheck:issa
const ALLERGEN_INGREDIENT_PATTERNS = {
  'kana':       ['kana', 'kanaliha', 'kananliha', 'kananrasva', 'broileri', 'siipikarja', 'siipikarjanliha', 'siipikarjanrasva', 'siipikarjanproteiini', 'siipikarjaproteiini'],
  'kananrasva': ['kananrasva', 'siipikarjanrasva'],
  'kananmuna':  ['kananmuna'],
  'kalkkuna':   ['kalkkuna', 'kalkkunanrasva', 'kalkkunanliha'],
  'ankka':      ['ankka', 'ankanrasva', 'ankanliha'],
  'lohi':       ['lohi', 'lohiöljy', 'lohijauho', 'lohifilee', 'kalaöljy', 'fish oil', 'siika', 'silakka', 'lohesta', 'kala', 'kalajauho', 'white fish', 'whitefish'],
  'lohiöljy':   ['lohiöljy'],
  'kala':       ['kala', 'kalajauho', 'kalaöljy', 'lohiöljy', 'silakka', 'taimen', 'turska', 'silli', 'fish'],
  'kalaöljy':   ['kalaöljy', 'fish oil', 'kalajauho'],
  'nauta':      ['nauta', 'naudanliha', 'naudanrasva', 'beef', 'härkä'],
  'lammas':     ['lammas', 'lampaan', 'lampaanliha', 'lampaanrasva'],
  'possu':      ['possu', 'sianliha', 'sianrasva', 'pork'],
  'hirvi':      ['hirvi', 'hirvenliha'],
  'peura':      ['peura', 'poro', 'poroa'],
  'jänis':      ['jänis', 'kani'],
  'hevonen':    ['hevonen', 'hevonenliha'],
  'peruna':     ['peruna'],
  'bataatti':   ['bataatti'],
  'vehnä':      ['vehnä', 'gluteeni', 'vehnägluteeni', 'vehnäjauho'],
  'kaura':      ['kaura', 'kauranjauho'],
  'ohra':       ['ohra', 'ohrajauho'],
  'maissi':     ['maissi', 'maissijauho', 'maissitärkkelys'],
  'herne':      ['herne'],
  'soija':      ['soija', 'soijaproteiini', 'soijaöljy'],
  'riisi':      ['riisi'],
  'silakka':    ['silakka'],
};

// ─── Allergeeniturvallisuustarkistus ─────────────────────────────────────
// KRIITTINEN: Jos ei dataa, hylkää turvallisesti (fail-safe)
function productPassesAllergenCheck(p, exclList) {
  if (!exclList || !exclList.length) return true;

  const vapaa     = (p.v || []).map(x => x.toLowerCase());
  const ainesosat = (p.a || '').toLowerCase();
  const proteiinit = (p.p || []).map(x => x.toLowerCase()); // Tarkista myös proteiinit-kenttä

  for (const excl of exclList) {
    const exclLow = excl.toLowerCase();
    const patterns = ALLERGEN_INGREDIENT_PATTERNS[exclLow] || [exclLow];

    // 1. Eksplisiittinen vapaa-merkintä → allergeeni hyväksytty tässä tuotteessa
    if (vapaa.includes(exclLow)) continue;

    // 2. Tarkista proteiinit-kenttä — UUSI: estää "Proteiinit: Kana" läpipääsyn
    if (proteiinit.some(pr => patterns.some(pat => pr.includes(pat)))) return false;

    // 3. Tarkista ainesosateksti
    if (ainesosat.length > 0) {
      if (patterns.some(pat => ainesosat.includes(pat))) return false;
      continue; // Ainesosat löytyy eikä allergeenia → ok
    }

    // 4. Ei dataa lainkaan → hylkää turvallisesti
    return false;
  }
  return true;
}

// ─── Yhteiset suodattimet helperfunktiona — EI duplikaattikoodia ──────────
function applyCommonFilters(products, filters, includeAllergen = true) {
  return products.filter(p => {
    // Allergeenisuodatus
    if (includeAllergen && !productPassesAllergenCheck(p, filters.excl)) return false;
    // Want-proteiini
    if (filters.want?.length && !filters.want.some(w => (p.p || []).includes(w))) return false;
    // Vähintään yksi ostolinkki
    if (!p.l && !p.l2 && !p.l3) return false;
    // Kauppasuodatus — KAIKISSA poluissa, URL-domain validoitu
    if (filters.store) {
      let hasStore = false;
      if (filters.store === 'petenkoiratarvike') hasStore = isValidStoreUrl(p.l, 'petenkoiratarvike');
      else if (filters.store === 'haukkula')      hasStore = isValidStoreUrl(p.l2, 'haukkula');
      else if (filters.store === 'zooplus')       hasStore = isValidStoreUrl(p.l3, 'zooplus');
      if (!hasStore) return false;
    }
    // Brändisuodatus
    if (filters.brand) {
      const bNorm = norm(filters.brand);
      if (!norm(p.m || '').includes(bNorm) && !norm(p.n || '').includes(bNorm)) return false;
    }
    return true;
  });
}

// ─── Filterien tunnistus käyttäjäviestistä ────────────────────────────────
export function extractFilters(history) {
  const userMsgs = history.filter(m => m.role === 'user');
  const lastUserMsgs = userMsgs.slice(-3);
  const allTxt = norm(history.map(m => m.content).join(' '));
  const latestMsg = userMsgs.length > 0 ? norm(userMsgs[userMsgs.length - 1].content) : '';

  const RESET_WORDS = ['kaverillani', 'ystävälläni', 'toinen koira', 'toisella koiralla'];
  const hasReset = RESET_WORDS.some(w => latestMsg.includes(norm(w)));
  const allergenMsgs = hasReset ? userMsgs.slice(-2) : lastUserMsgs;
  const userTxt = norm(allergenMsgs.map(m => m.content).join(' '));

  const excl = {};

  // 1. Ei saa -pattern
  const eiSaaPattern = /ei saa (?:syöd[äa]|syod[äa])\s+([^.!?]+)/g;
  let m2;
  while ((m2 = eiSaaPattern.exec(userTxt)) !== null) {
    const chunk = norm(m2[0]);
    for (const [kw, vals] of Object.entries(ALLERGEN_MAP)) {
      if (chunk.includes(kw)) vals.forEach(a => excl[a] = true);
    }
  }

  // 2. Trigger-pohjainen
  for (const [kw, vals] of Object.entries(ALLERGEN_MAP)) {
    let found = false;
    for (const tr of TRIGGERS) {
      if (found) break;
      let ki = userTxt.indexOf(kw);
      while (ki >= 0 && !found) {
        const ctx = userTxt.slice(Math.max(0, ki - 50), ki + 50);
        if (ctx.includes(tr)) found = true;
        ki = userTxt.indexOf(kw, ki + 1);
      }
    }
    if (found) vals.forEach(a => excl[a] = true);
  }

  // Kalaruoka = WANT ei EXCL
  if (/kalaruoa|kala[\s-]?ruoa|lohi[\s-]?ruoa/.test(userTxt)) {
    delete excl['Kala']; delete excl['Kalaöljy'];
  }

  const want = [];
  if (/kalaruoa|kalapitoinen|rakastaa kalaa/.test(userTxt)) {
    if (!want.includes('Kala')) want.push('Kala');
  }

  // Halutut proteiinit
  const WT = ['rakastaa', 'tykkaa', 'haluaa', 'sopii', 'suosittele', 'etsin',
              'mieluiten', 'pohjaista', 'pohjainen', 'pitoinen', 'sisaltava',
              'nimenomaan', 'erityisesti', 'haen', 'etsii', 'tarvitsen',
              'jossa on', 'sisaltaa', 'mita loytyy', 'mita löytyy', 'elainproteiini', 'lihana'];

  const PROTEIN_PATTERNS = [
    { name: 'Kala',     words: ['kala', 'kalaa'] },
    { name: 'Lohi',     words: ['lohi', 'lohta'] },
    { name: 'Silakka',  words: ['silakka', 'silakkaa'] },
    { name: 'Lammas',   words: ['lammas', 'lammasta'] },
    { name: 'Nauta',    words: ['nauta', 'nautaa', 'naudan'] },
    { name: 'Kana',     words: ['kana', 'kanaa', 'broileri', 'broileria'] },
    { name: 'Kalkkuna', words: ['kalkkuna', 'kalkkunaa'] },
    { name: 'Ankka',    words: ['ankka', 'ankkaa'] },
    { name: 'Hirvi',    words: ['hirvi', 'hirvea', 'hirveä'] },
    { name: 'Peura',    words: ['peura', 'peuraa'] },
    { name: 'Possu',    words: ['possu', 'possua', 'sika', 'sikaa'] }
  ];

  for (const pr of PROTEIN_PATTERNS) {
    let found = false;
    for (const w of pr.words) {
      const pi = userTxt.indexOf(w);
      if (pi >= 0) {
        const ctx = userTxt.slice(Math.max(0, pi - 150), pi + 150);
        if (WT.some(t => ctx.includes(t))) { found = true; break; }
      }
    }
    if (found && !want.includes(pr.name)) want.push(pr.name);
  }

  if (/riista|hirvipohjai|peurapohjai/.test(userTxt)) {
    ['Hirvi', 'Peura'].forEach(v => { if (!want.includes(v)) want.push(v); });
  }

  // Want/excl konflikti: EXCL voittaa aina
  for (let i = want.length - 1; i >= 0; i--) {
    if (excl[want[i]]) want.splice(i, 1);
  }

  // Erikoisruokavaliot
  const specialDiets = [];
  for (const [kw, diets] of Object.entries(SPECIAL_DIET_MAP)) {
    if (allTxt.includes(kw)) diets.forEach(d => { if (!specialDiets.includes(d)) specialDiets.push(d); });
  }

  const wantLowFat = /v[äa]h[äa]rasva|matalarasva|alhainen rasva|low fat|löys[äa] vatsa|ylipaino|lihav|kevyt|light/.test(allTxt);

  let age = null;
  if (/pentu|puppy|pennulle/.test(latestMsg || allTxt)) age = 'Pentu';
  else if (/senior|seniori|vanha |7v|8v|9v|10v/.test(latestMsg || allTxt)) age = 'Senior';
  else if (/aikuinen|adult/.test(latestMsg || allTxt)) age = 'Aikuinen';

  let size = null;
  for (const [breed, sz] of Object.entries(BREED_SIZE)) {
    if (allTxt.includes(breed)) { size = sz; break; }
  }
  if (!size) {
    if (/pieni |pienelle|miniatur/.test(latestMsg || allTxt)) size = 'Pieni';
    else if (/suuri |suurelle|iso |isokokoin/.test(latestMsg || allTxt)) size = 'Suuri';
    else if (/keski|medium /.test(latestMsg || allTxt)) size = 'Keski';
  }

  // Kauppa — VAIN viimeisimmästä viestistä
  let store = null;
  const latestStoreTxt = norm(userMsgs[userMsgs.length - 1]?.content || '').toLowerCase();
  if (/peten|petenkoira/.test(latestStoreTxt)) store = 'petenkoiratarvike';
  else if (/haukkula/.test(latestStoreTxt)) store = 'haukkula';
  else if (/zooplus/.test(latestStoreTxt)) store = 'zooplus';
  if (!store) {
    const recentStoreTxt = norm(userMsgs.slice(-2).map(m => m.content).join(' ')).toLowerCase();
    if (/peten/.test(recentStoreTxt)) store = 'petenkoiratarvike';
    else if (/haukkula/.test(recentStoreTxt)) store = 'haukkula';
    else if (/zooplus/.test(recentStoreTxt)) store = 'zooplus';
  }

  const RED_FLAGS = ['verta', 'veristä', 'musta uloste', 'kourist', 'tajuton', 'ei pysty nousem'];
  const hasRedFlag = RED_FLAGS.some(rf => allTxt.includes(rf));

  // Poissulje kliiniset eläinlääkäriruoat terveen koiran perushaussa
  const hasMedicalTerms = /maksa|munuais|hepatic|renal|gastro|haima|pankreatiit|virtsatie|urinary|sokeritauti|diabetes|saira|obesity|munuainen/.test(allTxt);
  const excludeClinical = !hasMedicalTerms;

  return { excl: Object.keys(excl), want, brand: null, age, size, specialDiets, wantLowFat, hasRedFlag, store, excludeClinical };
}

// ─── Tuotesuodatus ─────────────────────────────────────────────────────────
export function filterProducts(products, filters) {
  if (!products.length) return [];

  // ERIKOISRUOKAVALIOT — nyt kaikki suodattimet mukana (aiempi bugi: store puuttui)
  if (filters.specialDiets?.length > 0) {
    let sdRes = products.filter(p =>
      filters.specialDiets.some(sd => (p.er || []).includes(sd))
    );
    // Allergeeni + muut yhteissuodattimet
    sdRes = applyCommonFilters(sdRes, filters, true);
    // Ikä ja koko
    if (filters.age)  sdRes = sdRes.filter(p => (p.i || []).some(x => x === filters.age || x === 'Kaikki' || x.startsWith('Kaikki')));
    if (filters.size) sdRes = sdRes.filter(p => (p.k || []).some(x => x === filters.size || x === 'Kaikki' || x.startsWith('Kaikki')));

    if (filters.wantLowFat) {
      sdRes.sort((a, b) => {
        const getFat = p => { const m = (p.rv || '').match(/raakarasva:\s*([\d.,]+)/); return m ? parseFloat(m[1].replace(',', '.')) : 99; };
        return getFat(a) - getFat(b);
      });
    }

    // Fallback: löyhennä kokorajoitus jos ei tuloksia
    if (sdRes.length === 0 && filters.size) {
      sdRes = products.filter(p => filters.specialDiets.some(sd => (p.er || []).includes(sd)));
      sdRes = applyCommonFilters(sdRes, filters, true);
    }

    return sdRes.slice(0, 12);
  }

  // Kliinisten eläinlääkäriruokien tunnistus
  const CLINICAL_ER_TAGS = ['Maksan vajaatoiminta', 'Munuaisten vajaatoiminta', 'Diabetes', 'Virtsakivet'];
  const CLINICAL_NAME_WORDS = ['hepatic', 'renal', 'urinary', 'prescription diet', 'veterinary diet', 'gastro intestinal', 'diabetic', 'obesity management'];
  function isClinicalProduct(p) {
    const nameLow = (p.n || '').toLowerCase();
    if (CLINICAL_NAME_WORDS.some(w => nameLow.includes(w))) return true;
    if ((p.er || []).some(tag => CLINICAL_ER_TAGS.includes(tag))) return true;
    return false;
  }

  // PÄÄSUODATUS
  let res = products.filter(p => {
    if (!productPassesAllergenCheck(p, filters.excl)) return false;
    // Suodata kliiniset ruoat pois terveen koiran haussa
    if (filters.excludeClinical && isClinicalProduct(p)) return false;
    if (filters.want?.length && !filters.want.some(w => (p.p || []).includes(w))) return false;
    if (!p.l && !p.l2 && !p.l3) return false;
    if (filters.store) {
      // Validoi URL-domain — estää väärän kaupan linkit läpäisemästä
      let hasStore = false;
      if (filters.store === 'petenkoiratarvike') hasStore = isValidStoreUrl(p.l, 'petenkoiratarvike');
      else if (filters.store === 'haukkula')      hasStore = isValidStoreUrl(p.l2, 'haukkula');
      else if (filters.store === 'zooplus')       hasStore = isValidStoreUrl(p.l3, 'zooplus');
      if (!hasStore) return false;
    }
    if (filters.brand) {
      const bNorm = norm(filters.brand);
      if (!norm(p.m || '').includes(bNorm) && !norm(p.n || '').includes(bNorm)) return false;
    }
    if (filters.age  && !(p.i || []).some(x => x === filters.age  || x === 'Kaikki' || x.startsWith('Kaikki'))) return false;
    if (filters.size && !(p.k || []).some(x => x === filters.size || x === 'Kaikki' || x.startsWith('Kaikki'))) return false;
    return true;
  });

  // FALLBACK 1: Löyhennä kokorajoitus — allergeeni + kauppa pysyvät
  if (res.length === 0 && filters.size) {
    res = products.filter(p => {
      if (!productPassesAllergenCheck(p, filters.excl)) return false;
      if (filters.excludeClinical && isClinicalProduct(p)) return false;
      if (filters.want?.length && !filters.want.some(w => (p.p || []).includes(w))) return false;
      if (!p.l && !p.l2 && !p.l3) return false;
      if (filters.store) {
        let hasStore = false;
        if (filters.store === 'petenkoiratarvike') hasStore = isValidStoreUrl(p.l, 'petenkoiratarvike');
        else if (filters.store === 'haukkula')      hasStore = isValidStoreUrl(p.l2, 'haukkula');
        else if (filters.store === 'zooplus')       hasStore = isValidStoreUrl(p.l3, 'zooplus');
        if (!hasStore) return false;
      }
      if (filters.brand) {
        const bNorm = norm(filters.brand);
        if (!norm(p.m || '').includes(bNorm) && !norm(p.n || '').includes(bNorm)) return false;
      }
      return true;
    });
  }

  // FALLBACK 2 (brändi): Palauttaa VAIN allergeenisuodatetut tuotteet — EI KOSKAAN poista allergeenisuodatusta
  if (res.length === 0 && filters.brand) {
    const bNorm = norm(filters.brand);
    const brandAllergenSafe = products.filter(p =>
      (norm(p.m || '').includes(bNorm) || norm(p.n || '').includes(bNorm)) &&
      productPassesAllergenCheck(p, filters.excl) &&
      (p.l || p.l2 || p.l3)
    );
    if (brandAllergenSafe.length > 0) {
      return brandAllergenSafe.slice(0, 8);
    }
    // Jos KAIKKI brändin tuotteet sisältävät allergeenin → palauta tyhjä, älä palauta vaarallisia
    return [];
  }

  // Järjestys — relevantimmat ensin
  res.sort((a, b) => {
    // Pisteytetään relevanssi
    let scoreA = 0, scoreB = 0;

    // Erityisruokavaliomerkintä osuu → +2
    if (filters.specialDiets?.length) {
      if (filters.specialDiets.some(sd => (a.er || []).includes(sd))) scoreA += 2;
      if (filters.specialDiets.some(sd => (b.er || []).includes(sd))) scoreB += 2;
    }

    // Ikä täsmää → +2
    if (filters.age) {
      if ((a.i || []).includes(filters.age)) scoreA += 2;
      if ((b.i || []).includes(filters.age)) scoreB += 2;
    }

    // Koko täsmää → +1
    if (filters.size) {
      if ((a.k || []).includes(filters.size)) scoreA += 1;
      if ((b.k || []).includes(filters.size)) scoreB += 1;
    }

    // Haluttu proteiini — purity scoring: puhtaat proteiinilähteet ensin
    if (filters.want?.length) {
      function proteinScore(p) {
        const prots = (p.p || []);
        const wantedCount = filters.want.filter(w => prots.includes(w)).length;
        if (wantedCount === 0) return 0;
        // Laske "ylimääräiset" proteiinit (ei haluttu eikä geneerinen)
        const unwantedCount = prots.filter(pr => !filters.want.includes(pr) && pr !== 'Eläinperäinen').length;
        // Puhdas osuma (vain haluttua) → 5, sekainen → 3 - ylimääräiset
        return wantedCount > 0 ? Math.max(1, 5 - unwantedCount) : 0;
      }
      scoreA += proteinScore(a);
      scoreB += proteinScore(b);
    }

    // Matala rasva prioriteetti → rasva nousevasti
    if (filters.wantLowFat) {
      const getFat = p => { const m = (p.rv || '').match(/raakarasva:\s*([\d.,]+)/); return m ? parseFloat(m[1].replace(',', '.')) : 99; };
      const fatDiff = getFat(a) - getFat(b);
      if (fatDiff !== 0) return fatDiff;
    }

    // Korkein pisteet ensin, tasatilanteessa nimi
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.n.localeCompare(b.n, 'fi');
  });

  return res.slice(0, filters.brand ? 50 : 15);
}

// ─── Suora backendivastaus ilman Geminiä ──────────────────────────────────
export function buildDirectProductResponse(products, filters) {
  if (!products.length) {
    return 'Valikoimastamme ei löydy näillä kriteereillä sopivia tuotteita. Haluatko löyhentää jotain rajoitusta?';
  }

  const storeNames = { petenkoiratarvike: 'Peten Koiratarvike', haukkula: 'Koiratarvike Haukkula', zooplus: 'Zooplus' };
  const storeSuffix = filters?.store ? ` ${storeNames[filters.store] || filters.store}lta` : '';

  const maxP = Math.min(products.length, 5);
  let response = `Löysin ${products.length} sopivaa tuotetta${storeSuffix}:\n`;

  products.slice(0, maxP).forEach(p => {
    response += `\n**${p.n}**\n`;
    if (p.p?.length) response += `Proteiinit: ${p.p.join(', ')}\n`;

    // Rasvapitoisuus — käsittele JSON-string tai tavallinen teksti
    let rl = p.rl || '';
    try { const parsed = JSON.parse(rl); rl = Array.isArray(parsed) ? parsed[0] : String(parsed); } catch {}
    rl = String(rl).replace(/^\["|"\]$|^\[|\]$/g, '').trim();
    if (rl) response += `Rasvapitoisuus: ${rl}\n`;

    if (p.er?.length) response += `Sopii erityisesti: ${p.er.join(', ')}\n`;

    // Linkit — näytä vain pyydetyn kaupan linkki jos store-filtteri aktiivinen
    if (filters?.store === 'petenkoiratarvike' && p.l) {
      response += `Ostolinkki (Peten Koiratarvike): ${p.l}\n`;
    } else if (filters?.store === 'haukkula' && p.l2) {
      response += `Ostolinkki (Koiratarvike Haukkula): ${p.l2}\n`;
    } else if (filters?.store === 'zooplus' && p.l3) {
      response += `Ostolinkki (Zooplus): ${p.l3}\n`;
    } else {
      if (p.l)  response += `Ostolinkki (Peten Koiratarvike): ${p.l}\n`;
      if (p.l2) response += `Ostolinkki (Koiratarvike Haukkula): ${p.l2}\n`;
      if (p.l3) response += `Ostolinkki (Zooplus): ${p.l3}\n`;
    }
  });

  if (products.length > maxP) {
    response += `\n(+${products.length - maxP} muuta sopivaa tuotetta valikoimassamme)`;
  }

  response += '\n\n📋 Tarkistathan tuotteen tiedot ennen ostopäätöstä.';
  return response;
}

// buildProductContext — lähettää tuotedata Geminille muotoiltavaksi
export function buildProductContext(products, filters) {
  if (!products.length) {
    return '\n\n[TULOS: 0 tuotetta. Kerro asiakkaalle rehellisesti ettei valikoimasta löydy sopivia tuotteita näillä kriteereillä. ÄLÄ suosittele muita tuotteita.]';
  }

  const el = filters.excl?.length ? ` (poissuljetut allergeenit: ${filters.excl.join(', ')})` : '';
  const maxP = products.length <= 3 ? products.length : (filters?.brand ? Math.min(products.length, 20) : 5);
  const approvedNames = products.slice(0, maxP).map(p => p.n);

  const lines = [];
  lines.push(`\n\n<tuotteet_tietokannasta>`);
  lines.push(`Haun tulos: ${products.length} tuotetta${el}.`);
  lines.push(`KRIITTINEN SÄÄNTÖ: Suosittele VAIN näitä ${maxP} tuotetta: ${approvedNames.join(' | ')}`);
  lines.push(`ÄLÄ lisää, korvaa tai mainitse muita tuotteita. ÄLÄ keksi ravintoarvoja.`);
  lines.push(`---`);

  products.slice(0, maxP).forEach((p, idx) => {
    const tt = p.tt ? `[${p.tt}] ` : '';
    lines.push(`TUOTE: ${tt}${p.n} | Merkki: ${p.m}`);
    if (p.p?.length)  lines.push(`Proteiinit: ${p.p.join(', ')}`);
    if (p.i?.length)  lines.push(`Ikäryhmä: ${p.i.join(', ')}`);
    if (p.k?.length)  lines.push(`Koko: ${p.k.join(', ')}`);
    if (p.er?.length) lines.push(`Erityisruokavaliot: ${p.er.join(', ')}`);
    if (p.rl)         lines.push(`Rasvapitoisuus: ${p.rl}`);
    if (idx === 0 || maxP <= 2) {
      if (p.a)  lines.push(`Ainesosat: ${p.a}`);
      if (p.rv) lines.push(`Ravintoarvot: ${p.rv}`);
    }
    if (p.v?.length) lines.push(`Allergeenitieto – vapaa näistä: ${p.v.join(', ')}`);
    // Näytä vain pyydetyn kaupan linkki jos store-filtteri on aktiivinen
    if (filters?.store === 'petenkoiratarvike' && p.l) {
      lines.push(`Ostolinkki (Peten Koiratarvike): ${p.l}`);
    } else if (filters?.store === 'haukkula' && p.l2) {
      lines.push(`Ostolinkki (Koiratarvike Haukkula): ${p.l2}`);
    } else if (filters?.store === 'zooplus' && p.l3) {
      lines.push(`Ostolinkki (Zooplus): ${p.l3}`);
    } else {
      const shownLinks = new Set();
      if (p.l  && !shownLinks.has(p.l))  { lines.push(`Ostolinkki (Peten Koiratarvike): ${p.l}`);  shownLinks.add(p.l); }
      if (p.l2 && !shownLinks.has(p.l2)) { lines.push(`Ostolinkki (Koiratarvike Haukkula): ${p.l2}`); shownLinks.add(p.l2); }
      if (p.l3 && !shownLinks.has(p.l3)) { lines.push(`Ostolinkki (Zooplus): ${p.l3}`); shownLinks.add(p.l3); }
    }
    lines.push(`---`);
  });

  if (products.length > maxP) lines.push(`(+${products.length - maxP} muuta sopivaa tuotetta)`);
  lines.push(`</tuotteet_tietokannasta>`);
  return lines.join('\n');
}
