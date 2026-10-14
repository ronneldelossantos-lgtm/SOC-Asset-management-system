const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../index.html'), 'utf8');

function functionSource(name, asyncFn) {
  const start = source.indexOf((asyncFn ? 'async function ' : 'function ') + name + '(');
  assert.notEqual(start, -1, name + ' is missing');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(name + ' is incomplete');
}

// The dashboard stock listener fires for every stock change by anyone. It must
// never re-read whole record collections (thousands of docs) per change.
const live = functionSource('startDashboardLiveSync');
assert.match(live, /loadRecordDelta\(/);
assert.doesNotMatch(live, /loadRecordSection\(/, 'dashboard live sync must use the delta fetch, not a full reload');

(async () => {
  const calls = [];
  const factory = new Function('storage', `
    let DB = {issuance: [{id:'A', status:'x', deptReceived:false}, {id:'B', status:'x', deptReceived:false}]};
    const loadedRecordArchives = new Set();
    const window = {storage};
    let normalized = null;
    function normalizeRecordSection(key, records){ normalized = {key, records}; DB[key] = records; }
    async function loadRecordSection(key, inc){ return {full:true, key, inc}; }
    ${functionSource('recordIsArchived')}
    ${functionSource('loadRecordDelta', true)}
    return {DB, loadRecordDelta, get normalized(){ return normalized; }};
  `);

  // 1. changed + new + now-archived records merge; others untouched
  let t = factory({getRecordsUpdatedSince: async () => [
    {id:'B', value: JSON.stringify({id:'B', status:'y', deptReceived:false})},
    {id:'C', value: JSON.stringify({id:'C', status:'z', deptReceived:false})},
    {id:'A', value: JSON.stringify({id:'A', status:'x', deptReceived:true})}, // archived, archive not loaded -> dropped
  ]});
  await t.loadRecordDelta('issuance');
  assert.deepEqual(t.normalized.records.map(r => r.id + ':' + r.status).sort(), ['B:y', 'C:z']);

  // 2. nothing changed -> no rewrite of the section
  t = factory({getRecordsUpdatedSince: async () => []});
  await t.loadRecordDelta('issuance');
  assert.equal(t.normalized, null);

  // 3. no watermark -> falls back to a full load
  t = factory({getRecordsUpdatedSince: async () => null});
  const res = await t.loadRecordDelta('issuance');
  assert.deepEqual(res, {full:true, key:'issuance', inc:false});

  console.log('dashboard delta sync checks passed');
})().catch(e => { console.error(e); process.exit(1); });
