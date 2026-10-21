'use strict';

// Runs the hub on an in-memory database, for trying the apps without MongoDB.
//   PORT=4060 node test/serve-fake.js
const config = require('../src/config');
const { setup } = require('../src/db');
const { createApp } = require('../src/app');
const { createFakeDb } = require('./fakeDb');

(async () => {
  const db = createFakeDb();
  await setup(db);
  createApp({ db }).listen(config.PORT, '127.0.0.1', () => console.log(`[HUB] in-memory hub on ${config.PORT}`));
})();
