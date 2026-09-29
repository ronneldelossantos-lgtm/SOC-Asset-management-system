'use strict';

/* One-time recovery tool for a browser migration interrupted by a quota
   outage. It only reads legacy V1 documents and writes their copies to the
   isolated V2 schema; it never deletes or updates V1 documents. */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ID = 'spx-soc-asset-management';
const API_KEY = 'AIzaSyC9NknHkluFaWdqQnZWW5--HreG-w7fTZ8';
const STORAGE_COLLECTION = 'sms_erp_storage';
const STORAGE_VERSION = 'pilot_v2';
const RECORD_SECTIONS = new Set(['requests', 'returns', 'issuance']);
const SECTION_KEYS = [
  'users', 'employees', 'sku', 'departments', 'suppliers', 'warehouses',
  'sortingStations', 'handOverTo', 'accountability', 'stock', 'reorderPoint',
  'requests', 'receiving', 'issuance', 'issuanceMetrics',
  'cycleCountConsumable', 'cycleCountAsset', 'repairs', 'pmChecklists',
  'pmCounts', 'pmInspections', 'returns', 'deptIssuance', 'notifications',
  'cages', 'cageCycleCounts', 'pdas', 'pdaLogs', 'pdaAllocations',
  'pdaAllocationsBySoc', 'pdaDeptBuckets', 'departmentSoc', 'parcels',
  'counters'
];
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const migrationDocId = `shared__${STORAGE_VERSION}____migration`;
const v1DocId = key => `shared__section__${key}`;
const v2DocId = key => `shared__${STORAGE_VERSION}__section__${key}`;
const chunkKey = (key, index) => `${key}__chunk__${index}`;
const recordCollection = section => `${STORAGE_VERSION}_${section}`;

function loadDefaultDB() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = source.indexOf('function defaultDB(){');
  if (start === -1) throw new Error('defaultDB is missing from index.html.');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) {
      return new Function(`${source.slice(start, index + 1)}; return defaultDB();`)();
    }
  }
  throw new Error('defaultDB is incomplete in index.html.');
}

function url(path) {
  return `${BASE_URL}/${path}?key=${API_KEY}`;
}

function documentName(path) {
  return `projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
}

async function request(path, options = {}) {
  const response = await fetch(url(path), options);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Firestore ${options.method || 'GET'} ${path} failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function getStorageDocument(id) {
  return request(`${STORAGE_COLLECTION}/${encodeURIComponent(id)}`);
}

async function readLegacyValue(key) {
  const doc = await getStorageDocument(v1DocId(key));
  if (!doc) return null;
  const fields = doc.fields || {};
  if (!fields.chunked?.booleanValue) return fields.value?.stringValue ?? null;
  const count = Number(fields.chunks?.integerValue);
  if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid V1 chunk manifest for ${key}.`);
  const chunks = await Promise.all(Array.from({length: count}, (_, index) => getStorageDocument(chunkKey(v1DocId(key), index))));
  return chunks.map((chunk, index) => {
    const value = chunk?.fields?.value?.stringValue;
    if (typeof value !== 'string') throw new Error(`Missing V1 chunk ${index} for ${key}.`);
    return value;
  }).join('');
}

function splitValue(value) {
  if (Buffer.byteLength(value, 'utf8') <= 240 * 1024) return [value];
  const chunks = [];
  for (let start = 0; start < value.length;) {
    let low = start + 1;
    let high = Math.min(value.length, start + 240 * 1024);
    let end = start;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (Buffer.byteLength(value.slice(start, middle), 'utf8') <= 240 * 1024) {
        end = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (end === start) throw new Error('Could not split a V2 section into safe Firestore documents.');
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

function fields(value, updatedAt) {
  return {
    value: {stringValue: value},
    updatedAt: {integerValue: String(updatedAt)}
  };
}

function sectionWrites(key, value, updatedAt) {
  const chunks = splitValue(value);
  if (chunks.length === 1) {
    return [{update: {name: documentName(`${STORAGE_COLLECTION}/${v2DocId(key)}`), fields: fields(value, updatedAt)}}];
  }
  const writes = [{
    update: {
      name: documentName(`${STORAGE_COLLECTION}/${v2DocId(key)}`),
      fields: {
        chunked: {booleanValue: true},
        chunks: {integerValue: String(chunks.length)},
        updatedAt: {integerValue: String(updatedAt)}
      }
    }
  }];
  chunks.forEach((chunk, index) => {
    writes.push({update: {name: documentName(`${STORAGE_COLLECTION}/${chunkKey(v2DocId(key), index)}`), fields: fields(chunk, updatedAt)}});
  });
  return writes;
}

function recordIsArchived(section, record) {
  if (section === 'requests') return ['Rejected', 'Received'].includes(record.status);
  if (section === 'returns') return ['Received', 'Asset Received'].includes(record.status);
  return section === 'issuance' && record.deptReceived === true;
}

function recordWrites(section, record, updatedAt) {
  if (!record || !record.id) throw new Error(`Cannot migrate a ${section} record without an id.`);
  const value = JSON.stringify(record);
  const chunks = splitValue(value);
  const data = {
    status: {stringValue: String(record.status || '')},
    archived: {booleanValue: recordIsArchived(section, record)},
    updatedAt: {integerValue: String(updatedAt)}
  };
  const name = `${recordCollection(section)}/${encodeURIComponent(String(record.id))}`;
  if (chunks.length === 1) {
    return [{
      update: {
        name: documentName(name),
        fields: {...fields(value, updatedAt), ...data}
      }
    }];
  }
  const writes = [{
    update: {
      name: documentName(name),
      fields: {
        ...data,
        chunked: {booleanValue: true},
        chunks: {integerValue: String(chunks.length)}
      }
    }
  }];
  chunks.forEach((chunk, index) => {
    writes.push({
      update: {
        name: documentName(`${name}/__chunks/${index}`),
        fields: fields(chunk, updatedAt)
      }
    });
  });
  return writes;
}

async function commit(writes) {
  if (!writes.length) return;
  await request(':commit', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({writes})
  });
}

async function writeInBatches(writes) {
  const maxBytes = 7 * 1024 * 1024;
  let batch = [];
  let batchBytes = 32;
  for (const write of writes) {
    const writeBytes = Buffer.byteLength(JSON.stringify(write), 'utf8') + 1;
    if (writeBytes > maxBytes) throw new Error('A single Firestore write exceeds the migration request-size limit.');
    if (batch.length && (batch.length === 450 || batchBytes + writeBytes > maxBytes)) {
      await commit(batch);
      batch = [];
      batchBytes = 32;
    }
    batch.push(write);
    batchBytes += writeBytes;
  }
  await commit(batch);
}

async function main() {
  const startedAt = Date.now();
  const owner = `recovery_${startedAt}`;
  const defaults = loadDefaultDB();
  const legacy = {};
  for (const key of SECTION_KEYS) {
    const value = await readLegacyValue(key);
    legacy[key] = value === null ? JSON.stringify(defaults[key]) : value;
  }

  await commit([{
    update: {
      name: documentName(`${STORAGE_COLLECTION}/${migrationDocId}`),
      fields: fields(JSON.stringify({state: 'migrating', owner, startedAt}), startedAt)
    }
  }]);

  const writes = [];
  for (const key of SECTION_KEYS) {
    if (RECORD_SECTIONS.has(key)) continue;
    writes.push(...sectionWrites(key, legacy[key], startedAt));
  }
  const recordCounts = {};
  for (const section of RECORD_SECTIONS) {
    const records = JSON.parse(legacy[section]);
    if (!Array.isArray(records)) throw new Error(`V1 ${section} is not an array.`);
    recordCounts[section] = records.length;
    records.forEach(record => writes.push(...recordWrites(section, record, startedAt)));
  }
  await writeInBatches(writes);

  const completedAt = Date.now();
  await commit([{
    update: {
      name: documentName(`${STORAGE_COLLECTION}/${migrationDocId}`),
      fields: fields(JSON.stringify({
        state: 'complete',
        completedAt,
        migratedBy: 'recovery-script',
        sectionCount: SECTION_KEYS.length - RECORD_SECTIONS.size,
        recordCounts
      }), completedAt)
    }
  }]);

  console.log(JSON.stringify({
    state: 'complete',
    sectionCount: SECTION_KEYS.length - RECORD_SECTIONS.size,
    recordCounts,
    writes: writes.length
  }));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
