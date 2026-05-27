// api/chat.js — Hauku backend (Vercel serverless) — Gemini API

import { extractFilters, filterProducts, buildProductContext } from '../lib/filters.js';
import { getProducts } from '../lib/shopify.js';

function norm(s) {
  return s.toLowerCase().replace(/[^a-zäöå ]/g, ' ').replace(/ +/g, ' ').trim();
}

export default async function handler(req, res) {
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

    // 3. Bränditunnistus tuotelistan perusteella
    if (!filters.brand && products.length > 0) {
      const vendors = [...new Set(products.map(p => norm(p.m || '')).filter(v => v.length >= 3))];
      vendors.sort((a, b) => b.length - a.length); // pisin ensin
      const allUserText = norm(messages.map(m => m.content).join(' '));
      for (const vendor of vendors) {
        if (vendor.length < 4) continue;
        // Täsmäytä vain kokonaisena sanana (ei osana toista sanaa)
        const re = new RegExp('(?:^|\\s)' + vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)');
        if (re.test(allUserText)) {
          filters.brand = vendor;
          break;
        }
      }
    }

    const hasFilters = !!(
      filters.excl.length || filters.want.length ||
      filters.brand || filters.age || filters.size || filters.specialDiets?.length
    );
    const matched = hasFilters ? filterProducts(products, filters) : [];
    const productCtx = hasFilters ? buildProductContext(matched, filters) : '';

    // 4. Rakenna viestit Geminille
    const systemPrompt = process.env.SYSTEM_PROMPT || '';
    const geminiMessages = messages.map((m, i) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: i === messages.length - 1 && m.role === 'user' && productCtx
        ? m.content + productCtx
        : m.content }]
    }));

    // 5. Kutsu Gemini API
    const apiKey = process.env.GEMINI_API_KEY;
    const model = 'gemini-2.5-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: geminiMessages,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
      }),
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      console.error('Gemini API error:', err);
      return res.status(502).json({ error: `Gemini error: ${geminiRes.status}` });
    }

    const data = await geminiRes.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Yritä uudelleen.';

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}