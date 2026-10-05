'use strict';
/* Verbatim extraction of index.html's asset-code allocation logic
   (requestAssetCodesArr, approvedQtyOf, availableAssetCodes,
   syncOpenRequestAssetCodes, requestSoc, and their dependencies), unmodified,
   for use as the ground-truth reference when testing a scoped/incremental
   rewrite against real data outside the browser. DB is injected via setDB()
   instead of being a module-level global, so a test can run this against
   many different snapshots in one process. */
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

function syncOpenRequestAssetCodes(){
  (DB.requests||[]).filter(r=>r.status==='Rejected').forEach(r=>(r.items||[]).forEach(it=>{
    if(it.type==='Asset' && Array.isArray(it.assetCodes)){ it.assetCodes=[]; it.assetTagging=''; }
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
    (r.items||[]).filter(it=>it.type==='Asset').forEach(it=>{it.assetCodes=[];it.assetTagging='';});
  });
  approved.forEach(({r})=>{
    (r.items||[]).forEach(it=>{
      if(it.type!=='Asset') return;
      const site=requestSoc(r);
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
      const qty = Math.max(0,Math.floor(approvedQtyOf(it)||0));
      const requestSite = requestSoc(r);
      const candidates = requestSite===null ? [] : availableAssetCodes(it.sku,requestSite||'').filter(code=>!reserved.has(code.toUpperCase()));
      const allocatedTags = candidates.slice(0,Math.max(0,qty-it.assetCodes.length));
      it.assetCodes = it.assetCodes.concat(allocatedTags);
      it.assetTagging = assetAmsTagsForCodes(it.assetCodes).join(', ');
      allocatedTags.forEach(code=>reserved.add(code.toUpperCase()));
    });
  });
}

module.exports = { setDB, syncOpenRequestAssetCodes, availableAssetCodes, requestSoc, requestAssetCodesArr, approvedQtyOf, assetAmsTagsForCodes };
