'use strict';

// Creates the collections with their validators and indexes, and the two apps.
// Safe to run again after a model change. The server also does this on start.
const config = require('../src/config');
const { connect, setup } = require('../src/db');

(async () => {
  if (!config.MONGO_URL) throw new Error('Set MONGO_URL first, e.g. MONGO_URL="mongodb+srv://..." npm run init-db');
  const { client, db } = await connect(config.MONGO_URL, config.MONGO_DB);
  const problems = await setup(db);
  problems.forEach((p) => console.warn(`Skipped ${p}`));
  console.log(`Database ${config.MONGO_DB} is ready.`);
  await client.close();
})().catch((err) => { console.error(err.message); process.exit(1); });
