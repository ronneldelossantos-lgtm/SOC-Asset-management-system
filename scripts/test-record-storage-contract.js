const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../index.html'), 'utf8');

function functionSource(name) {
  const start = source.indexOf('function '+name+'(');
  assert.notEqual(start, -1, name+' is missing');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for(let index = bodyStart; index < source.length; index++) {
    if(source[index] === '{') depth++;
    if(source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(name+' is incomplete');
}

const recordFactory = new Function(`
  let DB = {requests:[], returns:[], issuance:[], issuanceMetrics:{}};
  let recordSnapshots = {};
  let lastKnownSnapshot = {issuanceMetrics: '{}'};
  ${functionSource('recordIsArchived')}
  ${functionSource('recordSnapshot')}
  ${functionSource('recordChanges')}
  ${functionSource('issuanceMetricDate')}
  ${functionSource('changeIssuanceMetricBucket')}
  ${functionSource('changeIssuanceMetric')}
  ${functionSource('buildIssuanceMetrics')}
  ${functionSource('refreshIssuanceMetrics')}
  return {DB, recordSnapshots, recordIsArchived, recordSnapshot, recordChanges, buildIssuanceMetrics, refreshIssuanceMetrics};
`);

const record = recordFactory();
assert.equal(record.recordIsArchived('requests', {status:'Received'}), true);
assert.equal(record.recordIsArchived('requests', {status:'Issued'}), false);
assert.equal(record.recordIsArchived('returns', {status:'Pending'}), false);
assert.equal(record.recordIsArchived('issuance', {deptReceived:true}), true);

record.DB.issuance = [{id:'ISS-1', sku:'CON-1', qty:2, date:'2026-09-01T12:00:00.000Z'}];
record.recordSnapshots.issuance = {};
const changes = record.recordChanges('issuance');
record.refreshIssuanceMetrics(changes);
assert.deepEqual(record.DB.issuanceMetrics, {
  all:{'CON-1': {totalQty:2, dates:{'2026-09-01':2}, earliest:'2026-09-01'}},
  bySoc:{'':{'CON-1': {totalQty:2, dates:{'2026-09-01':2}, earliest:'2026-09-01'}}}
});

record.recordSnapshots.issuance = record.recordSnapshot(record.DB.issuance);
record.DB.issuance[0].qty = 5;
record.refreshIssuanceMetrics(record.recordChanges('issuance'));
assert.equal(record.DB.issuanceMetrics.all['CON-1'].totalQty, 5);

console.log('record storage contract checks passed');
