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

  const KEY = process.env.TRELLO_KEY,
    TOKEN = process.env.TRELLO_TOKEN,
    BOARD = process.env.TRELLO_BOARD_ID;
  if (!KEY || !TOKEN || !BOARD) {
    return res.status(500).json({ error: 'TRELLO_KEY / TRELLO_TOKEN / TRELLO_BOARD_ID missing from env' });
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
      skippedNoStage = 0,
      skippedHandChuck = 0;

    for (const c of cards) {
      if (/HAND CHUCK/i.test(c.name)) {
        skippedHandChuck++;
        continue;
      }
      const stage = stageByListId[c.idList];
      if (!stage) {
        // QUOTES/RFQ or PAID — not migrated (see file header)
        skippedNoStage++;
        continue;
      }
      const { part, po } = parseCardName(c.name);
      const desc = parseDescription(c.desc);
      const customer = customerFromLabels(c.labels);
      const dadJob = (c.labels || []).some((l) => l.name === 'DAD JOB');
      const prior = byId.get(c.id) || {};

      byId.set(c.id, {
        id: c.id,
        part,
        po,
        customer,
        qty: prior.qty ?? null,
        price: prior.price ?? null,
        dueDate: c.due || prior.dueDate || null,
        stage,
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
      skippedNotOnActivePipeline: skippedNoStage,
      totalInStore: all.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'migrate failed' });
  }
}
