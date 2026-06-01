// lib/filters.js — Suodatuslogiikka suomen kielen taivutuksineen v2

function norm(s) {
  return s.toLowerCase()
    .replace(/[^a-zäöå ]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

const ALLERGEN_MAP = {
  // Siipikarja
  'kana': ['Kana', 'Kananrasva'],
  'kananliha': ['Kana', 'Kananrasva'],
  'kananrasva': ['Kananrasva'],
  'kananmuna': ['Kananmuna'],
  'muna': ['Kananmuna'],
  'kalkkuna': ['Kalkkuna', 'Kalkkunanrasva'],
  'kalkkunalle': ['Kalkkuna', 'Kalkkunanrasva'],
  'kalkkunasta': ['Kalkkuna', 'Kalkkunanrasva'],
  'ankka': ['Ankka', 'Ankanrasva'],
  'ankalle': ['Ankka', 'Ankanrasva'],
  'siipikarja': ['Kana', 'Kananrasva', 'Kalkkuna', 'Kalkkunanrasva', 'Ankka', 'Ankanrasva'],
  // Punainen liha
  'nauta': ['Nauta', 'Naudanrasva'],
  'naud': ['Nauta', 'Naudanrasva'],
  'naudanliha': ['Nauta', 'Naudanrasva'],
  'naudanrasva': ['Naudanrasva'],
  'lammas': ['Lammas', 'Lampaanrasva'],
  'lampaa': ['Lammas', 'Lampaanrasva'],
  'lampaanliha': ['Lammas', 'Lampaanrasva'],
  'lampaanrasva': ['Lampaanrasva'],
  'possu': ['Possu', 'Sianrasva'],
  'possul': ['Possu', 'Sianrasva'],
  'sika': ['Possu', 'Sianrasva'],
  'sianrasva': ['Sianrasva'],
  'villisika': ['Possu', 'Sianrasva'],
  // Riista
  'hirvi': ['Hirvi'],
  'hirve': ['Hirvi'],
  'hirven': ['Hirvi'],
  'hirvenliha': ['Hirvi'],
  'peura': ['Peura'],
  'poro': ['Peura'],
  'jänis': ['Jänis'],
  'janis': ['Jänis'],
  'kani': ['Jänis'],
  'kanin': ['Jänis'],
  'hevonen': ['Hevonen'],
  'hevos': ['Hevonen'],
  // Kala
  'kala': ['Kala', 'Kalaöljy'],
  'kalaöljy': ['Kala', 'Kalaöljy'],
  'kalaöljyä': ['Kala', 'Kalaöljy'],
  'lohi': ['Lohi', 'Lohiöljy'],
  'lohiöljy': ['Lohi', 'Lohiöljy'],
  'lohiöljyä': ['Lohi', 'Lohiöljy'],
  'lohe': ['Lohi'],
  'lohelle': ['Lohi'],
  'lohesta': ['Lohi'],
  'silakka': ['Silakka'],
  // Viljat
  'vehnä': ['Vehnä'],
  'vehn': ['Vehnä'],
  'kaura': ['Kaura'],
  'ohra': ['Ohra'],
  'maissi': ['Maissi'],
  'gluteeni': ['Vehnä'],
  'vilja': ['Vehnä', 'Kaura', 'Ohra', 'Maissi'],
  'viljat': ['Vehnä', 'Kaura', 'Ohra', 'Maissi'],
  'viljaton': ['Vehnä', 'Kaura', 'Ohra', 'Maissi'],
  'viljavapaa': ['Vehnä', 'Kaura', 'Ohra', 'Maissi'],
  'gluteeniton': ['Vehnä'],
  // Palkokasvit
  'herne': ['Herne'],
  'herneet': ['Herne'],
  'hernettä': ['Herne'],
  'palkokasvit': ['Herne', 'Soija'],
  'soija': ['Soija', 'Soijaöljy'],
  'soijaöljy': ['Soijaöljy'],
  // Kasvikset
  'peruna': ['Peruna'],
  'perunat': ['Peruna'],
  'perunaa': ['Peruna'],
  'perunalle': ['Peruna'],
  'perunaton': ['Peruna'],
  'bataatti': ['Bataatti'],
  // Muut
  'riisi': ['Riisi'],
  'kookos': ['Kookosöljy'],
  'kookosöljy': ['Kookosöljy'],
};

const TRIGGERS = [
  'allergi', 'herkk', 'ei sovi', 'vapaa', 'ei kesta', 'ei voi',
  'ei ehka sovi', 'ei taida', 'ei tainnut', 'oireilu', 'reagoi',
  'ei sieda', 'ei syo', 'ei saa', 'saa syoda',
  'sopimaton', 'intoleranssi', 'ongelma', 'aiheuttaa', 'reaktio',
  'valtettava', 'rajoitus', 'kielletty',
  'tunnu sopi', 'tuntuu sopi', 'ei oikein', 'ei taida sopia',
  'ei tunnu', 'ei taida', 'ei tahdo',
  'tulee oireita', 'aiheuttaa oireita', 'saa oireita',
  'tuli oireita', 'tuli löysä', 'löysä vatsa',
  'oireita', 'oireilee', 'ei siedä', 'ei pysty', 'ei kestä',
];

const SPECIAL_DIET_MAP = {
  'munuain': ['Munuaisten vajaatoiminta'],
  'munuais': ['Munuaisten vajaatoiminta'],
  'renal': ['Munuaisten vajaatoiminta'],
  'virtsakiv': ['Virtsakivet'],
  'virtsatei': ['Virtsakivet'],
  'urinary': ['Virtsakivet'],
  'mukoseel': ['Virtsakivet', 'Munuaisten vajaatoiminta'],
  'maksa': ['Maksan vajaatoiminta'],
  'hepatic': ['Maksan vajaatoiminta'],
  'diabetes': ['Diabetes'],
  'haima': ['Haiman vajaatoiminta', 'Suolisto-ongelmat'],
  'haimatuleh': ['Haiman vajaatoiminta', 'Suolisto-ongelmat'],
  'steriloitu': ['Steriloiduille'],
  'kastroitu': ['Steriloiduille'],
  'painonhallin': ['Painonhallinta'],
  'ylipaino': ['Painonhallinta'],
  'lihav': ['Painonhallinta'],
  'iho-ongel': ['Iho-ongelmat', 'Hypoallergeeninen'],
  'ihottum': ['Iho-ongelmat', 'Hypoallergeeninen'],
  'atoop': ['Iho-ongelmat', 'Hypoallergeeninen'],
  'nuolee tassuj': ['Iho-ongelmat', 'Hypoallergeeninen'],
  'tassuja nuol': ['Iho-ongelmat', 'Hypoallergeeninen'],
  'korvat punoit': ['Iho-ongelmat', 'Hypoallergeeninen'],
  'kutisee': ['Iho-ongelmat', 'Hypoallergeeninen'],
  'nivel-ongel': ['Nivel-ongelmat'],
  'nivel': ['Nivel-ongelmat'],
  'suolisto': ['Suolisto-ongelmat'],
  'gastro': ['Suolisto-ongelmat'],
  'ripuli': ['Suolisto-ongelmat'],
  'hypoaller': ['Hypoallergeeninen'],
  'eliminaat': ['Eliminaatiodieetti'],
};

const BREED_SIZE = {
  'chihuahua': 'Pieni', 'mops': 'Pieni', 'yorkie': 'Pieni', 'jack russell': 'Pieni',
  'villakoira': 'Keski', 'puudeli': 'Keski', 'beagle': 'Keski', 'cocker': 'Keski',
  'husky': 'Keski', 'bordercollie': 'Keski', 'border collie': 'Keski',
  'labrador': 'Suuri', 'labradorin': 'Suuri', 'kultainen noutaja': 'Suuri',
  'golden retriever': 'Suuri', 'saksanpaimenkoira': 'Suuri', 'amstaffi': 'Suuri',
  'amstaff': 'Suuri', 'american staffordshire': 'Suuri', 'rottweiler': 'Suuri',
  'boxeri': 'Suuri', 'dobermann': 'Suuri', 'berner': 'Suuri',
};

export function extractFilters(history) {
  const userMsgs = history.filter(m => m.role === 'user');
  const lastUserMsgs = userMsgs.slice(-3);
  const allTxt = norm(history.map(m => m.content).join(' '));
  const latestMsg = userMsgs.length > 0 ? norm(userMsgs[userMsgs.length - 1].content) : '';

  const RESET_WORDS = ['kaverillani', 'ystävälläni', 'toinen koira', 'myos toinen', 'toisella koiralla'];
  const hasReset = RESET_WORDS.some(w => latestMsg.includes(norm(w)));
  const allergenMsgs = hasReset ? userMsgs.slice(-2) : lastUserMsgs;
  const userTxt = norm(allergenMsgs.map(m => m.content).join(' '));

  const excl = {};
  const want = [];
  let brand = null, age = null, size = null;

  // 1. Pattern-pohjainen tunnistus
  const eiSaaPattern = /ei saa (?:syöd[äa]|syod[äa])\s+([^.!?]+)/g;
  const eiSoviPattern = /ei sovi[^.!?]*/g;
  for (const pat of [eiSaaPattern, eiSoviPattern]) {
    let m;
    while ((m = pat.exec(userTxt)) !== null) {
      const chunk = norm(m[0]);
      for (const [kw, vals] of Object.entries(ALLERGEN_MAP)) {
        if (chunk.includes(kw)) vals.forEach(a => excl[a] = true);
      }
    }
  }

  // 2. Trigger-pohjainen tunnistus
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
    delete excl['Kala'];
    delete excl['Kalaöljy'];
  }
  if (/kalaruoa|kalapitoinen|rakastaa kalaa/.test(userTxt)) {
    ['Kala'].forEach(v => { if (!want.includes(v)) want.push(v); });
  }

  // Halutut proteiinit
  const WT = ['rakastaa', 'tykkaa', 'haluaa', 'sopii', 'suosittele', 'etsin', 'mieluiten',
              'tarkoitan', 'tarkoitan', 'pohjaista', 'pohjainen', 'pitoinen', 'sisaltava',
              'nimenomaan', 'erityisesti', 'juuri', 'haen', 'etsii', 'tarvitsen'];
  const PROTEINS = ['Kala', 'Lohi', 'Silakka', 'Lammas', 'Nauta', 'Kana', 'Kalkkuna', 'Ankka', 'Hirvi', 'Peura'];
  for (const pr of PROTEINS) {
    const prNorm = norm(pr);
    const pi = userTxt.indexOf(prNorm);
    if (pi >= 0) {
      const ctx = userTxt.slice(Math.max(0, pi - 50), pi + 50);
      if (WT.some(t => ctx.includes(t)) && !want.includes(pr)) {
        want.push(pr);
      }
    }
  }

  // Riistahaku — "riista", "peura", "hirvi" ilman triggereitä
  if (/riista|hirvipohjai|peurapohjai|hirvenliha|peuranlih/.test(userTxt)) {
    ['Hirvi', 'Peura'].forEach(v => { if (!want.includes(v)) want.push(v); });
  }

  // Want/excl konflikti: EXCL voittaa
  for (let i = want.length - 1; i >= 0; i--) {
    if (excl[want[i]] || excl[want[i].toLowerCase()]) {
      want.splice(i, 1);
    }
  }

  // Erikoisruokavaliot
  const specialDiets = [];
  for (const [kw, diets] of Object.entries(SPECIAL_DIET_MAP)) {
    if (allTxt.includes(kw)) {
      diets.forEach(d => { if (!specialDiets.includes(d)) specialDiets.push(d); });
    }
  }

  const wantLowFat = /v[äa]h[äa]rasva|matalarasva|alhainen rasva|low fat|löys[äa] vatsa|ylipaino|lihav|kevyt|light/.test(allTxt);

  if (/pentu|puppy|pennulle/.test(latestMsg || allTxt)) age = 'Pentu';
  else if (/senior|seniori|vanha |7v|8v|9v|10v/.test(latestMsg || allTxt)) age = 'Senior';
  else if (/aikuinen|adult/.test(latestMsg || allTxt)) age = 'Aikuinen';

  for (const [breed, sz] of Object.entries(BREED_SIZE)) {
    if (allTxt.includes(breed)) { size = sz; break; }
  }
  if (!size) {
    if (/pieni |pienelle|miniatur|pienrotuinen/.test(latestMsg || allTxt)) size = 'Pieni';
    else if (/suuri |suurelle|iso |isokokoin/.test(latestMsg || allTxt)) size = 'Suuri';
    else if (/keski|medium /.test(latestMsg || allTxt)) size = 'Keski';
  }

  let store = null;
  // Kauppa tunnistetaan VAIN viimeisimmästä käyttäjäviestistä
  // Näin "Entä Haukkulalta?" vaihtaa kaupan oikein
  const latestStoreTxt = norm(userMsgs[userMsgs.length - 1]?.content || '').toLowerCase();
  if (/peten|petenkoira|peten koiratarvike/.test(latestStoreTxt)) store = 'petenkoiratarvike';
  else if (/haukkula|koiratarvike haukkula/.test(latestStoreTxt)) store = 'haukkula';
  else if (/zooplus/.test(latestStoreTxt)) store = 'zooplus';
  // Jos viimeisin viesti on "entä X" tai "entä X:ltä" ilman aiempaa kontekstia, tarkista 2 viestiä
  if (!store) {
    const recentStoreTxt = norm(userMsgs.slice(-2).map(m => m.content).join(' ')).toLowerCase();
    if (/peten|petenkoira/.test(recentStoreTxt)) store = 'petenkoiratarvike';
    else if (/haukkula/.test(recentStoreTxt)) store = 'haukkula';
    else if (/zooplus/.test(recentStoreTxt)) store = 'zooplus';
  }

  const RED_FLAGS = ['verta', 'veristä', 'musta uloste', 'kourist', 'tajuton', 'ei pysty nousem'];
  const hasRedFlag = RED_FLAGS.some(rf => allTxt.includes(rf));

  return { excl: Object.keys(excl), want, brand, age, size, specialDiets, wantLowFat, hasRedFlag, store };
}

export function filterProducts(products, filters) {
  if (!products.length) return [];

  // Allergeenisuodatuksen apufunktio — KRIITTINEN: jos ei dataa, hylkää turvallisesti
  const allergenPatterns = {
    'kana': ['kanaliha', 'kananliha', 'kananrasva', 'broileri', 'siipikarja', 'siipikarjanliha', 'siipikarjanrasva'],
    'kananrasva': ['kananrasva', 'siipikarjanrasva'],
    'kalaöljy': ['kalaöljy', 'kala öljy', 'fish oil', 'kalajauho', 'kalaproteiini'],
    'lohiöljy': ['lohiöljy', 'lohi öljy', 'lohijauho', 'salmon oil'],
    'lohi': ['lohi', 'lohiöljy', 'lohijauho', 'lohifilee', 'lohiliemi'],
    'kala': ['kala', 'kalajauho', 'kalaöljy', 'lohiöljy', 'silakka', 'taimen', 'turska', 'fish'],
    'nauta': ['nauta', 'naudanliha', 'naudanrasva', 'beef', 'härkä'],
    'lammas': ['lammas', 'lampaan', 'lampaanliha', 'lampaanrasva'],
    'peruna': ['peruna'],
    'riisi': ['riisi'],
    'vehnä': ['vehnä', 'gluteeni', 'vehnägluteeni'],
    'herne': ['herne'],
    'soija': ['soija', 'soijaproteiini', 'soijaöljy'],
  };

  function productPassesAllergenCheck(p, exclList) {
    if (!exclList.length) return true;
    const vapaa = (p.v || []).map(x => x.toLowerCase());
    const ainesosat = (p.a || '').toLowerCase();

    for (const excl of exclList) {
      const exclLow = excl.toLowerCase();
      const patterns = allergenPatterns[exclLow] || [exclLow];

      // 1. Jos vapaa-listassa on eksplisiittinen "vapaa X" -merkintä → hyväksy tämä allergeeni
      if (vapaa.includes(exclLow)) continue;

      // 2. Jos ainesosat löytyvät → tarkista ettei allergeeni ole siellä
      if (ainesosat.length > 0) {
        if (patterns.some(pat => ainesosat.includes(pat))) return false;
        // Ainesosat löytyvät eikä allergeenia siellä → ok
        continue;
      }

      // 3. Ei ainesosatietoa eikä vapaa-merkintää → hylkää turvallisuuden vuoksi
      return false;
    }
    return true;
  }

  // Erikoisruokavaliot
  if (filters.specialDiets?.length > 0) {
    let sdRes = products.filter(p =>
      filters.specialDiets.some(sd => (p.er || []).includes(sd))
    );
    if (filters.excl.length) {
      sdRes = sdRes.filter(p => productPassesAllergenCheck(p, filters.excl));
    }
    if (filters.wantLowFat || filters.specialDiets.some(d => d.includes('vajaatoiminta') || d.includes('Suolisto'))) {
      sdRes.sort((a, b) => {
        const getFat = p => {
          const m = (p.rv || '').match(/raakarasva:\s*([\d.,]+)/);
          return m ? parseFloat(m[1].replace(',', '.')) : 99;
        };
        return getFat(a) - getFat(b);
      });
    }
    return sdRes.slice(0, 12);
  }

  let res = products.filter(p => {
    if (!productPassesAllergenCheck(p, filters.excl)) return false;
    if (filters.want.length && !filters.want.some(w => (p.p || []).includes(w))) return false;
    // Jos ei yhtään ostolinkkiä → älä näytä tuotetta lainkaan
    if (!p.l && !p.l2 && !p.l3) return false;
    if (filters.store) {
      // Kauppa tunnistetaan LINKIN SIJAINNIN perusteella (ei URL-sisällöstä):
      // kauppa_1_linkki = Peten, kauppa_2_linkki = Haukkula, kauppa_3_linkki = Zooplus
      let hasStore = false;
      if (filters.store === 'petenkoiratarvike') hasStore = !!p.l;
      else if (filters.store === 'haukkula') hasStore = !!p.l2;
      else if (filters.store === 'zooplus') hasStore = !!p.l3;
      if (!hasStore) return false;
    }
    if (filters.brand) {
      const bNorm = norm(filters.brand);
      if (!norm(p.m || '').includes(bNorm) && !norm(p.n || '').includes(bNorm)) return false;
    }
    if (filters.age && !(p.i || []).some(x => x === filters.age || x === 'Kaikki' || x.startsWith('Kaikki'))) return false;
    if (filters.size && !(p.k || []).some(x => x === filters.size || x === 'Kaikki' || x.startsWith('Kaikki'))) return false;
    return true;
  });

  // Fallback: poista VAIN kokorajoitus jos ei tuloksia — kauppa- ja allergeenisuodatus pysyy
  if (res.length === 0 && filters.size) {
    res = products.filter(p => {
      if (!productPassesAllergenCheck(p, filters.excl)) return false;
      if (filters.want.length && !filters.want.some(w => (p.p || []).includes(w))) return false;
      if (!p.l && !p.l2 && !p.l3) return false;
      if (filters.store) {
        let hasStore = false;
        if (filters.store === 'petenkoiratarvike') hasStore = !!p.l;
        else if (filters.store === 'haukkula') hasStore = !!p.l2;
        else if (filters.store === 'zooplus') hasStore = !!p.l3;
        if (!hasStore) return false;
      }
      if (filters.brand) {
        const bNorm = norm(filters.brand);
        if (!norm(p.m || '').includes(bNorm) && !norm(p.n || '').includes(bNorm)) return false;
      }
      return true;
    });
  }

  // Brändifallback — merkitse allergeenivaroituksella
  if (res.length === 0 && filters.brand) {
    const bNorm = norm(filters.brand);
    const brandOnly = products.filter(p =>
      norm(p.m || '').includes(bNorm) || norm(p.n || '').includes(bNorm)
    );
    if (brandOnly.length > 0) {
      brandOnly.forEach(p => p._allergenWarning = true);
      return brandOnly.slice(0, 8);
    }
  }

  // Järjestys
  if (filters.wantLowFat) {
    res.sort((a, b) => {
      const getFat = p => {
        const m = (p.rv || '').match(/raakarasva:\s*([\d.,]+)/);
        return m ? parseFloat(m[1].replace(',', '.')) : 99;
      };
      return getFat(a) - getFat(b);
    });
  } else if (filters.age) {
    res.sort((a, b) => {
      const aSpec = (a.i || []).includes(filters.age) ? 0 : 1;
      const bSpec = (b.i || []).includes(filters.age) ? 0 : 1;
      return aSpec !== bSpec ? aSpec - bSpec : a.n.localeCompare(b.n, 'fi');
    });
  } else {
    res.sort((a, b) => a.n.localeCompare(b.n, 'fi'));
  }

  return res.slice(0, filters.brand ? 50 : 15);
}

export function buildProductContext(products, filters) {
  if (!products.length) {
    return '\n\n[TIETOKANTAHAKU: Valikoimastamme ei löydy näillä kriteereillä yhtään sopivaa tuotetta. Kerro tämä asiakkaalle rehellisesti. Älä suosittele mitään tuotetta. Ohjaa tarvittaessa info@ruokakoiralle.fi]';
  }

  const el = filters.excl.length ? ` (poissuljetut allergeenit: ${filters.excl.join(', ')})` : '';
  const hasWarning = products.some(p => p._allergenWarning);

  const lines = [];
  lines.push(`\n\n<tuotteet_tietokannasta>`);
  lines.push(`Haun tulos: ${products.length} tuotetta${el}.`);
  lines.push(`EHDOTON SÄÄNTÖ 1: Suosittele VAIN alla lueteltuja ${products.length} tuotetta nimeltä. Brändin muita tuotteita EI OLE haettu – niitä ei ole olemassa tässä kontekstissa.`);
  lines.push(`EHDOTON SÄÄNTÖ 2: ÄLÄ KOSKAAN lisää, keksi tai "täydennä" tuotetietoja omasta tietämyksestäsi. Jos tieto puuttuu alta, se puuttuu – älä arvaile.`);
  lines.push(`EHDOTON SÄÄNTÖ 3: Älä tulosta JSON-rakennetta, koodiblokkeja tai teknistä dataa. Vastaa asiakkaalle normaalina tekstinä.`);

  if (hasWarning) {
    lines.push(`ALLERGEENIVAROITUS: Brändihaun vuoksi tuloksissa voi olla tuotteita jotka sisältävät kiellettyjä allergeeneja. Tarkista jokaisen tuotteen ainesosat ennen suosittelua ja kerro asiakkaalle mitkä sopivat.`);
  }

  const maxP = products.length <= 3
    ? products.length
    : (filters && filters.brand ? Math.min(products.length, 20) : 5);

  products.slice(0, maxP).forEach((p, idx) => {
    lines.push('---');
    const tt = p.tt ? `[${p.tt}] ` : '';
    lines.push(`TUOTE: ${tt}${p.n} | Merkki: ${p.m}`);
    if (p.p?.length)  lines.push(`Proteiinit: ${p.p.join(', ')}`);
    if (p.i?.length)  lines.push(`Ikäryhmä: ${p.i.join(', ')}`);
    if (p.k?.length)  lines.push(`Koko: ${p.k.join(', ')}`);
    if (p.v?.length)  lines.push(`TUOTE EI SISÄLLÄ NÄITÄ (allergeenitieto, vapaa-lista): ${p.v.join(', ')}`);
    if (p.er?.length) lines.push(`Erityisruokavaliot: ${p.er.join(', ')}`);
    if (p.rl)         lines.push(`Rasvapitoisuus: ${p.rl}`);
    // Täydet tiedot vain ensimmäiselle tuotteelle (yleensä exactProduct) tai jos vain 1-2 tuotetta
    if (idx === 0 || maxP <= 2) {
      if (p.a)          lines.push(`Ainesosat: ${p.a}`);
      if (p.rv)         lines.push(`Ravintoarvot: ${p.rv}`);
      if (p.la)         lines.push(`Lisäaineet: ${p.la}`);
      if (p.rf?.length) lines.push(`Rasvat ja öljyt: ${p.rf.join(', ')}`);
    }
    // Ostolinkki aina
    const shownLinks = new Set();
    if (p.l  && !shownLinks.has(p.l))  { lines.push(`Ostolinkki (Peten Koiratarvike): ${p.l}`);  shownLinks.add(p.l); }
    if (p.l2 && !shownLinks.has(p.l2)) { lines.push(`Ostolinkki (Koiratarvike Haukkula): ${p.l2}`); shownLinks.add(p.l2); }
    if (p.l3 && !shownLinks.has(p.l3)) { lines.push(`Ostolinkki (Zooplus): ${p.l3}`); shownLinks.add(p.l3); }
  });

  if (products.length > maxP) {
    lines.push(`---`);
    lines.push(`(+${products.length - maxP} muuta sopivaa tuotetta – näytä ensin yllä olevat)`);
  }

  // Whitelist SISÄLLÄ XML-tagin
  lines.push(`---`);
  lines.push(`SALLITTU TUOTELISTA (vain näitä saa suositella): ${products.slice(0, maxP).map(p => p.n).join(' | ')}`);
  lines.push(`</tuotteet_tietokannasta>`);

  return lines.join('\n');
}
