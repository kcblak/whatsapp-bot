import pkg from 'pg'
import dotenv from 'dotenv'
dotenv.config()

const { Pool } = pkg
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

export async function loadSession() {
  try {
    const res = await pool.query('SELECT data FROM sessions WHERE id = $1 LIMIT 1', ['whatsapp'])
    return res.rows[0]?.data || null
  } catch (err) {
    console.error('Error loading session:', err.message)
    return null
  }
}

export async function saveSession(authData) {
  try {
    await pool.query(
      'INSERT INTO sessions (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()',
      ['whatsapp', authData]
    )
  } catch (err) {
    console.error('Error saving session:', err.message)
  }
}
