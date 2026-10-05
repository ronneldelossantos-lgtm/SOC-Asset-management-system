'use strict';
/* Scoped rewrite of syncOpenRequestAssetCodes: identical algorithm, but
   skips any item whose (sku, site) pair isn't in the affected set, instead
   of recomputing + re-scanning full history for every open request's every
   item on every change.

   Why this is safe: availableAssetCodes(sku, site) already filters strictly
   by sku (and site) before returning candidates, so an item for SKU A can
   never be assigned, or compete for, a code that belongs to SKU B — the
   `reserved` set spans all SKUs textually but never actually overlaps across
   SKUs in practice. That means items whose (sku, site) didn't change can be
   left completely untouched without affecting the correctness of items that
   did change, as long as every approved/active item that shares an affected
   (sku, site) is still processed together, in the same global filing-order
   pass, exactly as today.

   affectedSkuSites === null means "treat everything as affected" - this
   must produce byte-identical output to the unscoped original, and is used
   both as a safe default and as the equivalence check in tests. */
let DB = {};
function setDB(db){ DB = db; }

function assetTagsArr(it){
  if(Array.isArray(it.assetTagging)) return it.assetTagging;
  if(typeof it.assetTagging === 'string') return it.assetTagging ? it.assetTagging.split(',').map(t=>t.trim()).filter(t=>t) : [];
  return [];
}
function requestAssetCodesArr(it){
  return Array.isArray(it.assetCodes) ? it.assetCodes.map(t=>String(t||'').trim()).filter(Boolean) : assetTagsArr(it);
}
function approvedQtyOf(it){
  return (it.approvedQty!=null && it.approvedQty!=='') ? Number(it.approvedQty) : Number(it.qty);
}
function assetCodeValues(value){
  const seen = new Set();
  return String(value||'').split(/[,;\n]+/).map(code=>code.trim()).filter(code=>{
    if(!code) return false;
    const key = code.toUpperCase();
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function recvAssetCodes(value){
  const seen = new Set();
  return String(value||'').split(/[,;\n]+/).map(code=>code.trim()).filter(code=>{
    if(!code) return false;
    const key = code.toUpperCase();
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function recvAssetCodesOf(r){
  if(!r) return [];
  const arrayCodes = Array.isArray(r.assetCodes) ? r.assetCodes : [];
  return recvAssetCodes(arrayCodes.concat([r.assetCode||'']).join('\n'));
}
function assetAmsTagsForCodes(codes){
  const tagsByCode = new Map();
  (DB.receiving||[]).forEach(r=>{
    const receivedCodes = r.type==='Asset' ? recvAssetCodesOf(r) : [];
    const amsTags = Array.isArray(r.amsTags) ? r.amsTags : assetCodeValues(r.amsTags);
    receivedCodes.forEach((code,i)=>{
      const key=code.toUpperCase();
      if(amsTags[i] && !tagsByCode.has(key)) tagsByCode.set(key,amsTags[i]);
    });
  });
  return (codes||[]).map(code=>tagsByCode.get(String(code).toUpperCase())||'').filter(Boolean);
}
function socKey(value){ return String(value||'').trim().toUpperCase(); }
function departmentEntries(name){
  const key = String(name||'').trim().toLowerCase();
  return (DB.departments||[]).filter(d=>String(d.name||'').trim().toLowerCase()===key);
}
function requestSoc(r){
  const recordedSoc = r && r.soc ? String(r.soc) : '';
  if(recordedSoc.trim()) return recordedSoc.trim();
  const matches = departmentEntries(r&&r.department);
  if(matches.length===1) return matches[0].soc||'';
  if(matches.length>1){
    if(matches.some(d=>(d.soc||'')===recordedSoc)) return recordedSoc;
    const legacySoc = (DB.departmentSoc||{})[r.department]||'';
    return matches.some(d=>(d.soc||'')===legacySoc) ? legacySoc : null;
  }
  return recordedSoc;
}

function availableAssetCodes(sku, soc){
  const codeInfo = new Map();
  const amsCodeMap = new Map();
  const events = [];
  const addEvent = (code, skuCode, eventSoc, date, kind, order)=>{
    const rawKey = String(code||'').trim().toUpperCase();
    const key = codeInfo.has(rawKey) ? rawKey : (amsCodeMap.get(rawKey)||rawKey);
    if(!key || !codeInfo.has(key)) return;
    const info = codeInfo.get(key);
    if(skuCode && String(info.sku||'').trim().toUpperCase()!==String(skuCode).trim().toUpperCase()) return;
    if(socKey(eventSoc) && socKey(info.soc) && socKey(eventSoc)!==socKey(info.soc)) return;
    const parsed = Date.parse(date||'');
    events.push({key, time:Number.isFinite(parsed)?parsed:0, kind, order});
  };
  (DB.receiving||[]).forEach((r,idx)=>{
    if(r.type!=='Asset') return;
    const codes = recvAssetCodesOf(r);
    const amsTags = Array.isArray(r.amsTags) ? r.amsTags : assetCodeValues(r.amsTags);
    codes.forEach((code,unitIdx)=>{
      const key = code.toUpperCase();
      if(codeInfo.has(key)) return;
      codeInfo.set(key,{code,sku:String(r.sku||''),soc:r.soc||'',order:idx*1000+unitIdx});
      events.push({key,time:Number.isFinite(Date.parse(r.date||''))?Date.parse(r.date):0,kind:'add',order:idx*1000+unitIdx});
      if(amsTags[unitIdx] && !amsCodeMap.has(amsTags[unitIdx].toUpperCase())) amsCodeMap.set(amsTags[unitIdx].toUpperCase(),key);
    });
  });
  (DB.issuance||[]).forEach((i,idx)=>{
    const codes = Array.isArray(i.assetCodes)&&i.assetCodes.length ? i.assetCodes : assetCodeValues(i.assetTagging);
    codes.forEach((code,unitIdx)=>addEvent(code,i.sku,i.soc,i.date,'remove',1000000+idx*1000+unitIdx));
  });
  (DB.returns||[]).forEach((r,idx)=>{
    if(r.category!=='Asset' || r.condition!=='Good' || !['Received','Asset Received'].includes(r.status)) return;
    const codes = Array.isArray(r.assetCodes)&&r.assetCodes.length ? r.assetCodes : assetCodeValues(r.assetTagging);
    codes.forEach((code,unitIdx)=>addEvent(code,r.sku,r.soc,r.dateReceived||r.dateReturned,'add',2000000+idx*1000+unitIdx));
  });
  (DB.repairs||[]).forEach((r,idx)=>{
    const kind = r.status==='Added to Inventory' ? 'add' : (r.status==='Disposed'||r.status==='Backloaded' ? 'remove' : '');
    if(!kind) return;
    addEvent(r.assetTagging,r.sku,r.soc,kind==='add'?(r.inventoryDate||r.dateReceived):(r.disposedDate||r.backloadDate),kind,3000000+idx);
  });
  events.sort((a,b)=>a.time-b.time || a.order-b.order);
  const availableAt = new Map();
  events.forEach(e=>{ if(e.kind==='add') availableAt.set(e.key,e.time); else availableAt.delete(e.key); });
  return Array.from(availableAt.keys()).map(key=>codeInfo.get(key))
    .filter(info=>String(info.sku||'').trim().toUpperCase()===String(sku||'').trim().toUpperCase() && (socKey(soc) ? (!socKey(info.soc)||socKey(info.soc)===socKey(soc)) : !socKey(info.soc)))
    .sort((a,b)=>(availableAt.get(a.code.toUpperCase())-availableAt.get(b.code.toUpperCase())) || a.order-b.order)
    .map(info=>info.code);
}

function skuSiteKey(sku, site){ return String(sku||'').trim().toUpperCase()+'||'+socKey(site); }

function syncOpenRequestAssetCodesScoped(affectedSkuSites){
  const inScope = (sku, site) => affectedSkuSites===null || affectedSkuSites.has(skuSiteKey(sku, site));

  (DB.requests||[]).filter(r=>r.status==='Rejected').forEach(r=>(r.items||[]).forEach(it=>{
    if(it.type==='Asset' && Array.isArray(it.assetCodes) && inScope(it.sku, requestSoc(r))){ it.assetCodes=[]; it.assetTagging=''; }
  }));
  const active = (DB.requests||[]).map((r,index)=>({r,index}))
    .filter(x=>!['Rejected','Issued','Received'].includes(x.r.status))
    .sort((a,b)=>{
      const aId=String(a.r.id||'').match(/^REQ-(\d+)$/i), bId=String(b.r.id||'').match(/^REQ-(\d+)$/i);
      if(aId&&bId&&Number(aId[1])!==Number(bId[1])) return Number(aId[1])-Number(bId[1]);
      const at=Date.parse(a.r.dateFiled||'')||0, bt=Date.parse(b.r.dateFiled||'')||0;
      return at-bt || a.index-b.index;
    });
  const reserved = new Set();
  const approved = active.filter(({r})=>['Preparing','Ready for Pull-out','Approved'].includes(r.status));
  active.filter(({r})=>!['Preparing','Ready for Pull-out','Approved'].includes(r.status)).forEach(({r})=>{
    (r.items||[]).filter(it=>it.type==='Asset' && inScope(it.sku, requestSoc(r))).forEach(it=>{it.assetCodes=[];it.assetTagging='';});
  });
  approved.forEach(({r})=>{
    (r.items||[]).forEach(it=>{
      if(it.type!=='Asset') return;
      const site=requestSoc(r);
      if(!inScope(it.sku, site)) return;
      const available=site===null?[]:availableAssetCodes(it.sku,site||'');
      const canonical=new Map(available.map(code=>[code.toUpperCase(),code]));
      const qty=Math.max(0,Math.floor(approvedQtyOf(it)||0));
      const kept=[];
      requestAssetCodesArr(it).forEach(code=>{
        const key=code.toUpperCase();
        if(kept.length<qty && canonical.has(key) && !reserved.has(key)){
          kept.push(canonical.get(key)); reserved.add(key);
        }
      });
      it.assetCodes=kept;
    });
  });
  approved.forEach(({r})=>{
    (r.items||[]).forEach(it=>{
      if(it.type!=='Asset') return;
      const requestSite = requestSoc(r);
      if(!inScope(it.sku, requestSite)) return;
      const qty = Math.max(0,Math.floor(approvedQtyOf(it)||0));
      const candidates = requestSite===null ? [] : availableAssetCodes(it.sku,requestSite||'').filter(code=>!reserved.has(code.toUpperCase()));
      const allocatedTags = candidates.slice(0,Math.max(0,qty-it.assetCodes.length));
      it.assetCodes = it.assetCodes.concat(allocatedTags);
      it.assetTagging = assetAmsTagsForCodes(it.assetCodes).join(', ');
      allocatedTags.forEach(code=>reserved.add(code.toUpperCase()));
    });
  });
}

/* Computes which (sku, site) pairs could possibly need re-evaluation, given
   the requests/receiving/issuance/returns/repairs records that actually
   changed in this save (before/after pairs; `before` is undefined for a
   brand-new record, `after` is undefined for a deleted one). A request's own
   item list contributes its (sku, site) directly (covers status changes,
   item edits, and the request's own site). A receiving/issuance/returns/
   repairs record contributes its own (sku, site) (covers inventory events
   that change what's available for whoever is already waiting on that sku). */
function computeAffectedSkuSites({changedRequests, changedReceiving, changedIssuance, changedReturns, changedRepairs}){
  const keys = new Set();
  const addRequest = r=>{
    if(!r) return;
    const site = requestSoc(r);
    (r.items||[]).forEach(it=>{ if(it.type==='Asset') keys.add(skuSiteKey(it.sku, site)); });
  };
  const addDirect = rec=>{ if(rec) keys.add(skuSiteKey(rec.sku, rec.soc)); };
  (changedRequests||[]).forEach(({before,after})=>{ addRequest(before); addRequest(after); });
  (changedReceiving||[]).forEach(({before,after})=>{ addDirect(before); addDirect(after); });
  (changedIssuance||[]).forEach(({before,after})=>{ addDirect(before); addDirect(after); });
  (changedReturns||[]).forEach(({before,after})=>{ addDirect(before); addDirect(after); });
  (changedRepairs||[]).forEach(({before,after})=>{ addDirect(before); addDirect(after); });
  return keys;
}

module.exports = { setDB, syncOpenRequestAssetCodesScoped, computeAffectedSkuSites, skuSiteKey, requestSoc };
