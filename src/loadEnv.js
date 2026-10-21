'use strict';

const fs = require('fs');
const path = require('path');

// Reads KEY=value lines from .env in the release_hub folder, so `npm start` works
// without exporting variables first. Values already set (e.g. on Render) win.
function loadEnv(file = path.join(__dirname, '..', '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

module.exports = { loadEnv };
