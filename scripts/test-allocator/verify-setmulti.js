'use strict';
/* Verifies the ACTUAL setMulti() code extracted from index.html against a
   mock Firestore SDK, specifically the scenario that just broke production:
   a single legacy blob section (receiving) whose own chunks alone exceed
   one commit's ~10MiB budget. Checks:
   1. No single transaction/batch commit ever exceeds the byte budget.
   2. The full value is correctly reconstructable from what actually got
      written (no data loss/corruption from the multi-commit split).
   3. Conflict detection (compare-and-swap) still works and still writes
      nothing when the expected-previous value doesn't match.
   4. A normal small save still produces exactly one commit (no regression
      for the common case).
*/
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const start = html.indexOf('async setMulti(entries, shared, recordEntries){');
const end = html.indexOf('async delete(key, shared){');
const body = html.slice(start + 'async setMulti(entries, shared, recordEntries)'.length, end).replace(/},\s*$/, '}');
const setMultiSrc = 'async function(entries, shared, recordEntries)' + body;

const CHUNK_BYTES = 240 * 1024;
const MAX_COMMIT_BYTES = 10 * 1024 * 1024; // Firestore's real limit, what we must stay under

function utf8Bytes(value){ return Buffer.byteLength(value, 'utf8'); }
function chunkKey(key, index){ return key+'__chunk__'+index; }
function splitValue(value){
  if(utf8Bytes(value) <= CHUNK_BYTES) return [value];
  const chunks = [];
  let start = 0;
  while(start < value.length){
    let low = start+1, high = Math.min(value.length, start+CHUNK_BYTES), end = start;
    while(low <= high){
      const mid = Math.floor((low+high)/2);
      if(utf8Bytes(value.slice(start, mid)) <= CHUNK_BYTES){ end = mid; low = mid+1; } else high = mid-1;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}
function recordIsArchived(){ return false; }

// Mock Firestore: a doc store + transaction/batch that record each commit's
// total write bytes so we can assert none exceed the real Firestore limit.
function makeMockFirestore(initialDocs){
  const docs = new Map(Object.entries(initialDocs || {})); // id -> data
  const commits = []; // [{bytes, ops}]
  const reads = []; // every doc id read, to prove how many reads a save costs
  function docRefObj(id){
    return {
      id,
      async get(){ reads.push(id); return { exists: docs.has(id), data: () => docs.get(id) }; },
    };
  }
  function opSize(data){
    if(data===undefined) return 0; // delete
    return utf8Bytes(JSON.stringify(data));
  }
  const fsDB = {
    async runTransaction(fn){
      const writes = [];
      const tx = {
        get: async ref => ref.get(),
        set: (ref, data) => writes.push({type:'set', id:ref.id, data}),
        delete: ref => writes.push({type:'delete', id:ref.id}),
      };
      const result = await fn(tx);
      const bytes = writes.reduce((s,w)=>s+opSize(w.data),0);
      commits.push({kind:'transaction', bytes, count:writes.length});
      writes.forEach(w=>{ if(w.type==='set') docs.set(w.id, w.data); else docs.delete(w.id); });
      return result;
    },
    batch(){
      const writes = [];
      return {
        set: (ref, data) => writes.push({type:'set', id:ref.id, data}),
        delete: ref => writes.push({type:'delete', id:ref.id}),
        async commit(){
          const bytes = writes.reduce((s,w)=>s+opSize(w.data),0);
          commits.push({kind:'batch', bytes, count:writes.length});
          writes.forEach(w=>{ if(w.type==='set') docs.set(w.id, w.data); else docs.delete(w.id); });
        },
      };
    },
  };
  return { fsDB, docs, commits, reads, docRefObj };
}

function buildSetMulti({fsDB, docRefObj}){
  const scope = {
    fsDB,
    docRef: (key) => docRefObj('main__'+key),
    recordRef: (section,id) => docRefObj('record__'+section+'__'+id),
    recordChunkRef: (section,id,n) => docRefObj('record__'+section+'__'+id+'__chunk__'+n),
    chunkKey, splitValue, utf8Bytes, recordIsArchived,
    cacheApplyOwnSave: ()=>{},
  };
  const fn = new Function(...Object.keys(scope), 'shared', `return (${setMultiSrc});`);
  return fn(...Object.values(scope));
}

let failures = 0;
function check(name, pass, detail){ if(pass) console.log('PASS:', name); else { failures++; console.log('FAIL:', name); if(detail) console.log(detail); } }

// Scenario 1: a single legacy blob section ~11.5MB (matches the real
// 'receiving' section that broke production) being saved for the first time
// against an EMPTY store (simulates: add one more entry to push it over).
(async () => {
  const bigValue = JSON.stringify(Array.from({length: 48}, (_,i)=>({id:'RCV-'+i, blob:'x'.repeat(230*1024)})));
  console.log('Simulated receiving blob size:', utf8Bytes(bigValue), 'bytes');

  const mock = makeMockFirestore({});
  const setMulti = buildSetMulti(mock);
  const result = await setMulti([{key:'section__receiving', value:bigValue, expectedPrevious:null}], true, []);

  check('oversized single-entry save succeeds (no conflict, no throw)', result && result.ok===true, JSON.stringify(result));
  const overLimitCommits = mock.commits.filter(c=>c.bytes>MAX_COMMIT_BYTES);
  check('no single transaction/batch commit exceeds the real 10MiB Firestore limit',
    overLimitCommits.length===0, JSON.stringify(mock.commits.map(c=>({kind:c.kind,bytes:c.bytes}))));
  check('used more than one commit (proves the split actually happened)', mock.commits.length>1, JSON.stringify(mock.commits.map(c=>c.bytes)));

  // Reconstruct the written value from the mock store and confirm it matches exactly.
  const manifest = mock.docs.get('main__section__receiving');
  check('manifest marks the doc as chunked with the right chunk count', manifest && manifest.chunked===true);
  const chunkCount = manifest.chunks;
  const reconstructed = Array.from({length: chunkCount}, (_,n)=>mock.docs.get('main__section__receiving__chunk__'+n).value).join('');
  check('reconstructed value exactly matches the original (no data loss across the split)', reconstructed===bigValue);
})();

// Scenario 2: conflict detection must still work - saving against a stale
// expectedPrevious must write NOTHING and report a conflict.
(async () => {
  const existingValue = JSON.stringify({a:1});
  const mock = makeMockFirestore({'main__section__sku': existingValue});
  const setMulti = buildSetMulti(mock);
  const result = await setMulti([{key:'section__sku', value:JSON.stringify({a:2}), expectedPrevious:JSON.stringify({a:999})}], true, []);
  check('stale expectedPrevious is reported as a conflict, not silently written', result && result.conflict===true, JSON.stringify(result));
  check('nothing was committed on conflict', mock.commits.length===0 || mock.commits.every(c=>c.count===0), JSON.stringify(mock.commits));
  check('the existing value was not overwritten', mock.docs.get('main__section__sku')===existingValue);
})();

// Scenario 3: a normal small save (the overwhelmingly common case) must
// still produce exactly ONE commit - no regression from this rewrite.
(async () => {
  const mock = makeMockFirestore({});
  const setMulti = buildSetMulti(mock);
  const result = await setMulti([{key:'section__counters', value:JSON.stringify({n:1}), expectedPrevious:null}], true, [{section:'requests', id:'REQ-1', value:JSON.stringify({id:'REQ-1', status:'Pending'}), expectedPrevious:null}]);
  check('small save succeeds', result && result.ok===true);
  check('small save uses exactly one commit', mock.commits.length===1, JSON.stringify(mock.commits));
})();

// Scenario 4: signature-based compare-and-swap. A re-save of a chunked blob
// must cost ONE read (the manifest), not 1+chunks; legacy manifests without a
// signature must still be verified by reading chunks; conflicts must still be
// caught and report the true current value; shrinking must delete stale chunks.
(async () => {
  const v1 = JSON.stringify(Array.from({length: 6}, (_,i)=>({id:'E-'+i, blob:'y'.repeat(120*1024)})));
  const mock = makeMockFirestore({});
  const setMulti = buildSetMulti(mock);
  await setMulti([{key:'section__employees', value:v1, expectedPrevious:null}], true, []);
  const m1 = mock.docs.get('main__section__employees');
  check('chunked manifest carries a content signature', m1 && m1.chunked===true && typeof m1.sig==='string', JSON.stringify(m1));
  const chunkCount = m1.chunks;
  check('value is chunked into several docs', chunkCount>=3, 'chunks='+chunkCount);

  const v2 = v1.replace('E-0', 'E-X');
  mock.reads.length = 0;
  const r2 = await setMulti([{key:'section__employees', value:v2, expectedPrevious:v1}], true, []);
  check('re-save with matching expectedPrevious succeeds', r2 && r2.ok===true, JSON.stringify(r2));
  check('re-save reads ONLY the manifest, not the old chunks (was 1+chunks reads)', mock.reads.length===1, JSON.stringify(mock.reads));

  // stale expectedPrevious against a signed manifest -> conflict with the true current value
  mock.reads.length = 0;
  const r3 = await setMulti([{key:'section__employees', value:v1+' ', expectedPrevious:v1}], true, []);
  check('stale expectedPrevious on a signed chunked doc is a conflict', r3 && r3.conflict===true, JSON.stringify(r3&&{conflict:r3.conflict}));
  check('conflict reports the exact current value', r3 && r3.conflicts && r3.conflicts['section__employees']===v2);

  // legacy chunked doc without sig: must fall back to reading chunks and still verify correctly
  const legacy = makeMockFirestore({});
  const lm = buildSetMulti(legacy);
  const parts = splitValue(v1);
  legacy.docs.set('main__section__employees', {chunked:true, chunks:parts.length, updatedAt:1});
  parts.forEach((p,n)=>legacy.docs.set('main__section__employees__chunk__'+n, {value:p, updatedAt:1}));
  const r4 = await lm([{key:'section__employees', value:v2, expectedPrevious:v1}], true, []);
  check('legacy (unsigned) chunked doc is still verified and saved', r4 && r4.ok===true, JSON.stringify(r4));
  check('legacy path reads the chunks to verify', legacy.reads.length===1+parts.length, 'reads='+legacy.reads.length);
  const r5 = await lm([{key:'section__employees', value:v1, expectedPrevious:v1}], true, []);
  check('legacy doc with a stale expectedPrevious is a conflict', r5 && r5.conflict===true);

  // shrinking a chunked blob deletes the now-unused chunk docs
  const small = JSON.stringify({tiny:true});
  const r6 = await setMulti([{key:'section__employees', value:small, expectedPrevious:v2}], true, []);
  check('shrink save succeeds', r6 && r6.ok===true, JSON.stringify(r6));
  check('stale chunk docs were deleted on shrink', ![...mock.docs.keys()].some(k=>k.includes('__chunk__')), [...mock.docs.keys()].join(','));
  check('shrunk value stored inline', mock.docs.get('main__section__employees').value===small);

  // record chunked with sig
  const big = JSON.stringify({id:'R-1', status:'Pending', blob:'z'.repeat(700*1024)});
  const rm = makeMockFirestore({});
  const rs = buildSetMulti(rm);
  await rs([], true, [{section:'receiving', id:'R-1', value:big, expectedPrevious:null}]);
  rm.reads.length = 0;
  const big2 = big.replace('Pending','Done');
  const rr = await rs([], true, [{section:'receiving', id:'R-1', value:big2, expectedPrevious:big}]);
  check('chunked record re-save succeeds', rr && rr.ok===true, JSON.stringify(rr));
  check('chunked record re-save reads only its manifest', rm.reads.length===1, JSON.stringify(rm.reads));
})();

setTimeout(() => {
  console.log(failures===0 ? '\nALL setMulti CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures===0?0:1);
}, 500);
