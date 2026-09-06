// Read-only Trello proxy for the terminal dashboard.
// GET /api/trello -> { updated, late[], dueWeek[], attention[], counts{} }
//
// Credentials stay server-side. Never expose TRELLO_TOKEN to the browser —
// it grants full write access to every board on the account.
//
// Env: TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID (optional, defaults below)

const BOARD_ID = process.env.TRELLO_BOARD_ID || '684d7a35e5bf6187591390e1';

// Lists a job passes through while it is still work. Anything not named
// here (QUOTES / RFQ, SHIPPED/INVOICED, PAID) is not open work and is
// excluded from late/due counts.
const ACTIVE_LISTS = [
  'JOB AWARD',
  'JOB PLANNING / PROGRAMMING',
  'MACHINING',
  'QUALITY CONTROL',
  'PACKAGING',
];

const SHIPPED_LIST = 'SHIPPED/INVOICED';
const DAY = 86400000;

// Customer comes from the label; DAD JOB and OTHER are not customers.
function customerOf(card) {
  const labels = card.labels || [];
  const cust = labels.find((l) => l.name && !['DAD JOB', 'OTHER'].includes(l.name));
  return cust ? cust.name : null;
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s/])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const key = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) {
    res.status(500).json({ error: 'Trello not configured', detail: 'TRELLO_KEY / TRELLO_TOKEN missing' });
    return;
  }

  try {
    const url =
      `https://api.trello.com/1/boards/${BOARD_ID}/lists` +
      `?cards=open&fields=name&card_fields=name,desc,due,dueComplete,labels,shortUrl` +
      `&key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;

    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text();
      res.status(502).json({ error: 'Trello request failed', detail: `${r.status} ${body.slice(0, 200)}` });
      return;
    }
    const lists = await r.json();

    const now = Date.now();
    const late = [];
    const dueWeek = [];
    const attention = [];
    const counts = { open: 0, late: 0, dueWeek: 0, unbilled: 0 };

    for (const list of lists) {
      const listName = list.name || '';
      const cards = list.cards || [];

      if (listName === SHIPPED_LIST) {
        // Shipped but never invoiced = money sitting on the board.
        for (const c of cards) {
          if (!/^\s*INVOICE:\s*\d+/m.test(c.desc || '')) {
            counts.unbilled++;
            attention.push({
              job: c.name,
              where: [customerOf(c), 'shipped, no invoice number'].filter(Boolean).join(' · '),
              flag: 'Not billed',
              level: 'bad',
              url: c.shortUrl,
            });
          }
        }
        continue;
      }

      if (!ACTIVE_LISTS.includes(listName)) continue;

      const stage = titleCase(listName);

      for (const c of cards) {
        counts.open++;
        const cust = customerOf(c);

        if (!c.due) {
          attention.push({
            job: c.name,
            where: [stage, cust].filter(Boolean).join(' · '),
            flag: 'No due date',
            level: '',
            url: c.shortUrl,
          });
          continue;
        }
        if (c.dueComplete) continue;

        const due = new Date(c.due).getTime();
        const days = Math.floor((now - due) / DAY);

        if (days >= 0) {
          counts.late++;
          late.push({
            job: c.name,
            where: [stage, cust].filter(Boolean).join(' · '),
            flag: days === 0 ? 'Due today' : `${days} day${days === 1 ? '' : 's'} over`,
            level: 'bad',
            url: c.shortUrl,
            _sort: due,
          });
        } else if (-days <= 7) {
          const left = -days;
          counts.dueWeek++;
          dueWeek.push({
            job: c.name,
            where: [stage, cust].filter(Boolean).join(' · '),
            flag:
              new Date(c.due).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }) +
              ` · ${left} day${left === 1 ? '' : 's'}`,
            level: 'warn',
            url: c.shortUrl,
            _sort: due,
          });
        }
      }
    }

    late.sort((a, b) => a._sort - b._sort);      // most overdue first
    dueWeek.sort((a, b) => a._sort - b._sort);   // soonest first
    late.forEach((x) => delete x._sort);
    dueWeek.forEach((x) => delete x._sort);

    res.setHeader('Cache-Control', 'private, no-cache');
    res.status(200).json({ updated: new Date().toISOString(), counts, late, dueWeek, attention });
  } catch (err) {
    console.error('trello.js error:', err);
    res.status(500).json({ error: 'Trello read failed', detail: String((err && err.message) || err) });
  }
};
