// ============================================
// STEALTH R&D — PIN CHECK ENDPOINT
// Version: 1.0.0
// Updated: 2026-09-06
// Pairs with: login.html v1.0.0, middleware.js v1.0.0
// ============================================
// Checks the submitted PIN against the SHOP_PIN environment variable.
// On success, sets an httpOnly cookie holding SITE_TOKEN for 30 days.

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false });
  }

  let pin = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    pin = String(body.pin || '');
  } catch (e) {
    pin = '';
  }

  const expected = process.env.SHOP_PIN || '';
  const token = process.env.SITE_TOKEN || '';

  if (!expected || !token) {
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  if (pin && pin === expected) {
    res.setHeader('Set-Cookie',
      'srnd=' + encodeURIComponent(token) +
      '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000');
    return res.status(200).json({ ok: true });
  }

  return res.status(401).json({ ok: false });
}
