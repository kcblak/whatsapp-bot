import makeWASocket, { useSingleFileAuthState } from '@whiskeysockets/baileys'
import fs from 'fs'
import dotenv from 'dotenv'
import { loadSession, saveSession } from './supabase.js'

dotenv.config()

const AUTH_FILE = './auth_info.json'

async function startBot() {
  const session = await loadSession()
  if (session) fs.writeFileSync(AUTH_FILE, JSON.stringify(session))

  const { state, saveState } = useSingleFileAuthState(AUTH_FILE)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  })

  sock.ev.on('creds.update', () => {
    saveState()
    const updatedAuth = JSON.parse(fs.readFileSync(AUTH_FILE))
    saveSession(updatedAuth)
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    const text = msg?.message?.conversation || ''
    if (!text) return

    if (text.toLowerCase() === 'hi') {
      await sock.sendMessage(msg.key.remoteJid, {
        text: 'Hello from WhatsApp Bot 🤖'
      })
    }
  })
}

startBot()
