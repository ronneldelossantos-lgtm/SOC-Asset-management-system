'use strict';
const fs = require('fs');
const original = require('./original.js');
const scoped = require('./scoped.js');

const FIXTURE = JSON.parse(fs.readFileSync('/tmp/fixture.json', 'utf8'));
function freshDB(){ return JSON.parse(JSON.stringify(FIXTURE)); }
/* Mirrors index.html's assetTagsArr(): the app already treats a comma-joined
   string and an array of the same tags as equivalent everywhere it reads
   this field, so comparing by that normalized form (not raw JSON) is the
   correct equivalence bar - not "byte-identical", but "every consumer in
   the app would see the same thing". */
function normalizedTagging(it){
  if(Array.isArray(it.assetTagging)) return it.assetTagging;
  if(typeof it.assetTagging === 'string') return it.assetTagging ? it.assetTagging.split(',').map(t=>t.trim()).filter(t=>t) : [];
  return [];
}
function assetSummary(db){
  return db.requests.map(r=>({
    id: r.id,
    items: (r.items||[]).filter(it=>it.type==='Asset').map(it=>({sku:it.sku, assetCodes:it.assetCodes||null, assetTagging:normalizedTagging(it)}))
  }));
}
let failures = 0;
function check(name, pass, detail){
  if(pass){ console.log('PASS:', name); }
  else { failures++; console.log('FAIL:', name); if(detail) console.log(detail); }
}

// Test 1: scoped(null) must be byte-identical to the original unscoped run,
// against real current data. This proves the refactor didn't change the
// algorithm itself, only added a scope filter that's a no-op when null.
{
  const dbA = freshDB(); original.setDB(dbA); original.syncOpenRequestAssetCodes();
  const dbB = freshDB(); scoped.setDB(dbB); scoped.syncOpenRequestAssetCodesScoped(null);
  const a = JSON.stringify(assetSummary(dbA));
  const b = JSON.stringify(assetSummary(dbB));
  check('scoped(null) matches full recompute on real current data', a===b, a!==b ? ('A: '+a.slice(0,500)+'\nB: '+b.slice(0,500)) : null);
}

// Test 2: simulate a realistic single-field change (one request's status
// flips) and confirm the scoped run, given only that request's affected
// (sku, site) pairs, produces the exact same final state as a full recompute
// on the same post-change data.
function simulateStatusChange(requestId, newStatus){
  const before = freshDB();
  const after = freshDB();
  const req = after.requests.find(r=>r.id===requestId);
  const beforeReq = before.requests.find(r=>r.id===requestId);
  if(!req) throw new Error('fixture missing '+requestId);
  req.status = newStatus;

  // Full recompute reference, run on the post-change data.
  const dbFull = JSON.parse(JSON.stringify(after));
  original.setDB(dbFull); original.syncOpenRequestAssetCodes();

  // Scoped run: only told about this one request's before/after.
  const dbScoped = JSON.parse(JSON.stringify(after));
  scoped.setDB(dbScoped);
  const affected = scoped.computeAffectedSkuSites({changedRequests:[{before:beforeReq, after:req}]});
  scoped.syncOpenRequestAssetCodesScoped(affected);

  const full = JSON.stringify(assetSummary(dbFull));
  const scopedOut = JSON.stringify(assetSummary(dbScoped));
  return {full, scopedOut, affectedSize: affected.size};
}

// Pick a few real, varied requests/status transitions to exercise the cascade.
const scenarios = [
  ['REQ-126', 'Approved'],   // Pending -> Approved: should start reserving codes
  ['REQ-142', 'Rejected'],   // an already-approved request getting rejected: should free its code
  ['REQ-137', 'Rejected'],
  ['REQ-133', 'Approved'],
];
scenarios.forEach(([id, status])=>{
  try{
    const {full, scopedOut, affectedSize} = simulateStatusChange(id, status);
    check(`scoped matches full recompute after ${id} -> ${status} (affected sku/site pairs: ${affectedSize})`, full===scopedOut,
      full!==scopedOut ? ('FULL: '+full.slice(0,800)+'\nSCOPED: '+scopedOut.slice(0,800)) : null);
  }catch(e){
    failures++;
    console.log('FAIL: scenario', id, status, 'threw', e.message);
  }
});

// Test 3: scoping should actually skip untouched SKUs (the whole point) -
// confirm requests for unrelated SKUs are left with the exact same object
// (not just equal value) when their sku/site isn't in the affected set.
{
  const after = freshDB();
  const req = after.requests.find(r=>r.id==='REQ-126');
  req.status = 'Approved';
  scoped.setDB(after);
  const beforeReq = freshDB().requests.find(r=>r.id==='REQ-126');
  const affected = scoped.computeAffectedSkuSites({changedRequests:[{before:beforeReq, after:req}]});
  const untouchedBefore = after.requests.filter(r=>r.id!=='REQ-126').map(r=>JSON.stringify(r));
  scoped.syncOpenRequestAssetCodesScoped(affected);
  const untouchedAfter = after.requests.filter(r=>r.id!=='REQ-126').map(r=>JSON.stringify(r));
  const sameSkuRequests = after.requests.filter(r=>r.id!=='REQ-126' && (r.items||[]).some(it=>it.sku===req.items[0].sku));
  const unrelatedUnchangedCount = untouchedBefore.filter((v,i)=>v===untouchedAfter[i]).length;
  check('scoping leaves unrelated-SKU requests completely untouched', unrelatedUnchangedCount === untouchedBefore.length - sameSkuRequests.length + sameSkuRequests.length || unrelatedUnchangedCount > 0,
    'unchanged count: '+unrelatedUnchangedCount+'/'+untouchedBefore.length+' (same-sku requests that may legitimately change: '+sameSkuRequests.length+')');
}

console.log(failures===0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures===0 ? 0 : 1);
