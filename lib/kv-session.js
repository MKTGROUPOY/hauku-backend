// lib/kv-session.js — Vercel KV -pohjainen sessiomuisti
// Tallentaa haetut tuotteet conversation_id:n alle

// Vercel KV ympäristömuuttujat (aseta Vercel dashboardissa):
// KV_REST_API_URL, KV_REST_API_TOKEN
// Asenna: npm install @vercel/kv

let kv = null;
async function getKV() {
  if (!kv) {
    try {
      const { kv: kvClient } = await import('@vercel/kv');
      kv = kvClient;
    } catch {
      console.warn('Vercel KV ei saatavilla — käytetään in-memory fallbackia');
    }
  }
  return kv;
}

// In-memory fallback (toimii yhdessä serverless-instanssissa)
const memoryStore = new Map();
const SESSION_TTL = 60 * 60; // 1 tunti sekunteina

export async function saveSession(conversationId, products) {
  if (!conversationId || !products?.length) return;
  const data = JSON.stringify(products.slice(0, 5).map(p => ({
    n: p.n, m: p.m, p: p.p,
    a: (p.a || '').substring(0, 800),
    rv: (() => { let r = p.rv || ''; try { const x = JSON.parse(r); r = Array.isArray(x) ? x[0] : String(x); } catch {} return r; })(),
    v: (p.v || []).slice(0, 20),
    er: p.er || [], rl: p.rl || '',
    l: p.l || '', l2: p.l2 || '', l3: p.l3 || ''
  })));

  try {
    const client = await getKV();
    if (client) {
      await client.set(`session:${conversationId}`, data, { ex: SESSION_TTL });
      return;
    }
  } catch (e) {
    console.warn('KV save failed:', e.message);
  }
  // Fallback: in-memory
  memoryStore.set(conversationId, { data, ts: Date.now() });
}

export async function loadSession(conversationId) {
  if (!conversationId) return null;
  try {
    const client = await getKV();
    if (client) {
      const raw = await client.get(`session:${conversationId}`);
      return raw ? JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) : null;
    }
  } catch (e) {
    console.warn('KV load failed:', e.message);
  }
  // Fallback: in-memory
  const entry = memoryStore.get(conversationId);
  if (!entry) return null;
  if (Date.now() - entry.ts > SESSION_TTL * 1000) { memoryStore.delete(conversationId); return null; }
  return JSON.parse(entry.data);
}

export async function clearSession(conversationId) {
  if (!conversationId) return;
  try {
    const client = await getKV();
    if (client) { await client.del(`session:${conversationId}`); return; }
  } catch {}
  memoryStore.delete(conversationId);
}
