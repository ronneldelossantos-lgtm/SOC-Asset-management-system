'use strict';

/* Reads the app's own per-section Firestore documents via plain REST — same
   collection/doc-naming scheme index.html's window.storage uses
   (sms_erp_storage / shared__section__<key>), open-read by firestore.rules,
   so no service account is needed here either. */

const PROJECT_ID = 'spx-soc-asset-management';
const COLLECTION = 'sms_erp_storage';

async function fetchDocFields(docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}/${docId}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read failed for ${docId}: HTTP ${res.status}`);
  const body = await res.json();
  return body.fields || null;
}

/* index.html splits any value over 240KB across several `<key>__chunk__<n>`
   sub-documents once it would otherwise blow Firestore's 1MiB per-document
   limit (see index.html's splitValue/readValue) — 'requests' now does this.
   Mirror that reassembly here, or this throws the moment a section crosses
   that size ("Cannot read properties of undefined (reading 'stringValue')"
   from indexing the nonexistent `value` field on a chunk-manifest doc). */
async function readDoc(key) {
  const fields = await fetchDocFields(`shared__${key}`);
  if (!fields) return null;
  if (fields.chunked && fields.chunked.booleanValue) {
    const count = Number(fields.chunks && fields.chunks.integerValue);
    if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid Firestore chunk manifest for ${key}.`);
    const parts = await Promise.all(
      Array.from({ length: count }, (_, i) => fetchDocFields(`shared__${key}__chunk__${i}`))
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
  return readDoc(`section__${sectionKey}`);
}

module.exports = { readDoc, readSection };
