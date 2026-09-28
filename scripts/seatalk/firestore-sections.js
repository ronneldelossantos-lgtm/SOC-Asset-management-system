'use strict';

/* Reads the app's own per-section Firestore documents via plain REST — same
   collection/doc-naming scheme index.html's window.storage uses
   (sms_erp_storage / shared__section__<key>), open-read by firestore.rules,
   so no service account is needed here either. */

const PROJECT_ID = 'spx-soc-asset-management';
const COLLECTION = 'sms_erp_storage';
const STORAGE_VERSION = 'pilot_v2';
const RECORD_SECTIONS = new Set(['requests', 'returns', 'issuance']);
const sectionDocId = key => `shared__${STORAGE_VERSION}__${key}`;
const recordCollection = section => `${STORAGE_VERSION}_${section}`;

async function fetchDocFields(docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}/${docId}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read failed for ${docId}: HTTP ${res.status}`);
  const body = await res.json();
  return body.fields || null;
}

function recordFromDocument(document, section) {
  const value = document && document.fields && document.fields.value && document.fields.value.stringValue;
  if (typeof value !== 'string') throw new Error(`Invalid ${section} record document.`);
  return JSON.parse(value);
}

async function fetchCollection(section) {
  const records = [];
  let pageToken = '';
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${recordCollection(section)}`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firestore collection read failed for ${section}: HTTP ${res.status}`);
    const body = await res.json();
    (body.documents || []).forEach(document => records.push(recordFromDocument(document, section)));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return records;
}

async function fetchOpenCollection(section) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      structuredQuery: {
        from: [{collectionId: recordCollection(section)}],
        where: {
          fieldFilter: {
            field: {fieldPath: 'archived'},
            op: 'EQUAL',
            value: {booleanValue: false}
          }
        }
      }
    })
  });
  if (!res.ok) throw new Error(`Firestore open-record query failed for ${section}: HTTP ${res.status}`);
  const rows = await res.json();
  return rows.filter(row => row.document).map(row => recordFromDocument(row.document, section));
}

async function readRecord(section, id) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${recordCollection(section)}/${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore record read failed for ${section}/${id}: HTTP ${res.status}`);
  return recordFromDocument(await res.json(), section);
}

/* index.html splits any value over 240KB across several `<key>__chunk__<n>`
   sub-documents once it would otherwise blow Firestore's 1MiB per-document
   limit (see index.html's splitValue/readValue) — 'requests' now does this.
   Mirror that reassembly here, or this throws the moment a section crosses
   that size ("Cannot read properties of undefined (reading 'stringValue')"
   from indexing the nonexistent `value` field on a chunk-manifest doc). */
async function readDoc(key) {
  const fields = await fetchDocFields(sectionDocId(key));
  if (!fields) return null;
  if (fields.chunked && fields.chunked.booleanValue) {
    const count = Number(fields.chunks && fields.chunks.integerValue);
    if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid Firestore chunk manifest for ${key}.`);
    const parts = await Promise.all(
      Array.from({ length: count }, (_, i) => fetchDocFields(sectionDocId(`${key}__chunk__${i}`)))
    );
    const value = parts.map((part, i) => {
      if (!part || typeof part.value?.stringValue !== 'string') {
        throw new Error(`Incomplete Firestore chunks for ${key} (missing chunk ${i}).`);
      }
      return part.value.stringValue;
    }).join('');
    return JSON.parse(value);
  }
  if (typeof fields.value?.stringValue !== 'string') return null;
  return JSON.parse(fields.value.stringValue);
}

async function readSection(sectionKey) {
  if (RECORD_SECTIONS.has(sectionKey)) return fetchCollection(sectionKey);
  return readDoc(`section__${sectionKey}`);
}

module.exports = { readDoc, readSection, fetchOpenCollection, readRecord };
