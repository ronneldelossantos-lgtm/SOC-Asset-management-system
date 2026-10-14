/* Minimal in-memory stand-in for the firebase compat SDK surface index.html uses. */
(function(){
  const data = new Map();            // full path -> plain object
  const stats = { docReads: 0, queryReads: 0, writes: 0, deletes: 0 };
  const norm = d => JSON.parse(JSON.stringify(d));
  const parentOf = p => p.split('/').slice(0, -1).join('/');
  const idOf = p => p.split('/').pop();

  class Snap { constructor(path, d){ this.id = idOf(path); this.exists = d !== undefined; this._d = d; this.ref = new DocRef(path); } data(){ return this._d === undefined ? undefined : norm(this._d); } }
  class DocRef {
    constructor(path){ this.path = path; this.id = idOf(path); }
    async get(){ stats.docReads++; return new Snap(this.path, data.get(this.path)); }
    async set(d){ stats.writes++; data.set(this.path, norm(d)); }
    async delete(){ stats.deletes++; data.delete(this.path); }
    collection(name){ return new Query(this.path + '/' + name, []); }
    onSnapshot(opts, cb){ const snap = new Snap(this.path, data.get(this.path)); setTimeout(()=>cb(snap), 0); return ()=>{}; }
  }
  class Query {
    constructor(path, filters){ this.path = path; this.filters = filters; }
    doc(id){ return new DocRef(this.path + '/' + id); }
    where(f, op, v){ return new Query(this.path, this.filters.concat([[f, op, v]])); }
    _docs(){
      const prefix = this.path + '/';
      const out = [];
      data.forEach((d, p) => {
        if (!p.startsWith(prefix) || p.slice(prefix.length).includes('/')) return;
        if (this.filters.every(([f, op, v]) => op === '==' ? d[f] === v : op === '>' ? d[f] > v : false)) out.push(new Snap(p, d));
      });
      return out;
    }
    async get(){ const docs = this._docs(); stats.queryReads += Math.max(1, docs.length); return { docs, size: docs.length, forEach: cb => docs.forEach(cb) }; }
  }
  const db = {
    collection(name){ return new Query(name, []); },
    async runTransaction(fn){
      const writes = [];
      const tx = {
        async get(ref){ return ref.get(); },
        set(ref, d){ writes.push(['set', ref.path, d]); },
        delete(ref){ writes.push(['del', ref.path]); },
      };
      const res = await fn(tx);
      writes.forEach(([k, p, d]) => { if (k === 'set'){ stats.writes++; data.set(p, norm(d)); } else { stats.deletes++; data.delete(p); } });
      return res;
    },
    batch(){
      const writes = [];
      return {
        set(ref, d){ writes.push(['set', ref.path, d]); },
        delete(ref){ writes.push(['del', ref.path]); },
        async commit(){ writes.forEach(([k, p, d]) => { if (k === 'set'){ stats.writes++; data.set(p, norm(d)); } else { stats.deletes++; data.delete(p); } }); },
      };
    },
  };
  window.firebase = { initializeApp: () => ({}), firestore: () => db };
  window.__fake = { data, stats, reset(){ stats.docReads = stats.queryReads = stats.writes = stats.deletes = 0; } };

  // REST count aggregation, answered from the same store
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    if (String(url).includes(':runAggregationQuery')){
      const q = JSON.parse(opts.body).structuredAggregationQuery.structuredQuery;
      const col = q.from[0].collectionId;
      const filters = q.where ? [[q.where.fieldFilter.field.fieldPath, '==', q.where.fieldFilter.value.booleanValue]] : [];
      const n = new Query(col, filters)._docs().length;
      window.__fake.countCalls = (window.__fake.countCalls || 0) + 1;
      return new Response(JSON.stringify([{ result: { aggregateFields: { n: { integerValue: String(n) } } } }]), { status: 200 });
    }
    return realFetch(url, opts);
  };
})();
