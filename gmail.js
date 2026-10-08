// Reads HDFC alert emails + Swiggy order emails straight from Gmail (read-only), in the browser.
// Path of your data: Google → this phone. No other server involved.
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Instamart mails from its own domain (confirmed: noreply@instamart.in), not swiggy.in.
const SENDERS = ['alerts@hdfcbank.net', 'alerts@hdfcbank.bank.in', 'noreply@swiggy.in', 'no-reply@swiggy.in', 'noreply@instamart.in'];
let accessToken = null, tokenExpiry = 0;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not reach Google sign-in.'));
    document.head.appendChild(s);
  });
}

// Must be called from a tap (iOS blocks sign-in popups otherwise).
async function getToken(clientId) {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      callback: r => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        accessToken = r.access_token;
        tokenExpiry = Date.now() + (r.expires_in - 60) * 1000;
        resolve(accessToken);
      },
      error_callback: e => reject(new Error(e.message || 'Sign-in cancelled')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

async function api(path) {
  const res = await fetch(`${GMAIL}/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401) { accessToken = null; throw new Error('Gmail session expired. Tap Sync again.'); }
  if (!res.ok) throw new Error(`Gmail error ${res.status}`);
  return res.json();
}

function decode(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function htmlToText(html) {
  html = html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li|\/table)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ');
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
  return text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// Prefer the plain-text part; fall back to HTML converted to text.
function bodyText(payload) {
  const parts = [];
  (function walk(p) { if (p.parts) p.parts.forEach(walk); else if (p.body?.data) parts.push(p); })(payload);
  const plain = parts.find(p => p.mimeType === 'text/plain');
  if (plain) return decode(plain.body.data);
  const html = parts.find(p => p.mimeType === 'text/html');
  return html ? htmlToText(decode(html.body.data)) : '';
}

const localDate = ms => { const d = new Date(Number(ms)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const localTime = ms => new Date(Number(ms)).toTimeString().slice(0, 5);

async function syncGmail(onProgress = () => {}) {
  const settings = (await DB.get('settings')) || {};
  if (!settings.clientId) throw new Error('Add your Google Client ID in Import → Gmail first.');
  await getToken(settings.clientId);

  const rules = (await DB.get('rules')) || {};
  const sync = (await DB.get('sync')) || { since: null, seen: [] };
  const seen = new Set(sync.seen);
  const since = sync.since || localDate(Date.now() - 90 * 864e5);       // first sync: last 90 days
  const q = `from:(${SENDERS.join(' OR ')}) after:${since.replace(/-/g, '/')}`;

  const ids = [];
  let pageToken = '';
  do {
    const r = await api(`messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ''}`);
    (r.messages || []).forEach(m => { if (!seen.has(m.id)) ids.push(m.id); });
    pageToken = r.nextPageToken;
  } while (pageToken);

  const txns = [], orders = [];
  let unrecognised = 0;
  for (const [n, id] of ids.entries()) {
    onProgress(`Reading ${n + 1} of ${ids.length}`);
    const m = await api(`messages/${id}?format=full`);
    const h = name => (m.payload.headers.find(x => x.name.toLowerCase() === name) || {}).value || '';
    const from = h('from').toLowerCase(), subject = h('subject');
    const text = bodyText(m.payload);
    const date = localDate(m.internalDate);

    if (from.includes('hdfcbank')) {
      const t = parseHdfcAlert(text, rules);
      if (t === 'unrecognised') { unrecognised++; await addUnrecognised('hdfc-email', date, `${subject}\n\n${text}`); }
      else if (t) { t.time = t.time || localTime(m.internalDate); txns.push(t); }
    } else if (/swiggy|instamart/.test(from)) {
      const o = parseSwiggyEmail(text, subject, date);
      if (o) orders.push(o);
      // Confirmed subjects: "Your Swiggy order was delivered before time", "Your Instamart order was successfully delivered".
      // Promotions ("Order now…") are ignored rather than cluttering the Unrecognised list.
      else if (/order (was|has been|is) (successfully )?delivered|order summary/i.test(subject)) { unrecognised++; await addUnrecognised('swiggy-email', date, `${subject}\n\n${text}`); }
    }
    seen.add(id);
  }

  await DB.putMany('orders', orders);
  const r = await mergeTxns(txns);
  const linked = await linkSwiggy();
  // Re-check yesterday next time (emails can arrive late); "seen" stops double-reading.
  await DB.set('sync', { since: localDate(Date.now() - 864e5), seen: [...seen].slice(-3000), at: Date.now() });
  return `${r.added} new payments, ${orders.length} Swiggy orders` + (linked ? `, ${linked} linked` : '') +
    (unrecognised ? `, ${unrecognised} unrecognised` : '');
}
