import { getDb } from '../db.js';

function getSetting(key, db = getDb()) {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : null;
}

function setSetting(key, value, db = getDb()) {
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString());
}

export { getSetting, setSetting };
