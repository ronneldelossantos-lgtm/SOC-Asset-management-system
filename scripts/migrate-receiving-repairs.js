'use strict';
/* One-time migration: copies the existing single-blob 'receiving' and
   'repairs' sections (shared__pilot_v2__section__<key>, chunked past
   240KB) into per-record collections (pilot_v2_receiving/{id},
   pilot_v2_repairs/{id}), matching the storage shape index.html's
   RECORD_SECTION_KEYS now expects for them - the same move requests/
   returns/issuance already went through.

   Run as: node scripts/migrate-receiving-repairs.js [--dry-run]

   Non-destructive: only WRITES to the new pilot_v2_receiving/pilot_v2_repairs
   collections. The original section__receiving/section__repairs blob
   documents are left untouched as a rollback fallback - delete them
   manually later once the new collections are confirmed working in
   production, not as part of this script.

   Uses the Firestore REST API directly (no service account needed - same
   open read/write access the live app itself uses, per firestore.rules).
   Batches writes under a byte budget so this can't repeat the exact
   incident this migration exists to fix (see setMulti()'s comment in
   index.html for why a single oversized commit fails outright). */
const PROJECT_ID = 'spx-soc-asset-management';
const COLLECTION = 'sms_erp_storage';
const STORAGE_VERSION = 'pilot_v2';
const CHUNK_BYTES = 240 * 1024;
const MAX_COMMIT_BYTES = 8 * 1024 * 1024; // safe margin under Firestore's ~10MiB cap
const SECTIONS = ['receiving', 'repairs'];
const DRY_RUN = process.argv.includes('--dry-run');

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function utf8Bytes(value) { return Buffer.byteLength(value, 'utf8'); }

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

async function fetchDocFields(docId) {
  const res = await fetch(`${BASE}/${COLLECTION}/${docId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Read failed for ${docId}: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.fields || null;
}

async function readLegacySection(key) {
  const docId = `shared__${STORAGE_VERSION}__section__${key}`;
  const fields = await fetchDocFields(docId);
  if (!fields) return null;
  if (fields.chunked && fields.chunked.booleanValue) {
    const count = Number(fields.chunks && fields.chunks.integerValue);
    if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid chunk manifest for ${key}.`);
    const parts = await Promise.all(
      Array.from({ length: count }, (_, i) => fetchDocFields(`shared__${STORAGE_VERSION}__section__${key}__chunk__${i}`))
    );
    const value = parts.map((part, i) => {
      if (!part || typeof part.value?.stringValue !== 'string') throw new Error(`Incomplete chunks for ${key} (missing ${i}).`);
      return part.value.stringValue;
    }).join('');
    return JSON.parse(value);
  }
  if (typeof fields.value?.stringValue !== 'string') return null;
  return JSON.parse(fields.value.stringValue);
}

// Firestore REST field-value encoding for the small set of types this data
// actually uses (string/number/boolean - the record payload itself travels
// as one opaque JSON string, same as index.html's own record writes).
function encodeValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(Math.trunc(v)) };
  throw new Error('Unsupported field value type: ' + typeof v);
}
function encodeFields(obj) {
  const fields = {};
  Object.entries(obj).forEach(([k, v]) => { fields[k] = encodeValue(v); });
  return fields;
}

// A single Firestore REST :commit request, with every write's approximate
// byte size tracked so the caller can respect MAX_COMMIT_BYTES across many
// calls instead of blindly trusting one big batch.
async function commitWrites(writes) {
  if (DRY_RUN) return;
  const res = await fetch(`${BASE}:commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) throw new Error(`Commit failed: HTTP ${res.status} ${await res.text()}`);
}

function recordWrite(path, fields, size) {
  return { op: { update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/${path}`, fields } }, size };
}

async function migrateSection(section) {
  console.log(`\n=== ${section} ===`);
  const records = await readLegacySection(section);
  if (!records) { console.log('No legacy data found, nothing to migrate.'); return { count: 0, bytes: 0 }; }
  if (!Array.isArray(records)) throw new Error(`${section} legacy value is not an array - unexpected shape, aborting.`);

  console.log(`Read ${records.length} records from the legacy blob.`);
  const updatedAt = Date.now();
  const ops = [];
  let totalBytes = 0;

  records.forEach(record => {
    if (!record || !record.id) throw new Error(`A ${section} record is missing an id - cannot migrate safely.`);
    const value = JSON.stringify(record);
    totalBytes += utf8Bytes(value);
    const chunks = splitValue(value);
    const collection = `pilot_v2_${section}`;
    if (chunks.length === 1) {
      const fields = encodeFields({ value, status: String(record.status || ''), archived: false, updatedAt });
      ops.push(recordWrite(`${collection}/${record.id}`, fields, utf8Bytes(value)));
    } else {
      const manifestFields = encodeFields({ chunked: true, chunks: chunks.length, status: String(record.status || ''), archived: false, updatedAt });
      ops.push(recordWrite(`${collection}/${record.id}`, manifestFields, 200)); // manifest itself is tiny
      chunks.forEach((chunkValue, n) => {
        const chunkFields = encodeFields({ value: chunkValue, updatedAt });
        ops.push(recordWrite(`${collection}/${record.id}/__chunks/${n}`, chunkFields, utf8Bytes(chunkValue)));
      });
    }
  });

  console.log(`Total payload: ${totalBytes} bytes across ${records.length} records -> ${ops.length} Firestore writes.`);

  // Commit in byte-budgeted groups - the exact discipline setMulti() now
  // follows live, applied here so the migration itself can never reproduce
  // the "payload exceeds the limit" failure on a section this size.
  let offset = 0, commitCount = 0;
  while (offset < ops.length) {
    let budget = MAX_COMMIT_BYTES;
    const group = [];
    while (offset < ops.length && (group.length === 0 || ops[offset].size <= budget)) {
      group.push(ops[offset]);
      budget -= ops[offset].size;
      offset++;
    }
    commitCount++;
    console.log(`  commit ${commitCount}: ${group.length} writes, ~${MAX_COMMIT_BYTES - budget} bytes${DRY_RUN ? ' (dry run, not sent)' : ''}`);
    await commitWrites(group.map(g => g.op));
  }

  return { count: records.length, bytes: totalBytes, commits: commitCount };
}

(async () => {
  console.log(DRY_RUN ? 'DRY RUN - no writes will be sent.' : 'LIVE RUN - writing to pilot_v2_receiving / pilot_v2_repairs.');
  const results = {};
  for (const section of SECTIONS) {
    results[section] = await migrateSection(section);
  }
  console.log('\n=== Summary ===');
  console.log(JSON.stringify(results, null, 2));
})().catch(e => { console.error('MIGRATION FAILED:', e); process.exit(1); });
