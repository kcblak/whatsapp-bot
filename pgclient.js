import pkg from 'pg'
const { Pool } = pkg

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }
})

export async function loadSession() {
  const res = await pool.query("SELECT data FROM sessions WHERE id = 'whatsapp' LIMIT 1")
  return res.rows[0]?.data || null
}

export async function saveSession(authData) {
  await pool.query(
    `INSERT INTO sessions (id, data, updated_at)
     VALUES ('whatsapp', $1, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [authData]
  )
}