'use strict';

const express = require('express');
const cors = require('cors');
const M = require('./models');

const toInt = (v, fallback, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max ?? n) : fallback;
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// No sign-in yet (keys come later). Who made a change is whatever name the caller gives:
// the mobile app sends X-User-Name, release scripts send publishedBy.
const who = (req, fallback = 'maintainer') => String(req.get('x-user-name') || req.body?.by || fallback).trim().slice(0, 80) || fallback;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** What a machine (vendor) may see about its own reports. */
const PUBLIC_BUG_FIELDS = { _id: 0, number: 1, title: 1, status: 1, fixedInVersion: 1, clientReportId: 1, createdAt: 1, updatedAt: 1 };

function createApp({ db }) {
  const apps = db.collection('apps');
  const releases = db.collection('releases');
  const bugs = db.collection('bug_reports');
  const machines = db.collection('machines');
  const updateEvents = db.collection('update_events');
  const counters = db.collection('counters');

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  const api = express.Router();
  api.get('/health', (req, res) => res.json({ ok: true, db: 'connected', time: new Date().toISOString() }));

  // Every /apps/:appId route checks the app exists and the key may use it.
  let appCache = { at: 0, ids: new Set(), docs: [] };
  async function appList() {
    if (Date.now() - appCache.at > 10000) {
      const docs = await apps.find({}).sort({ _id: 1 }).toArray();
      appCache = { at: Date.now(), ids: new Set(docs.map((d) => d._id)), docs };
    }
    return appCache;
  }
  api.param('appId', (req, res, next, appId) => {
    appList().then(({ ids, docs }) => {
      if (!ids.has(appId)) return res.status(404).json({ error: `Unknown app ${appId}` });
      req.appDoc = docs.find((d) => d._id === appId);
      next();
    }, next);
  });

  // ── Apps ────────────────────────────────────────────────────
  api.get('/apps', wrap(async (req, res) => res.json({ apps: (await appList()).docs })));

  api.put('/apps/:id', wrap(async (req, res) => {
    const { value, error } = M.normaliseApp({ ...req.body, _id: req.params.id });
    if (error) return res.status(400).json({ error });
    const { _id, ...rest } = value;
    await apps.updateOne({ _id }, { $set: { ...rest, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    appCache.at = 0;
    res.json({ app: await apps.findOne({ _id }) });
  }));

  // ── Releases ────────────────────────────────────────────────
  api.get('/apps/:appId/releases', wrap(async (req, res) => {
    const filter = { appId: req.params.appId };
    // The installed apps ask for status=published; the mobile app lists everything.
    if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
    if (req.query.channel === 'stable') filter.channel = 'stable';
    let list = await releases.find(filter).sort({ releasedAt: -1 }).limit(toInt(req.query.limit, 50, 200)).toArray();
    if (req.query.after) list = list.filter((r) => M.compareVersions(r.version, String(req.query.after).replace(/^v/i, '')) > 0);
    list.sort((a, b) => M.compareVersions(b.version, a.version));
    res.json({ releases: list });
  }));

  api.get('/apps/:appId/releases/:version', wrap(async (req, res) => {
    const filter = { appId: req.params.appId, version: req.params.version.replace(/^v/i, '') };
    const release = await releases.findOne(filter);
    if (!release) return res.status(404).json({ error: 'Release not found' });
    res.json({ release });
  }));

  // Create or replace the notes for one version (release script, GitHub Action, mobile app).
  api.put('/apps/:appId/releases/:version', wrap(async (req, res) => {
    const { value, error } = M.normaliseRelease({ ...req.body, version: req.params.version }, req.params.appId);
    if (error) return res.status(400).json({ error });
    if (!value.publishedBy) value.publishedBy = who(req);
    const now = new Date();
    await releases.updateOne(
      { appId: value.appId, version: value.version },
      { $set: { ...value, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    // Publishing closes the loop on the bugs the release fixes.
    let linkedBugs = [];
    if (value.status === 'published') {
      linkedBugs = [...new Set(value.changes.flatMap((c) => c.bugs))];
      for (const number of linkedBugs) {
        const bug = await bugs.findOne({ number, appId: value.appId });
        if (!bug || ['closed', 'wont_fix', 'duplicate'].includes(bug.status)) continue;
        await bugs.updateOne({ _id: bug._id }, {
          $set: { status: 'released', fixedInVersion: value.version, updatedAt: now },
          $push: { statusHistory: { status: 'released', by: value.publishedBy, at: now, note: `Fixed in ${value.version}` } },
        });
      }
    }
    res.json({ release: await releases.findOne({ appId: value.appId, version: value.version }), linkedBugs });
  }));

  // ── Bug reports ─────────────────────────────────────────────
  async function nextBugNumber(appDoc) {
    const r = await counters.findOneAndUpdate(
      { _id: `bug:${appDoc._id}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' },
    );
    return { seq: r.seq, number: `${appDoc.bugPrefix}-${r.seq}` };
  }

  api.post('/apps/:appId/bugs', wrap(async (req, res) => {
    const { value, error } = M.normaliseBugReport(req.body, req.params.appId);
    if (error) return res.status(400).json({ error });
    // Offline machines resend until they get an answer: same clientReportId → same bug.
    if (value.clientReportId) {
      const existing = await bugs.findOne({ clientReportId: value.clientReportId }, { projection: PUBLIC_BUG_FIELDS });
      if (existing) return res.json({ bug: existing, duplicate: true });
    }
    const now = new Date();
    const { seq, number } = await nextBugNumber(req.appDoc);
    const doc = {
      ...value,
      seq,
      number,
      status: 'new',
      priority: null,
      assignee: null,
      labels: [],
      duplicateOf: null,
      fixedInVersion: null,
      comments: [],
      statusHistory: [{ status: 'new', by: value.reporter.name || 'reporter', at: now, note: '' }],
      submittedBy: value.reporter.name || value.machine.name || 'unknown',
      createdAt: now,
      updatedAt: now,
    };
    try {
      await bugs.insertOne(doc);
    } catch (err) {
      if (err.code === 11000 && value.clientReportId) {
        const existing = await bugs.findOne({ clientReportId: value.clientReportId }, { projection: PUBLIC_BUG_FIELDS });
        if (existing) return res.json({ bug: existing, duplicate: true });
      }
      throw err;
    }
    res.status(201).json({ bug: Object.fromEntries(Object.keys(PUBLIC_BUG_FIELDS).filter((k) => k !== '_id').map((k) => [k, doc[k]])) });
  }));

  api.get('/apps/:appId/bugs', wrap(async (req, res) => {
    const filter = { appId: req.params.appId };
    const { status, severity, category, machineId, assignee, version, q } = req.query;
    if (status === 'open') filter.status = { $in: M.OPEN_BUG_STATUSES };
    else if (status) filter.status = { $in: String(status).split(',') };
    if (severity) filter.severity = { $in: String(severity).split(',') };
    if (category) filter.category = String(category);
    if (machineId) filter['machine.machineId'] = String(machineId);
    if (assignee) filter.assignee = String(assignee);
    if (version) filter.appVersion = String(version);
    if (q) {
      const rx = { $regex: escapeRegex(String(q).slice(0, 100)), $options: 'i' };
      filter.$or = [{ title: rx }, { description: rx }, { number: rx }, { 'reporter.company': rx }, { 'machine.name': rx }];
    }
    const limit = toInt(req.query.limit, 30, 100) || 30;
    const page = Math.max(1, toInt(req.query.page, 1));
    const [total, list] = await Promise.all([
      bugs.countDocuments(filter),
      bugs.find(filter, { projection: { context: 0, comments: 0, statusHistory: 0 } })
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    ]);
    res.json({ bugs: list, total, page, limit });
  }));

  api.get('/bugs/:number', wrap(async (req, res) => {
    const bug = await bugs.findOne({ number: req.params.number.toUpperCase() });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    res.json({ bug });
  }));

  api.patch('/bugs/:number', wrap(async (req, res) => {
    const { value, error } = M.normaliseBugPatch(req.body || {});
    if (error) return res.status(400).json({ error });
    const number = req.params.number.toUpperCase();
    const bug = await bugs.findOne({ number });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    const now = new Date();
    const update = { $set: { ...value, updatedAt: now } };
    if (value.status && value.status !== bug.status) {
      update.$push = { statusHistory: { status: value.status, by: who(req), at: now, note: String(req.body.note || '').slice(0, 500) } };
    }
    await bugs.updateOne({ _id: bug._id }, update);
    res.json({ bug: await bugs.findOne({ _id: bug._id }) });
  }));

  api.post('/bugs/:number/comments', wrap(async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: 'text is required' });
    const comment = { author: String(req.body.author || who(req)).slice(0, 80), text, internal: req.body.internal !== false, at: new Date() };
    const r = await bugs.updateOne({ number: req.params.number.toUpperCase() }, { $push: { comments: comment }, $set: { updatedAt: comment.at } });
    if (!r.matchedCount) return res.status(404).json({ error: 'Bug not found' });
    res.status(201).json({ comment });
  }));

  // A machine checks on the reports it sent (status, fixed in which version).
  api.get('/apps/:appId/machines/:machineId/bugs', wrap(async (req, res) => {
    const list = await bugs.find({ appId: req.params.appId, 'machine.machineId': req.params.machineId }, { projection: PUBLIC_BUG_FIELDS })
      .sort({ createdAt: -1 }).limit(200).toArray();
    // Comments marked as not internal are the maintainer's answer to the vendor.
    res.json({ bugs: list });
  }));

  // ── Machines ────────────────────────────────────────────────
  async function touchMachine(m, extra = {}) {
    const now = new Date();
    const { machineId, ...rest } = m;
    const set = { ...rest, ...extra, lastSeenAt: now };
    Object.keys(set).forEach((k) => (set[k] === '' || set[k] === null) && delete set[k]);
    await machines.updateOne({ _id: machineId }, { $set: set, $setOnInsert: { firstSeenAt: now } }, { upsert: true });
  }

  api.post('/apps/:appId/machines/heartbeat', wrap(async (req, res) => {
    const { value, error } = M.normaliseHeartbeat(req.body, req.params.appId);
    if (error) return res.status(400).json({ error });
    await touchMachine(value);
    res.json({ ok: true });
  }));

  api.get('/apps/:appId/machines', wrap(async (req, res) => {
    res.json({ machines: await machines.find({ appId: req.params.appId }).sort({ lastSeenAt: -1 }).limit(500).toArray() });
  }));

  // ── Update records ──────────────────────────────────────────
  api.post('/apps/:appId/update-events', wrap(async (req, res) => {
    const { value, error } = M.normaliseUpdateEvent(req.body, req.params.appId);
    if (error) return res.status(400).json({ error });
    const existing = await updateEvents.findOne({ clientEventId: value.clientEventId });
    if (existing) return res.json({ event: existing, duplicate: true });
    await updateEvents.insertOne({ ...value, receivedAt: new Date() });
    await touchMachine({ machineId: value.machineId, appId: value.appId }, {
      version: value.result === 'success' ? value.toVersion : value.fromVersion,
      lastUpdate: { toVersion: value.toVersion, result: value.result, at: value.finishedAt },
    });
    res.status(201).json({ event: value });
  }));

  api.get('/apps/:appId/update-events', wrap(async (req, res) => {
    const filter = { appId: req.params.appId };
    if (req.query.machineId) filter.machineId = String(req.query.machineId);
    if (req.query.result) filter.result = { $in: String(req.query.result).split(',') };
    if (req.query.version) filter.toVersion = String(req.query.version);
    const list = await updateEvents.find(filter, { projection: { log: 0 } }).sort({ finishedAt: -1 }).limit(toInt(req.query.limit, 100, 500)).toArray();
    res.json({ events: list });
  }));

  // ── Dashboard for the mobile app ────────────────────────────
  api.get('/apps/:appId/summary', wrap(async (req, res) => {
    const appId = req.params.appId;
    const byStatus = {};
    for (const s of M.BUG_STATUSES) byStatus[s] = await bugs.countDocuments({ appId, status: s });
    const openBySeverity = {};
    for (const s of M.SEVERITIES) openBySeverity[s] = await bugs.countDocuments({ appId, status: { $in: M.OPEN_BUG_STATUSES }, severity: s });
    const all = await releases.find({ appId, status: 'published' }).toArray();
    const latest = all.sort((a, b) => M.compareVersions(b.version, a.version))[0] || null;
    const machineList = await machines.find({ appId }).toArray();
    const versions = {};
    for (const m of machineList) versions[m.version || 'unknown'] = (versions[m.version || 'unknown'] || 0) + 1;
    const failedUpdates = await updateEvents.find({ appId, result: { $in: ['failed', 'rolled_back'] } }, { projection: { log: 0 } })
      .sort({ finishedAt: -1 }).limit(10).toArray();
    res.json({
      appId,
      bugs: { byStatus, openBySeverity, open: M.OPEN_BUG_STATUSES.reduce((n, s) => n + byStatus[s], 0) },
      latestRelease: latest && { version: latest.version, title: latest.title, releasedAt: latest.releasedAt },
      machines: { total: machineList.length, onLatest: latest ? (versions[latest.version] || 0) : 0, versions },
      failedUpdates,
    });
  }));

  // Lists the enums so the mobile app builds its pickers from the server.
  api.get('/meta', (req, res) => res.json({
    changeTypes: M.CHANGE_TYPES, releaseStatuses: M.RELEASE_STATUSES, channels: M.CHANNELS,
    bugCategories: M.BUG_CATEGORIES, severities: M.SEVERITIES, frequencies: M.FREQUENCIES,
    bugStatuses: M.BUG_STATUSES, openBugStatuses: M.OPEN_BUG_STATUSES, updateResults: M.UPDATE_RESULTS,
  }));

  app.use('/api/v1', api);
  app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[HTTP]', err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
  });
  return app;
}

module.exports = { createApp };
