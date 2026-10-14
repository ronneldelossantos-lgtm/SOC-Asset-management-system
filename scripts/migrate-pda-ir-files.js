'use strict';
/* One-time migration: moves the base64 Incident Report attachments
   (irFileData) off the 'pdas' and 'pdaLogs' blob sections into their own
   per-record collection (pilot_v2_pdaIrFiles/{id}), which is what
   index.html's RECORD_SECTION_KEYS ('pdaIrFiles') now expects.

   Why: those two blobs held ~4.2MB, ~1.6MB of it four attachments. A blob is
   rewritten whole on every save, so each PDA issue/return rewrote ~20
   Firestore docs. Without the attachments the blobs are ~1MB (~7 writes).

   Run as, in order (each step is separate on purpose):
     node scripts/migrate-pda-ir-files.js                   dry run: reads only, prints the plan
     node scripts/migrate-pda-ir-files.js --apply-records   step 1: writes pilot_v2_pdaIrFiles, then
                                                            reads every record back and compares
     node scripts/migrate-pda-ir-files.js --strip           step 2: rewrites the pdas/pdaLogs blobs
                                                            with irFileData cleared (one atomic commit
                                                            per section, guarded by the manifest's
                                                            updateTime so a concurrent app save aborts it)
   Both write steps first save the untouched blobs to a local backup file
   (pda-ir-backup-<timestamp>.json - contains the attachments, do not commit it).
   --strip refuses to run unless every attachment is already present and
   identical in pdaIrFiles.

   Uses the Firestore REST API directly (no service account - same open
   access firestore.rules gives the app). */
const fs = require('node:fs');

const PROJECT_ID = 'spx-soc-asset-management';
const COLLECTION = 'sms_erp_storage';
const STORAGE_VERSION = 'pilot_v2';
const IR_COLLECTION = `${STORAGE_VERSION}_pdaIrFiles`;
const CHUNK_BYTES = 240 * 1024;
const MAX_COMMIT_BYTES = 8 * 1024 * 1024;
const APPLY_RECORDS = process.argv.includes('--apply-records');
const STRIP = process.argv.includes('--strip');

const DOCS = `projects/${PROJECT_ID}/databases/(default)/documents`;
const BASE = `https://firestore.googleapis.com/v1/${DOCS}`;

const utf8Bytes = value => Buffer.byteLength(value, 'utf8');

/* Must match index.html's pdaIrKeyPart / pdaIrMasterId / pdaIrLogId. */
const keyPart = v => String(v == null ? '' : v).replace(/[\/\s]+/g, '_');
const masterId = p => 'PDA~' + keyPart(p.soc) + '~' + keyPart(p.pdaNo);
const logId = l => 'LOG~' + keyPart(l.id);

function splitValue(value) {
  if (utf8Bytes(value) <= CHUNK_BYTES) return [value];
  const chunks = [];
  let start = 0;
  while (start < value.length) {
    let low = start + 1, high = Math.min(value.length, start + CHUNK_BYTES), end = start;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (utf8Bytes(value.slice(start, mid)) <= CHUNK_BYTES) { end = mid; low = mid + 1; } else high = mid - 1;
    }
    if (end === start) throw new Error('Could not split a value into safe chunk sizes.');
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

function encodeValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(Math.trunc(v)) };
  throw new Error('Unsupported field value type: ' + typeof v);
}
const encodeFields = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encodeValue(v)]));
const seg = path => path.split('/').map(encodeURIComponent).join('/');

async function getDoc(path) {
  const res = await fetch(`${BASE}/${seg(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Read failed for ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function readBlobSection(key) {
  const id = `shared__${STORAGE_VERSION}__section__${key}`;
  const doc = await getDoc(`${COLLECTION}/${id}`);
  if (!doc || !doc.fields) throw new Error(`Section ${key} not found.`);
  const f = doc.fields;
  let chunkCount = 0, text;
  if (f.chunked && f.chunked.booleanValue) {
    chunkCount = Number(f.chunks.integerValue);
    const parts = await Promise.all(Array.from({ length: chunkCount }, (_, i) => getDoc(`${COLLECTION}/${id}__chunk__${i}`)));
    text = parts.map((part, i) => {
      if (!part || !part.fields || typeof part.fields.value?.stringValue !== 'string') throw new Error(`Incomplete chunks for ${key} (missing ${i}).`);
      return part.fields.value.stringValue;
    }).join('');
  } else {
    text = f.value.stringValue;
  }
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error(`${key} is not an array - unexpected shape.`);
  return { id, rows, text, chunkCount, updateTime: doc.updateTime };
}

async function readIrRecord(id) {
  const doc = await getDoc(`${IR_COLLECTION}/${id}`);
  if (!doc) return null;
  const f = doc.fields;
  if (f.chunked && f.chunked.booleanValue) {
    const n = Number(f.chunks.integerValue);
    const parts = await Promise.all(Array.from({ length: n }, (_, i) => getDoc(`${IR_COLLECTION}/${id}/__chunks/${i}`)));
    return JSON.parse(parts.map((p, i) => {
      if (!p) throw new Error(`Missing chunk ${i} for ${id}`);
      return p.fields.value.stringValue;
    }).join(''));
  }
  return JSON.parse(f.value.stringValue);
}

async function commit(writes) {
  const res = await fetch(`${BASE}:commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) throw new Error(`Commit failed: HTTP ${res.status} ${await res.text()}`);
}

const docName = path => `${DOCS}/${path}`;

function collectAttachments(pdas, logs) {
  const out = [];
  pdas.forEach(p => { if (p.irFileData) out.push({ id: masterId(p), irFile: p.irFile || '', irFileData: p.irFileData }); });
  logs.forEach(l => { if (l.irFileData) out.push({ id: logId(l), irFile: l.irFile || '', irFileData: l.irFileData }); });
  const seen = new Set();
  out.forEach(r => { if (seen.has(r.id)) throw new Error(`Duplicate attachment id ${r.id} - two rows map to the same key, aborting.`); seen.add(r.id); });
  return out;
}

function recordWrites(rec, updatedAt) {
  const value = JSON.stringify(rec);
  const chunks = splitValue(value);
  const path = `${IR_COLLECTION}/${rec.id}`;
  if (chunks.length === 1) {
    return [{ w: { update: { name: docName(path), fields: encodeFields({ value, status: '', archived: false, updatedAt }) } }, size: utf8Bytes(value) }];
  }
  return [
    { w: { update: { name: docName(path), fields: encodeFields({ chunked: true, chunks: chunks.length, status: '', archived: false, updatedAt }) } }, size: 200 },
    ...chunks.map((c, n) => ({ w: { update: { name: docName(`${path}/__chunks/${n}`), fields: encodeFields({ value: c, updatedAt }) } }, size: utf8Bytes(c) })),
  ];
}

async function commitByBudget(ops, label) {
  let offset = 0, n = 0;
  while (offset < ops.length) {
    let budget = MAX_COMMIT_BYTES;
    const group = [];
    while (offset < ops.length && (group.length === 0 || ops[offset].size <= budget)) { group.push(ops[offset]); budget -= ops[offset].size; offset++; }
    n++;
    console.log(`  ${label} commit ${n}: ${group.length} writes, ~${MAX_COMMIT_BYTES - budget} bytes`);
    await commit(group.map(g => g.w));
  }
}

function saveBackup(pdas, logs) {
  const file = `pda-ir-backup-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), pdas: pdas.rows, pdaLogs: logs.rows }));
  console.log(`Backup of the untouched blobs written to ${file} (contains attachments - do not commit).`);
}

async function verifyRecords(atts) {
  let bad = 0;
  for (const a of atts) {
    const got = await readIrRecord(a.id);
    if (!got || got.id !== a.id || got.irFile !== a.irFile || got.irFileData !== a.irFileData) { bad++; console.log(`  MISMATCH ${a.id}`); }
  }
  return bad;
}

function blobWrites(key, section, newRows) {
  const text = JSON.stringify(newRows);
  const chunks = splitValue(text);
  const updatedAt = Date.now();
  const manifestPath = `${COLLECTION}/${section.id}`;
  const writes = [];
  const precondition = { updateTime: section.updateTime };
  if (chunks.length === 1) {
    writes.push({ w: { update: { name: docName(manifestPath), fields: encodeFields({ value: text, updatedAt }) }, currentDocument: precondition }, size: utf8Bytes(text) });
  } else {
    chunks.forEach((c, n) => writes.push({ w: { update: { name: docName(`${manifestPath}__chunk__${n}`), fields: encodeFields({ value: c, updatedAt }) } }, size: utf8Bytes(c) }));
    writes.push({ w: { update: { name: docName(manifestPath), fields: encodeFields({ chunked: true, chunks: chunks.length, updatedAt }) }, currentDocument: precondition }, size: 200 });
  }
  for (let n = chunks.length > 1 ? chunks.length : 0; n < section.chunkCount; n++) {
    writes.push({ w: { delete: docName(`${manifestPath}__chunk__${n}`) }, size: 100 });
  }
  return { writes, newChunks: chunks.length, bytes: utf8Bytes(text) };
}

const stripRows = rows => rows.map(r => (r.irFileData ? { ...r, irFileData: '' } : r));

(async () => {
  console.log(STRIP ? 'STEP 2: strip attachments from blobs' : APPLY_RECORDS ? 'STEP 1: write pdaIrFiles records' : 'DRY RUN - reads only.');
  const pdas = await readBlobSection('pdas');
  const logs = await readBlobSection('pdaLogs');
  console.log(`pdas: ${pdas.rows.length} rows, ${utf8Bytes(pdas.text)} bytes, ${pdas.chunkCount} chunks`);
  console.log(`pdaLogs: ${logs.rows.length} rows, ${utf8Bytes(logs.text)} bytes, ${logs.chunkCount} chunks`);
  const atts = collectAttachments(pdas.rows, logs.rows);
  console.log(`Attachments inline on rows: ${atts.length}`);
  const strippedPdas = blobWrites('pdas', pdas, stripRows(pdas.rows));
  const strippedLogs = blobWrites('pdaLogs', logs, stripRows(logs.rows));
  console.log(`After strip: pdas ${strippedPdas.bytes} bytes (${strippedPdas.newChunks} chunks), pdaLogs ${strippedLogs.bytes} bytes (${strippedLogs.newChunks} chunks)`);

  if (!APPLY_RECORDS && !STRIP) { console.log('Dry run complete, nothing written.'); return; }

  if (APPLY_RECORDS) {
    if (!atts.length) { console.log('Nothing to write (no inline attachments). Re-run --strip only if records already exist.'); return; }
    saveBackup(pdas, logs);
    const updatedAt = Date.now();
    const ops = atts.flatMap(a => recordWrites(a, updatedAt));
    console.log(`Writing ${atts.length} attachment records (${ops.length} Firestore writes).`);
    await commitByBudget(ops, 'records');
    const bad = await verifyRecords(atts);
    if (bad) throw new Error(`${bad} record(s) did not read back identical - do NOT run --strip.`);
    console.log(`Verified: all ${atts.length} records read back identical. Safe to run --strip next.`);
    return;
  }

  // --strip
  if (!atts.length) { console.log('Blobs already have no inline attachments, nothing to strip.'); return; }
  const bad = await verifyRecords(atts);
  if (bad) throw new Error(`${bad} attachment(s) missing/different in ${IR_COLLECTION} - refusing to strip. Run --apply-records first.`);
  console.log(`All ${atts.length} attachments confirmed present in ${IR_COLLECTION}.`);
  saveBackup(pdas, logs);
  await commit(strippedPdas.writes.map(o => o.w));
  console.log('pdas blob rewritten.');
  await commit(strippedLogs.writes.map(o => o.w));
  console.log('pdaLogs blob rewritten.');
  const checkPdas = await readBlobSection('pdas');
  const checkLogs = await readBlobSection('pdaLogs');
  const expectPdas = JSON.stringify(stripRows(pdas.rows)), expectLogs = JSON.stringify(stripRows(logs.rows));
  if (JSON.stringify(checkPdas.rows) !== expectPdas || JSON.stringify(checkLogs.rows) !== expectLogs) throw new Error('Post-strip read-back differs from expected - restore from the backup file.');
  console.log(`Verified read-back. pdas now ${checkPdas.chunkCount} chunks, pdaLogs ${checkLogs.chunkCount} chunks.`);
})().catch(e => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
