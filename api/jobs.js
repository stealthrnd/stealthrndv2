// api/jobs.js
//
// The write endpoint. This is the "single blocking dependency" from the handoff —
// once this exists, office.html can persist real jobs, timeline.html can read them
// instead of (or alongside) Trello, and stage moves / clock sessions / QC records
// have somewhere durable to land instead of localStorage.
//
// Schema (locked, do not add fields without updating every reader):
//   { id, part, po, customer, qty, price, dueDate, stage, dadJob, invoice,
//     time, op1, op2, rate, quoted, rev, photo, createdAt }
//
// Storage: one JSON blob (jobs.json), private access. Shop-scale — dozens of open
// jobs, not thousands — so a single read-modify-write per request is plenty. If
// this ever needs to survive concurrent writers fighting each other, split to
// per-job blob keys; not worth the complexity at today's volume.
//
// Auth: none in this file on purpose. middleware.js default-denies every route
// except /login and /api/login, so requests already carry a valid shop_session
// cookie by the time they get here — same as every other /api/* route.

import { get, put } from '@vercel/blob';

const BLOB_PATH = 'jobs.json';

// ---------------------------------------------------------------- storage ----
export async function readJobs() {
  try {
    const blob = await get(BLOB_PATH, { access: 'private' });
    if (!blob) return [];
    const text = await new Response(blob.stream).text();
    const parsed = JSON.parse(text || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // No blob yet (first run) or a bad read — treat as empty rather than 500,
    // so a fresh deploy doesn't break office.html's first "Award job".
    return [];
  }
}

export async function writeJobs(jobs) {
  await put(BLOB_PATH, JSON.stringify(jobs), {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

function newId() {
  return 'j_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const REQUIRED_ON_CREATE = ['part', 'po', 'customer'];

// ---------------------------------------------------------------- handler ----
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const jobs = await readJobs();
      const { id, po } = req.query;
      if (id) {
        const job = jobs.find((j) => j.id === id);
        return job
          ? res.status(200).json(job)
          : res.status(404).json({ error: 'not found' });
      }
      if (po) {
        return res.status(200).json(jobs.filter((j) => j.po === po));
      }
      return res.status(200).json(jobs);
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const missing = REQUIRED_ON_CREATE.filter((k) => !body[k]);
      if (missing.length) {
        return res
          .status(400)
          .json({ error: 'missing required field(s): ' + missing.join(', ') });
      }
      const jobs = await readJobs();
      const job = {
        id: body.id || newId(), // migrate.js passes the Trello card id explicitly
        part: body.part,
        po: body.po,
        customer: body.customer,
        qty: body.qty ?? null,
        price: body.price ?? null,
        dueDate: body.dueDate ?? null,
        stage: body.stage ?? 1, // 1 = Award
        dadJob: !!body.dadJob,
        invoice: body.invoice ?? null,
        time: body.time ?? 0,
        op1: body.op1 ?? null,
        op2: body.op2 ?? null,
        rate: body.rate ?? null,
        quoted: body.quoted ?? null,
        rev: body.rev ?? null,
        photo: body.photo ?? null,
        createdAt: body.createdAt || new Date().toISOString(),
      };
      const existingIdx = jobs.findIndex((j) => j.id === job.id);
      if (existingIdx >= 0) jobs[existingIdx] = job; // upsert — migrate.js relies on this
      else jobs.push(job);
      await writeJobs(jobs);
      return res.status(201).json(job);
    }

    if (req.method === 'PATCH') {
      const body = req.body || {};
      if (!body.id) return res.status(400).json({ error: 'id required' });
      const jobs = await readJobs();
      const i = jobs.findIndex((j) => j.id === body.id);
      if (i === -1) return res.status(404).json({ error: 'not found' });
      // Never let a PATCH blank out an existing INVOICE — same double-billing
      // guard the Trello convention has always used.
      if ('invoice' in body && body.invoice == null && jobs[i].invoice) {
        delete body.invoice;
      }
      jobs[i] = { ...jobs[i], ...body };
      await writeJobs(jobs);
      return res.status(200).json(jobs[i]);
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      const jobs = await readJobs();
      const next = jobs.filter((j) => j.id !== id);
      await writeJobs(next);
      return res.status(200).json({ deleted: id });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'server error' });
  }
}
