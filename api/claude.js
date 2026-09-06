// Proxies requests to Anthropic's API so ANTHROPIC_API_KEY never reaches
// the browser. POST the same body you'd send to api.anthropic.com/v1/messages
// — { model, max_tokens, messages, ... } — and this forwards it as-is.
//
// DEFAULTS: model and max_tokens are optional. If the caller omits them,
// this fills in a current model and a reasonable token cap, so a tool
// (or a quick console test) can just send { messages } and get an answer
// without knowing the exact model string. Passing your own model/max_tokens
// always wins — these are fallbacks, not overrides.
//
// Confirmed working 2026-09-06 with a real client-side fetch() call.

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 1024;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set in environment');
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  const payload = {
    model: DEFAULT_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    ...body, // caller-supplied model/max_tokens/system/tools/etc. win
  };

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Claude proxy error:', err);
    res.status(502).json({ error: 'Upstream request failed' });
  }
};
