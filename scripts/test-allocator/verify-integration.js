'use strict';
/* End-to-end test of the ACTUAL code pasted into index.html (not a
   reimplementation): extracts syncOpenRequestAssetCodesScoped,
   computePendingAssetCodeScope, and syncOpenRequestAssetCodes verbatim from
   index.html, wires them up against a minimal DB/recordSnapshots/
   lastKnownSnapshot/recordChanges harness that mimics how saveDBWithRetry's
   mutate() callback actually calls this mid-action, and confirms the
   wrapper's auto-computed scope produces the same result as a full
   recompute - without the test manually constructing the affected set
   itself (verify.js and verify-synthetic.js already proved the core
   algorithm; this proves the integration glue that decides *what* to pass
   it is correct too). */
const fs = require('fs');
const path = require('path');
const original = require('./original.js');

const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const startMarker = 'function skuSiteKey';
const endMarker = 'function issuanceRecordForTag';
const extracted = html.slice(html.indexOf(startMarker), html.indexOf(endMarker));

function makeHarness(resting){
  const DB = JSON.parse(JSON.stringify(resting));
  const recordSnapshots = {
    requests: Object.fromEntries(DB.requests.map(r=>[r.id, JSON.stringify(r)])),
    returns: Object.fromEntries(DB.returns.map(r=>[r.id, JSON.stringify(r)])),
    issuance: Object.fromEntries(DB.issuance.map(r=>[r.id, JSON.stringify(r)])),
  };
  const lastKnownSnapshot = { receiving: JSON.stringify(DB.receiving), repairs: JSON.stringify(DB.repairs) };
  function recordChanges(section){
    const previous = recordSnapshots[section] || {};
    const current = {}; (DB[section]||[]).forEach(r=>{ if(r&&r.id) current[r.id]=JSON.stringify(r); });
    const ids = new Set([...Object.keys(previous), ...Object.keys(current)]);
    return [...ids].filter(id=>previous[id]!==current[id]).map(id=>({
      section, id, value: current[id]===undefined?null:current[id], expectedPrevious: previous[id]===undefined?null:previous[id]
    }));
  }
  const scope = {
    DB, recordSnapshots, lastKnownSnapshot, recordChanges, recordModeActive: true,
    socKey: v=>String(v||'').trim().toUpperCase(),
    departmentEntries: name=>{ const key=String(name||'').trim().toLowerCase(); return (DB.departments||[]).filter(d=>String(d.name||'').trim().toLowerCase()===key); },
  };
  scope.requestSoc = function(r){
    const recordedSoc = r && r.soc ? String(r.soc) : '';
    if(recordedSoc.trim()) return recordedSoc.trim();
    const matches = scope.departmentEntries(r&&r.department);
    if(matches.length===1) return matches[0].soc||'';
    if(matches.length>1){
      if(matches.some(d=>(d.soc||'')===recordedSoc)) return recordedSoc;
      const legacySoc = (DB.departmentSoc||{})[r.department]||'';
      return matches.some(d=>(d.soc||'')===legacySoc) ? legacySoc : null;
    }
    return recordedSoc;
  };
  scope.requestAssetCodesArr = function(it){
    const assetTagsArr = it=>{
      if(Array.isArray(it.assetTagging)) return it.assetTagging;
      if(typeof it.assetTagging==='string') return it.assetTagging ? it.assetTagging.split(',').map(t=>t.trim()).filter(t=>t) : [];
      return [];
    };
    return Array.isArray(it.assetCodes) ? it.assetCodes.map(t=>String(t||'').trim()).filter(Boolean) : assetTagsArr(it);
  };
  scope.approvedQtyOf = it => (it.approvedQty!=null && it.approvedQty!=='') ? Number(it.approvedQty) : Number(it.qty);
  function assetCodeValues(value){
    const seen=new Set();
    return String(value||'').split(/[,;\n]+/).map(c=>c.trim()).filter(c=>{ if(!c) return false; const k=c.toUpperCase(); if(seen.has(k)) return false; seen.add(k); return true; });
  }
  function recvAssetCodesOf(r){ if(!r) return []; const arr=Array.isArray(r.assetCodes)?r.assetCodes:[]; return assetCodeValues(arr.concat([r.assetCode||'']).join('\n')); }
  scope.assetAmsTagsForCodes = function(codes){
    const tagsByCode = new Map();
    (DB.receiving||[]).forEach(r=>{
      const receivedCodes = r.type==='Asset' ? recvAssetCodesOf(r) : [];
      const amsTags = Array.isArray(r.amsTags) ? r.amsTags : assetCodeValues(r.amsTags);
      receivedCodes.forEach((code,i)=>{ const key=code.toUpperCase(); if(amsTags[i] && !tagsByCode.has(key)) tagsByCode.set(key,amsTags[i]); });
    });
    return (codes||[]).map(code=>tagsByCode.get(String(code).toUpperCase())||'').filter(Boolean);
  };
  scope.availableAssetCodes = function(sku, soc){
    const codeInfo=new Map(), amsCodeMap=new Map(), events=[];
    const addEvent=(code,skuCode,eventSoc,date,kind,order)=>{
      const rawKey=String(code||'').trim().toUpperCase();
      const key=codeInfo.has(rawKey)?rawKey:(amsCodeMap.get(rawKey)||rawKey);
      if(!key||!codeInfo.has(key)) return;
      const info=codeInfo.get(key);
      if(skuCode && String(info.sku||'').trim().toUpperCase()!==String(skuCode).trim().toUpperCase()) return;
      if(scope.socKey(eventSoc) && scope.socKey(info.soc) && scope.socKey(eventSoc)!==scope.socKey(info.soc)) return;
      const parsed=Date.parse(date||'');
      events.push({key,time:Number.isFinite(parsed)?parsed:0,kind,order});
    };
    (DB.receiving||[]).forEach((r,idx)=>{
      if(r.type!=='Asset') return;
      const codes=recvAssetCodesOf(r);
      const amsTags=Array.isArray(r.amsTags)?r.amsTags:assetCodeValues(r.amsTags);
      codes.forEach((code,unitIdx)=>{
        const key=code.toUpperCase();
        if(codeInfo.has(key)) return;
        codeInfo.set(key,{code,sku:String(r.sku||''),soc:r.soc||'',order:idx*1000+unitIdx});
        events.push({key,time:Number.isFinite(Date.parse(r.date||''))?Date.parse(r.date):0,kind:'add',order:idx*1000+unitIdx});
        if(amsTags[unitIdx] && !amsCodeMap.has(amsTags[unitIdx].toUpperCase())) amsCodeMap.set(amsTags[unitIdx].toUpperCase(),key);
      });
    });
    (DB.issuance||[]).forEach((i,idx)=>{
      const codes=Array.isArray(i.assetCodes)&&i.assetCodes.length?i.assetCodes:assetCodeValues(i.assetTagging);
      codes.forEach((code,unitIdx)=>addEvent(code,i.sku,i.soc,i.date,'remove',1000000+idx*1000+unitIdx));
    });
    (DB.returns||[]).forEach((r,idx)=>{
      if(r.category!=='Asset'||r.condition!=='Good'||!['Received','Asset Received'].includes(r.status)) return;
      const codes=Array.isArray(r.assetCodes)&&r.assetCodes.length?r.assetCodes:assetCodeValues(r.assetTagging);
      codes.forEach((code,unitIdx)=>addEvent(code,r.sku,r.soc,r.dateReceived||r.dateReturned,'add',2000000+idx*1000+unitIdx));
    });
    (DB.repairs||[]).forEach((r,idx)=>{
      const kind=r.status==='Added to Inventory'?'add':(r.status==='Disposed'||r.status==='Backloaded'?'remove':'');
      if(!kind) return;
      addEvent(r.assetTagging,r.sku,r.soc,kind==='add'?(r.inventoryDate||r.dateReceived):(r.disposedDate||r.backloadDate),kind,3000000+idx);
    });
    events.sort((a,b)=>a.time-b.time||a.order-b.order);
    const availableAt=new Map();
    events.forEach(e=>{ if(e.kind==='add') availableAt.set(e.key,e.time); else availableAt.delete(e.key); });
    return Array.from(availableAt.keys()).map(key=>codeInfo.get(key))
      .filter(info=>String(info.sku||'').trim().toUpperCase()===String(sku||'').trim().toUpperCase() && (scope.socKey(soc)?(!scope.socKey(info.soc)||scope.socKey(info.soc)===scope.socKey(soc)):!scope.socKey(info.soc)))
      .sort((a,b)=>(availableAt.get(a.code.toUpperCase())-availableAt.get(b.code.toUpperCase()))||a.order-b.order)
      .map(info=>info.code);
  };
  const fn = new Function(...Object.keys(scope), extracted + '\nreturn {syncOpenRequestAssetCodes, syncOpenRequestAssetCodesScoped, computePendingAssetCodeScope};');
  const api = fn(...Object.values(scope));
  return {DB, api};
}

function normalizedTagging(it){
  if(Array.isArray(it.assetTagging)) return it.assetTagging;
  if(typeof it.assetTagging==='string') return it.assetTagging ? it.assetTagging.split(',').map(t=>t.trim()).filter(t=>t) : [];
  return [];
}
function summary(db){
  return db.requests.map(r=>({ id:r.id, items:(r.items||[]).filter(it=>it.type==='Asset').map(it=>({sku:it.sku, assetCodes:it.assetCodes||[], assetTagging:normalizedTagging(it)})) }));
}

let failures=0;
function check(name, pass, detail){ if(pass) console.log('PASS:', name); else { failures++; console.log('FAIL:', name); if(detail) console.log(detail); } }

function baseDB(){
  return {
    requests: [
      {id:'REQ-001', status:'Approved', soc:'SOC1', dateFiled:'2026-01-01', items:[{type:'Asset', sku:'SPX-X', qty:1, approvedQty:1, assetCodes:[], assetTagging:''}]},
      {id:'REQ-002', status:'Approved', soc:'SOC1', dateFiled:'2026-01-02', items:[{type:'Asset', sku:'SPX-X', qty:1, approvedQty:1, assetCodes:[], assetTagging:''}]},
      {id:'REQ-003', status:'Pending', soc:'SOC1', dateFiled:'2026-01-03', items:[{type:'Asset', sku:'SPX-X', qty:1, approvedQty:1, assetCodes:[], assetTagging:''}]},
      {id:'REQ-004', status:'Approved', soc:'SOC2', dateFiled:'2026-01-01', items:[{type:'Asset', sku:'SPX-Y', qty:1, approvedQty:1, assetCodes:[], assetTagging:''}]},
    ],
    receiving: [{sku:'SPX-X', soc:'SOC1', type:'Asset', date:'2025-12-01', assetCodes:['X-001'], amsTags:['AMS-X1']},
                {sku:'SPX-Y', soc:'SOC2', type:'Asset', date:'2025-12-01', assetCodes:['Y-001'], amsTags:['AMS-Y1']}],
    issuance: [], returns: [], repairs: [], departments: [], departmentSoc: {}
  };
}

// Establish a resting state (how production data always looks before a new
// action arrives), then simulate a real action: directly mutate DB.requests
// (as an approve/reject handler would), then call the PUBLIC
// syncOpenRequestAssetCodes() wrapper exactly as all 17 call sites in
// index.html do - no manual scope construction by the test at all.
{
  const resting = baseDB();
  original.setDB(resting); original.syncOpenRequestAssetCodes();

  const h = makeHarness(resting);
  // Simulate: REQ-003 (Pending, SPX-X/SOC1) gets approved, becoming a 3rd
  // competitor for the single X-001 code REQ-001 already holds.
  h.DB.requests.find(r=>r.id==='REQ-003').status = 'Approved';
  h.api.syncOpenRequestAssetCodes();

  const dbFull = JSON.parse(JSON.stringify(resting));
  dbFull.requests.find(r=>r.id==='REQ-003').status = 'Approved';
  original.setDB(dbFull); original.syncOpenRequestAssetCodes();

  check('public syncOpenRequestAssetCodes() wrapper auto-scopes correctly for a real status change',
    JSON.stringify(summary(dbFull)) === JSON.stringify(summary(h.DB)),
    'FULL: '+JSON.stringify(summary(dbFull))+'\nWRAPPER: '+JSON.stringify(summary(h.DB)));

  // REQ-004 (unrelated SPX-Y/SOC2 pool) must not have been touched at all.
  const req004Before = JSON.stringify(resting.requests.find(r=>r.id==='REQ-004'));
  const req004After = JSON.stringify(h.DB.requests.find(r=>r.id==='REQ-004'));
  check('unrelated pool (REQ-004) left completely untouched by the wrapper', req004Before===req004After);
}

// Second real action on top of the result of the first, to confirm the
// scope computation keeps working correctly across successive calls (not
// just a single isolated invocation).
{
  const resting = baseDB();
  original.setDB(resting); original.syncOpenRequestAssetCodes();
  const h = makeHarness(resting);
  h.DB.requests.find(r=>r.id==='REQ-003').status = 'Approved';
  h.api.syncOpenRequestAssetCodes();
  // Now a second action: REQ-001 gets rejected, freeing its code for REQ-002/003.
  h.DB.requests.find(r=>r.id==='REQ-001').status = 'Rejected';
  h.api.syncOpenRequestAssetCodes();

  const dbFull = JSON.parse(JSON.stringify(resting));
  dbFull.requests.find(r=>r.id==='REQ-003').status = 'Approved';
  original.setDB(dbFull); original.syncOpenRequestAssetCodes();
  dbFull.requests.find(r=>r.id==='REQ-001').status = 'Rejected';
  original.setDB(dbFull); original.syncOpenRequestAssetCodes();

  check('wrapper stays correct across two successive real actions',
    JSON.stringify(summary(dbFull)) === JSON.stringify(summary(h.DB)),
    'FULL: '+JSON.stringify(summary(dbFull))+'\nWRAPPER: '+JSON.stringify(summary(h.DB)));
}

console.log(failures===0 ? '\nALL INTEGRATION CHECKS PASSED' : `\n${failures} INTEGRATION CHECK(S) FAILED`);
process.exit(failures===0?0:1);
