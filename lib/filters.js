// lib/filters.js — Suodatuslogiikka suomen kielen taivutuksineen
// Tämä on sama logiikka kuin hauku-widget.html:n JS, mutta Node.js-muodossa

function norm(s) {
  return s.toLowerCase()
    .replace(/[^a-zäöå ]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

// ─── ALLERGEENIKARTTA (66 merkintää + suomen sijamuodot) ──────────────────────
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
  // Punainen liha + sijamuodot
  'nauta': ['Nauta', 'Naudanrasva'],
  'naud': ['Nauta', 'Naudanrasva'],         // naudasta, naudalle, naudalla
  'naudanliha': ['Nauta', 'Naudanrasva'],
  'naudanrasva': ['Naudanrasva'],
  'lammas': ['Lammas', 'Lampaanrasva'],
  'lampaa': ['Lammas', 'Lampaanrasva'],     // lampaalle, lampaasta
  'lampaanliha': ['Lammas', 'Lampaanrasva'],
  'lampaanrasva': ['Lampaanrasva'],
  'possu': ['Possu', 'Sianrasva'],
  'possul': ['Possu', 'Sianrasva'],
  'sika': ['Possu', 'Sianrasva'],
  'sianrasva': ['Sianrasva'],
  'villisika': ['Possu', 'Sianrasva'],
  // Riista + sijamuodot
  'hirvi': ['Hirvi'],
  'hirve': ['Hirvi'],    // hirvelle, hirvestä
  'hirven': ['Hirvi'],
  'hirvenliha': ['Hirvi'],
  'peura': ['Peura'],
  'poro': ['Peura'],
  'jänis': ['Jänis'],
  'janis': ['Jänis'],
  'kani': ['Jänis'],
  'kanin': ['Jänis'],
  'hevonen': ['Hevonen'],
  'hevos': ['Hevonen'],  // hevoselle, hevosesta
  // Kala + sijamuodot
  'kala': ['Kala'],
  'lohi': ['Lohi'],
  'lohe': ['Lohi'],       // lohelle, lohesta, lohen
  'lohelle': ['Lohi'],
  'lohesta': ['Lohi'],
  'lohiöljy': ['Lohi'],
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

// Triggerit jotka osoittavat allergiaa/herkkyyttä
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

// Erikoisruokavalioiden tunnistus
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

// Rotukohtainen koko
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

  // Kontekstin vaihto ("kaverillani on koira") → nollaa allergeenit
  const RESET_WORDS = ['kaverillani', 'ystävälläni', 'toinen koira', 'myos toinen', 'toisella koiralla'];
  const hasReset = RESET_WORDS.some(w => latestMsg.includes(norm(w)));
  const allergenMsgs = hasReset ? userMsgs.slice(-2) : lastUserMsgs;
  const userTxt = norm(allergenMsgs.map(m => m.content).join(' '));

  const excl = {};
  const want = [];
  let brand = null, age = null, size = null;

  // ── Allergeenien tunnistus ─────────────────────────────────────────────────
  // 1. Pattern-pohjainen: "ei saa syödä X, Y ja Z"
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

  // 2. Trigger-pohjainen: allergeeni + trigger lähellä toisiaan
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

  // ── Kalaruoka = WANT ei EXCL ───────────────────────────────────────────────
  if (/kalaruoa|kala[\s-]?ruoa|lohi[\s-]?ruoa/.test(userTxt)) {
    delete excl['Kala'];
  }
  if (/kalaruoa|kalapitoinen|rakastaa kalaa/.test(userTxt)) {
    ['Kala'].forEach(v => { if (!want.includes(v)) want.push(v); });
  }

  // ── Halutut proteiinit ────────────────────────────────────────────────────
  const WT = ['rakastaa', 'tykkaa', 'haluaa', 'sopii', 'suosittele', 'etsin', 'mieluiten'];
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

  // ── Want/excl konflikti: poista exclistä jos myös wantissa ────────────────
  for (const w of want) {
    delete excl[w];
  }

  // ── Erikoisruokavaliot ────────────────────────────────────────────────────
  const specialDiets = [];
  for (const [kw, diets] of Object.entries(SPECIAL_DIET_MAP)) {
    if (allTxt.includes(kw)) {
      diets.forEach(d => { if (!specialDiets.includes(d)) specialDiets.push(d); });
    }
  }

  // ── Matalarasvainen ───────────────────────────────────────────────────────
  const wantLowFat = /v[äa]h[äa]rasva|matalarasva|alhainen rasva|low fat|löys[äa] vatsa|ylipaino|lihav|kevyt|light/.test(allTxt);

  // ── Ikä ───────────────────────────────────────────────────────────────────
  if (/pentu|puppy|pennulle/.test(latestMsg || allTxt)) age = 'Pentu';
  else if (/senior|seniori|vanha |7v|8v|9v|10v/.test(latestMsg || allTxt)) age = 'Senior';
  else if (/aikuinen|adult/.test(latestMsg || allTxt)) age = 'Aikuinen';

  // ── Koko ──────────────────────────────────────────────────────────────────
  for (const [breed, sz] of Object.entries(BREED_SIZE)) {
    if (allTxt.includes(breed)) { size = sz; break; }
  }
  if (!size) {
    if (/pieni |pienelle|miniatur|pienrotuinen/.test(latestMsg || allTxt)) size = 'Pieni';
    else if (/suuri |suurelle|iso |isokokoin/.test(latestMsg || allTxt)) size = 'Suuri';
    else if (/keski|medium /.test(latestMsg || allTxt)) size = 'Keski';
  }

  // ── Red flag -oireet ──────────────────────────────────────────────────────
  const RED_FLAGS = ['verta', 'veristä', 'musta uloste', 'kourist', 'tajuton', 'ei pysty nousem'];
  const hasRedFlag = RED_FLAGS.some(rf => allTxt.includes(rf));

  return {
    excl: Object.keys(excl),
    want,
    brand,
    age,
    size,
    specialDiets,
    wantLowFat,
    hasRedFlag,
  };
}

export function filterProducts(products, filters) {
  if (!products.length) return [];

  // Erikoisruokavaliot: haiman vajaatoiminta, virtsakivet jne.
  if (filters.specialDiets?.length > 0) {
    let sdRes = products.filter(p =>
      filters.specialDiets.some(sd => (p.er || []).includes(sd))
    );
    // Lisää allergeenisuodatus päälle
    if (filters.excl.length) {
      sdRes = sdRes.filter(p =>
        filters.excl.every(a => (p.v || []).map(x => x.toLowerCase()).includes(a.toLowerCase()))
      );
    }
    // Matalarasvainen: järjestä rasvan mukaan
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
    const vapaa = (p.v || []).map(x => x.toLowerCase());
    const ainesosat = (p.a || '').toLowerCase();
    
    // Allergeenisuodatus: tarkista vapaa-lista JA ainesosat
    if (filters.excl.length) {
      for (const excl of filters.excl) {
        const exclLow = excl.toLowerCase();
        // Jos vapaa-listassa on merkintä, luota siihen
        if (vapaa.length > 0) {
          if (!vapaa.includes(exclLow)) return false;
        } else if (ainesosat.length > 0) {
          // Muuten tarkista ainesosat - jos allergeeni löytyy ainesosista, hylkää
          const allergenPatterns = {
            'kana': ['kana', 'kanaliha', 'kananliha', 'kananrasva', 'kananmuna', 'broileri', 'siipikarja'],
            'kananrasva': ['kananrasva'],
            'nauta': ['nauta', 'naudanliha', 'naudanrasva', 'beef'],
            'lohi': ['lohi', 'lohiöljy'],
            'peruna': ['peruna'],
            'riisi': ['riisi'],
            'vehnä': ['vehnä', 'gluteeni'],
            'herne': ['herne'],
            'lammas': ['lammas', 'lampaan'],
          };
          const patterns = allergenPatterns[exclLow] || [exclLow];
          if (patterns.some(p => ainesosat.includes(p))) return false;
        }
      }
    }
    // Haluttu proteiini
    if (filters.want.length && !filters.want.some(w => (p.p || []).includes(w))) return false;
    // Brändi
    if (filters.brand) {
      const bNorm = norm(filters.brand);
      const mNorm = norm(p.m || '');
      const nNorm = norm(p.n || '');
      if (!mNorm.includes(bNorm) && !nNorm.includes(bNorm)) return false;
    }
    // Ikä
    if (filters.age && !(p.i || []).some(x => x === filters.age || x === 'Kaikki')) return false;
    // Koko
    if (filters.size && !(p.k || []).some(x => x === filters.size || x === 'Kaikki')) return false;
    return true;
  });

  // Fallback ilman kokoa
  if (res.length === 0 && filters.size) {
    res = products.filter(p => {
      const vapaa = (p.v || []).map(x => x.toLowerCase());
      if (filters.excl.length && !filters.excl.every(a => vapaa.includes(a.toLowerCase()))) return false;
      if (filters.want.length && !filters.want.some(w => (p.p || []).includes(w))) return false;
      return true;
    });
  }

  // Brändifallback: jos brändi löytyy mutta allergeenifilteri poistaa kaikki
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

  return res.slice(0, filters.brand ? 25 : 15);
}

export function buildProductContext(products, filters) {
  if (!products.length) {
    return '\n\n[Valikoimastamme ei löydy näillä kriteereillä sopivaa tuotetta. Kerro rehellisesti ja ohjaa tarvittaessa info@ruokakoiralle.fi]';
  }

  const el = filters.excl.length ? ` (ei sisällä: ${filters.excl.join(', ')})` : '';
  const lines = [`\n\n<tuotteet_tietokannasta>\nLöydetty ${products.length} sopivaa tuotetta${el}:`];
  const hasWarning = products.some(p => p._allergenWarning);
  if (hasWarning) lines.push('HUOM: Nämä ovat kaikki brändin tuotteet – osa voi sisältää kiellettyjä allergeeneja. Tarkista ainesosat ja kerro asiakkaalle mitkä sopivat.');

  const maxP = products.length <= 3 ? products.length : 5;
  products.slice(0, maxP).forEach(p => {
    lines.push('');
    const tt = p.tt ? `[${p.tt}] ` : '';
    lines.push(`${tt}${p.n} (${p.m})`);
    if (p.p?.length) lines.push(`Proteiinit: ${p.p.join(', ')}`);
    if (p.i?.length) lines.push(`Ikäryhmä: ${p.i.join(', ')}`);
    if (p.k?.length) lines.push(`Koko: ${p.k.join(', ')}`);
    if (p.a) lines.push(`Ainesosat: ${p.a}`);
    if (p.rv) lines.push(`Ravintoarvot: ${p.rv}`);
    if (p.rf?.length) lines.push(`Rasvat ja öljyt: ${p.rf.join(', ')}`);
    if (p.rl) lines.push(`Rasvapitoisuus: ${p.rl}`);
    if (p.er?.length) lines.push(`Erityisruokavaliot: ${p.er.join(', ')}`);
    if (p.kp && p.l) lines.push(`Osta (${p.kp}): ${p.l}`);
    if (p.kp2 && p.l2) lines.push(`Osta myös (${p.kp2}): ${p.l2}`);
  });

  if (products.length > maxP) lines.push(`\n...+${products.length - maxP} muuta sopivaa tuotetta.`);
  lines.push('\n</tuotteet_tietokannasta>');
  lines.push('Käytä yllä olevat TARKAT tiedot. Vastaa suoraan datan perusteella. Mainitse aina ostolinkki.');

  return lines.join('\n');
}
