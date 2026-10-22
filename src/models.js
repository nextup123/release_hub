'use strict';

/**
 * The data model, in one place. Every document carries `appId`, so bugs,
 * releases and update records of the EtherCAT config tool and the main
 * application never mix. DATA_MODEL.md explains each field.
 *
 * normaliseX(input) takes untrusted JSON (from a machine, the mobile app or
 * a release script) and returns either { value } or { error }.
 */

const CHANGE_TYPES = ['feature', 'improvement', 'fix', 'security', 'breaking', 'known_issue'];
const RELEASE_STATUSES = ['draft', 'published', 'withdrawn'];
const CHANNELS = ['stable', 'beta'];

const BUG_CATEGORIES = ['crash', 'wrong_result', 'drive_communication', 'screen_problem', 'slow', 'update', 'other'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const FREQUENCIES = ['always', 'sometimes', 'once'];
const BUG_STATUSES = ['new', 'triaged', 'in_progress', 'fixed', 'released', 'closed', 'wont_fix', 'duplicate', 'need_info'];
// Statuses that count as "open" on dashboards.
const OPEN_BUG_STATUSES = ['new', 'triaged', 'in_progress', 'need_info'];

const UPDATE_RESULTS = ['success', 'failed', 'rolled_back', 'not_applied'];
const UPDATE_KINDS = ['update', 'rollback'];

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const APP_ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
const UUID_RE = /^[0-9a-fA-F-]{8,64}$/;

const str = (v, max) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const optStr = (v, max) => (str(v, max) || null);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const bool = (v, fallback = false) => (typeof v === 'boolean' ? v : fallback);
function date(v, fallback = null) {
  if (!v) return fallback;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d;
}
const strList = (v, maxItems, maxLen) => (Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : []);

/** Compare "3.10.0" with "3.9.2". Pre-release suffixes sort before the plain version. */
function compareVersions(a, b) {
  const [ma, pa = ''] = String(a).split('-');
  const [mb, pb = ''] = String(b).split('-');
  const na = ma.split('.').map(Number);
  const nb = mb.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0);
  }
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa < pb ? -1 : 1;
}

// ── Apps ──────────────────────────────────────────────────────
function normaliseApp(b) {
  const id = str(b?._id ?? b?.appId, 40);
  if (!APP_ID_RE.test(id)) return { error: 'appId must be lowercase letters, digits and _ (e.g. ethercat_config_tool)' };
  const bugPrefix = str(b.bugPrefix, 8).toUpperCase();
  if (!/^[A-Z]{2,8}$/.test(bugPrefix)) return { error: 'bugPrefix must be 2 to 8 letters (e.g. ECT)' };
  return {
    value: {
      _id: id,
      name: str(b.name, 80) || id,
      bugPrefix,
      description: str(b.description, 500),
      repo: {
        url: str(b.repo?.url, 300),
        tagPrefix: str(b.repo?.tagPrefix, 40) || 'v',
        subdir: str(b.repo?.subdir, 200),
      },
      platforms: strList(b.platforms, 10, 40),
    },
  };
}

// ── Releases ──────────────────────────────────────────────────
function normaliseChange(c) {
  if (!c || typeof c !== 'object') return null;
  const title = str(c.title, 200);
  if (!title) return null;
  return {
    type: oneOf(c.type, CHANGE_TYPES, 'improvement'),
    area: str(c.area, 80),
    title,
    description: str(c.description, 4000),
    // Bug numbers this change fixes, e.g. "ECT-12". Linked both ways on publish.
    bugs: strList(c.bugs, 50, 20).map((n) => n.toUpperCase()),
    images: strList(c.images, 10, 500),
  };
}

function normaliseRelease(b, appId) {
  const version = str(b?.version, 40).replace(/^v/i, '');
  if (!VERSION_RE.test(version)) return { error: 'version must look like 3.5.0' };
  const changes = Array.isArray(b.changes) ? b.changes.map(normaliseChange).filter(Boolean).slice(0, 200) : [];
  const minVersion = str(b.minVersion, 40).replace(/^v/i, '');
  return {
    value: {
      appId,
      version,
      tag: str(b.tag, 80) || null,
      commit: optStr(b.commit, 64),
      channel: oneOf(b.channel, CHANNELS, 'stable'),
      status: oneOf(b.status, RELEASE_STATUSES, 'draft'),
      title: str(b.title, 200) || `Version ${version}`,
      summary: str(b.summary, 2000),
      releasedAt: date(b.releasedAt, new Date()),
      changes,
      upgradeNotes: str(b.upgradeNotes, 4000),
      requiresRestart: bool(b.requiresRestart, true),
      mandatory: bool(b.mandatory, false),
      minVersion: VERSION_RE.test(minVersion) ? minVersion : null,
      compatibility: b.compatibility && typeof b.compatibility === 'object' && !Array.isArray(b.compatibility)
        ? Object.fromEntries(Object.entries(b.compatibility).slice(0, 20).map(([k, v]) => [str(k, 40), str(v, 200)]))
        : {},
      artifacts: Array.isArray(b.artifacts)
        ? b.artifacts.slice(0, 20).map((a) => ({
          platform: str(a?.platform, 40), url: str(a?.url, 500), sha256: str(a?.sha256, 64), size: Number(a?.size) || null,
        })).filter((a) => a.url)
        : [],
      publishedBy: str(b.publishedBy, 80),
    },
  };
}

// ── Bug reports ───────────────────────────────────────────────
function normaliseBugReport(b, appId) {
  const title = str(b?.title, 200);
  if (!title) return { error: 'title is required' };
  const description = str(b.description, 8000);
  if (!description) return { error: 'description is required' };
  const clientReportId = str(b.clientReportId, 64);
  if (clientReportId && !UUID_RE.test(clientReportId)) return { error: 'clientReportId must be a UUID' };
  const appVersion = str(b.appVersion, 40).replace(/^v/i, '');

  const reporter = b.reporter && typeof b.reporter === 'object' ? b.reporter : {};
  const machine = b.machine && typeof b.machine === 'object' ? b.machine : {};
  const context = b.context && typeof b.context === 'object' ? b.context : {};

  return {
    value: {
      appId,
      appVersion: VERSION_RE.test(appVersion) ? appVersion : null,
      // Made on the machine, so a report saved offline and sent twice is stored once.
      clientReportId: clientReportId || null,
      title,
      description,
      stepsToReproduce: str(b.stepsToReproduce, 4000),
      expected: str(b.expected, 2000),
      actual: str(b.actual, 2000),
      category: oneOf(b.category, BUG_CATEGORIES, 'other'),
      severity: oneOf(b.severity, SEVERITIES, 'medium'),
      frequency: oneOf(b.frequency, FREQUENCIES, 'once'),
      area: str(b.area, 80),
      reporter: {
        name: str(reporter.name, 80),
        company: str(reporter.company, 120),
        phone: str(reporter.phone, 40),
        email: str(reporter.email, 120),
      },
      machine: {
        machineId: optStr(machine.machineId, 64),
        name: str(machine.name, 80),
        site: str(machine.site, 120),
        hostname: str(machine.hostname, 120),
        os: str(machine.os, 120),
      },
      // Free-form snapshot the app adds (drives on the bus, recent history, log lines).
      // Capped so one report cannot fill the database.
      context: JSON.stringify(context).length <= 200000 ? context : { truncated: true },
      attachments: Array.isArray(b.attachments)
        ? b.attachments.slice(0, 10).map((a) => ({
          name: str(a?.name, 200), type: str(a?.type, 80), size: Number(a?.size) || null, url: str(a?.url, 500),
        })).filter((a) => a.name)
        : [],
      reportedAt: date(b.reportedAt, new Date()),
    },
  };
}

// Screenshots sent with a bug report. The apps shrink them first (about 300 KB each).
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGES_PER_BUG = 5;
const MAX_IMAGE_BYTES = 700 * 1024;

/** The real type of an image from its first bytes (the sender's type label is not trusted). */
function sniffImage(buf) {
  if (buf.length > 12) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  }
  return null;
}

/** One screenshot: { clientAttachmentId, name, data (base64) }. Returns the stored form with the bytes. */
function normaliseAttachment(b) {
  const clientAttachmentId = str(b?.clientAttachmentId, 64);
  if (clientAttachmentId && !UUID_RE.test(clientAttachmentId)) return { error: 'clientAttachmentId must be a UUID' };
  const raw = typeof b?.data === 'string' ? b.data.replace(/^data:[^,]*,/, '') : '';
  if (!raw) return { error: 'data (base64 image) is required' };
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) return { error: `The image is too large (${Math.round(bytes.length / 1024)} KB). The limit is ${MAX_IMAGE_BYTES / 1024} KB.` };
  const type = sniffImage(bytes);
  if (!type) return { error: 'Only JPEG, PNG, WebP or GIF images are accepted' };
  const base = str(b.name, 200).replace(/[\\/:*?"<>|]+/g, '_') || 'image';
  const name = /\.[A-Za-z0-9]{2,4}$/.test(base) ? base : `${base}.${IMAGE_TYPES[type]}`;
  return { value: { clientAttachmentId: clientAttachmentId || null, name, type, size: bytes.length, data: raw.replace(/\s+/g, '') } };
}

/** Fields the maintainer (mobile app) may change on a bug. */
function normaliseBugPatch(b) {
  const out = {};
  if (b.status !== undefined) {
    if (!BUG_STATUSES.includes(b.status)) return { error: `status must be one of ${BUG_STATUSES.join(', ')}` };
    out.status = b.status;
  }
  if (b.priority !== undefined) {
    if (b.priority !== null && !SEVERITIES.includes(b.priority)) return { error: `priority must be one of ${SEVERITIES.join(', ')}` };
    out.priority = b.priority;
  }
  if (b.severity !== undefined) out.severity = oneOf(b.severity, SEVERITIES, 'medium');
  if (b.category !== undefined) out.category = oneOf(b.category, BUG_CATEGORIES, 'other');
  if (b.assignee !== undefined) out.assignee = optStr(b.assignee, 80);
  if (b.title !== undefined) out.title = str(b.title, 200) || undefined;
  if (b.labels !== undefined) out.labels = strList(b.labels, 20, 40);
  if (b.duplicateOf !== undefined) out.duplicateOf = optStr(b.duplicateOf, 20)?.toUpperCase() || null;
  if (b.fixedInVersion !== undefined) {
    const v = str(b.fixedInVersion, 40).replace(/^v/i, '');
    if (v && !VERSION_RE.test(v)) return { error: 'fixedInVersion must look like 3.5.0' };
    out.fixedInVersion = v || null;
  }
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return { value: out };
}

// ── Machines and update records ───────────────────────────────
function normaliseHeartbeat(b, appId) {
  const machineId = str(b?.machineId, 64);
  if (!UUID_RE.test(machineId)) return { error: 'machineId must be a UUID' };
  const version = str(b.version, 40).replace(/^v/i, '');
  return {
    value: {
      machineId,
      appId,
      name: str(b.name, 80),
      site: str(b.site, 120),
      hostname: str(b.hostname, 120),
      os: str(b.os, 120),
      version: VERSION_RE.test(version) ? version : null,
      channel: oneOf(b.channel, CHANNELS, 'stable'),
    },
  };
}

function normaliseUpdateEvent(b, appId) {
  const clientEventId = str(b?.clientEventId, 64);
  if (!UUID_RE.test(clientEventId)) return { error: 'clientEventId must be a UUID' };
  const machineId = str(b.machineId, 64);
  if (!UUID_RE.test(machineId)) return { error: 'machineId must be a UUID' };
  const fromVersion = str(b.fromVersion, 40).replace(/^v/i, '');
  const toVersion = str(b.toVersion, 40).replace(/^v/i, '');
  if (!VERSION_RE.test(toVersion)) return { error: 'toVersion must look like 3.5.0' };
  return {
    value: {
      clientEventId,
      appId,
      machineId,
      kind: oneOf(b.kind, UPDATE_KINDS, 'update'),
      fromVersion: VERSION_RE.test(fromVersion) ? fromVersion : null,
      toVersion,
      tag: str(b.tag, 80),
      result: oneOf(b.result, UPDATE_RESULTS, 'failed'),
      failedStep: str(b.failedStep, 80),
      error: str(b.error, 2000),
      log: str(b.log, 20000),
      startedAt: date(b.startedAt),
      finishedAt: date(b.finishedAt, new Date()),
      durationSec: Number.isFinite(Number(b.durationSec)) ? Number(b.durationSec) : null,
    },
  };
}

module.exports = {
  CHANGE_TYPES, RELEASE_STATUSES, CHANNELS,
  BUG_CATEGORIES, SEVERITIES, FREQUENCIES, BUG_STATUSES, OPEN_BUG_STATUSES,
  UPDATE_RESULTS, UPDATE_KINDS,
  compareVersions,
  IMAGE_TYPES, MAX_IMAGES_PER_BUG, MAX_IMAGE_BYTES, normaliseAttachment, sniffImage,
  normaliseApp, normaliseRelease, normaliseBugReport, normaliseBugPatch, normaliseHeartbeat, normaliseUpdateEvent,
};
