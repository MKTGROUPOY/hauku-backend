// lib/products.js — Lataa tuotetietokanta JSON-tiedostosta

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Pilkoo "\n"-erotetun merkkijonon listaksi — turvallinen myös ei-array/ei-string syötteille
function splitField(arr) {
  if (!arr) return [];
  if (!Array.isArray(arr)) arr = [arr];
  return arr.flatMap(s =>
    typeof s === 'string'
      ? s.split('\n').map(x => x.trim()).filter(Boolean)
      : (s == null ? [] : [String(s)])
  );
}

// Lataa ja normalisoi data kerran käynnistyksessä
let _products = null;

export function getProducts() {
  if (_products) return _products;

  const filePath = join(__dirname, '../data/tuotetietokanta_botille.json');
  let raw;

  try {
    const fileText = readFileSync(filePath, 'utf-8');
    raw = JSON.parse(fileText);
  } catch (err) {
    console.error('[products.js] Tiedoston lukeminen/JSON.parse epäonnistui:', filePath, '-', err.message);
    throw new Error(`Tuotetietokannan lataus epäonnistui: ${err.message}`);
  }

  if (!Array.isArray(raw)) {
    console.error('[products.js] JSON ei ole array. Tyyppi:', typeof raw, 'Avaimet:', Object.keys(raw || {}).slice(0, 10));
    throw new Error(`Tuotetietokanta ei ole listamuotoinen (saatu: ${typeof raw})`);
  }

  console.log(`[products.js] Ladattu ${raw.length} tuotetta tiedostosta ${filePath}`);

  _products = raw.map(p => ({
    nimi:      p.tuotteen_nimi || '',
    prio:      p.prioriteetti || 2,
    linkki:    p.ostolinkki   || '',
    vapaa:     splitField(p.ei_sisalla_naita_ainesosia),  // mitä EI sisällä
    ika:       splitField(p.ominaisuudet?.ika),
    koko:      splitField(p.ominaisuudet?.koko),
    rasva:     p.ominaisuudet?.rasvataso || 'Tuntematon',
    rasvaTarkka: p.ominaisuudet?.rasvataso_tarkka || p.ominaisuudet?.rasvataso || 'Tuntematon',
    erikois:   splitField(p.ominaisuudet?.erikoisominaisuudet),
    ainesosat: p.ainesosat || '',
    ravintoaineet: p.ravintoaineet || '',
    proteiinit: Array.isArray(p.proteiinit) ? p.proteiinit : splitField(p.proteiinit),
    hiilihydraatit: Array.isArray(p.hiilihydraatit) ? p.hiilihydraatit : splitField(p.hiilihydraatit),
    rajatut: Array.isArray(p.rajatut_raaka_aineet) ? p.rajatut_raaka_aineet : splitField(p.rajatut_raaka_aineet),
  }));

  return _products;
}
