Integration harness for the REAL `window.storage` block in index.html, run against an
in-memory fake Firestore (so no quota is used) in a real browser (real IndexedDB).

    node scripts/storage-harness/build.js        # extracts the storage block -> storage-under-test.js
    (serve this folder with any static server, open run.html, read the PASS/FAIL list)

It asserts read counts: cold load = every doc, warm load = ~1 read, blob/record re-saves
read only the manifest, deletions force a full reload, own edits survive clock skew.
`storage-under-test.js` is generated; do not commit it.
