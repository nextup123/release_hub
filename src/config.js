'use strict';

const envFileFound = require('./loadEnv').loadEnv();

// No keys for now: anyone who knows the address can use the API. Sign-in comes later.
module.exports = {
  PORT: Number(process.env.PORT) || 4060,
  HOST: process.env.HOST || '0.0.0.0',
  MONGO_URL: (process.env.MONGO_URL || process.env.MONGODB_URI || '').trim(),
  MONGO_DB: process.env.MONGO_DB || 'nextup_support',
  envFileFound,
};
