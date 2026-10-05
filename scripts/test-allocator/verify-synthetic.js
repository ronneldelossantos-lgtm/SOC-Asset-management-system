'use strict';
/* Hand-built scarcity/contention scenarios the real current data doesn't
   happen to exercise: multiple simultaneously-approved requests competing
   for fewer available codes than they want, receiving/issuance/repairs
   events as the trigger (not just a request's own status), and multiple
   requests changing in the same save. Real data proved the common case;
   this proves the FIFO-priority and non-request triggers are scoped
   correctly too. */
const original = require('./original.js');
const scoped = require('./scoped.js');

function normalizedTagging(it){
  if(Array.isArray(it.assetTagging)) return it.assetTagging;
  if(typeof it.assetTagging === 'string') return it.assetTagging ? it.assetTagging.split(',').map(t=>t.trim()).filter(t=>t) : [];
  return [];
}
function summary(db){
  return db.requests.map(r=>({
    id: r.id,
    items: (r.items||[]).filter(it=>it.type==='Asset').map(it=>({sku:it.sku, assetCodes:it.assetCodes||[], assetTagging:normalizedTagging(it)}))
  }));
}
let failures = 0;
function check(name, pass, detail){
  if(pass) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name); if(detail) console.log(detail); }
}

function baseDB(){
  return {
    requests: [
      {id:'REQ-001', status:'Approved', soc:'SOC1', dateFiled:'2026-01-01', items:[{type:'Asset', sku:'SPX-X', qty:1, approvedQty:1, assetCodes:[], assetTagging:''}]},
      {id:'REQ-002', status:'Approved', soc:'SOC1', dateFiled:'2026-01-02', items:[{type:'Asset', sku:'SPX-X', qty:1, approvedQty:1, assetCodes:[], assetTagging:''}]},
      {id:'REQ-003', status:'Approved', soc:'SOC1', dateFiled:'2026-01-03', items:[{type:'Asset', sku:'SPX-X', qty:1, approvedQty:1, assetCodes:[], assetTagging:''}]},
      {id:'REQ-004', status:'Pending', soc:'SOC1', dateFiled:'2026-01-04', items:[{type:'Asset', sku:'SPX-X', qty:1, approvedQty:1, assetCodes:[], assetTagging:''}]},
      {id:'REQ-005', status:'Approved', soc:'SOC2', dateFiled:'2026-01-01', items:[{type:'Asset', sku:'SPX-Y', qty:1, approvedQty:1, assetCodes:[], assetTagging:''}]},
    ],
    receiving: [
      {sku:'SPX-X', soc:'SOC1', type:'Asset', date:'2025-12-01', assetCodes:['X-001','X-002'], amsTags:['AMS-X1','AMS-X2']},
      {sku:'SPX-Y', soc:'SOC2', type:'Asset', date:'2025-12-01', assetCodes:['Y-001'], amsTags:['AMS-Y1']},
    ],
    issuance: [], returns: [], repairs: [], departments: [], departmentSoc: {}
  };
}

/* Real production data is always already self-consistent before a new
   change arrives - every approved request's assetCodes already reflects
   the last recompute. Starting a test from a blank slate (nobody has a
   code yet) doesn't model that: an untouched item with nothing to
   "preserve" looks like a bug even when the scoping is correct. So every
   scenario first resolves a resting state with a full recompute, THEN
   applies the simulated change on top of that - matching how this would
   actually run in the live app. */
function runBoth(mutateAfter, affectedFn){
  const resting = baseDB();
  original.setDB(resting); original.syncOpenRequestAssetCodes();

  const before = JSON.parse(JSON.stringify(resting));
  const after = JSON.parse(JSON.stringify(resting));
  mutateAfter(after);

  const dbFull = JSON.parse(JSON.stringify(after));
  original.setDB(dbFull); original.syncOpenRequestAssetCodes();

  const dbScoped = JSON.parse(JSON.stringify(after));
  scoped.setDB(dbScoped);
  const affected = affectedFn(before, after);
  scoped.syncOpenRequestAssetCodesScoped(affected);

  return {full: summary(dbFull), scopedOut: summary(dbScoped), affected};
}

// Scenario 1: 2 codes available, 3 approved requests want 1 each (FIFO: 001, 002 get codes, 003 doesn't).
{
  const {full, scopedOut, affected} = runBoth(
    after=>{}, // no change simulated yet, just confirm baseline FIFO scarcity resolves identically
    ()=>null // null = full scope, since this is a baseline sanity check not a real "what changed" scenario
  );
  check('baseline scarcity (2 codes, 3 requests) resolves identically under full scope',
    JSON.stringify(full)===JSON.stringify(scopedOut),
    'FULL: '+JSON.stringify(full)+'\nSCOPED: '+JSON.stringify(scopedOut));
  const r1 = full.find(r=>r.id==='REQ-001'), r3 = full.find(r=>r.id==='REQ-003');
  check('FIFO: earliest-filed request gets a code', r1.items[0].assetCodes.length===1);
  check('FIFO: request beyond supply gets none', r3.items[0].assetCodes.length===0);
}

// Scenario 2: REQ-004 (Pending, SPX-X) gets Approved, becoming the 4th competitor
// for only 2 codes. Scoped, told only about REQ-004's change, must still
// correctly re-evaluate REQ-001/002/003 since they share the same pool and
// filing order determines who wins - this is the actual cascade case.
{
  const {full, scopedOut, affected} = runBoth(
    after=>{ after.requests.find(r=>r.id==='REQ-004').status='Approved'; },
    (before, after)=>{
      const b = before.requests.find(r=>r.id==='REQ-004'), a = after.requests.find(r=>r.id==='REQ-004');
      return scoped.computeAffectedSkuSites({changedRequests:[{before:b, after:a}]});
    }
  );
  check('new competitor (REQ-004 approved) scoped matches full across the whole contested pool',
    JSON.stringify(full)===JSON.stringify(scopedOut),
    'FULL: '+JSON.stringify(full)+'\nSCOPED: '+JSON.stringify(scopedOut)+'\naffected: '+JSON.stringify([...affected]));
}

// Scenario 3: receiving a 3rd SPX-X/SOC1 code should free REQ-003 (the one
// that lost out in scenario 1) once there's enough supply - triggered by a
// receiving change, not a request change.
{
  const {full, scopedOut, affected} = runBoth(
    after=>{ after.receiving.push({sku:'SPX-X', soc:'SOC1', type:'Asset', date:'2025-12-02', assetCodes:['X-003'], amsTags:['AMS-X3']}); },
    (before, after)=>scoped.computeAffectedSkuSites({changedReceiving:[{before:undefined, after:after.receiving[after.receiving.length-1]}]})
  );
  check('new receiving record (more supply) scoped matches full, frees the waiting request',
    JSON.stringify(full)===JSON.stringify(scopedOut),
    'FULL: '+JSON.stringify(full)+'\nSCOPED: '+JSON.stringify(scopedOut)+'\naffected: '+JSON.stringify([...affected]));
  const r3 = full.find(r=>r.id==='REQ-003');
  check('the previously-unfulfilled request now has a code once supply increased', r3.items[0].assetCodes.length===1);
}

// Scenario 4: two unrelated requests (different SKUs) change in the SAME
// save - each should only affect its own pool, proving multiple changed
// records in one save compute a correctly unioned affected set.
{
  const {full, scopedOut, affected} = runBoth(
    after=>{
      after.requests.find(r=>r.id==='REQ-004').status='Approved'; // SPX-X/SOC1
      after.requests.push({id:'REQ-006', status:'Approved', soc:'SOC2', dateFiled:'2026-01-02', items:[{type:'Asset', sku:'SPX-Y', qty:1, approvedQty:1, assetCodes:[], assetTagging:''}]}); // SPX-Y/SOC2, contends with REQ-005
    },
    (before, after)=>{
      const b4 = before.requests.find(r=>r.id==='REQ-004'), a4 = after.requests.find(r=>r.id==='REQ-004');
      const a6 = after.requests.find(r=>r.id==='REQ-006');
      return scoped.computeAffectedSkuSites({changedRequests:[{before:b4, after:a4}, {before:undefined, after:a6}]});
    }
  );
  check('two unrelated simultaneous changes (different SKU/site pools) each scope correctly',
    JSON.stringify(full)===JSON.stringify(scopedOut),
    'FULL: '+JSON.stringify(full)+'\nSCOPED: '+JSON.stringify(scopedOut)+'\naffected: '+JSON.stringify([...affected]));
}

console.log(failures===0 ? '\nALL SYNTHETIC CHECKS PASSED' : `\n${failures} SYNTHETIC CHECK(S) FAILED`);
process.exit(failures===0?0:1);
