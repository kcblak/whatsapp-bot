const fs = require('fs');
const path = require('path');
const db = require('./db');

const SESSION_ID = 'whatsapp';

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  data jsonb,
  updated_at timestamptz DEFAULT now()
);`;

async function ensureTable() {
  await db.query(TABLE_SQL);
}

async function saveSessionDirToDB(authDir) {
  await ensureTable();
  if (!fs.existsSync(authDir)) return;
  const files = fs.readdirSync(authDir);
  const payload = {};
  for (const file of files) {
    const full = path.join(authDir, file);
    if (fs.statSync(full).isFile()) {
      const buf = fs.readFileSync(full);
      payload[file] = buf.toString('base64');
    }
  }
  await db.query(
    `INSERT INTO sessions (id, data, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [SESSION_ID, payload]
  );
}

async function restoreSessionDirFromDB(authDir) {
  await ensureTable();
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
  const { rows } = await db.query('SELECT data FROM sessions WHERE id = $1', [SESSION_ID]);
  if (!rows.length || !rows[0].data) return false;
  const payload = rows[0].data;
  for (const [file, b64] of Object.entries(payload)) {
    const full = path.join(authDir, file);
    fs.writeFileSync(full, Buffer.from(b64, 'base64'));
  }
  return true;
}

async function clearSessionInDB() {
  await ensureTable();
  await db.query('DELETE FROM sessions WHERE id = $1', [SESSION_ID]);
}

module.exports = {
  saveSessionDirToDB,
  restoreSessionDirFromDB,
  clearSessionInDB,
};