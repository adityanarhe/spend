// Reads HDFC alert emails + Swiggy order emails straight from Gmail (read-only), in the browser.
// Path of your data: Google → this phone. No other server involved.
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Instamart mails from its own domain (confirmed: noreply@instamart.in), not swiggy.in.
const SENDERS = ['alerts@hdfcbank.net', 'alerts@hdfcbank.bank.in', 'noreply@swiggy.in', 'no-reply@swiggy.in', 'noreply@instamart.in'];
// Sign-in uses a full-page redirect, not a popup: iPhone home-screen apps block or break popups.
// Tap Sync → Google's page → Google sends you back here with a 1-hour read-only pass in the URL
// fragment (#access_token=…). Fragments never reach any server; we read it and wipe it from the URL.
// The pass lives in sessionStorage only (gone when the app is closed).
const session = {
  get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
  del: k => { try { sessionStorage.removeItem(k); } catch {} },
};
let accessToken = session.get('gmail-token');
let tokenExpiry = Number(session.get('gmail-expiry')) || 0;

// Must exactly match an "Authorized redirect URI" in Google Cloud: https://adityanarhe.github.io/spend/ and http://localhost:5173/
const redirectUri = () => location.origin + location.pathname;

function getToken(clientId) {
  if (accessToken && Date.now() < tokenExpiry) return Promise.resolve(accessToken);
  const state = crypto.getRandomValues(new Uint32Array(2)).join('-');   // proves the reply answers our own request
  session.set('gmail-state', state);
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(), response_type: 'token',
    scope: 'https://www.googleapis.com/auth/gmail.readonly', include_granted_scopes: 'true', state,
  });
  return new Promise(() => {});                          // page is leaving; sync resumes after the redirect back
}

// Called on app start. Returns 'ok' if we just came back from Google with a pass, an error message, or null.
function handleAuthRedirect() {
  if (!location.hash.includes('access_token') && !location.hash.includes('error')) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);     // wipe the token from the address bar / history
  const expected = session.get('gmail-state');
  session.del('gmail-state');
  if (p.get('error')) return p.get('error') === 'access_denied' ? 'Gmail access was not allowed' : `Google sign-in error: ${p.get('error')}`;
  if (!expected || p.get('state') !== expected) return 'Sign-in reply did not match this app. Tap Sync again.';
  accessToken = p.get('access_token');
  tokenExpiry = Date.now() + (Number(p.get('expires_in')) - 60) * 1000;
  session.set('gmail-token', accessToken);
  session.set('gmail-expiry', String(tokenExpiry));
  return 'ok';
}

async function api(path) {
  const res = await fetch(`${GMAIL}/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401) { accessToken = null; session.del('gmail-token'); throw new Error('Gmail session expired. Tap Sync again.'); }
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
