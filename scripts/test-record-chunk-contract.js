'use strict';

const assert = require('node:assert/strict');
const { readRecord } = require('./seatalk/firestore-sections');

const originalFetch = global.fetch;
global.fetch = async url => {
  const value = String(url);
  if (value.endsWith('/pilot_v2_requests/REQ-large')) {
    return new Response(JSON.stringify({
      name: 'projects/spx-soc-asset-management/databases/(default)/documents/pilot_v2_requests/REQ-large',
      fields: {
        chunked: {booleanValue: true},
        chunks: {integerValue: '2'}
      }
    }), {status: 200});
  }
  if (value.endsWith('/pilot_v2_requests/REQ-large/__chunks/0')) {
    return new Response(JSON.stringify({fields: {value: {stringValue: '{"id":"REQ-large","status":"Pending","note":"'}}}), {status: 200});
  }
  if (value.endsWith('/pilot_v2_requests/REQ-large/__chunks/1')) {
    return new Response(JSON.stringify({fields: {value: {stringValue: 'preserved"}'}}}), {status: 200});
  }
  throw new Error('Unexpected Firestore request: ' + value);
};

(async () => {
  assert.deepEqual(await readRecord('requests', 'REQ-large'), {
    id: 'REQ-large',
    status: 'Pending',
    note: 'preserved'
  });
  console.log('record chunk contract checks passed');
})().finally(() => {
  global.fetch = originalFetch;
});
