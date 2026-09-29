const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../index.html'), 'utf8');

assert.doesNotMatch(source, /\.onSnapshot\(/, 'the pilot must not create Firestore snapshot listeners');
assert.doesNotMatch(source, /window\.storage\.subscribe\(/, 'the pilot must not subscribe to the meta heartbeat');
assert.doesNotMatch(source, /document\.addEventListener\('visibilitychange'/, 'returning to a tab must not trigger background reads');
assert.match(source, /function refreshCurrentRoute\(/, 'an explicit refresh path is required');

console.log('listener-free refresh contract checks passed');
