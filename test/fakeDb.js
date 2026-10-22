'use strict';

// A small in-memory stand-in for the parts of the MongoDB driver the hub uses,
// so the API can be tested without a MongoDB server. Not a full emulation.
const get = (doc, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
function set(doc, p, v) {
  const keys = p.split('.');
  let o = doc;
  keys.slice(0, -1).forEach((k) => { o[k] = o[k] ?? {}; o = o[k]; });
  o[keys.at(-1)] = v;
}
const eq = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    const v = get(doc, k);
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('$in' in cond) return cond.$in.some((x) => eq(v, x));
      if ('$regex' in cond) return typeof v === 'string' && new RegExp(cond.$regex, cond.$options).test(v);
      if ('$type' in cond) return typeof v === cond.$type;
    }
    return eq(v, cond);
  });
}

function project(doc, projection) {
  if (!projection) return structuredClone(doc);
  const inc = Object.entries(projection).filter(([, v]) => v === 1).map(([k]) => k);
  const copy = structuredClone(doc);
  if (inc.length) {
    const out = {};
    inc.forEach((k) => { if (k in copy) out[k] = copy[k]; });
    if (projection._id !== 0) out._id = copy._id;
    return out;
  }
  Object.entries(projection).forEach(([k, v]) => { if (v === 0) delete copy[k]; });
  return copy;
}

function applyUpdate(doc, update, inserting) {
  Object.entries(update.$set || {}).forEach(([k, v]) => set(doc, k, structuredClone(v)));
  if (inserting) Object.entries(update.$setOnInsert || {}).forEach(([k, v]) => set(doc, k, structuredClone(v)));
  Object.entries(update.$inc || {}).forEach(([k, v]) => set(doc, k, (get(doc, k) || 0) + v));
  Object.entries(update.$push || {}).forEach(([k, v]) => set(doc, k, [...(get(doc, k) || []), structuredClone(v)]));
}

class Cursor {
  constructor(docs) { this.docs = docs; }
  sort(spec) {
    const [[k, dir]] = Object.entries(spec);
    this.docs.sort((a, b) => { const x = get(a, k); const y = get(b, k); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
    return this;
  }
  skip(n) { this.docs = this.docs.slice(n); return this; }
  limit(n) { if (n) this.docs = this.docs.slice(0, n); return this; }
  async toArray() { return this.docs; }
}

class Collection {
  constructor(unique = []) { this.docs = []; this.unique = unique; this.seq = 0; }
  find(filter = {}, opts = {}) { return new Cursor(this.docs.filter((d) => matches(d, filter)).map((d) => project(d, opts.projection))); }
  async findOne(filter, opts = {}) { const d = this.docs.find((x) => matches(x, filter)); return d ? project(d, opts.projection) : null; }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  async insertOne(doc) {
    for (const k of this.unique) {
      const v = get(doc, k);
      if (v != null && this.docs.some((d) => eq(get(d, k), v))) { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; }
    }
    const copy = structuredClone(doc);
    if (copy._id === undefined) { this.seq += 1; copy._id = `id${this.seq}`; doc._id = copy._id; }
    this.docs.push(copy);
    return { insertedId: copy._id };
  }
  async updateOne(filter, update, opts = {}) {
    let d = this.docs.find((x) => matches(x, filter));
    if (!d && opts.upsert) {
      d = {};
      Object.entries(filter).forEach(([k, v]) => { if (typeof v !== 'object') set(d, k, v); });
      applyUpdate(d, update, true);
      this.docs.push(d);
      return { matchedCount: 0, upsertedCount: 1 };
    }
    if (!d) return { matchedCount: 0 };
    applyUpdate(d, update, false);
    return { matchedCount: 1 };
  }
  async findOneAndUpdate(filter, update, opts = {}) {
    await this.updateOne(filter, update, opts);
    return this.findOne(filter);
  }
  async createIndex() {}
}

function createFakeDb() {
  const unique = { bug_reports: ['number', 'clientReportId'], update_events: ['clientEventId'], attachments: ['clientAttachmentId'] };
  const cols = {};
  return {
    collection: (n) => { cols[n] = cols[n] || new Collection(unique[n]); return cols[n]; },
    listCollections: () => ({ toArray: async () => Object.keys(cols).map((name) => ({ name })) }),
    createCollection: async (n) => { cols[n] = cols[n] || new Collection(unique[n]); },
    command: async () => ({ ok: 1 }),
  };
}

module.exports = { createFakeDb };
