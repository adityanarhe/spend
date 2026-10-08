// Local storage on the device (IndexedDB). Nothing here ever leaves the phone.
// Stores: txns (payments), orders (Swiggy orders with items), kv (settings, rules, sync state, unrecognised).
const DB = (() => {
  let db;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('spend', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('txns', { keyPath: 'id' });
        d.createObjectStore('orders', { keyPath: 'orderId' });
        d.createObjectStore('kv');
      };
      req.onsuccess = () => { db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  function run(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const result = fn(t.objectStore(store));
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }

  const all = store => run(store, 'readonly', s => s.getAll());
  const putMany = (store, items) => run(store, 'readwrite', s => { items.forEach(i => s.put(i)); });
  const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
  const get = key => run('kv', 'readonly', s => s.get(key));
  const set = (key, value) => run('kv', 'readwrite', s => s.put(value, key));

  async function exportAll() {
    const kv = {};
    for (const k of ['settings', 'rules', 'sync', 'unrecognised', 'fixes']) kv[k] = await get(k);
    return { app: 'spend', version: 1, exportedAt: new Date().toISOString(),
      txns: await all('txns'), orders: await all('orders'), kv };
  }

  async function importAll(data) {
    if (data.app !== 'spend') throw new Error('Not a Spend backup file');
    await run('txns', 'readwrite', s => s.clear());
    await run('orders', 'readwrite', s => s.clear());
    await putMany('txns', data.txns || []);
    await putMany('orders', data.orders || []);
    for (const [k, v] of Object.entries(data.kv || {})) if (v !== undefined) await set(k, v);
  }

  return { open, all, putMany, del, get, set, exportAll, importAll };
})();
