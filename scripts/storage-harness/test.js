(async () => {
  const out = []; let fails = 0;
  const ok = (n, c, d) => { out.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (d || ''))); if (!c) fails++; };
  const F = window.__fake, S = window.storage;
  await new Promise(r => { const q = indexedDB.deleteDatabase('spx_record_cache__pilot_v2'); q.onsuccess = q.onerror = q.onblocked = r; });
  const rec = (id, status, pad = 10, extra = {}) => ({ id, status, pad: 'p'.repeat(pad), ...extra });
  const entry = (section, r, prev = null) => ({ section, id: r.id, value: JSON.stringify(r), expectedPrevious: prev });
  const ageAll = () => { F.data.forEach(d => { if (d.updatedAt) d.updatedAt = Date.now() - 3600e3; }); };

  // --- T1: save 30 small + 1 chunked record
  const recs = Array.from({ length: 30 }, (_, i) => rec('R' + i, i % 5 === 0 ? 'Closed' : 'Open'));
  const big = rec('BIG', 'Open', 700 * 1024);
  const res = await S.setMulti([], true, [...recs, big].map(r => entry('issuance', r)));
  ok('save ok', res && res.ok === true, JSON.stringify(res));
  ok('chunked record manifest has sig', typeof F.data.get('pilot_v2_issuance/BIG').sig === 'string');
  const total = 31;

  // --- T2: cold load
  F.reset();
  let rows = await S.getRecords('issuance', true);
  ok('cold load returns all 31', rows.length === total, rows.length);
  ok('cold load reads ~= doc count + chunks', F.stats.queryReads === total && F.stats.docReads >= 3, JSON.stringify(F.stats));
  const coldReads = F.stats.queryReads + F.stats.docReads;

  // --- T3: warm load (docs aged so only truly-new docs are re-read)
  ageAll();
  F.reset(); F.countCalls = 0;
  rows = await S.getRecords('issuance', true);
  ok('warm load returns all 31', rows.length === total, rows.length);
  const warmReads = F.stats.queryReads + F.stats.docReads;
  ok('warm load is nearly free (' + warmReads + ' reads vs ' + coldReads + ' cold)', warmReads <= 2 && F.countCalls === 1, JSON.stringify(F.stats) + ' count calls ' + F.countCalls);

  // --- T4: another client adds + edits a record: delta picks it up cheaply
  F.data.set('pilot_v2_issuance/X', { value: JSON.stringify(rec('X', 'Open')), status: 'Open', archived: false, updatedAt: Date.now() });
  F.data.set('pilot_v2_issuance/R1', { value: JSON.stringify(rec('R1', 'Edited')), status: 'Edited', archived: false, updatedAt: Date.now() });
  F.reset();
  rows = await S.getRecords('issuance', true);
  ok('new + edited records appear', rows.length === total + 1 && !!rows.find(r => r.id === 'X') && rows.find(r => r.id === 'R1').status === 'Edited', rows.length);
  ok('only the 2 changed docs were read', F.stats.queryReads + F.stats.docReads <= 3, JSON.stringify(F.stats));

  // --- T5: deletion by another client -> full reload, deleted doc gone
  ageAll();
  F.data.delete('pilot_v2_issuance/R2');
  F.reset();
  rows = await S.getRecords('issuance', true);
  ok('deleted record is gone after a count mismatch', !rows.find(r => r.id === 'R2') && rows.length === total, rows.length);
  ok('deletion forced a full read', F.stats.queryReads >= total, JSON.stringify(F.stats));

  // --- T6: own save stays visible even if writer clock is far behind (skew)
  ageAll();
  const realNow = Date.now; const cur = rows.find(r => r.id === 'R3');
  Date.now = () => realNow() - 3 * 3600e3;  // this PC's clock is 3h slow
  await S.setMulti([], true, [entry('issuance', rec('R3', 'MyEdit'), JSON.stringify(cur))]);
  Date.now = realNow;
  await new Promise(r => setTimeout(r, 50)); // cacheApplyOwnSave is fire-and-forget
  F.reset();
  rows = await S.getRecords('issuance', true);
  ok('own edit visible after reload despite skewed clock', rows.find(r => r.id === 'R3').status === 'MyEdit', rows.find(r => r.id === 'R3').status);
  ok('...and served from cache', F.stats.queryReads + F.stats.docReads <= 2, JSON.stringify(F.stats));

  // --- T7: open-only request served from the 'all' cache, archived filtered
  F.data.set('pilot_v2_issuance/R5', { ...F.data.get('pilot_v2_issuance/R5'), archived: true, status: 'Closed', updatedAt: Date.now() });
  rows = await S.getRecords('issuance', false);
  ok('open-only load excludes archived (served from cache)', !rows.find(r => r.id === 'R5') && rows.length > 0, rows.length);

  // --- T8: dashboard delta
  await S.getRecords('issuance', true);
  ageAll();
  F.data.set('pilot_v2_issuance/Y', { value: JSON.stringify(rec('Y', 'Open')), status: 'Open', archived: false, updatedAt: Date.now() });
  F.reset();
  const delta = await S.getRecordsUpdatedSince('issuance');
  ok('getRecordsUpdatedSince returns just the new record', delta && delta.length === 1 && delta[0].id === 'Y', JSON.stringify(delta && delta.map(d => d.id)));
  ok('...for ~1 read', F.stats.queryReads + F.stats.docReads <= 2, JSON.stringify(F.stats));
  F.reset();
  const delta2 = await S.getRecordsUpdatedSince('issuance');
  ok('second delta call re-reads at most the skew-window doc (<=1 read)', delta2.length <= 1 && F.stats.queryReads <= 1, JSON.stringify(F.stats));
  ok('unloaded section reports null (caller does a full load)', (await S.getRecordsUpdatedSince('never_loaded')) === null);

  // --- T9: section blob CAS reads
  const blobV1 = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ id: i, pad: 'q'.repeat(120 * 1024) })));
  await S.setMulti([{ key: 'section__employees', value: blobV1, expectedPrevious: null }], true, []);
  const chunks = F.data.get('sms_erp_storage/shared__pilot_v2__section__employees').chunks;
  F.reset();
  const blobV2 = blobV1.replace('"id":0', '"id":99');
  const r2 = await S.setMulti([{ key: 'section__employees', value: blobV2, expectedPrevious: blobV1 }], true, []);
  ok('blob re-save ok', r2 && r2.ok === true);
  ok('blob re-save read 1 doc, not 1+' + chunks, F.stats.docReads === 1, JSON.stringify(F.stats));
  const r3 = await S.setMulti([{ key: 'section__employees', value: blobV1 + ' ', expectedPrevious: blobV1 }], true, []);
  ok('stale blob save is a conflict returning the real current value', r3.conflict === true && r3.conflicts['section__employees'] === blobV2);

  document.getElementById('out').textContent = out.join('\n') + '\n\n' + (fails ? fails + ' FAILED' : 'ALL PASSED');
  window.__done = true;
})().catch(e => { document.getElementById('out').textContent = 'HARNESS ERROR: ' + (e && e.stack || e); window.__done = true; });
