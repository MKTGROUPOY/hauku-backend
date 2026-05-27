// api/chat.js — Hauku backend (Vercel serverless)
// Vastaanottaa käyttäjän viestin, hakee tuotteet Shopifysta,
// suodattaa JS:llä ja kutsuu Claude API:a.

import { extractFilters, filterProducts, buildProductContext } from '../lib/filters.js';
import { getProducts } from '../lib/shopify.js';

export const config = { runtime: 'edge' }; // Edge runtime = nopeampi cold start

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // CORS – salli vain oma domain tuotannossa
  const origin = req.headers.get('origin') || '';
  const allowed = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
  const corsOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try {
    const body = await req.json();
    const { messages } = body; // [{role:'user'|'assistant', content:'...'}]

    if (!messages?.length) {
      return new Response(JSON.stringify({ error: 'messages required' }), { status: 400, headers });
    }

    // 1. Hae tuotteet Shopifysta (cachetettu 1h)
    const products = await getProducts();

    // 2. Tunnista filtterit keskusteluhistoriasta
    const filters = extractFilters(messages);

    // 3. Suodata tuotteet
    const hasFilters = !!(
      filters.excl.length || filters.want.length ||
      filters.brand || filters.age || filters.size || filters.specialDiets?.length
    );
    const matched = hasFilters ? filterProducts(products, filters) : [];
    const productCtx = hasFilters ? buildProductContext(matched, filters) : '';

    // 4. Rakenna viestit Claudelle (lisää tuotekonteksti viimeiseen user-viestiin)
    const claudeMessages = messages.map((m, i) => ({
      role: m.role,
      content: i === messages.length - 1 && m.role === 'user' && productCtx
        ? m.content + productCtx
        : m.content,
    }));

    // 5. Kutsu Claude API
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: process.env.SYSTEM_PROMPT || '',
        messages: claudeMessages,
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error('Claude API error:', err);
      return new Response(JSON.stringify({ error: 'AI service error' }), { status: 502, headers });
    }

    const data = await anthropicRes.json();
    const reply = data.content?.find(b => b.type === 'text')?.text ?? 'Yritä uudelleen.';

    return new Response(JSON.stringify({ reply }), { status: 200, headers });

  } catch (err) {
    console.error('Handler error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers });
  }
}
