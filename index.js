// index.js
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require("qrcode");
const fetch = require('node-fetch');
const dotenv = require('dotenv');
dotenv.config();
const { Pool } = require('pg');
const { saveSessionDirToDB, restoreSessionDirFromDB, clearSessionInDB } = require('./db-session');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const RESET_TOKEN = process.env.RESET_TOKEN || null;
const forceSetupFile = path.join(__dirname, '.force_setup');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store for the WhatsApp socket
let sock = null;
let qrCode = null;

// Logger configuration
const logger = pino({ level: 'info' });

// Auth state directory
const authDir = './auth_info_baileys';

// Ensure auth directory exists
if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
}

// Helper to clear Baileys auth directory
function clearAuthDirectory() {
    try {
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }
        fs.mkdirSync(authDir, { recursive: true });
        logger.info('Auth directory cleared successfully.');
    } catch (err) {
        logger.error('Failed to clear auth directory:', err);
        throw err;
    }
}

// Bot configuration
const botConfig = {
    botName: 'My WhatsApp Bot',
    ownerNumber: process.env.OWNER_NUMBER || '1234567890', // Set your number in environment variables
    prefix: '!',
    responses: {
        welcome: 'Hello! I am a WhatsApp bot. Type !help for commands.',
        help: `Available commands:
!help - Show this help message
!ping - Check if bot is online
!echo <message> - Echo your message
!time - Get current time
!info - Get bot information`,
        ping: 'Pong! Bot is online 🤖',
        info: 'I am a WhatsApp bot built with Baileys and deployed on Render.',
        unknown: 'Unknown command. Type !help for available commands.'
    }
};

// Message handler function
// Utility to load responses from file
function loadBotResponses() {
    const filePath = path.join(__dirname, 'bot-messages.txt');
    const responses = {};
    if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        for (const line of lines) {
            if (line.trim().length === 0 || line.startsWith('#')) continue;
            const [cmd, ...respArr] = line.split('|');
            if (cmd && respArr.length > 0) {
                // Remove the prefix if it exists, then store without prefix
                const cleanCmd = cmd.trim().startsWith(botConfig.prefix) 
                    ? cmd.trim().slice(botConfig.prefix.length) 
                    : cmd.trim();
                responses[cleanCmd] = respArr.join('|').trim();
            }
        }
    }
    return responses;
}

// Utility to log incoming messages
function logIncomingMessage(sender, message) {
    const filePath = path.join(__dirname, 'incoming-messages.txt');
    const logLine = `${new Date().toISOString()} | ${sender} | ${message}\n`;
    fs.appendFileSync(filePath, logLine);
}

async function handleMessage(message) {
    try {
        const messageText = message.message?.conversation || 
                           message.message?.extendedTextMessage?.text || '';
        const senderNumber = message.key.remoteJid;
        const isGroup = senderNumber.endsWith('@g.us');
        const isFromMe = message.key.fromMe;
        if (isFromMe) return;
        
        logger.info(`Message from ${senderNumber}: ${messageText}`);
        logIncomingMessage(senderNumber, messageText);
        const botResponses = loadBotResponses();

        // Check for micro influencer message
        if (messageText.toLowerCase().includes('micro influencer')) {
            const response = botResponses['micro influencer'] || 'Please contact the admin for more information.';
            // Replace \n with actual line breaks
            const formattedResponse = response.replace(/\\n/g, '\n');
            await sock.sendMessage(senderNumber, { text: formattedResponse });
            return;
        }

        if (!messageText.startsWith(botConfig.prefix)) {
            if (!isGroup && messageText.toLowerCase().includes('hello')) {
                await sock.sendMessage(senderNumber, { text: botResponses['welcome'] || botConfig.responses.welcome });
            }
            return;
        }

        const args = messageText.slice(botConfig.prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        let response = '';
        switch (command) {
            case 'help':
                response = botResponses['help'] || botConfig.responses.help;
                break;
            case 'ping':
                response = botResponses['ping'] || botConfig.responses.ping;
                break;
            case 'echo':
                response = args.length > 0 ? args.join(' ') : (botResponses['echo'] || 'Please provide a message to echo.');
                break;
            case 'time':
                response = (botResponses['time'] || '').replace('{time}', new Date().toLocaleString());
                break;
            case 'info':
                response = botResponses['info'] || botConfig.responses.info;
                break;
            case 'status':
                if (senderNumber.includes(botConfig.ownerNumber)) {
                    response = `Bot Status: Online\nUptime: ${process.uptime()} seconds\nMemory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`;
                } else {
                    response = 'You are not authorized to use this command.';
                }
                break;
            default:
                response = botResponses['unknown'] || botConfig.responses.unknown;
        }
        await sock.sendMessage(senderNumber, { text: response });
    } catch (error) {
        logger.error('Error handling message:', error);
    }
}

// Connect to WhatsApp
async function connectToWhatsApp() {
    try {
        // Try restoring session files from Postgres before initializing Baileys state
        try {
            await restoreSessionDirFromDB(authDir);
        } catch (e) {
            logger.warn('Failed to restore session from DB:', e?.message || e);
        }
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            auth: state,
            logger: logger,
            version,
            // printQRInTerminal deprecated; handle via connection.update
            browser: ['My WhatsApp Bot', 'Chrome', '1.0.0'],
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            getMessage: async (key) => {
                return null;
            }
        });
        
        // Handle connection updates
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            // Expanded logging for diagnostics
            try {
                logger.info({ updateKeys: Object.keys(update || {}) }, 'connection.update keys');
                if (lastDisconnect?.error) {
                    const code = lastDisconnect.error?.output?.statusCode;
                    logger.warn({ code, err: String(lastDisconnect.error) }, 'lastDisconnect error');
                }
            } catch (e) {
                logger.warn('connection.update logging failed:', e?.message || e);
            }
            if (qr) {
                qrCode = qr;
                logger.info('QR Code generated, scan it with your phone');
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;
                logger.info('Connection closed due to', lastDisconnect?.error, ', reconnecting', shouldReconnect);
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                logger.info('WhatsApp connection opened successfully');
                qrCode = null;
            }
        });
        
        // Handle credentials update
        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
            } catch (e) {
                logger.warn('Failed to save Baileys creds:', e?.message || e);
            }
            try {
                await saveSessionDirToDB(authDir);
            } catch (e) {
                logger.warn('Failed to backup session to DB:', e?.message || e);
            }
        });
        
        // Handle incoming messages
        sock.ev.on('messages.upsert', async (messageUpdate) => {
            const { messages } = messageUpdate;
            
            for (const message of messages) {
                await handleMessage(message);
            }
        });
        
        // Handle message updates (for read receipts, etc.)
        sock.ev.on('messages.update', (updates) => {
            for (const update of updates) {
                logger.info('Message update:', update);
            }
        });
        
        // Handle group updates
        sock.ev.on('groups.update', (updates) => {
            for (const update of updates) {
                logger.info('Group update:', update);
            }
        });
        
    } catch (error) {
        logger.error('Error connecting to WhatsApp:', error);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        status: 'WhatsApp Bot is running',
        connected: sock?.ws?.readyState === 1,
        qrCode: qrCode ? 'QR Code available at /qr' : 'Connected or no QR code needed'
    });
});

app.get('/qr', async (req, res) => {
    if (qrCode) {
        try {
            const qrPng = await qrcode.toBuffer(qrCode, { type: 'png' });
            res.setHeader('Content-Type', 'image/png');
            res.send(qrPng);
        } catch (err) {
            res.status(500).json({ error: 'Failed to generate QR code image' });
        }
    } else {
        res.json({ message: 'No QR code available or already connected' });
    }
});

// Securely reset session to force a new QR
app.all('/reset-session', async (req, res) => {
    try {
        const token = req.query.token || req.headers['x-reset-token'];
        if (RESET_TOKEN && token !== RESET_TOKEN) {
            return res.status(403).json({ error: 'Forbidden: invalid token' });
        }

        // Logout if connected
        if (sock) {
            try {
                await sock.logout();
            } catch (e) {
                logger.warn('Logout encountered an issue, proceeding to clear auth:', e?.message || e);
            }
            sock = null;
        }

        // Clear auth files and DB backup, then restart connection
        clearAuthDirectory();
        try { await clearSessionInDB(); } catch (e) { logger.warn('Failed to clear DB session:', e?.message || e); }
        qrCode = null;
        await connectToWhatsApp();
        res.json({ success: true, message: 'Session reset. Visit /qr to scan.' });
    } catch (error) {
        logger.error('Error resetting session:', error);
        res.status(500).json({ error: 'Failed to reset session' });
    }
});

app.all('/reset-setup', async (req, res) => {
    try {
        const token = req.query.token || req.headers['x-reset-token'];
        if (RESET_TOKEN && token !== RESET_TOKEN) {
            return res.status(403).json({ error: 'Forbidden: invalid token' });
        }

        // Best effort logout and clear runtime state
        if (sock) {
            try { await sock.logout(); } catch (e) { logger.warn('Logout issue on reset-setup:', e?.message || e); }
            sock = null;
        }
        try { clearAuthDirectory(); } catch (e) { logger.warn('Failed to clear auth dir on reset-setup:', e?.message || e); }
        try { await clearSessionInDB(); } catch (e) { logger.warn('Failed to clear DB session on reset-setup:', e?.message || e); }

        // Remove .env to force missing env vars
        const envPath = path.join(__dirname, '.env');
        try {
            if (fs.existsSync(envPath)) {
                fs.rmSync(envPath, { force: true });
            }
        } catch (e) {
            logger.warn('Failed to remove .env on reset-setup:', e?.message || e);
        }

        // Create a force setup flag file so /setup appears even if cPanel env vars exist
        try { fs.writeFileSync(forceSetupFile, '1'); } catch (e) { logger.warn('Failed to write force setup flag:', e?.message || e); }

        res.json({ success: true, message: 'Setup reset. App will restart; visit /setup.' });
        setTimeout(() => process.exit(0), 500);
    } catch (error) {
        logger.error('Error resetting setup:', error);
        res.status(500).json({ error: 'Failed to reset setup' });
    }
});

app.get('/status', (req, res) => {
    res.json({
        connected: sock?.ws?.readyState === 1,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    });
});

// Send message endpoint (for external integrations)
app.post('/send-message', async (req, res) => {
    try {
        const { number, message } = req.body;
        
        if (!number || !message) {
            return res.status(400).json({ error: 'Number and message are required' });
        }
        
        if (!sock || sock.ws.readyState !== 1) {
            return res.status(503).json({ error: 'WhatsApp not connected' });
        }
        
        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        logger.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Debug endpoint
app.get('/debug', async (req, res) => {
  try {
    const token = req.query.token || req.headers['x-reset-token'];
    if (RESET_TOKEN && token !== RESET_TOKEN) {
      return res.status(403).json({ error: 'Forbidden: invalid token' });
    }
    let authFiles = 0;
    try {
      if (fs.existsSync(authDir)) {
        authFiles = fs.readdirSync(authDir).length;
      }
    } catch {}
    let rowCount = null;
    try {
      const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM sessions');
      rowCount = rows?.[0]?.c ?? null;
    } catch (e) {
      rowCount = `error: ${e?.message || String(e)}`;
    }
    const readyState = sock?.ws?.readyState ?? null;
    res.json({
      connected: readyState === 1,
      readyState,
      qrAvailable: Boolean(qrCode),
      authFiles,
      sessionRows: rowCount,
      env: {
        host: process.env.PGHOST,
        db: process.env.PGDATABASE,
        user: process.env.PGUSER,
        ssl: process.env.PGSSL,
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'debug failed', message: error?.message || String(error) });
  }
});
app.get('/pairing-code', async (req, res) => {
  try {
    const token = req.query.token || req.headers['x-reset-token'];
    if (RESET_TOKEN && token !== RESET_TOKEN) {
      return res.status(403).json({ error: 'Forbidden: invalid token' });
    }
    if (!sock) {
      return res.status(503).json({ error: 'Socket not initialized' });
    }
    const phone = (req.query.phone || process.env.OWNER_NUMBER || '').replace(/\D/g, '');
    if (!phone) {
      return res.status(400).json({ error: 'Missing phone number. Provide ?phone=234xxxxxxxxxx' });
    }
    let code;
    try {
      code = await sock.requestPairingCode(phone);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to request pairing code', message: e?.message || String(e) });
    }
    res.json({ success: true, phone, code });
  } catch (error) {
    logger.error('Error generating pairing code:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});
app.listen(PORT, async () => {
  logger.info(`Server listening on port ${PORT}`);
  try {
    await connectToWhatsApp();
  } catch (e) {
    logger.error('Initial WhatsApp connection failed:', e?.message || e);
  }
});