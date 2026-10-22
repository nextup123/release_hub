'use strict';

const express = require('express');
const cors = require('cors');
const config = require('./config');
const { connect, setup } = require('./db');
const { createApp } = require('./app');

// The web server starts straight away, so Render's health check passes and
// /api/v1/health can say what is wrong while the database is not reachable.
// The API itself answers 503 until MongoDB is connected; connecting is retried.
// What this server can do, so the tool and the app can tell an older server apart.
const VERSION = require('../package.json').version;
const FEATURES = ['pictures'];
const state = { db: 'connecting', error: '', since: new Date().toISOString(), attempts: 0 };
let api = null;
let client = null;

const outer = express();
outer.use(cors());
outer.get(['/', '/api/v1/health'], (req, res) => {
  // Always 200 so Render keeps the service up and the page can show what is wrong.
  res.json({ ok: !!api, version: VERSION, features: FEATURES, db: state.db, error: state.error || undefined, attempts: state.attempts, dbName: config.MONGO_DB, time: new Date().toISOString() });
});
outer.use((req, res, next) => {
  if (api) return api(req, res, next);
  res.status(503).json({ error: `The server is running but the database is not ready (${state.db}${state.error ? `: ${state.error}` : ''}).` });
});

const server = outer.listen(config.PORT, config.HOST, () => console.log(`[HUB] version ${VERSION} listening on http://${config.HOST}:${config.PORT}/api/v1`));
if (config.envFileFound) console.log('[HUB] read settings from .env');
// Show where it connects, without the user name and password.
if (config.MONGO_URL) {
  const host = (config.MONGO_URL.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/?]+)/i) || [])[1] || '?';
  console.log(`[HUB] database ${config.MONGO_DB} on ${host}`);
}

function explain(err) {
  const m = String(err && err.message || err);
  if (/bad auth|authentication failed/i.test(m)) return `MongoDB user name or password in MONGO_URL is wrong (${m})`;
  if (/ENOTFOUND|querySrv/i.test(m)) return `MongoDB address in MONGO_URL was not found (${m})`;
  if (/Server selection timed out|ECONNREFUSED|timed out/i.test(m)) return `MongoDB did not answer. On Atlas, open Network Access and allow 0.0.0.0/0 so Render can connect (${m})`;
  return m;
}

async function start() {
  if (!config.MONGO_URL) {
    state.db = 'not configured';
    state.error = config.envFileFound
      ? 'MONGO_URL is not set. The .env file was read but has no MONGO_URL line.'
      : 'MONGO_URL is not set. Put it in a .env file in the release_hub folder, or set it as an environment variable (on Render: Environment).';
    console.error(`[HUB] ${state.error}`);
    return;
  }
  for (;;) {
    state.attempts += 1;
    try {
      const c = await connect(config.MONGO_URL, config.MONGO_DB);
      client = c.client;
      const problems = await setup(c.db);
      problems.forEach((p) => console.warn(`[HUB] setup: ${p}`));
      api = createApp({ db: c.db });
      state.db = 'connected';
      state.error = '';
      console.log(`[HUB] connected to MongoDB, database ${config.MONGO_DB}`);
      return;
    } catch (err) {
      state.db = 'not connected';
      state.error = explain(err);
      console.error(`[HUB] database connection failed (attempt ${state.attempts}): ${state.error}. Retrying in 10 s.`);
      if (client) await client.close().catch(() => {});
      client = null;
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}
start();

const stop = async () => { server.close(); if (client) await client.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
