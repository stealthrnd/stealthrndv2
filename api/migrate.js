// api/migrate.js
//
// One-shot: pull the live Trello board through the same TRELLO_KEY/TRELLO_TOKEN
// this project already uses, map each card onto the locked job schema, and
// upsert into api/jobs.js's store.
//
// Idempotent by design: every job's id IS the Trello card id, so running this
// twice re-syncs instead of duplicating. Read-only against Trello — nothing on
// the board is touched. The active pipeline (Award through Shipped/Invoiced)
// migrates; PAID stays on Trello as the dead archive, matching the handoff
// note to "leave the board intact as a dead backup" rather than importing
// everything on day one.
//
// Trigger: POST /api/migrate  (gated by middleware.js's default-deny, same as
// every other route — hit it from a browser tab with a valid session, or curl
// with the shop_session cookie attached).
//
// HAND CHUCK is skipped everywhere else in this project and is skipped here too.

import { readJobs, writeJobs } from './jobs.js';

const LIST_NAME_TO_STAGE = {
  'JOB AWARD': 1,
  'JOB PLANNING/PROGRAMMING': 2, // normalized below — spacing around "/" varies
  MACHINING: 3,
  'QUALITY CONTROL': 4,
  PACKAGING: 5,
  'SHIPPED/INVOICED': 6,
  // QUOTES/RFQ and PAID intentionally absent — see file header
};

function normalizeListName(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/\s*\/\s*/g, '/') // "JOB PLANNING / PROGRAMMING" -> "JOB PLANNING/PROGRAMMING"
    .trim();
}

function parseCardName(name) {
  // "[PART] — PO [NUMBER]" — the em dash is the convention, but tolerate a
  // plain hyphen too since it's easy to fat-finger on a Trello mobile app.
  const m = String(name || '').match(/^(.*?)\s*[—-]\s*PO\s*(\S+)/i);
  return m ? { part: m[1].trim(), po: m[2].trim() } : { part: String(name || '').trim(), po: null };
}

function parseDescription(desc) {
  const out = {};
  String(desc || '')
    .split('\n')
    .forEach((line) => {
      let m;
      if ((m = line.match(/^INVOICE:\s*(.+)$/i))) out.invoice = m[1].trim();
      else if ((m = line.match(/^TIME:\s*([\d.]+)/i))) out.time = parseFloat(m[1]);
      else if ((m = line.match(/^OP1:\s*(\d+)\s*\/\s*(\d+)/i))) out.op1 = { n: +m[1], of: +m[2] };
      else if ((m = line.match(/^OP2:\s*(\d+)\s*\/\s*(\d+)/i))) out.op2 = { n: +m[1], of: +m[2] };
      else if ((m = line.match(/^RATE:\s*\$?([\d.]+)/i))) out.rate = parseFloat(m[1]);
    });
  return out;
}

function customerFromLabels(labels) {
  const names = (labels || []).map((l) => l.name || l);
  if (names.includes('ROBERTS')) return 'ROBERTS';
  if (names.includes('FTI')) return 'FTI';
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only — this writes data' });
  }

  // Accept the common naming variants — api/trello.js already authenticates
  // fine, so the credentials exist under one of these. The board id isn't a
  // secret (it's in the repo's AWARD_SWEEP notes), so it falls back to a
  // literal rather than being a third thing to configure.
  const KEY = process.env.TRELLO_KEY || process.env.TRELLO_API_KEY;
  const TOKEN = process.env.TRELLO_TOKEN || process.env.TRELLO_API_TOKEN;
  const BOARD =
    process.env.TRELLO_BOARD_ID ||
    process.env.TRELLO_BOARD ||
    '684d7a35e5bf6187591390e1';

  const missing = [];
  if (!KEY) missing.push('TRELLO_KEY (or TRELLO_API_KEY)');
  if (!TOKEN) missing.push('TRELLO_TOKEN (or TRELLO_API_TOKEN)');
  if (missing.length) {
    return res.status(500).json({
      error: 'missing from env: ' + missing.join(', '),
      hint: 'Check the exact variable names api/trello.js reads, and confirm they are set for the Production environment. Vercel env changes need a redeploy to take effect.',
      sawEnvKeys: Object.keys(process.env).filter((k) => /TRELLO/i.test(k)),
    });
  }

  try {
    const [cardsRes, listsRes] = await Promise.all([
      fetch(
        `https://api.trello.com/1/boards/${BOARD}/cards?filter=open&fields=name,desc,idList,labels,due&key=${KEY}&token=${TOKEN}`
      ),
      fetch(`https://api.trello.com/1/boards/${BOARD}/lists?fields=name&key=${KEY}&token=${TOKEN}`),
    ]);
    if (!cardsRes.ok || !listsRes.ok) {
      return res.status(502).json({ error: 'Trello API call failed', cardsStatus: cardsRes.status, listsStatus: listsRes.status });
    }
    const cards = await cardsRes.json();
    const lists = await listsRes.json();

    const stageByListId = {};
    lists.forEach((l) => {
      const stage = LIST_NAME_TO_STAGE[normalizeListName(l.name)];
      if (stage) stageByListId[l.id] = stage;
    });

    const existing = await readJobs();
    const byId = new Map(existing.map((j) => [j.id, j]));

    let migrated = 0,
      skippedHandChuck = 0;
    const skipped = []; // names, so a skip is never silent

    for (const c of cards) {
      if (/HAND CHUCK/i.test(c.name)) {
        skippedHandChuck++;
        continue;
      }
      const stage = stageByListId[c.idList];
      if (!stage) {
        // PAID, QUOTES/RFQ, or a card whose list has been archived out from
        // under it — Trello leaves such cards "open". Record the name and the
        // list id so nothing disappears without being accounted for.
        skipped.push({ name: c.name, idList: c.idList });
        continue;
      }
      const { part, po } = parseCardName(c.name);
      const desc = parseDescription(c.desc);
      const customer = customerFromLabels(c.labels);
      const dadJob = (c.labels || []).some((l) => l.name === 'DAD JOB');
      const prior = byId.get(c.id) || {};

      // Stage: Trello seeds it on first import, but once a job exists in the
      // store the new system owns it. Without this, re-running migrate silently
      // reverts every stage move made from the tablet back to whatever the
      // Trello list says — destroying real work. Trello is being retired; it
      // does not get to overwrite live state.
      // `prior.stageSource === 'jobs'` is set the moment anything PATCHes the
      // stage, so a job that has never moved still re-seeds cleanly from Trello.
      const isNew = !byId.has(c.id);
      const keepLocalStage = !isNew && prior.stageSource === 'jobs';

      byId.set(c.id, {
        id: c.id,
        part,
        po,
        customer,
        qty: prior.qty ?? null,
        price: prior.price ?? null,
        dueDate: c.due || prior.dueDate || null,
        stage: keepLocalStage ? prior.stage : stage,
        stageSource: keepLocalStage ? 'jobs' : 'trello',
        dadJob,
        invoice: desc.invoice ?? prior.invoice ?? null,
        time: desc.time ?? prior.time ?? 0,
        op1: desc.op1 ?? prior.op1 ?? null,
        op2: desc.op2 ?? prior.op2 ?? null,
        rate: desc.rate ?? prior.rate ?? null,
        quoted: prior.quoted ?? null,
        rev: prior.rev ?? null,
        photo: prior.photo ?? null,
        createdAt: prior.createdAt || new Date().toISOString(),
      });
      migrated++;
    }

    const all = Array.from(byId.values());
    await writeJobs(all);
    return res.status(200).json({
      migrated,
      skippedHandChuck,
      skippedNotOnActivePipeline: skipped.length,
      skipped, // names + list ids of everything not migrated
      totalInStore: all.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'migrate failed' });
  }
}
