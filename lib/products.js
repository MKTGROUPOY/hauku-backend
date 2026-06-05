// lib/products.js — Lataa tuotetietokanta JSON-tiedostosta

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Pilkoo "\n"-erotetun merkkijonon listaksi
function splitField(arr) {
  if (!arr?.length) return [];
  return arr.flatMap(s =>
    typeof s === 'string'
      ? s.split('\n').map(x => x.trim()).filter(Boolean)
      : [String(s)]
  );
}

// Lataa ja normalisoi data kerran käynnistyksessä
let _products = null;
export function getProducts() {
  if (_products) return _products;
  const raw = JSON.parse(
    readFileSync(join(__dirname, '../data/tuotetietokanta_botille.json'), 'utf-8')
  );
  _products = raw.map(p => ({
    nimi:      p.tuotteen_nimi || '',
    prio:      p.prioriteetti || 2,
    linkki:    p.ostolinkki   || '',
    vapaa:     splitField(p.ei_sisalla_naita_ainesosia),  // mitä EI sisällä
    ika:       splitField(p.ominaisuudet?.ika || []),
    koko:      splitField(p.ominaisuudet?.koko || []),
    rasva:     p.ominaisuudet?.rasvataso || 'Tuntematon',
    erikois:   splitField(p.ominaisuudet?.erikoisominaisuudet || []),
  }));
  return _products;
}
