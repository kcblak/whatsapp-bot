import makeWASocket, { useSingleFileAuthState } from '@whiskeysockets/baileys'
import { loadSession, saveSession } from './supabase.js'
import fs from 'fs'
import dotenv from 'dotenv'
dotenv.config()

const AUTH_FILE = './auth_info.json'

async function startBot() {
  const existingSession = await loadSession()
  if (existingSession) fs.writeFileSync(AUTH_FILE, JSON.stringify(existingSession))

  const { state, saveState } = useSingleFileAuthState(AUTH_FILE)
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  })

  sock.ev.on('creds.update', () => {
    saveState()
    const sessionData = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    saveSession(sessionData)
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    const text = msg?.message?.conversation || ''

    if (text?.toLowerCase() === 'hi') {
      await sock.sendMessage(msg.key.remoteJid, {
        text: 'Hello from WhatsApp Bot 🤖'
      })
    }
  })
}

startBot()
