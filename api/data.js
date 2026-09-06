// Simple key-value store backed by Vercel Blob.
// GET  /api/data?key=foo          -> { key, value, etag }
// PUT  /api/data  { key, value, etag? } -> { key, ok:true }
//   - if etag is provided and doesn't match the current stored version,
//     responds 409 {error:'conflict', currentEtag} instead of overwriting.
//     Client should re-fetch and retry, per your offline/conflict design.
//
// ASSUMPTION I'm making, unverified against your actual client code:
// the exact request/response shape above. If shop_timeclock.html or the
// other tools already call /api/data with a different shape (different
// field names, a different key format), this needs to match that instead
// of the other way around — tell me the actual fetch() calls and I'll
// align this file to them rather than the reverse.

const { put, list } = require('@vercel/blob');

const PREFIX = 'data/';

function etagFor(blob) {
  // Cheap version fingerprint: size + upload timestamp. Good enough to
  // detect "did this change since I last read it" without extra storage.
  return `${blob.size}-${new Date(blob.uploadedAt).getTime()}`;
}

async function findBlob(key) {
  const pathname = PREFIX + key + '.json';
  const { blobs } = await list({ prefix: pathname });
  return blobs.find((b) => b.pathname === pathname) || null;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const key = req.query && req.query.key;
    if (!key) {
      res.status(400).json({ error: 'key query param required' });
      return;
    }
    try {
      const found = await findBlob(key);
      if (!found) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const upstream = await fetch(found.url);
      const value = await upstream.json();
      res.status(200).json({ key, value, etag: etagFor(found) });
    } catch (err) {
      console.error('data.js GET error:', err);
      res.status(500).json({ error: 'Read failed' });
    }
    return;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const { key, value, etag } = body || {};
    if (!key) {
      res.status(400).json({ error: 'key required in body' });
      return;
    }

    try {
      if (etag) {
        const existing = await findBlob(key);
        if (existing && etagFor(existing) !== etag) {
          res.status(409).json({ error: 'conflict', currentEtag: etagFor(existing) });
          return;
        }
      }

      const blob = await put(PREFIX + key + '.json', JSON.stringify(value), {
        access: 'public',
        addRandomSuffix: false,
        contentType: 'application/json',
        allowOverwrite: true,
      });

      res.status(200).json({ key, ok: true, url: blob.url });
    } catch (err) {
      console.error('data.js WRITE error:', err);
      res.status(500).json({ error: 'Write failed' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
