// Getting data in: merge duplicates, link Swiggy orders to payments, read statement/backup files.

// UPI payments and other bank debits come out of the same bank account, so they dedupe against each other.
const sameAccount = (a, b) => a === b || (a !== 'hdfc_cc' && b !== 'hdfc_cc');
const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 864e5);

// The same payment can arrive as an email alert, an SMS and a statement row. Keep one record.
// Match: same UPI reference, or same account + same amount + date within 1 day.
async function mergeTxns(incoming) {
  const existing = await DB.all('txns');
  const byId = new Map(existing.map(t => [t.id, t]));
  const used = new Set();
  const changed = [];
  let added = 0, merged = 0;

  for (const t of incoming) {
    if (byId.has(t.id)) continue;
    const twin = existing.find(e => !used.has(e.id) && e.origin !== t.origin && (
      (t.ref && e.ref === t.ref) ||
      (sameAccount(e.account, t.account) && e.amount === t.amount && dayDiff(e.date, t.date) <= 1)));
    if (twin) {
      used.add(twin.id);
      twin.confirmed = twin.confirmed || t.confirmed;   // a statement row confirms an alert
      twin.ref = twin.ref || t.ref;
      twin.time = twin.time || t.time;
      if (t.origin === 'statement') twin.date = t.date;  // statement date is authoritative
      changed.push(twin);
      merged++;
    } else {
      existing.push(t);
      byId.set(t.id, t);
      used.add(t.id);
      changed.push(t);
      added++;
    }
  }
  await DB.putMany('txns', changed);
  return { added, merged };
}

// Attach each Swiggy order (items) to its payment: Swiggy-ish name + same total (±₹1) + date within 1 day.
async function linkSwiggy() {
  const [txns, orders] = [await DB.all('txns'), await DB.all('orders')];
  const linked = new Set(orders.map(o => o.txnId).filter(Boolean));
  const tChanged = [], oChanged = [];
  for (const o of orders.filter(o => !o.txnId)) {
    const t = txns.find(t => !linked.has(t.id) && /SWIGGY|INSTAMART|BUNDL/i.test(t.name + ' ' + (t.ref || ''))
      && Math.abs(t.amount - o.total) <= 1 && dayDiff(t.date, o.date) <= 1);
    if (!t) continue;
    linked.add(t.id);
    o.txnId = t.id; t.orderId = o.orderId;
    if (!t.userCategory) t.category = o.kind === 'instamart' ? 'Groceries' : 'Food';
    tChanged.push(t); oChanged.push(o);
  }
  await DB.putMany('txns', tChanged);
  await DB.putMany('orders', oChanged);
  return oChanged.length;
}

async function addUnrecognised(source, date, text) {
  const list = (await DB.get('unrecognised')) || [];
  const id = P.hash(text);
  if (!list.some(u => u.id === id)) list.unshift({ id, source, date, text: text.slice(0, 3000) });
  await DB.set('unrecognised', list.slice(0, 200));
}

// After a pattern update, messages stuck in Unrecognised may now parse. Re-try them all (runs on app open).
async function retryUnrecognised() {
  const list = (await DB.get('unrecognised')) || [];
  if (!list.length) return 0;
  const rules = (await DB.get('rules')) || {};
  const txns = [], orders = [], still = [];
  for (const u of list) {
    let r = null;
    if (u.source === 'hdfc-email') r = parseHdfcAlert(u.text, rules);
    else if (u.source === 'sms') r = parseHdfcSms(u.text, rules);
    else if (u.source === 'swiggy-email') {
      const [subject, ...body] = u.text.split('\n\n');           // stored as "subject\n\nbody"
      r = parseSwiggyEmail(body.join('\n\n'), subject, u.date);
    }
    if (r && r !== 'unrecognised') (u.source === 'swiggy-email' ? orders : txns).push(r);
    else still.push(u);
  }
  if (still.length === list.length) return 0;
  await DB.putMany('orders', orders);
  await mergeTxns(txns);
  await linkSwiggy();
  await DB.set('unrecognised', still);
  return list.length - still.length;
}

// ---------- files ----------
let pdfjsReady;
function loadPdfJs() {
  pdfjsReady = pdfjsReady || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(pdfjsLib);
    };
    s.onerror = () => reject(new Error('Could not load the PDF reader (needs internet once).'));
    document.head.appendChild(s);
  });
  return pdfjsReady;
}

// PDF → text lines (pdf.js gives positioned words; group words sharing a baseline into one line).
async function pdfLines(file, password) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer(), password }).promise;
  const lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const rows = new Map();
    for (const it of content.items) {
      if (!it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 2);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(it);
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0])
      .forEach(([, items]) => lines.push(items.sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str.trim()).join(' ')));
  }
  return lines;
}

// ExpenseOwl-compatible CSV: name,category,amount,date
function toCsv(txns) {
  const esc = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
  return ['name,category,amount,date', ...txns.map(t => [esc(t.name), esc(t.category), t.amount, t.date].join(','))].join('\n');
}

function parseOwlCsv(csv, rules) {
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  const head = splitCsv(lines[0]).map(h => h.toLowerCase());
  const i = k => head.indexOf(k);
  return lines.slice(1).map(splitCsv).map(r => P.txn({
    origin: 'manual', account: 'other', name: r[i('name')], amount: Math.abs(P.money(r[i('amount')])),
    date: P.date(r[i('date')]), category: r[i('category')] || P.categorize(r[i('name')], rules), confirmed: true,
  })).filter(t => t.date && t.amount);
}

// One entry point for every file the user picks. Returns a short summary string.
async function importFile(file) {
  const rules = (await DB.get('rules')) || {};
  const name = file.name.toLowerCase();

  if (name.endsWith('.json')) {
    if (!confirm('Restore this backup? It replaces everything currently in the app.')) return 'Cancelled';
    await DB.importAll(JSON.parse(await file.text()));
    return 'Backup restored';
  }

  let txns;
  if (name.endsWith('.pdf')) {
    let lines;
    try { lines = await pdfLines(file); }
    catch (e) {
      if (e.name !== 'PasswordException') throw e;
      const pw = prompt('Statement password (HDFC: usually first 4 letters of your name + DDMM of birth date)');
      if (!pw) return 'Cancelled';
      lines = await pdfLines(file, pw);
    }
    txns = parseCcStatementLines(lines, rules);
    if (!txns.length) {
      await addUnrecognised('cc-statement', null, lines.join('\n'));
      return 'No rows recognised. Saved to Unrecognised so the pattern can be fixed.';
    }
  } else if (name.endsWith('.csv') || name.endsWith('.txt') && /narration/i.test(await file.text())) {
    const text = await file.text();
    txns = /narration/i.test(text) ? parseBankCsv(text, rules) : parseOwlCsv(text, rules);
  } else if (name.endsWith('.txt')) {
    txns = [];
    for (const block of (await file.text()).split(/\n-{3,}\n|\n\s*\n/)) {
      const t = parseHdfcSms(block.trim(), rules);
      if (t === 'unrecognised') await addUnrecognised('sms', null, block.trim());
      else if (t) txns.push(t);
    }
  } else {
    throw new Error('Unsupported file. Use PDF (card statement), CSV (bank statement), TXT (SMS) or JSON (backup).');
  }

  const r = await mergeTxns(txns);
  const linkedOrders = await linkSwiggy();
  return `${r.added} new, ${r.merged} matched existing` + (linkedOrders ? `, ${linkedOrders} Swiggy orders linked` : '');
}
