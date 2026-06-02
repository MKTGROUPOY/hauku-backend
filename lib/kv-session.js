// lib/kv-session.js — In-memory sessiomuisti (Vercel KV fallback)
// Toimii ilman @vercel/kv pakettia

const memoryStore = new Map();
const SESSION_TTL = 60 * 60 * 1000; // 1 tunti ms

export async function saveSession(conversationId, products) {
  if (!conversationId || !products?.length) return;
  const data = products.slice(0, 5).map(p => ({
    n: p.n, m: p.m, p: p.p,
    a: (p.a || '').substring(0, 800),
    rv: (() => { let r = p.rv || ''; try { const x = JSON.parse(r); r = Array.isArray(x) ? x[0] : String(x); } catch {} return r; })(),
    v: (p.v || []).slice(0, 20),
    er: p.er || [], rl: p.rl || '',
    l: p.l || '', l2: p.l2 || '', l3: p.l3 || ''
  }));
  memoryStore.set(conversationId, { data, ts: Date.now() });
}

export async function loadSession(conversationId) {
  if (!conversationId) return null;
  const entry = memoryStore.get(conversationId);
  if (!entry) return null;
  if (Date.now() - entry.ts > SESSION_TTL) {
    memoryStore.delete(conversationId);
    return null;
  }
  return entry.data;
}

export async function clearSession(conversationId) {
  if (conversationId) memoryStore.delete(conversationId);
}
