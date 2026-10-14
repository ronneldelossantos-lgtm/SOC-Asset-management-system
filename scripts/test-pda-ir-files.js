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

// pdaIrFiles must be a per-record section, loaded for the PDA route, so the
// attachments never go back into the pdas/pdaLogs blobs.
assert.match(source, /const RECORD_SECTION_KEYS = \[[^\]]*'pdaIrFiles'[^\]]*\]/);
assert.match(source, /itassets: \['pdaIrFiles'\]/);
assert.doesNotMatch(source, /itassets: \[[^\]]*'pdaIrFiles'[^\]]*\],\n  parcelretrieval/, 'pdaIrFiles must not be a blob section for the itassets route');

const f = new Function(`
  let DB = {pdaIrFiles: []};
  ${functionSource('pdaIrKeyPart')}
  ${functionSource('pdaIrMasterId')}
  ${functionSource('pdaIrLogId')}
  ${functionSource('pdaIrData')}
  ${functionSource('pdaIrSet')}
  ${functionSource('pdaIrClear')}
  return {DB, pdaIrMasterId, pdaIrLogId, pdaIrData, pdaIrSet, pdaIrClear};
`)();

// ids must match scripts/migrate-pda-ir-files.js and be legal Firestore doc ids (no '/')
assert.equal(f.pdaIrMasterId({soc:'SOC 5', pdaNo:'PDA/12'}), 'PDA~SOC_5~PDA_12');
assert.equal(f.pdaIrMasterId({pdaNo:'7'}), 'PDA~~7');
assert.equal(f.pdaIrLogId({id:'PL-ABC'}), 'LOG~PL-ABC');
assert.ok(!f.pdaIrMasterId({soc:'a/b', pdaNo:'c/d'}).includes('/'));

// falls back to inline data on un-migrated rows, prefers the record
assert.equal(f.pdaIrData('PDA~~1', 'inline'), 'inline');
assert.equal(f.pdaIrData('PDA~~1', ''), '');
f.pdaIrSet('PDA~~1', 'a.pdf', 'DATA1');
assert.equal(f.pdaIrData('PDA~~1', 'inline'), 'DATA1');
f.pdaIrSet('PDA~~1', 'b.pdf', 'DATA2');
assert.equal(f.DB.pdaIrFiles.length, 1);
assert.equal(f.pdaIrData('PDA~~1', ''), 'DATA2');
f.pdaIrClear('PDA~~1');
assert.equal(f.DB.pdaIrFiles.length, 0);


// the app must no longer write attachment bytes onto pdas/pdaLogs rows
assert.doesNotMatch(source, /(?:p|l|log).irFileDatas*=s*[^'s;]/);

console.log('PDA IR attachment storage checks passed');
