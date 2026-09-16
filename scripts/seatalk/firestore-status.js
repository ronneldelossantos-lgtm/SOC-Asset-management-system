'use strict';

/* Writes a small status document to the same Firestore project/collection
   the app itself uses (sms_erp_storage), via plain REST — no service
   account needed, since firestore.rules already allows open read/write on
   that collection for the app's own client-side use. This exists purely so
   run results can be checked without needing a GitHub login to view
   Actions step logs (which are gated even on a public repo). */

const PROJECT_ID = 'spx-soc-asset-management';
const COLLECTION = 'sms_erp_storage';

async function writeStatus(key, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}/shared__${key}`;
  const body = {
    fields: {
      value: { stringValue: JSON.stringify(data) },
      updatedAt: { integerValue: String(Date.now()) },
    },
  };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Best-effort only — never let a status-reporting failure fail the run.
    console.error('writeStatus failed (non-fatal):', res.status, await res.text());
  }
}

module.exports = { writeStatus };
