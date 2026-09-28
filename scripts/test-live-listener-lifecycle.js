const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../index.html'), 'utf8');

function functionSource(name) {
  const start = source.indexOf('function '+name+'(');
  assert.notEqual(start, -1, name+' is missing');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for(let index = bodyStart; index < source.length; index++) {
    if(source[index] === '{') depth++;
    if(source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(name+' is incomplete');
}

const lifecycleFactory = new Function('document', 'window', 'console', `
  let opsIdSheetUnsubscribe = null;
  let opsIdSheetListenerGeneration = 0;
  let opsIdSheetQueue = Promise.resolve();
  let metaUnsubscribe = null;
  let metaListenerGeneration = 0;
  let session = null;
  let metaUpdates = 0;
  let opsUpdates = 0;
  function setOpsIdSheetSyncStatus(){}
  async function applyOpsIdSheetSnapshot(){ opsUpdates++; }
  async function onMetaUpdate(){ metaUpdates++; }
  ${functionSource('startOpsIdSheetSync')}
  ${functionSource('stopOpsIdSheetSync')}
  ${functionSource('startAutoRefresh')}
  ${functionSource('stopAutoRefresh')}
  ${functionSource('syncLiveListenersForVisibility')}
  return {
    setSession(value){ session = value; },
    startAutoRefresh,
    syncLiveListenersForVisibility,
    state(){ return {metaUpdates, opsUpdates}; }
  };
`);

const subscriptions = [];
const document = {hidden:false};
const window = {
  storage: {
    subscribe(key, shared, onValue) {
      const subscription = {key, shared, onValue, stopped:false};
      subscriptions.push(subscription);
      return () => { subscription.stopped = true; };
    }
  }
};
const lifecycle = lifecycleFactory(document, window, {debug(){}, error(){}});

lifecycle.setSession({id:'admin'});
lifecycle.syncLiveListenersForVisibility();
assert.deepEqual(subscriptions.map(s=>s.key), ['opsid_sheet_sync', '__meta']);
lifecycle.startAutoRefresh();
lifecycle.syncLiveListenersForVisibility();
assert.equal(subscriptions.length, 2, 'duplicate starts must not attach duplicate listeners');

document.hidden = true;
lifecycle.syncLiveListenersForVisibility();
assert.ok(subscriptions.every(s=>s.stopped), 'hidden tabs must detach both listeners');
subscriptions.forEach(s=>s.onValue({value:'{}'}));

setImmediate(() => {
  assert.deepEqual(lifecycle.state(), {metaUpdates:0, opsUpdates:0}, 'detached listeners must ignore stale callbacks');
  document.hidden = false;
  lifecycle.syncLiveListenersForVisibility();
  assert.deepEqual(subscriptions.slice(2).map(s=>s.key), ['opsid_sheet_sync', '__meta']);
  console.log('live listener lifecycle checks passed');
});
