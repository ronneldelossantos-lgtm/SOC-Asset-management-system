const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../index.html'), 'utf8');

assert.doesNotMatch(source, /\.onSnapshot\(/, 'the pilot must not create Firestore snapshot listeners');
assert.doesNotMatch(source, /window\.storage\.subscribe\(/, 'the pilot must not subscribe to the meta heartbeat');
assert.match(source, /function refreshFocusedData\(/, 'focused refresh is required for returning to a tab');

console.log('listener-free refresh contract checks passed');
