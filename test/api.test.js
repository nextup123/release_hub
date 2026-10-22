'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./fakeDb');
const { setup } = require('../src/db');
const { createApp } = require('../src/app');
const { compareVersions } = require('../src/models');

const MACHINE = '6f1c2b1e-1111-4a2b-9c3d-000000000001';

let base;
let server;
test.before(async () => {
  const db = createFakeDb();
  await setup(db);
  const app = createApp({ db });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'X-User-Name': 'dhirendra', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('versions compare numerically', () => {
  assert.ok(compareVersions('3.10.0', '3.9.9') > 0);
  assert.ok(compareVersions('3.5.0', '3.5.0-beta.1') > 0);
  assert.strictEqual(compareVersions('3.5.0', '3.5.0'), 0);
});

test('no key is needed; apps are listed and unknown apps refused', async () => {
  const r = await call('GET', '/apps');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.apps.map((a) => a._id), ['ethercat_config_tool', 'main_app']);
  assert.strictEqual((await call('GET', '/apps/nope/bugs')).status, 404);
  assert.strictEqual((await call('GET', '/health')).body.ok, true);
});

test('bugs are numbered per app and deduplicated by clientReportId', async () => {
  const report = {
    clientReportId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
    appVersion: '3.5.0', title: 'Homing stops on J3', description: 'Run Homing, J3 stops at step 4',
    severity: 'high', category: 'drive_communication', frequency: 'always',
    reporter: { name: 'Ravi', company: 'Acme Automation' },
    machine: { machineId: MACHINE, name: 'Robot cell 2' },
    context: { drives: [{ position: 2, state: 'OP' }] },
  };
  const a = await call('POST', '/apps/ethercat_config_tool/bugs', report);
  assert.strictEqual(a.status, 201);
  assert.strictEqual(a.body.bug.number, 'ECT-1');
  const again = await call('POST', '/apps/ethercat_config_tool/bugs', report);
  assert.strictEqual(again.body.duplicate, true);
  assert.strictEqual(again.body.bug.number, 'ECT-1');
  const main = await call('POST', '/apps/main_app/bugs', { title: 'Login screen freezes', description: 'After 10 min idle' });
  assert.strictEqual(main.body.bug.number, 'MAIN-1');
  const ect2 = await call('POST', '/apps/ethercat_config_tool/bugs', { title: 'Typo on Help page', description: 'x', severity: 'low' });
  assert.strictEqual(ect2.body.bug.number, 'ECT-2');
  assert.strictEqual((await call('POST', '/apps/ethercat_config_tool/bugs', { title: '' })).status, 400);

  const list = await call('GET', '/apps/ethercat_config_tool/bugs?status=open&severity=high');
  assert.deepStrictEqual(list.body.bugs.map((b) => b.number), ['ECT-1']);
  const search = await call('GET', '/apps/ethercat_config_tool/bugs?q=acme');
  assert.strictEqual(search.body.total, 1);
});

test('maintainer triages a bug and a published release closes it', async () => {
  const p = await call('PATCH', '/bugs/ect-1', { status: 'in_progress', assignee: 'dhirendra', priority: 'high', note: 'Looking at it' });
  assert.strictEqual(p.body.bug.status, 'in_progress');
  assert.strictEqual(p.body.bug.statusHistory.length, 2);
  assert.strictEqual(p.body.bug.statusHistory[1].by, 'dhirendra');
  assert.strictEqual((await call('PATCH', '/bugs/ECT-1', { status: 'bogus' })).status, 400);
  await call('POST', '/bugs/ECT-1/comments', { text: 'Fixed the step timeout', internal: false });

  const draft = await call('PUT', '/apps/ethercat_config_tool/releases/3.5.1', {
    tag: 'v3.5.1', title: 'Homing fix', status: 'draft',
    changes: [{ type: 'fix', area: 'Recipes', title: 'Homing no longer stops on J3', bugs: ['ect-1'] }, { type: 'nonsense', title: 'Kept as improvement' }],
  });
  assert.strictEqual(draft.status, 200);
  assert.strictEqual(draft.body.release.changes[1].type, 'improvement');
  // Installed apps ask for published releases only.
  assert.strictEqual((await call('GET', '/apps/ethercat_config_tool/releases?status=published')).body.releases.length, 0);
  assert.strictEqual((await call('GET', '/apps/ethercat_config_tool/releases')).body.releases.length, 1);

  const pub = await call('PUT', '/apps/ethercat_config_tool/releases/3.5.1', { ...draft.body.release, status: 'published' });
  assert.deepStrictEqual(pub.body.linkedBugs, ['ECT-1']);
  const bug = await call('GET', '/bugs/ECT-1');
  assert.strictEqual(bug.body.bug.status, 'released');
  assert.strictEqual(bug.body.bug.fixedInVersion, '3.5.1');

  await call('PUT', '/apps/ethercat_config_tool/releases/3.10.0', { title: 'Later', status: 'published' });
  const after = await call('GET', '/apps/ethercat_config_tool/releases?after=3.5.0');
  assert.deepStrictEqual(after.body.releases.map((r) => r.version), ['3.10.0', '3.5.1']);

  // The vendor's machine sees its own reports with the fix version.
  const mine = await call('GET', `/apps/ethercat_config_tool/machines/${MACHINE}/bugs`);
  assert.strictEqual(mine.body.bugs[0].fixedInVersion, '3.5.1');
  assert.strictEqual(mine.body.bugs[0].description, undefined);
});

test('update records and heartbeats feed the dashboard', async () => {
  await call('POST', '/apps/ethercat_config_tool/machines/heartbeat', { machineId: MACHINE, name: 'Robot cell 2', version: '3.5.0' });
  const ev = {
    clientEventId: 'cccccccc-bbbb-4ccc-8ddd-000000000009', machineId: MACHINE,
    fromVersion: '3.5.0', toVersion: '3.5.1', tag: 'v3.5.1', result: 'success', durationSec: 140,
  };
  assert.strictEqual((await call('POST', '/apps/ethercat_config_tool/update-events', ev)).status, 201);
  assert.strictEqual((await call('POST', '/apps/ethercat_config_tool/update-events', ev)).body.duplicate, true);
  await call('POST', '/apps/ethercat_config_tool/update-events', { ...ev, clientEventId: 'cccccccc-bbbb-4ccc-8ddd-000000000010', toVersion: '3.10.0', fromVersion: '3.5.1', result: 'rolled_back', failedStep: 'check' });

  const s = await call('GET', '/apps/ethercat_config_tool/summary');
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.latestRelease.version, '3.10.0');
  assert.deepStrictEqual(s.body.machines.versions, { '3.5.1': 1 });
  assert.strictEqual(s.body.failedUpdates.length, 1);
  assert.strictEqual(s.body.bugs.open, 1);
});

test('screenshots are stored once, checked and served', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
  const img = { clientAttachmentId: 'dddddddd-bbbb-4ccc-8ddd-000000000001', name: 'screen 1', data: png.toString('base64') };
  const a = await call('POST', '/bugs/ECT-2/attachments', img);
  assert.strictEqual(a.status, 201);
  assert.strictEqual(a.body.attachment.type, 'image/png');
  assert.strictEqual(a.body.attachment.name, 'screen 1.png');
  // Sent again after a lost answer: stored once.
  const again = await call('POST', '/bugs/ECT-2/attachments', img);
  assert.strictEqual(again.body.duplicate, true);
  assert.strictEqual(again.body.attachment.id, a.body.attachment.id);
  // Not an image, and too large.
  assert.strictEqual((await call('POST', '/bugs/ECT-2/attachments', { data: Buffer.from('<html>not an image at all</html>').toString('base64') })).status, 400);
  assert.strictEqual((await call('POST', '/bugs/ECT-2/attachments', { data: Buffer.concat([png, Buffer.alloc(800 * 1024)]).toString('base64') })).status, 400);
  assert.strictEqual((await call('POST', '/bugs/ECT-99/attachments', img)).status, 404);
  // The EtherCAT tool sends it under its own app, same result.
  assert.strictEqual((await call('POST', '/apps/ethercat_config_tool/bugs/ECT-2/attachments', img)).body.duplicate, true);
  // The bug lists it, and the file comes back as the same bytes.
  const bug = await call('GET', '/bugs/ECT-2');
  assert.strictEqual(bug.body.bug.attachments.length, 1);
  const res = await fetch(`http://127.0.0.1:${server.address().port}${a.body.attachment.url}`);
  assert.strictEqual(res.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(png));
  // At most five per bug.
  for (let i = 0; i < 4; i += 1) {
    const r = await call('POST', '/bugs/ECT-2/attachments', { name: `n${i}`, data: Buffer.concat([png, Buffer.from([i])]).toString('base64') });
    assert.strictEqual(r.status, 201);
  }
  assert.strictEqual((await call('POST', '/bugs/ECT-2/attachments', { name: 'sixth', data: png.toString('base64') })).status, 400);
});
