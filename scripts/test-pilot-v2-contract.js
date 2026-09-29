'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
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

function functionSource(source, name) {
  const asyncStart = source.indexOf('async function '+name+'(');
  const start = asyncStart === -1 ? source.indexOf('function '+name+'(') : asyncStart;
  assert.notEqual(start, -1, name+' is missing');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for(let index = bodyStart; index < source.length; index++) {
    if(source[index] === '{') depth++;
    if(source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(name+' is incomplete');
}

const appSource = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const migrationFactory = new Function('window', 'SECTION_KEYS', 'RECORD_SECTION_KEYS', 'STORE_KEY', 'defaultDB', `
  ${functionSource(appSource, 'isRecordSection')}
  ${functionSource(appSource, 'readLegacyDatabase')}
  ${functionSource(appSource, 'ensurePilotMigration')}
  return {readLegacyDatabase, ensurePilotMigration};
`);

(async () => {
  assert.equal(await readSection('sku'), null);
  assert.equal(await readRecord('returns', 'RET-1'), null);
  assert.deepEqual(await fetchOpenCollection('requests'), []);

  assert.match(calls[0].url, /sms_erp_storage\/shared__pilot_v2__section__sku$/);
  assert.match(calls[1].url, /pilot_v2_returns\/RET-1$/);
  assert.equal(JSON.parse(calls[2].options.body).structuredQuery.from[0].collectionId, 'pilot_v2_requests');

  const copied = {};
  const legacy = {
    users: [{id: 1, username: 'admin'}],
    requests: [{id: 'REQ-101', status: 'Pending'}],
    returns: [{id: 'RET-101', status: 'Pending'}],
    issuance: [{id: 'ISS-101', deptReceived: false}],
  };
  const migration = migrationFactory({
    storage: {
      supportsRecordCollections: true,
      async getMigrationState() { return null; },
      async getLegacy(key) {
        const section = key.replace(/^section__/, '');
        return Object.hasOwn(legacy, section) ? {value: JSON.stringify(legacy[section])} : null;
      },
      async claimMigration() { return 'owner'; },
      async finishMigration(owner, sections, records) { copied.owner = owner; copied.sections = sections; copied.records = records; },
    }
  }, ['users', 'requests', 'returns', 'issuance'], ['requests', 'returns', 'issuance'], 'sms_erp_state_v1', () => ({
    users: [], requests: [], returns: [], issuance: []
  }));
  assert.equal(await migration.ensurePilotMigration(), true);
  assert.equal(copied.sections.length, 1);
  assert.equal(copied.sections[0].key, 'section__users');
  assert.deepEqual(copied.records.map(record => record.section), ['requests', 'returns', 'issuance']);
  assert.deepEqual(copied.records.map(record => record.id), ['REQ-101', 'RET-101', 'ISS-101']);

  const recovered = {};
  let staleStateReads = 0;
  const staleMigration = migrationFactory({
    storage: {
      supportsRecordCollections: true,
      async getMigrationState() {
        staleStateReads++;
        return staleStateReads === 1 ? {state: 'migrating', startedAt: 0} : null;
      },
      async getLegacy(key) {
        const section = key.replace(/^section__/, '');
        return Object.hasOwn(legacy, section) ? {value: JSON.stringify(legacy[section])} : null;
      },
      async claimMigration() { return 'owner'; },
      async finishMigration(owner, sections, records) {
        recovered.owner = owner;
        recovered.sections = sections;
        recovered.records = records;
      },
    }
  }, ['users', 'requests', 'returns', 'issuance'], ['requests', 'returns', 'issuance'], 'sms_erp_state_v1', () => ({
    users: [], requests: [], returns: [], issuance: []
  }));
  assert.equal(await staleMigration.ensurePilotMigration(), true);
  assert.equal(recovered.sections.length, 1);
  assert.equal(recovered.records.length, 3);

  console.log('pilot v2 storage contract checks passed');
})().finally(() => {
  global.fetch = originalFetch;
});
