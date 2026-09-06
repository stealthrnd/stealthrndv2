// Proxies requests to Anthropic's API so ANTHROPIC_API_KEY never reaches
// the browser. Whatever tool needs Claude (terminal.html, presumably)
// should POST the same body it would send to api.anthropic.com/v1/messages
// directly to this endpoint instead — e.g. { model, max_tokens, messages }.
//
// ASSUMPTION I'm making, unverified against your actual terminal.html:
// the client sends a body shaped like the Anthropic Messages API request,
// and expects back exactly what Anthropic returns. If your terminal.html's
// fetch call sends something different (a custom shape, a specific field
// name), this will need adjusting to match.

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

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Claude proxy error:', err);
    res.status(502).json({ error: 'Upstream request failed' });
  }
};
