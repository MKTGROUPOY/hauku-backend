// api/chat.js — Hauku backend (Vercel serverless)

import { extractFilters, filterProducts, buildProductContext } from '../lib/filters.js';
import { getProducts } from '../lib/shopify.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { messages } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });

    // 1. Hae tuotteet Shopifysta
    const products = await getProducts();

    // 2. Tunnista filtterit
    const filters = extractFilters(messages);
    const hasFilters = !!(
      filters.excl.length || filters.want.length ||
      filters.brand || filters.age || filters.size || filters.specialDiets?.length
    );
    const matched = hasFilters ? filterProducts(products, filters) : [];
    const productCtx = hasFilters ? buildProductContext(matched, filters) : '';

    // 3. Rakenna viestit Claudelle
    const claudeMessages = messages.map((m, i) => ({
      role: m.role,
      content: i === messages.length - 1 && m.role === 'user' && productCtx
        ? m.content + productCtx
        : m.content,
    }));

    // 4. Kutsu Claude API
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
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await anthropicRes.json();
    const reply = data.content?.find(b => b.type === 'text')?.text ?? 'Yritä uudelleen.';

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
