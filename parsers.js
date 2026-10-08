// Turns bank/Swiggy text into transactions using fixed text patterns (regex). No AI.
// Each bank email/SMS is generated from a template: same words every time, only numbers change.
// DRAFT patterns: confirm each one against a real (redacted) sample in samples/ via tests.html.

const CATEGORIES = [
  { name: 'Food', color: '#ff9500' },
  { name: 'Groceries', color: '#34c759' },
  { name: 'Shopping', color: '#af52de' },
  { name: 'Transport', color: '#007aff' },
  { name: 'Bills', color: '#5856d6' },
  { name: 'Entertainment', color: '#ff2d55' },
  { name: 'Health', color: '#00c7be' },
  { name: 'Travel', color: '#32ade6' },
  { name: 'People', color: '#a2845e' },
  { name: 'Other', color: '#8e8e93' },
  // Excluded from totals: paying your card bill from the bank would otherwise count the same spend twice.
  { name: 'Card bill', color: '#c7c7cc', excluded: true },
  { name: 'Self transfer', color: '#c7c7cc', excluded: true },
];

const KEYWORDS = [
  ['INSTAMART', 'Groceries'], ['SWIGGY', 'Food'], ['BUNDL', 'Food'], ['ZOMATO', 'Food'],
  ['BLINKIT', 'Groceries'], ['ZEPTO', 'Groceries'], ['BIGBASKET', 'Groceries'], ['DMART', 'Groceries'],
  ['UBER', 'Transport'], ['METRO RAIL', 'Transport'], ['OLA', 'Transport'], ['RAPIDO', 'Transport'], ['FASTAG', 'Transport'], ['PETROL', 'Transport'],
  ['AMAZON', 'Shopping'], ['ASSPL', 'Shopping'] /* Amazon Seller Services Pvt Ltd */, ['FLIPKART', 'Shopping'], ['MYNTRA', 'Shopping'], ['AJIO', 'Shopping'], ['NYKAA', 'Shopping'],
  ['NETFLIX', 'Entertainment'], ['SPOTIFY', 'Entertainment'], ['BOOKMYSHOW', 'Entertainment'], ['HOTSTAR', 'Entertainment'], ['YOUTUBE', 'Entertainment'],
  ['AIRTEL', 'Bills'], ['JIO', 'Bills'], ['ELECTRICITY', 'Bills'], ['BESCOM', 'Bills'], ['MSEDCL', 'Bills'], ['BROADBAND', 'Bills'],
  ['PHARM', 'Health'], ['APOLLO', 'Health'], ['1MG', 'Health'], ['HOSPITAL', 'Health'], ['CLINIC', 'Health'],
  ['IRCTC', 'Travel'], ['MAKEMYTRIP', 'Travel'], ['INDIGO', 'Travel'], ['AIRINDIA', 'Travel'], ['GOIBIBO', 'Travel'],
];

const P = {
  money: s => Number(String(s).replace(/,/g, '')),
  key: name => String(name).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(),
  hash(s) { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); },

  // Accepts 08-10-25, 08/10/2025, 08 Oct, 2025, 08-Oct-25, 2025-10-08 → "2025-10-08"
  date(s) {
    s = String(s).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    m = s.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3}|\d{1,2}),?[-\/ ](\d{2,4})/);
    if (!m) return null;
    const mon = isNaN(m[2]) ? months[m[2].toLowerCase()] : Number(m[2]);
    const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (!mon) return null;
    return `${yr}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  },

  categorize(name, rules = {}) {
    const k = P.key(name);
    if (rules[k]) return rules[k];
    for (const [word, cat] of KEYWORDS) if (k.includes(word)) return cat;
    return 'Other';
  },

  txn(fields) {
    const t = { time: null, ref: null, orderId: null, confirmed: false, ...fields };
    t.name = String(t.name).replace(/\s+/g, ' ').trim();
    t.id = `${t.origin}:${t.ref || P.hash([t.account, t.date, t.time, t.amount, t.name].join('|'))}`;
    return t;
  },
};

const DATE = String.raw`(\d{4}-\d{2}-\d{2}|\d{1,2}[-\/ ](?:\d{1,2}|[A-Za-z]{3}),?[-\/ ]\d{2,4})`;
const TIME = String.raw`(\d{1,2}:\d{2}(?::\d{2})?)`;
const AMT = String.raw`(?:Rs\.?|INR|₹)\s?([\d,]+(?:\.\d{1,2})?)`;

// ---------- HDFC alert emails (CC + UPI) ----------
const ALERT_PATTERNS = [
  { // UPI (CONFIRMED from real email):
    //   "Rs.80.00 is debited from your account ending 0512 towards VPA citymetro.payu@axisbank (City Metro Rail Corporation Ltd) on 08-10-26."
    // Also accepts the older wording: "... has been debited from account **1234 to VPA swiggy@icici SWIGGY on 08-10-25."
    account: 'hdfc_upi',
    re: new RegExp(String.raw`${AMT}\s+(?:has been|is)\s+debited from (?:your )?(?:a\/c|account)(?:\s+ending)?\s*[*Xx]*\w{0,4}\s+(?:to|towards)\s+VPA\s+(\S+)(?:\s+\(([^)]+)\)|\s+(.+?))?\s+on\s+${DATE}`, 'is'),
    map: m => ({ amount: P.money(m[1]), vpa: m[2], name: m[3] || m[4] || m[2], date: P.date(m[5]) }),
  },
  { // CC (older): "Thank you for using your HDFC Bank Credit Card ending 1234 for Rs 450.00 at SWIGGY on 08-10-2025 12:34:56"
    account: 'hdfc_cc',
    re: new RegExp(String.raw`Credit Card ending\s*(\d{4})\s+for\s+${AMT}\s+at\s+(.+?)\s+on\s+${DATE}(?:\s+(?:at\s+)?${TIME})?`, 'is'),
    map: m => ({ last4: m[1], amount: P.money(m[2]), name: m[3], date: P.date(m[4]), time: m[5] || null }),
  },
  { // CC (CONFIRMED from real email): "Rs. 4599.00 has been debited from your HDFC Bank Credit Card ending 1234 towards ASSPL on 08 Oct, 2026 at 11:59:39."
    account: 'hdfc_cc',
    re: new RegExp(String.raw`${AMT}\s+(?:is|has been)\s+debited from your HDFC Bank Credit Card ending\s*(?:[X*]*(\d{4}))?\s+towards\s+(.+?)\s+on\s+${DATE}(?:\s+at\s+${TIME})?`, 'is'),
    map: m => ({ amount: P.money(m[1]), last4: m[2], name: m[3], date: P.date(m[4]), time: m[5] || null }),
  },
];

// Returns a txn, null (not a spend email, ignore), or 'unrecognised' (looks like a spend but no pattern matched).
function parseHdfcAlert(text, rules) {
  for (const p of ALERT_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    const f = p.map(m);
    if (!f.date || !f.amount) continue;
    // "UPI transaction reference no.: 123450987612." (confirmed) or "reference number is 1234..."
    const ref = (text.match(/reference (?:number|no\.?)\s*(?:is)?\s*:?\s*(\d{6,})/i) || [])[1] || null;
    return P.txn({ origin: 'alert', account: p.account, amount: f.amount, name: f.name, date: f.date,
      time: f.time || null, ref, category: P.categorize(f.vpa ? `${f.name} ${f.vpa}` : f.name, rules) });
  }
  return /debited|spent|thank you for using/i.test(text) ? 'unrecognised' : null;
}

// ---------- HDFC SMS (via iOS Shortcut file) ----------
const SMS_PATTERNS = [
  { // "Sent Rs.450.00 From HDFC Bank A/C *1234 To SWIGGY On 08/10/25 Ref 123456789012"
    account: 'hdfc_upi',
    re: new RegExp(String.raw`Sent\s+${AMT}\s+From HDFC Bank A\/C\s*[*X]*\d{4}\s+To\s+(.+?)\s+On\s+${DATE}(?:\s+Ref\s+(\d+))?`, 'is'),
    map: m => ({ amount: P.money(m[1]), name: m[2], date: P.date(m[3]), ref: m[4] || null }),
  },
  { // "Spent Rs.450 On HDFC Bank Card 1234 At SWIGGY On 2025-10-08:12:34:56"
    account: 'hdfc_cc',
    re: new RegExp(String.raw`Spent\s+${AMT}\s+On HDFC Bank Card\s*[*X]*\d{4}\s+At\s+(.+?)\s+On\s+${DATE}(?::${TIME})?`, 'is'),
    map: m => ({ amount: P.money(m[1]), name: m[2], date: P.date(m[3]), time: m[4] || null }),
  },
];

function parseHdfcSms(text, rules) {
  for (const p of SMS_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    const f = p.map(m);
    if (!f.date) continue;
    return P.txn({ origin: 'sms', account: p.account, ...f, category: P.categorize(f.name, rules) });
  }
  return /sent|spent|debited/i.test(text) ? 'unrecognised' : null;
}

// ---------- Swiggy order emails ----------
// Returns { orderId, date, kind, place, items[], total } or null.
function parseSwiggyEmail(text, subject = '', date = null) {
  const all = `${subject}\n${text}`;
  // "Grand Total ₹562.00" is what was charged (Item Bill + fees) — that's the amount the payment alert shows.
  const totals = [...all.matchAll(/(?:Grand Total|Order Total|Total Paid|Bill Total)\s*:?\s*(?:Rs\.?|₹)?\s*([\d,]+(?:\.\d{1,2})?)/gi)];
  if (!totals.length) return null;
  const total = P.money(totals[totals.length - 1][1]);
  // Order number if the email has one; otherwise date + total identifies the order well enough.
  const orderId = (all.match(/Order\s*(?:No|ID|#)[.:#\s]*(\d{6,})/i) || [])[1] || `sw-${date}-${total}`;
  const items = [];
  for (const line of text.split('\n').map(l => l.trim())) {
    // price = line total (2 x Onion ₹132.00 means ₹132 for both)
    let m = line.match(/^(\d+)\s*[x×]\s+(.+?)\s+(?:Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)$/i);       // Instamart (confirmed): "2 x Onion (Red)<tab>₹132.00"
    if (m) { items.push({ name: m[2], qty: +m[1], price: P.money(m[3]) }); continue; }
    m = line.match(/^(.+?)\s+[x×]\s*(\d+)\s+(?:Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)$/i);           // DRAFT: "Paneer Roll x 2 ₹ 240"
    if (m) { items.push({ name: m[1], qty: +m[2], price: P.money(m[3]) }); continue; }
    // Food (confirmed): "Paneer 65<tab>1<tab>₹ 360" — the LAST number before ₹ is the quantity,
    // so names ending in numbers ("Paneer 65", "Chicken 555") stay intact. "-Variant ₹ 720" sub-lines have no qty → skipped.
    m = line.match(/^([^-].*?)\s+(\d+)\s+(?:Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)$/i);
    if (m) items.push({ name: m[1], qty: +m[2], price: P.money(m[3]) });
  }
  // "Order placed at: Wednesday, December 31, 2025 9:21 PM" — payment happens at order time.
  const placed = text.match(/Order placed at:\s*\w+,\s*([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)/i);
  let time = null;
  if (placed) {
    date = P.date(`${placed[2]} ${placed[1]} ${placed[3]}`);
    time = `${String((+placed[4] % 12) + (/p/i.test(placed[6]) ? 12 : 0)).padStart(2, '0')}:${placed[5]}`;
  }
  const place = (text.match(/(?:Restaurant|Ordered from|Order from)\s*:?\s*\n?\s*(.+)/i) || [])[1] || null;
  return {
    orderId, date, time, items, place: place && place.trim(),
    kind: /instamart/i.test(all) ? 'instamart' : 'food',
    total,
  };
}

// ---------- HDFC bank statement (NetBanking → Download → "Delimited"/CSV) ----------
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const CARD_BILL = /CREDIT ?CARD|CC ?PAYMENT|CARD ?BILL|AUTOPAY.*CARD|CCPAY|^CC\s*\d|AUTOPAY SI-TAD/i;

// UPI narration: "UPI-SWIGGY-swiggy@icici-ICIC0DC0099-123456789012-UPI" → name SWIGGY, vpa, ref
function narration(n) {
  const upi = n.match(/^UPI-(.+?)-([^-\s]+@[^-\s]+)-[^-]*-(\d{6,})/i);
  if (upi) return { account: 'hdfc_upi', name: upi[1], vpa: upi[2], ref: upi[3] };
  const pos = n.match(/^POS\s+\S+\s+(.+)/i);
  return { account: 'hdfc_bank', name: pos ? pos[1] : n, vpa: '', ref: null };
}

function parseBankCsv(csv, rules) {
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  const hi = lines.findIndex(l => /narration/i.test(l));
  if (hi < 0) throw new Error('No "Narration" header found. Download the statement as Delimited/CSV.');
  const head = splitCsv(lines[hi]).map(h => h.toLowerCase());
  const col = re => head.findIndex(h => re.test(h));
  const c = { date: col(/^date/), nar: col(/narration/), debit: col(/withdrawal|debit/), ref: col(/ref|chq/) };
  const out = [];
  for (const line of lines.slice(hi + 1)) {
    const r = splitCsv(line);
    const amount = P.money(r[c.debit] || 0);
    const date = P.date(r[c.date] || '');
    if (!date || !(amount > 0)) continue;               // credits (salary, refunds to bank) are not spending
    const n = narration(r[c.nar]);
    const category = CARD_BILL.test(r[c.nar]) ? 'Card bill' : P.categorize(`${n.name} ${n.vpa}`, rules);
    out.push(P.txn({ origin: 'statement', account: n.account, amount, date, name: n.name,
      ref: n.ref || (c.ref >= 0 && /\d{6,}/.test(r[c.ref]) ? r[c.ref] : null), category, confirmed: true }));
  }
  return out;
}

// ---------- HDFC credit card statement (PDF text, one line per row) ----------
// "08/10/2025 12:34:56 SWIGGY 450.00" ; credits end with "Cr" or start amount with "+"
function parseCcStatementLines(lines, rules) {
  const out = [];
  const re = /^(\d{2}\/\d{2}\/\d{4})(?:\s*\|?\s*\d{2}:\d{2}(?::\d{2})?)?\s+(.+?)\s+(\+\s*)?(?:C\s+)?(?:Rs\.?|₹)?\s*([\d,]+\.\d{2})\s*(Cr)?$/i;
  for (const line of lines) {
    const m = line.trim().match(re);
    if (!m) continue;
    const credit = !!(m[3] || m[5]);
    const name = m[2].replace(/\s+\d+$/, '');          // drop trailing reward-points column
    if (credit && /PAYMENT|NETBANKING|THANK YOU|BBPS/i.test(name)) continue;   // your bill payment, not a refund
    out.push(P.txn({ origin: 'statement', account: 'hdfc_cc', date: P.date(m[1]), name,
      amount: credit ? -P.money(m[4]) : P.money(m[4]), category: P.categorize(name, rules), confirmed: true }));
  }
  return out;
}
