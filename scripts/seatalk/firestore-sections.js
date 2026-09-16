'use strict';

/* Reads the app's own per-section Firestore documents via plain REST — same
   collection/doc-naming scheme index.html's window.storage uses
   (sms_erp_storage / shared__section__<key>), open-read by firestore.rules,
   so no service account is needed here either. */

const PROJECT_ID = 'spx-soc-asset-management';
const COLLECTION = 'sms_erp_storage';

async function readDoc(key) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}/shared__${key}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read failed for ${key}: HTTP ${res.status}`);
  const body = await res.json();
  return JSON.parse(body.fields.value.stringValue);
}

async function readSection(sectionKey) {
  return readDoc(`section__${sectionKey}`);
}

module.exports = { readDoc, readSection };
