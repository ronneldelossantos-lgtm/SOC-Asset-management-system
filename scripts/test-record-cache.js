const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../index.html'), 'utf8');
function fnSrc(name, asyncFn) {
  const start = source.indexOf((asyncFn ? 'async function ' : 'function ') + name + '(');
  assert.notEqual(start, -1, name + ' is missing');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(name + ' incomplete');
}
const constSrc = name => { const m = source.match(new RegExp('const ' + name + ' = [^;]+;')); assert.ok(m, name); return m[0]; };
const { recordCacheSync, RECORD_DELTA_SKEW_MS, RECORD_CACHE_TTL_MS } = new Function(`
  ${constSrc('RECORD_DELTA_SKEW_MS')}
  ${constSrc('RECORD_CACHE_TTL_MS')}
  ${fnSrc('recordCacheMaxMark')}
  ${fnSrc('recordCacheSync', true)}
  return {recordCacheSync, RECORD_DELTA_SKEW_MS, RECORD_CACHE_TTL_MS};
`)();

const NOW = 1_000_000_000_000;
const doc = (id, updatedAt, archived = false, v = 'v') => ({ id, value: JSON.stringify({ id, v }), archived, updatedAt });

// An in-memory stand-in for the "server" collection plus the IndexedDB cache adapter.
function world(serverDocs, cacheInit) {
  const server = new Map(serverDocs.map(d => [d.id, d]));
  const meta = {}; const rows = {};
  if (cacheInit) { meta.sec = cacheInit.meta; rows.sec = new Map(cacheInit.rows.map(d => [d.id, d])); }
  const calls = { fetchFull: 0, fetchDelta: 0, count: 0, deltaDocsReturned: 0, replace: 0, applyDelta: 0 };
  let clock = NOW;
  const deps = {
    now: () => clock,
    warn: () => {},
    cache: {
      async getMeta(s) { return meta[s] || null; },
      async getRows(s) { return new Map(rows[s] || []); },
      async replace(s, docs, m) { calls.replace++; meta[s] = { section: s, ...m }; rows[s] = new Map(docs.map(d => [d.id, d])); },
      async applyDelta(s, puts, dels, mark) { calls.applyDelta++; puts.forEach(d => rows[s].set(d.id, d)); dels.forEach(id => rows[s].delete(id)); meta[s].mark = Math.max(meta[s].mark, mark || 0); },
    },
    async fetchFull(s, inc) { calls.fetchFull++; return [...server.values()].filter(d => inc || !d.archived); },
    async fetchDelta(s, since) { calls.fetchDelta++; const out = [...server.values()].filter(d => d.updatedAt > since); calls.deltaDocsReturned += out.length; return out; },
    async countServer(s, openOnly) { calls.count++; return [...server.values()].filter(d => !openOnly || !d.archived).length; },
  };
  return { server, meta, rows, calls, deps, setClock: t => { clock = t; } };
}
const ids = r => r.rows.map(x => x.id).sort();

(async () => {
  // 1. cold start: full load, cache populated, watermark = newest updatedAt
  let w = world([doc('A', NOW - 3_600_000), doc('B', NOW - 3_500_000), doc('C', NOW - 3_400_000, true)]);
  let r = await recordCacheSync(w.deps, 'sec', true);
  assert.equal(r.source, 'full'); assert.deepEqual(ids(r), ['A', 'B', 'C']);
  assert.equal(w.meta.sec.scope, 'all'); assert.equal(w.meta.sec.mark, NOW - 2 * RECORD_DELTA_SKEW_MS); assert.equal(w.rows.sec.size, 3);

  // 2. warm reload with nothing new: served from cache, ZERO documents re-read in full
  r = await recordCacheSync(w.deps, 'sec', true);
  assert.equal(r.source, 'cache'); assert.equal(w.calls.fetchFull, 1);
  assert.deepEqual(ids(r), ['A', 'B', 'C']);
  assert.equal(w.calls.deltaDocsReturned, 0, 'nothing changed -> delta reads no documents');

  // 3. a change + an addition by someone else arrive via the delta only
  w.server.set('B', doc('B', NOW - 100, false, 'v2'));
  w.server.set('D', doc('D', NOW - 50));
  const before = w.calls.deltaDocsReturned;
  r = await recordCacheSync(w.deps, 'sec', true);
  assert.equal(r.source, 'cache'); assert.equal(w.calls.fetchFull, 1);
  assert.deepEqual(ids(r), ['A', 'B', 'C', 'D']);
  assert.equal(JSON.parse(r.rows.find(x => x.id === 'B').value).v, 'v2');
  assert.equal(w.calls.deltaDocsReturned - before, 2, 'only the changed + new doc are read');
  assert.equal(w.meta.sec.mark, NOW - 50);

  // 4. a deletion by someone else is caught by the count check -> full reload, deleted doc gone
  w.server.delete('A');
  r = await recordCacheSync(w.deps, 'sec', true);
  assert.equal(r.source, 'full'); assert.deepEqual(ids(r), ['B', 'C', 'D']);

  // 5. cache older than the TTL is not trusted
  w.setClock(NOW + RECORD_CACHE_TTL_MS + 1000);
  r = await recordCacheSync(w.deps, 'sec', true);
  assert.equal(r.source, 'full');

  // 6. open-only cache cannot serve a request that needs archived records
  w = world([doc('A', NOW - 5000), doc('C', NOW - 3000, true)]);
  r = await recordCacheSync(w.deps, 'sec', false);
  assert.equal(r.source, 'full'); assert.equal(w.meta.sec.scope, 'open'); assert.deepEqual(ids(r), ['A']);
  r = await recordCacheSync(w.deps, 'sec', true);
  assert.equal(r.source, 'full'); assert.deepEqual(ids(r), ['A', 'C']); assert.equal(w.meta.sec.scope, 'all');

  // 7. an 'all' cache serves an open-only request by filtering archived out
  r = await recordCacheSync(w.deps, 'sec', false);
  assert.equal(r.source, 'cache'); assert.deepEqual(ids(r), ['A']);

  // 8. open-scope cache: a record that becomes archived on the server drops out of the cache
  w = world([doc('A', NOW - 5000), doc('B', NOW - 4000)]);
  await recordCacheSync(w.deps, 'sec', false);
  w.server.set('B', doc('B', NOW - 10, true));
  r = await recordCacheSync(w.deps, 'sec', false);
  assert.equal(r.source, 'cache'); assert.deepEqual(ids(r), ['A']); assert.ok(!w.rows.sec.has('B'));

  // 9. COUNT failure (offline / quota) must not trust the cache
  w = world([doc('A', NOW - 5000)]);
  await recordCacheSync(w.deps, 'sec', true);
  w.deps.countServer = async () => { throw new Error('boom'); };
  r = await recordCacheSync(w.deps, 'sec', true);
  assert.equal(r.source, 'full');

  // 10. a future-dated stamp (bad writer clock) never advances the watermark past "now"
  w = world([doc('A', NOW - 5000), doc('F', NOW + 7 * 24 * 3600 * 1000)]);
  r = await recordCacheSync(w.deps, 'sec', true);
  assert.equal(w.meta.sec.mark, NOW - 5000);
  assert.ok(w.meta.sec.mark <= NOW + RECORD_DELTA_SKEW_MS);

  // 11. no IndexedDB at all: plain full load every time, still correct
  w = world([doc('A', NOW - 5000)]);
  w.deps.cache = null;
  r = await recordCacheSync(w.deps, 'sec', true);
  assert.equal(r.source, 'full'); assert.deepEqual(ids(r), ['A']);

  // 12. a broken cache (throws) falls back to the full load
  w = world([doc('A', NOW - 5000)]);
  await recordCacheSync(w.deps, 'sec', true);
  w.deps.cache.getRows = async () => { throw new Error('idb broke'); };
  r = await recordCacheSync(w.deps, 'sec', true);
  assert.equal(r.source, 'full'); assert.deepEqual(ids(r), ['A']);

  console.log('record cache checks passed');
})().catch(e => { console.error(e); process.exit(1); });
