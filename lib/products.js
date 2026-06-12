// lib/products.js — v2: Shopify Admin API + JSON-fallback
//
// TOIMINTA:
//  1. Hakee kaikki aktiiviset tuotteet Shopifysta metafieldeineen (GraphQL)
//  2. Laskee jokaiselle tuotteelle "vapaa"-listan (mitä tuote EI sisällä)
//     suoraan ainesosatekstistä — FAIL-CLOSED: jos ainesosakenttä puuttuu,
//     vapaa-lista jää tyhjäksi ja tuote ei koskaan läpäise allergiasuodatusta
//  3. Välimuisti 10 min (serverless: nollautuu kylmäkäynnistyksessä, ok)
//  4. Jos Shopify-haku epäonnistuu TAI env-muuttujat puuttuvat → fallback
//     vanhaan data/tuotetietokanta_botille.json-tiedostoon
//
// VERCEL ENV -MUUTTUJAT (Settings → Environment Variables):
//  SHOPIFY_STORE_DOMAIN     esim. ruokakoiralle.myshopify.com  (PAKOLLINEN)
//  ...ja JOMPIKUMPI näistä:
//  A) SHOPIFY_ADMIN_TOKEN   vanhan custom-apin shpat_-token (API credentials)
//  B) SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
//     uuden Dev Dashboard -apin tunnukset → token haetaan automaattisesti
//     client credentials -menetelmällä ja uusitaan itsestään
//
// ⚠️ TÄYTÄ METAFIELD_MAP OIKEILLA NIMILLÄ (Shopify: Settings → Custom data → Products)

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════
// MAPPAUS — RuokaKoiralle.fi:n todelliset metafieldit
// ═══════════════════════════════════════════════════════════════════════
const METAFIELD_MAP = {
  ainesosat:      'custom.ainesosat',
  proteiinit:     'custom.proteiinit',
  hiilihydraatit: 'custom.hiilihydraatit',
  rasvat_oljyt:   'custom.rasvat_ja_oljyt',
  lisaaineet:     'custom.lisaaineet',
  ravintoaineet:  'custom.ravintoaineet',
  allergiat:      'custom.allergiat',           // semantiikka varmistettava — EI vielä käytössä suodatuksessa
  rajatut:        'custom.rajatut_raaka_aineet',
  ika:            'custom.koiran_ika',
  koko:           'custom.koiran_koko',
  rasvataso:      'custom.raakarasva',
  erikois:        'custom.erikoisruoat',
  kauppa1nimi:    'custom.kauppa_1_nimi',
  kauppa1linkki:  'custom.kauppa_1_linkki',
  kauppa2nimi:    'custom.kauppa_2_nimi',
  kauppa2linkki:  'custom.kauppa_2_linkki',
  kauppa3nimi:    'custom.kauppa_3_nimi',
  kauppa3linkki:  'custom.kauppa_3_linkki',
};

// ═══════════════════════════════════════════════════════════════════════
// ALLERGEENIEN TUNNISTUS AINESOSATEKSTISTÄ
// Kanoninen allergeeni → merkkijonot joiden ESIINTYMINEN ainesosissa
// tarkoittaa että tuote SISÄLTÄÄ allergeenin (suomi + englanti).
// Tuote merkitään vapaaksi allergeenista VAIN jos:
//  a) ainesosateksti on olemassa, JA
//  b) yksikään tunnistemerkkijono ei esiinny siinä
// Huom: tarkoituksella laaja — "kananmuna" sisältää "kana" → kananmunaa
// sisältävä tuote EI saa kana-vapaa-merkintää. Ylivarovaisuus on turvallista.
// ═══════════════════════════════════════════════════════════════════════
const ALLERGEN_SIGNATURES = {
  'Kana':          ['kana', 'broiler', 'siipikarja', 'chicken', 'poultry'],
  'Kananrasva':    ['kananrasva', 'siipikarjanrasva', 'chicken fat', 'poultry fat'],
  'Kalkkuna':      ['kalkkuna', 'siipikarja', 'turkey', 'poultry'],
  'Kalkkunanrasva':['kalkkunanrasva', 'siipikarjanrasva', 'turkey fat', 'poultry fat'],
  'Kananmuna':     ['kananmuna', 'muna', 'egg'],
  'Nauta':         ['nauta', 'naudan', 'härkä', 'beef', 'ox '],
  'Naudanrasva':   ['naudanrasva', 'beef fat', 'tallow'],
  'Lammas':        ['lammas', 'lampaan', 'karitsa', 'lamb', 'mutton'],
  'Lampaanrasva':  ['lampaanrasva', 'lamb fat'],
  'Possu':         ['possu', 'sian', 'porsas', 'pork', 'swine'],
  'Sianrasva':     ['sianrasva', 'pork fat', 'lard'],
  'Kala':          ['kala', 'lohi', 'silakka', 'taimen', 'turska', 'silli', 'sardiini', 'makrilli', 'fish', 'salmon', 'herring', 'trout', 'cod', 'sardine', 'mackerel', 'anchovy', 'krill'],
  'Kalaöljy':      ['kalaöljy', 'lohiöljy', 'fish oil', 'salmon oil', 'krill'],
  'Lohi':          ['lohi', 'salmon'],
  'Vehnä':         ['vehnä', 'wheat', 'gluteeni', 'gluten', 'spelt', 'speltti'],
  'Kaura':         ['kaura', 'oat'],
  'Ohra':          ['ohra', 'barley'],
  'Maissi':        ['maissi', 'corn', 'maize'],
  'Herne':         ['herne', 'pea ', 'peas', 'pea,', 'pea)'],
  'Soija':         ['soija', 'soy'],
  'Soijaöljy':     ['soijaöljy', 'soy oil', 'soybean oil'],
  'Peruna':        ['peruna', 'potato'],
  'Riisi':         ['riisi', 'rice'],
  'Ankka':         ['ankka', 'ankan', 'duck'],
  'Ankanrasva':    ['ankanrasva', 'duck fat'],
};

// Laske mitä tuote EI sisällä ainesosatekstin perusteella
function computeVapaa(ainesosaTeksti) {
  if (!ainesosaTeksti || ainesosaTeksti.trim().length < 3) {
    // EI ainesosatietoa → EI vapaa-merkintöjä → ei koskaan allergiselle
    return [];
  }
  const txt = ainesosaTeksti.toLowerCase();
  const vapaa = [];
  for (const [allergen, signatures] of Object.entries(ALLERGEN_SIGNATURES)) {
    const contains = signatures.some(sig => txt.includes(sig));
    if (!contains) vapaa.push(allergen);
  }
  return vapaa;
}

// ── Apufunktiot ───────────────────────────────────────────────────────────
function splitField(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.flatMap(splitField);
  let s = String(val);
  // Shopify list-tyyppiset metafieldit ovat JSON-taulukoita merkkijonona
  if (s.startsWith('[')) {
    try { return JSON.parse(s).map(x => String(x).trim()).filter(Boolean); } catch {}
  }
  return s.split(/\n|;/).map(x => x.trim()).filter(Boolean);
}

function metafieldValue(metafields, mapKey) {
  const full = METAFIELD_MAP[mapKey];
  if (!full) return null;
  const [namespace, key] = full.split('.');
  const mf = metafields.find(m => m.namespace === namespace && m.key === key);
  return mf?.value ?? null;
}

// ── Access token: suora token TAI client credentials -haku ───────────────
// Dev Dashboard -apit eivät näytä valmista tokenia — se haetaan Client ID:llä
// ja secretillä. Token vanhenee (~24h), joten välimuistitetaan ja uusitaan.
let _token = null;
let _tokenExpires = 0;

async function getAccessToken(domain) {
  // Reitti A: vanha custom-appi, kiinteä shpat_-token
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;

  // Reitti B: Dev Dashboard -appi, client credentials grant
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (_token && Date.now() < _tokenExpires) return _token;

  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Shopify token ${res.status}: ${await res.text()}`);
  const data = await res.json();
  _token = data.access_token;
  // Uusi token 5 min ennen vanhenemista (expires_in sekunteina)
  _tokenExpires = Date.now() + Math.max(60, (data.expires_in || 86400) - 300) * 1000;
  return _token;
}

// ── Shopify-haku (Admin GraphQL, sivutus) ─────────────────────────────────
async function fetchShopifyProducts() {
  // Hyväksy kumpi tahansa nimi — projektissa on jo SHOPIFY_DOMAIN entuudestaan.
  // Normalisoi: "https://kauppa.myshopify.com/" → "kauppa.myshopify.com"
  const rawDomain = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_DOMAIN || '';
  const domain = rawDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  if (!domain) return null; // → fallback JSONiin
  const token = await getAccessToken(domain);
  if (!token) return null; // → fallback JSONiin

  const endpoint = `https://${domain}/admin/api/2024-10/graphql.json`;
  const all = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const query = `
      query($cursor: String) {
        products(first: 100, after: $cursor, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              title
              handle
              onlineStoreUrl
              totalInventory
              metafields(first: 60) {
                edges { node { namespace key value } }
              }
            }
          }
        }
      }`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables: { cursor } }),
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.errors) throw new Error('Shopify GraphQL: ' + JSON.stringify(data.errors));

    const page = data.data.products;
    for (const edge of page.edges) all.push(edge.node);
    hasNext = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  // Normalisoi samaan muotoon jota filters.js ja chat.js käyttävät
  return all.map(node => {
    const metafields = node.metafields.edges.map(e => e.node);
    const mf = key => metafieldValue(metafields, key);

    // TURVALLISUUS: allergeenivapaus lasketaan KAIKISTA sisältökentistä
    // yhdessä — jos kana mainitaan vaikka vain rasvalähteissä tai
    // lisäaineissa, tuote EI saa kana-vapaa-merkintää.
    const ainesosat = mf('ainesosat') || '';
    const sisaltoTeksti = [
      ainesosat,
      mf('proteiinit'),
      mf('hiilihydraatit'),
      mf('rasvat_oljyt'),
      mf('lisaaineet'),
    ].filter(Boolean).join('\n');

    // Kaupat metafieldeistä (1–3). Kauppasuodatus tehdään kaupan NIMESTÄ.
    const kaupat = [1, 2, 3]
      .map(n => ({ nimi: mf(`kauppa${n}nimi`) || '', linkki: mf(`kauppa${n}linkki`) || '' }))
      .filter(k => k.linkki);

    return {
      nimi:      node.title || '',
      prio:      2,
      linkki:    kaupat[0]?.linkki || node.onlineStoreUrl || '',
      kaupat,
      ainesosat,
      ravinto:   mf('ravintoaineet') || '',
      vapaa:     computeVapaa(sisaltoTeksti),   // FAIL-CLOSED jos sisältötiedot puuttuvat
      ika:       splitField(mf('ika')),
      koko:      splitField(mf('koko')),
      rasva:     mf('rasvataso') || 'Tuntematon',
      erikois:   [...splitField(mf('erikois')), ...splitField(mf('rajatut'))],
      varastossa: node.totalInventory == null ? true : node.totalInventory > 0,
    };
  }).filter(p => p.varastossa); // loppuunmyytyjä ei suositella
}

// ── JSON-fallback (vanha tietokanta) ──────────────────────────────────────
function loadJsonProducts() {
  const raw = JSON.parse(
    readFileSync(join(__dirname, '../data/tuotetietokanta_botille.json'), 'utf-8')
  );
  return raw.map(p => ({
    nimi:      p.tuotteen_nimi || '',
    prio:      p.prioriteetti || 2,
    linkki:    p.ostolinkki   || '',
    kaupat:    [],
    ainesosat: '',
    ravinto:   '',
    vapaa:     splitField(p.ei_sisalla_naita_ainesosia),
    ika:       splitField(p.ominaisuudet?.ika || []),
    koko:      splitField(p.ominaisuudet?.koko || []),
    rasva:     p.ominaisuudet?.rasvataso || 'Tuntematon',
    erikois:   splitField(p.ominaisuudet?.erikoisominaisuudet || []),
    varastossa: true,
  }));
}

// ── Julkinen rajapinta — HUOM: NYT ASYNC ─────────────────────────────────
// chat.js:ssä kutsu muuttuu: const allProducts = await getProducts();
const CACHE_TTL = 10 * 60 * 1000; // 10 min
let _cache = null;
let _cacheTs = 0;

export async function getProducts() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;

  try {
    const shopify = await fetchShopifyProducts();
    if (shopify && shopify.length) {
      _cache = shopify;
      _cacheTs = Date.now();
      console.log(`Shopify: ${shopify.length} tuotetta ladattu`);
      return _cache;
    }
  } catch (err) {
    console.error('Shopify-haku epäonnistui, käytetään JSON-fallbackia:', err.message);
  }

  _cache = loadJsonProducts();
  _cacheTs = Date.now();
  return _cache;
}
