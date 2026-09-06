// Node.js serverless function (CommonJS — package.json has no "type":"module",
// so this must use module.exports, not export default).
//
// Expects: POST /api/login  body: { "pin": "12345" }
// On success: sets an httpOnly session cookie and returns 200 {ok:true}
// On failure: returns 401 {ok:false}
//
// This matches login.html, which POSTs {pin: enteredDigits} as JSON and
// treats any non-2xx response as a wrong PIN.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const pin = body && body.pin;

  const expectedPin = process.env.SHOP_PIN;
  const siteToken = process.env.SITE_TOKEN;

  if (!expectedPin || !siteToken) {
    // Env vars missing — fail loudly in logs, vaguely to the client.
    console.error('SHOP_PIN or SITE_TOKEN not set in environment');
    res.status(500).json({ ok: false, error: 'Server not configured' });
    return;
  }

  // String equality — SHOP_PIN is a string env var, so "01234" stays intact.
  // Do NOT parseInt() either side, or a leading zero breaks this.
  if (typeof pin !== 'string' || pin.length === 0 || pin !== expectedPin) {
    res.status(401).json({ ok: false });
    return;
  }

  // No Max-Age: this makes it a browser-session cookie. It survives closing
  // and reopening a tab, but is discarded once the whole browser quits —
  // so the PIN is required again on every fresh browser session.
  res.setHeader(
    'Set-Cookie',
    `shop_session=${encodeURIComponent(siteToken)}; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
  res.status(200).json({ ok: true });
};
