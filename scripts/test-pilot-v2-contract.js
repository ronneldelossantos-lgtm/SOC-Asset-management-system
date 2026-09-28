'use strict';

const assert = require('node:assert/strict');
const { readSection, fetchOpenCollection, readRecord } = require('./seatalk/firestore-sections');

const calls = [];
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  calls.push({url: String(url), options});
  if (String(url).endsWith('/shared__pilot_v2__section__sku')) {
    return new Response('', {status: 404});
  }
  if (String(url).endsWith('/pilot_v2_returns/RET-1')) {
    return new Response('', {status: 404});
  }
  if (String(url).endsWith(':runQuery')) {
    return new Response(JSON.stringify([]), {status: 200});
  }
  throw new Error('Unexpected Firestore request: ' + url);
};

(async () => {
  assert.equal(await readSection('sku'), null);
  assert.equal(await readRecord('returns', 'RET-1'), null);
  assert.deepEqual(await fetchOpenCollection('requests'), []);

  assert.match(calls[0].url, /sms_erp_storage\/shared__pilot_v2__section__sku$/);
  assert.match(calls[1].url, /pilot_v2_returns\/RET-1$/);
  assert.equal(JSON.parse(calls[2].options.body).structuredQuery.from[0].collectionId, 'pilot_v2_requests');

  console.log('pilot v2 storage contract checks passed');
})().finally(() => {
  global.fetch = originalFetch;
});
