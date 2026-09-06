// Simple key-value store backed by Vercel Blob (PRIVATE store).
//
// GET  /api/data?key=foo                 -> { key, value, etag }
// PUT  /api/data  { key, value, etag? }  -> { key, ok:true, etag }
//   - if etag is provided and doesn't match the stored version, responds
//     409 {error:'conflict', currentEtag} instead of overwriting.
//
// The store is private, so every call must pass access:'private'.
// Reads go through get(), which returns the body as a stream — a private
// blob's url is NOT publicly fetchable, so never fetch(blob.url) here.

const { get, put } = require('@vercel/blob');

const PREFIX = 'data/';
const pathFor = (key) => PREFIX + key + '.json';

// Cheap version fingerprint: size + upload time. Enough to answer
// "did this change since I last read it" without storing anything extra.
function etagFor(meta) {
  if (!meta) return null;
  const t = meta.uploadedAt ? new Date(meta.uploadedAt).getTime() : 0;
  return `${meta.size || 0}-${t}`;
}

// Returns { meta, text } or null when the key doesn't exist.
async function readBlob(key) {
  const result = await get(pathFor(key), { access: 'private' });
  if (!result) return null;
  const text = await new Response(result.stream).text();
  return { meta: result.blob, text };
}

function keyFromQuery(req) {
  if (req.query && req.query.key) return req.query.key;
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('key');
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const key = keyFromQuery(req);
    if (!key) {
      res.status(400).json({ error: 'key query param required' });
      return;
    }
    try {
      const found = await readBlob(key);
      if (!found) {
        res.status(404).json({ error: 'not found', key });
        return;
      }
      let value;
      try {
        value = JSON.parse(found.text);
      } catch (e) {
        value = found.text; // tolerate a non-JSON value rather than 500
      }
      res.setHeader('Cache-Control', 'private, no-cache');
      res.status(200).json({ key, value, etag: etagFor(found.meta) });
    } catch (err) {
      console.error('data.js GET error:', err);
      res.status(500).json({ error: 'Read failed', detail: String(err && err.message || err) });
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
        const existing = await readBlob(key);
        const currentEtag = existing ? etagFor(existing.meta) : null;
        if (existing && currentEtag !== etag) {
          res.status(409).json({ error: 'conflict', currentEtag });
          return;
        }
      }

      const blob = await put(pathFor(key), JSON.stringify(value), {
        access: 'private',
        addRandomSuffix: false,
        contentType: 'application/json',
        allowOverwrite: true,
      });

      res.status(200).json({ key, ok: true, etag: etagFor(blob) });
    } catch (err) {
      console.error('data.js WRITE error:', err);
      res.status(500).json({ error: 'Write failed', detail: String(err && err.message || err) });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
