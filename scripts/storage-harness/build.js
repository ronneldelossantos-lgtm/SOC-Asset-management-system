const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(require('path').join(__dirname, '../../index.html'), 'utf8').replace(/\r\n/g, '\n');
const out = __dirname;

// 1. the top-level cache helpers + recordIsArchived
const topStart = html.indexOf('const RECORD_DELTA_SKEW_MS');
const topEnd = html.indexOf('if(!window.storage){\n  const firebaseConfig');
const helpers = html.slice(topStart, topEnd);
function fn(name) {
  const start = html.indexOf('function ' + name + '(');
  let depth = 0; const bs = html.indexOf('{', start);
  for (let i = bs; i < html.length; i++) { if (html[i] === '{') depth++; if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1); }
}
// 2. the storage block
const blockStart = topEnd;
const blockEnd = html.indexOf('/* Last-resort fallback');
const block = html.slice(blockStart, blockEnd);

fs.writeFileSync(path.join(out, 'storage-under-test.js'),
  `// generated from index.html\n${helpers}\n${fn('recordIsArchived')}\n${block}\n`);
console.log('built', block.length, 'bytes of storage block');
