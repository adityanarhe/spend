// Screens: Today, Month, Import. Plain DOM rendering from what's in IndexedDB.
const $ = s => document.querySelector(s);
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const money = n => inr.format(Math.round(n));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ACCOUNT = { hdfc_cc: 'Credit card', hdfc_upi: 'UPI', hdfc_bank: 'Bank', other: 'Other' };
const ORIGIN = { alert: 'Email alert', sms: 'SMS', statement: 'Statement', manual: 'CSV import', fix: 'Fixed by you' };
const cat = name => CATEGORIES.find(c => c.name === name) || CATEGORIES.find(c => c.name === 'Other');
const counts = t => !cat(t.category).excluded;
const sum = list => list.filter(counts).reduce((s, t) => s + t.amount, 0);

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const today = () => iso(new Date());
const fmtDay = s => {
  if (s === today()) return 'Today';
  if (s === iso(addDays(new Date(), -1))) return 'Yesterday';
  return new Date(s).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
};

const state = { tab: 'today', offset: 0, txns: [], orders: [], settings: {} };

async function load() {
  state.txns = (await DB.all('txns')).sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  state.orders = await DB.all('orders');
  state.settings = { startDay: 1, ...((await DB.get('settings')) || {}) };
}

// A "month" can start on any day (e.g. salary day). Returns [startISO, endISO, label].
function period(offset) {
  const s = state.settings.startDay, now = new Date();
  let start = new Date(now.getFullYear(), now.getMonth() - (now.getDate() < s ? 1 : 0), s);
  start = new Date(start.getFullYear(), start.getMonth() + offset, s);
  const end = addDays(new Date(start.getFullYear(), start.getMonth() + 1, s), -1);
  const label = s === 1
    ? start.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    : `${start.getDate()} ${start.toLocaleDateString('en-IN', { month: 'short' })} – ${end.getDate()} ${end.toLocaleDateString('en-IN', { month: 'short' })}`;
  return [iso(start), iso(end), label];
}
const inRange = (a, b) => state.txns.filter(t => t.date >= a && t.date <= b);

// ---------- shared bits ----------
function txnRow(t) {
  const c = cat(t.category);
  const meta = [t.category, ACCOUNT[t.account], t.time?.slice(0, 5)].filter(Boolean).join(' · ');
  return `<button class="row has-icon" data-txn="${esc(t.id)}">
    <span class="icon" style="background:${c.color}">${esc(t.category[0])}</span>
    <span class="main"><div class="title">${esc(t.name)}</div><div class="subtitle">${esc(meta)}</div></span>
    <span class="value${c.excluded ? ' muted' : ''}">${t.amount < 0 ? '+' : ''}${money(Math.abs(t.amount))}</span>
  </button>`;
}

function groupedByDay(list) {
  const days = [...new Set(list.map(t => t.date))];
  return days.map(d => {
    const items = list.filter(t => t.date === d);
    return `<div class="section-header">${esc(fmtDay(d))} · ${money(sum(items))}</div>
      <div class="group">${items.map(txnRow).join('')}</div>`;
  }).join('');
}

function bars(days, highlight) {
  const vals = days.map(d => sum(state.txns.filter(t => t.date === d)));
  const max = Math.max(...vals, 1);
  return `<div class="chart">${days.map((d, i) => `
    <div class="col${highlight && d !== highlight ? ' dim' : ''}" title="${d}: ${money(vals[i])}">
      <i style="height:${(vals[i] / max) * 100}%"></i>
      ${days.length <= 7 ? `<span>${new Date(d).toLocaleDateString('en-IN', { weekday: 'narrow' })}</span>` : ''}
    </div>`).join('')}</div>`;
}

// Donut of spend by category, drawn with a CSS conic-gradient (no chart library).
function pie(list, caption) {
  const slices = CATEGORIES.filter(c => !c.excluded)
    .map(c => ({ ...c, total: sum(list.filter(t => t.category === c.name)) }))
    .filter(c => c.total > 0).sort((a, b) => b.total - a.total);
  const total = slices.reduce((s, c) => s + c.total, 0);
  let at = 0;
  const stops = slices.map(c => `${c.color} ${(at / total) * 360}deg ${((at += c.total) / total) * 360}deg`).join(', ');
  return `<div class="pie">
    <div class="donut" style="background:${total ? `conic-gradient(${stops})` : 'var(--fill)'}">
      <div><b>${money(total)}</b><span>${esc(caption)}</span></div>
    </div>
    <div class="legend">${slices.map(c => `
      <div><i style="background:${c.color}"></i><span>${c.name}</span><b>${Math.round((c.total / total) * 100)}%</b></div>`).join('')
      || '<div class="subtitle">No spending yet</div>'}</div>
  </div>`;
}

// Bar/pie choice is remembered per screen ('today', 'month').
const chartPref = {
  get(screen) { try { return localStorage.getItem(`chart-${screen}`) || 'bar'; } catch { return 'bar'; } },
  set(screen, v) { try { localStorage.setItem(`chart-${screen}`, v); } catch {} },
};

// A chart card with the bar/pie toggle pinned top-right.
function chartCard(screen, barsHtml, pieHtml) {
  const mode = chartPref.get(screen);
  return `<div class="group chart-card">
    <div class="mini-seg" role="group" aria-label="Chart type">
      <button data-chart="bar" data-screen="${screen}" class="${mode === 'bar' ? 'on' : ''}" aria-label="Daily bars">
        <svg viewBox="0 0 24 24"><path d="M6 20v-6M12 20V6M18 20v-9"/></svg></button>
      <button data-chart="pie" data-screen="${screen}" class="${mode === 'pie' ? 'on' : ''}" aria-label="By category">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4v8l6 5"/></svg></button>
    </div>
    ${mode === 'pie' ? pieHtml() : barsHtml()}
  </div>`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

function openSheet(html) { $('#sheet-body').innerHTML = html; $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; }

// ---------- Today ----------
function renderToday() {
  const t = today();
  const week = [...Array(7)].map((_, i) => iso(addDays(new Date(), i - 6)));
  const [ps, pe] = period(0);
  const recent = state.txns.filter(x => x.date >= week[0]);
  const synced = state.settings.clientId
    ? `<button data-action="sync">Sync</button>` : '<span></span>';
  return `
    <div class="nav"><span></span>${synced}</div>
    <h1 class="large-title">Today</h1>
    <div class="hero">
      <div class="label">Spent today</div>
      <div class="amount">${money(sum(state.txns.filter(x => x.date === t)))}</div>
      <div class="sub">This week ${money(sum(recent))} · This month ${money(sum(inRange(ps, pe)))}</div>
    </div>
    ${chartCard('today', () => bars(week, t), () => pie(recent, '7 days'))}
    ${recent.length ? groupedByDay(recent)
      : `<div class="empty">No payments in the last 7 days.<br>Tap <b>Import</b> to sync Gmail or add a statement.</div>`}`;
}

// ---------- Month ----------
function renderMonth() {
  const [s, e, label] = period(state.offset);
  const [ls, le] = period(state.offset - 1);
  const list = inRange(s, e), total = sum(list);
  // Compare like-for-like: the current month so far vs the same number of days last month.
  const elapsed = state.offset === 0 ? Math.round((new Date(today()) - new Date(s)) / 864e5) : 99;
  const prev = sum(inRange(ls, iso(addDays(new Date(ls), elapsed))).filter(t => t.date <= le));
  const diff = total - prev;

  const byCat = CATEGORIES.filter(c => !c.excluded)
    .map(c => ({ ...c, total: sum(list.filter(t => t.category === c.name)), n: list.filter(t => t.category === c.name).length }))
    .filter(c => c.n).sort((a, b) => b.total - a.total);
  const byAcc = Object.keys(ACCOUNT).map(a => ({ a, total: sum(list.filter(t => t.account === a)) })).filter(x => x.total);
  const merchants = {};
  list.filter(counts).forEach(t => { const k = P.key(t.name); (merchants[k] ||= { name: t.name, total: 0, n: 0 }); merchants[k].total += t.amount; merchants[k].n++; });
  const top = Object.values(merchants).sort((a, b) => b.total - a.total).slice(0, 5);
  const days = []; for (let d = new Date(s); iso(d) <= e && iso(d) <= today(); d = addDays(d, 1)) days.push(iso(d));
  const max = byCat[0]?.total || 1;

  return `
    <div class="nav">
      <button data-action="prev">‹ Previous</button>
      ${state.offset < 0 ? '<button data-action="next">Next ›</button>' : '<span></span>'}
    </div>
    <h1 class="large-title">${esc(label)}</h1>
    <div class="hero">
      <div class="label">Total spent</div>
      <div class="amount">${money(total)}</div>
      ${prev ? `<div class="sub"><span class="${diff > 0 ? 'up' : 'down'}">${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'}</span> than last month${state.offset === 0 ? ' at this point' : ''}</div>` : ''}
    </div>
    ${!list.length ? '<div class="empty">Nothing recorded for this period.</div>' : `
    <div class="section-header">By category</div>
    <div class="group">${byCat.map(c => `
      <button class="row has-icon" data-cat="${esc(c.name)}">
        <span class="icon" style="background:${c.color}">${c.name[0]}</span>
        <span class="main">
          <div style="display:flex;justify-content:space-between"><span>${c.name}</span><span class="value">${money(c.total)}</span></div>
          <div class="bar"><i style="width:${(c.total / max) * 100}%;background:${c.color}"></i></div>
        </span>
      </button>`).join('')}</div>
    <div class="section-header">${chartPref.get('month') === 'pie' ? 'Share by category' : 'Every day'}</div>
    ${chartCard('month',
      () => `${bars(days)}<div class="chart-axis"><span>${new Date(s).getDate()}</span><span>${new Date(days[days.length - 1] || e).getDate()}</span></div>`,
      () => pie(list, state.offset === 0 ? 'this month' : 'month'))}
    <div class="section-header">By payment method</div>
    <div class="group">${byAcc.map(x => `
      <div class="row"><span class="main">${ACCOUNT[x.a]}</span><span class="value">${money(x.total)}</span>
      <span class="value muted">${Math.round((x.total / total) * 100)}%</span></div>`).join('')}</div>
    <div class="section-header">Top places</div>
    <div class="group">${top.map(m => `
      <button class="row" data-merchant="${esc(P.key(m.name))}"><span class="main"><div class="title">${esc(m.name)}</div>
      <div class="subtitle">${m.n} payment${m.n > 1 ? 's' : ''}</div></span><span class="value">${money(m.total)}</span></button>`).join('')}</div>`}`;
}

// ---------- Import ----------
async function renderImport() {
  const sync = (await DB.get('sync')) || {};
  const unrec = (await DB.get('unrecognised')) || [];
  const fixes = (await DB.get('fixes')) || [];
  const st = state.settings;
  return `
    <div class="nav"></div>
    <h1 class="large-title">Import</h1>
    <div class="section-header">Automatic</div>
    <div class="group">
      <button class="row" data-action="sync"><span class="main"><div class="action">Sync Gmail</div>
        <div class="subtitle">${sync.at ? 'Last synced ' + new Date(sync.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Never synced'}</div></span></button>
      <button class="row" data-action="client"><span class="main">Google Client ID</span>
        <span class="value muted">${st.clientId ? 'Set' : 'Not set'}</span><span class="chev">›</span></button>
    </div>
    <div class="section-footer">Reads HDFC alert and Swiggy order emails, read-only, straight to this phone.</div>

    <div class="section-header">Files</div>
    <div class="group">
      <button class="row" data-action="file"><span class="main"><div class="action">Import a file</div>
      <div class="subtitle">Card statement PDF · bank statement CSV · SMS .txt · backup .json</div></span></button>
    </div>
    <div class="section-footer">Duplicates are matched automatically: a statement row confirms the alert you already have.</div>

    <div class="section-header">Review</div>
    <div class="group">
      <button class="row" data-action="unrec"><span class="main">Unrecognised</span>
      <span class="value muted">${unrec.length}</span><span class="chev">›</span></button>
      <button class="row" data-action="fixes"><span class="main">Fixes to review</span>
      <span class="value muted">${fixes.length}</span><span class="chev">›</span></button>
    </div>
    <div class="section-footer">Messages that looked like a payment but matched no pattern. Fix them by hand; each fix is kept so the pattern can be added later.</div>

    <div class="section-header">Settings</div>
    <div class="group">
      <label class="row"><span class="main">Month starts on day</span>
        <select data-setting="startDay">${[...Array(28)].map((_, i) => `<option${st.startDay === i + 1 ? ' selected' : ''}>${i + 1}</option>`).join('')}</select>
        <span class="chev">›</span></label>
    </div>

    <div class="section-header">Your data</div>
    <div class="group">
      <button class="row" data-action="backup"><span class="main action">Export backup</span></button>
      <button class="row" data-action="csv"><span class="main action">Export CSV</span></button>
      <button class="row" data-action="wipe"><span class="main danger">Delete all data</span></button>
    </div>
    <div class="section-footer">${state.txns.length} payments stored only on this device. Export a backup now and then — deleting the app deletes the data.</div>`;
}

// ---------- sheets ----------
function txnSheet(id) {
  const t = state.txns.find(x => x.id === id);
  if (!t) return;
  const o = t.orderId && state.orders.find(x => x.orderId === t.orderId);
  openSheet(`
    <h2>${esc(t.name)}</h2>
    <div class="big">${t.amount < 0 ? '+' : ''}${money(Math.abs(t.amount))}</div>
    <div class="group" style="margin-top:12px">
      <div class="row"><span class="main">Date</span><span class="value muted">${esc(fmtDay(t.date))}${t.time ? ', ' + esc(t.time.slice(0, 5)) : ''}</span></div>
      <div class="row"><span class="main">Paid with</span><span class="value muted">${ACCOUNT[t.account]}</span></div>
      <label class="row"><span class="main">Category</span>
        <select data-txn-cat="${esc(t.id)}">${CATEGORIES.map(c => `<option${c.name === t.category ? ' selected' : ''}>${c.name}</option>`).join('')}</select>
        <span class="chev">›</span></label>
      <div class="row"><span class="main">Source</span><span class="value muted">${ORIGIN[t.origin]}${t.confirmed && t.origin !== 'statement' ? ' ✓ statement' : ''}</span></div>
    </div>
    ${o ? `<div class="section-header">Swiggy ${o.kind === 'instamart' ? 'Instamart' : 'order'}${o.place ? ' · ' + esc(o.place) : ''}</div>
      <div class="group">${o.items.length ? o.items.map(i => `<div class="row"><span class="main">${esc(i.name)}</span>
        <span class="value muted">×${i.qty}</span><span class="value">${money(i.price)}</span></div>`).join('')
        : '<div class="row"><span class="main subtitle">Items not found in the email</span></div>'}
      <div class="row"><span class="main"><b>Order total</b></span><span class="value"><b>${money(o.total)}</b></span></div></div>` : ''}
    <div class="group" style="margin-top:22px"><button class="row" data-delete="${esc(t.id)}"><span class="main danger">Delete payment</span></button></div>`);
}

function listSheet(title, list) {
  openSheet(`<h2>${esc(title)}</h2><div class="big">${money(sum(list))}</div>${groupedByDay(list)}`);
}

async function unrecSheet() {
  const list = (await DB.get('unrecognised')) || [];
  openSheet(`<h2>Unrecognised</h2>
    <div class="section-footer" style="margin:4px 4px 12px">Fix each one by hand. Every fix is logged under <b>Fixes to review</b> so its pattern can be added later.</div>
    ${list.map(u => `<div class="section-header">${esc(u.source)}${u.date ? ' · ' + esc(u.date) : ''}</div>
      <div class="group"><pre class="raw">${esc(u.text.slice(0, 1200))}</pre>
        <button class="row" data-fix="${esc(u.id)}"><span class="main action">Fix: enter the details</span><span class="chev">›</span></button>
        <button class="row" data-dismiss="${esc(u.id)}"><span class="main subtitle">Not a payment, ignore it</span></button>
      </div>`).join('') || '<div class="empty">All clear.</div>'}`);
}

// Best guesses from the raw text so the form is mostly pre-filled.
async function fixSheet(id) {
  const u = ((await DB.get('unrecognised')) || []).find(x => x.id === id);
  if (!u) return;
  const amt = (u.text.match(/(?:Rs\.?|INR|₹)\s?([\d,]+(?:\.\d{1,2})?)/i) || [])[1];
  const dm = u.text.match(new RegExp(DATE));
  const date = (dm && P.date(dm[1])) || u.date || today();
  const account = /credit card/i.test(u.text) ? 'hdfc_cc' : /upi|vpa/i.test(u.text) ? 'hdfc_upi' : 'hdfc_bank';
  const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
  openSheet(`<h2>Fix payment</h2>
    <div class="group" style="margin-top:8px"><pre class="raw">${esc(u.text.slice(0, 600))}</pre></div>
    <form id="fix-form" data-id="${esc(u.id)}">
      <div class="group" style="margin-top:16px">
        <label class="row"><span class="main">Amount ₹</span><input name="amount" inputmode="decimal" required value="${amt ? P.money(amt) : ''}"></label>
        <label class="row"><span class="main">Merchant</span><input name="name" required placeholder="e.g. SWIGGY"></label>
        <label class="row"><span class="main">Date</span><input name="date" type="date" required value="${date}"></label>
        <label class="row"><span class="main">Paid with</span><select name="account">${opts(Object.entries(ACCOUNT), account)}</select><span class="chev">›</span></label>
        <label class="row"><span class="main">Category</span><select name="category">${opts(CATEGORIES.map(c => [c.name, c.name]), 'Other')}</select><span class="chev">›</span></label>
      </div>
      <div class="group" style="margin-top:22px"><button class="row" type="submit"><span class="main action">Save payment</span></button></div>
    </form>`);
}

// Moves an entry from Unrecognised to the fix log: original text + what it should have produced (null = not a payment).
async function logFix(id, corrected) {
  const list = (await DB.get('unrecognised')) || [];
  const u = list.find(x => x.id === id);
  const fixes = (await DB.get('fixes')) || [];
  fixes.push({ ...u, corrected, fixedAt: new Date().toISOString() });
  await DB.set('fixes', fixes);
  await DB.set('unrecognised', list.filter(x => x.id !== id));
}

async function fixesSheet() {
  const fixes = (await DB.get('fixes')) || [];
  openSheet(`<h2>Fixes to review</h2>
    <div class="section-footer" style="margin:4px 4px 12px">Payments you fixed by hand. Export and share this file so each one becomes a pattern; then clear the list.</div>
    ${fixes.map(f => `<div class="section-header">${esc(f.source)} · fixed ${esc(f.fixedAt.slice(0, 10))}</div>
      <div class="group">
        <div class="row"><span class="main">${f.corrected ? `${esc(f.corrected.name)} · ${esc(ACCOUNT[f.corrected.account])}` : '<span class="subtitle">Not a payment</span>'}</span>
          <span class="value">${f.corrected ? money(f.corrected.amount) : ''}</span></div>
        <pre class="raw">${esc(f.text.slice(0, 400))}</pre>
      </div>`).join('') || '<div class="empty">Nothing to review.</div>'}
    ${fixes.length ? `<div class="group" style="margin-top:22px">
      <button class="row" data-action="export-fixes"><span class="main action">Export fixes</span></button>
      <button class="row" data-action="clear-fixes"><span class="main danger">Clear (patterns updated)</span></button></div>` : ''}`);
}

async function share(filename, text, type) {
  const file = new File([text], filename, { type });
  if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file] }).catch(() => {});
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- events ----------
async function render() {
  await load();
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  $('#view').innerHTML = state.tab === 'today' ? renderToday() : state.tab === 'month' ? renderMonth() : await renderImport();
}

async function setCategory(id, category) {
  const t = state.txns.find(x => x.id === id);
  const rules = (await DB.get('rules')) || {};
  const key = P.key(t.name);
  rules[key] = category;                    // remember for next time
  const same = state.txns.filter(x => x.id !== id && P.key(x.name) === key && !x.userCategory && x.category !== category);
  same.forEach(x => (x.category = category));
  Object.assign(t, { category, userCategory: true });
  await DB.set('rules', rules);
  await DB.putMany('txns', [t, ...same]);
  toast(same.length ? `Also updated ${same.length} other ${t.name} payment${same.length > 1 ? 's' : ''}` : 'Saved. Future payments here will use it.');
  await render();
}

async function act(action) {
  const settings = (await DB.get('settings')) || {};
  if (action === 'sync') {
    if (!settings.clientId) { state.tab = 'import'; await render(); return toast('Add your Google Client ID first'); }
    try { toast('Syncing…'); toast(await syncGmail(toast)); } catch (e) { toast(e.message); }
  } else if (action === 'client') {
    const id = prompt('Google OAuth Client ID (ends with .apps.googleusercontent.com)', settings.clientId || '');
    if (id !== null) await DB.set('settings', { ...settings, clientId: id.trim() });
  } else if (action === 'file') {
    const f = $('#file');
    f.accept = '.pdf,.csv,.txt,.json';
    f.value = '';
    f.click();
    return;
  } else if (action === 'unrec') return unrecSheet();
  else if (action === 'fixes') return fixesSheet();
  else if (action === 'export-fixes') return share(`spend-fixes-${today()}.json`, JSON.stringify((await DB.get('fixes')) || [], null, 2), 'application/json');
  else if (action === 'clear-fixes') {
    if (!confirm('Clear the fix log? Do this after the patterns have been updated. Your payments stay.')) return;
    await DB.set('fixes', []); closeSheet();
  }
  else if (action === 'backup') return share(`spend-backup-${today()}.json`, JSON.stringify(await DB.exportAll()), 'application/json');
  else if (action === 'csv') return share(`spend-${today()}.csv`, toCsv(state.txns), 'text/csv');
  else if (action === 'wipe') {
    if (!confirm('Delete every payment, order and setting on this device? Export a backup first if unsure.')) return;
    await DB.importAll({ app: 'spend', txns: [], orders: [], kv: { rules: {}, sync: null, unrecognised: [], fixes: [] } });
  } else if (action === 'prev') state.offset--;
  else if (action === 'next') state.offset++;
  await render();
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-tab],[data-chart],[data-action],[data-txn],[data-cat],[data-merchant],[data-delete],[data-fix],[data-dismiss],.sheet-backdrop');
  if (!el) return;
  if (el.classList.contains('sheet-backdrop')) return closeSheet();
  const d = el.dataset;
  if (d.chart) { chartPref.set(d.screen, d.chart); return render(); }
  if (d.tab) { state.tab = d.tab; state.offset = 0; closeSheet(); window.scrollTo(0, 0); return render(); }
  if (d.action) return act(d.action);
  if (d.txn) return txnSheet(d.txn);
  if (d.fix) return fixSheet(d.fix);
  if (d.dismiss) { await logFix(d.dismiss, null); toast('Ignored, and logged for review'); await render(); return unrecSheet(); }
  const [s, end] = period(state.offset);
  if (d.cat) return listSheet(d.cat, inRange(s, end).filter(t => t.category === d.cat));
  if (d.merchant) return listSheet(inRange(s, end).find(t => P.key(t.name) === d.merchant).name, inRange(s, end).filter(t => P.key(t.name) === d.merchant));
  if (d.delete && confirm('Delete this payment?')) { await DB.del('txns', d.delete); closeSheet(); render(); }
});

// Saving a fix: create the payment (deduped like any other), remember the merchant's category, log the fix.
document.addEventListener('submit', async e => {
  if (e.target.id !== 'fix-form') return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const corrected = { amount: P.money(f.amount), name: f.name.trim(), date: f.date, account: f.account, category: f.category };
  if (!(corrected.amount > 0)) return toast('Enter the amount');
  const id = e.target.dataset.id;
  const u = ((await DB.get('unrecognised')) || []).find(x => x.id === id);
  await mergeTxns([P.txn({ origin: 'fix', ...corrected, userCategory: true })]);
  await linkSwiggy();
  const rules = (await DB.get('rules')) || {};
  rules[P.key(corrected.name)] = corrected.category;
  await DB.set('rules', rules);
  await logFix(u.id, corrected);
  toast('Saved, and logged for review');
  await render();
  unrecSheet();
});

document.addEventListener('change', async e => {
  if (e.target.dataset.txnCat) { await setCategory(e.target.dataset.txnCat, e.target.value); return txnSheet(e.target.dataset.txnCat); }
  if (e.target.dataset.setting) {
    const settings = (await DB.get('settings')) || {};
    await DB.set('settings', { ...settings, [e.target.dataset.setting]: Number(e.target.value) });
    return render();
  }
  if (e.target.id === 'file' && e.target.files[0]) {
    try { toast('Importing…'); toast(await importFile(e.target.files[0])); } catch (err) { toast(err.message); }
    render();
  }
});

(async () => {
  await DB.open();
  navigator.storage?.persist?.();          // ask the browser not to evict our data
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js');
  }
  await render();
  // Guard: right after an update, an old cached import.js can load once alongside the new app.js.
  const recovered = typeof retryUnrecognised === 'function' ? await retryUnrecognised() : 0;
  if (recovered) { toast(`${recovered} unrecognised message${recovered > 1 ? 's' : ''} now read with updated patterns`); render(); }
})();
