const assert = require('node:assert/strict');
const fs = require('node:fs');

/* This previously asserted the OPPOSITE of what's below - that the app must
   never use onSnapshot/subscribe/visibilitychange at all. That version was
   already failing against its own codebase before this rewrite (a
   setInterval-based poll had been added for the dashboard/cage-loading
   screens, and visibilitychange was already in use to pause it) - the
   policy it encoded and the code that shipped alongside it disagreed with
   each other. See CLAUDE.md's "Live data must use listeners, not polling"
   section for the current, explicit decision this test now enforces:
   setInterval must never be used to poll Firestore for UI auto-refresh
   (window.storage.subscribe exists for exactly that, and costs ~0 reads/hour
   for a screen nobody is touching instead of a fixed per-tick cost whether
   anything changed or not), and any such live sync must detach its listener
   when the relevant screen is no longer visible - a listener left running
   forever is exactly the kind of leak this exists to catch. */
const source = fs.readFileSync(require.resolve('../index.html'), 'utf8');

assert.doesNotMatch(source, /setInterval\(/, 'auto-refreshing UI data must use a Firestore listener (window.storage.subscribe), not a polling interval - see CLAUDE.md');
assert.match(source, /subscribe\(key, shared, onValue, onError\)/, 'window.storage must expose the generic listener helper new live-refresh features are required to use');
assert.match(source, /document\.addEventListener\('visibilitychange'/, 'listeners must be detached when the tab is hidden, not left running in the background');

console.log('listener-based (not polling) refresh contract checks passed');
