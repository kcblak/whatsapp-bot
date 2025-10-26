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
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const RESET_TOKEN = process.env.RESET_TOKEN || null;
const forceSetupFile = path.join(__dirname, '.force_setup');

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'whatsapp-bot-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true in production with HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

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

// Admin authentication system
const adminCredentialsFile = path.join(__dirname, 'admin-credentials.json');

// Load admin credentials
function loadAdminCredentials() {
    try {
        if (fs.existsSync(adminCredentialsFile)) {
            const data = fs.readFileSync(adminCredentialsFile, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        logger.error('Error loading admin credentials:', error);
    }
    return null;
}

// Save admin credentials
function saveAdminCredentials(username, hashedPassword) {
    try {
        const credentials = {
            username,
            password: hashedPassword,
            createdAt: new Date().toISOString()
        };
        fs.writeFileSync(adminCredentialsFile, JSON.stringify(credentials, null, 2));
        return true;
    } catch (error) {
        logger.error('Error saving admin credentials:', error);
        return false;
    }
}

// Check if admin setup is needed
function needsAdminSetup() {
    return !loadAdminCredentials();
}

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    } else {
        return res.status(401).json({ error: 'Authentication required' });
    }
}

// Redirect to login for HTML requests
function requireAuthOrRedirect(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    } else {
        const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
        if (acceptsHtml) {
            return res.redirect('/login');
        } else {
            return res.status(401).json({ error: 'Authentication required' });
        }
    }
}

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

// Advanced loader: returns entries with matchType and scope (backward compatible)
function loadBotResponseEntries() {
    const filePath = path.join(__dirname, 'bot-messages.txt');
    const entries = [];
    if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        for (const line of lines) {
            if (line.trim().length === 0 || line.startsWith('#')) continue;
            const parts = line.split('|');
            const rawKey = (parts[0] || '').trim();
            if (!rawKey) continue;
            const key = rawKey.startsWith(botConfig.prefix) ? rawKey.slice(botConfig.prefix.length) : rawKey;
            const response = String(parts[1] || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const matchType = ((parts[2] || '').trim().toLowerCase()) === 'contains' ? 'contains' : 'exact';
            const scopePart = (parts[3] || '').trim().toLowerCase();
            const scope = scopePart === 'group' ? 'group' : scopePart === 'dm' ? 'dm' : 'global';
            entries.push({ key, response, matchType, scope });
        }
    }
    return entries;
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
            case 'ai': {
                const prompt = args.join(' ').trim();
                if (!prompt) {
                    response = botResponses['ai'] || 'Provide a prompt: !ai your question';
                    break;
                }
                try {
                    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
                    const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';
                    const r = await fetch(`${ollamaUrl}/api/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model, prompt, stream: false })
                    });
                    if (!r.ok) {
                        throw new Error(`Ollama error ${r.status}`);
                    }
                    const data = await r.json();
                    response = data.response || '(no reply)';
                } catch (e) {
                    response = `Echo: ${prompt}`;
                }
                break;
            }
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

// Authentication Routes
app.get('/auth/setup-status', (req, res) => {
    res.json({ needsSetup: needsAdminSetup() });
});

app.post('/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const credentials = loadAdminCredentials();
        
        // First time setup
        if (!credentials) {
            if (username.length < 3) {
                return res.status(400).json({ error: 'Username must be at least 3 characters long' });
            }
            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters long' });
            }
            
            const hashedPassword = await bcrypt.hash(password, 10);
            if (saveAdminCredentials(username, hashedPassword)) {
                req.session.authenticated = true;
                req.session.username = username;
                logger.info(`Admin account created: ${username}`);
                return res.json({ success: true, setup: true, message: 'Admin account created successfully' });
            } else {
                return res.status(500).json({ error: 'Failed to create admin account' });
            }
        }
        
        // Regular login
        if (credentials.username === username) {
            const isValidPassword = await bcrypt.compare(password, credentials.password);
            if (isValidPassword) {
                req.session.authenticated = true;
                req.session.username = username;
                logger.info(`Admin logged in: ${username}`);
                return res.json({ success: true, message: 'Login successful' });
            }
        }
        
        return res.status(401).json({ error: 'Invalid username or password' });
    } catch (error) {
        logger.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/auth/logout', (req, res) => {
    if (req.session) {
        const username = req.session.username;
        req.session.destroy((err) => {
            if (err) {
                logger.error('Logout error:', err);
                return res.status(500).json({ error: 'Failed to logout' });
            }
            logger.info(`Admin logged out: ${username}`);
            res.json({ success: true, message: 'Logged out successfully' });
        });
    } else {
        res.json({ success: true, message: 'Already logged out' });
    }
});

// Serve login page
app.get('/login', (req, res) => {
    // If already authenticated, redirect to dashboard
    if (req.session && req.session.authenticated) {
        return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', (req, res) => {
    const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
    
    if (acceptsHtml) {
        // Redirect browsers to login page
        return res.redirect('/login');
    } else {
        // API response for non-browser requests
        res.json({
            status: 'WhatsApp Bot is running',
            connected: sock?.ws?.readyState === 1,
            qrCode: qrCode ? 'QR Code available at /qr' : 'Connected or no QR code needed'
        });
    }
});

app.get('/qr', async (req, res) => {
    const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
    
    if (acceptsHtml) {
        // Serve styled HTML page for browsers
        let qrImageData = '';
        let statusMessage = '';
        
        if (qrCode) {
            try {
                const qrPng = await qrcode.toDataURL(qrCode);
                qrImageData = qrPng;
                statusMessage = 'Scan the QR code with your WhatsApp to connect';
            } catch (err) {
                statusMessage = 'Failed to generate QR code image';
            }
        } else {
            statusMessage = 'No QR code available - Bot is already connected or starting up';
        }
        
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bot - QR Code</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        
        .container {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(20px);
            border-radius: 24px;
            padding: 40px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            text-align: center;
            max-width: 500px;
            width: 100%;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .header {
            background: linear-gradient(135deg, #25D366, #128C7E);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            font-size: 2rem;
            font-weight: 700;
            margin-bottom: 10px;
        }
        
        .subtitle {
            color: #64748b;
            font-size: 1rem;
            margin-bottom: 30px;
            font-weight: 400;
        }
        
        .qr-container {
            background: white;
            border-radius: 16px;
            padding: 20px;
            margin: 20px 0;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
        }
        
        .qr-image {
            max-width: 280px;
            width: 100%;
            height: auto;
            border-radius: 12px;
        }
        
        .status-message {
            color: #475569;
            font-size: 1rem;
            margin: 20px 0;
            line-height: 1.5;
        }
        
        .actions {
            display: flex;
            gap: 12px;
            justify-content: center;
            flex-wrap: wrap;
            margin-top: 30px;
        }
        
        .btn {
            padding: 12px 24px;
            border: none;
            border-radius: 12px;
            font-weight: 500;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease;
            cursor: pointer;
            font-size: 0.9rem;
        }
        
        .btn-primary {
            background: linear-gradient(135deg, #25D366, #128C7E);
            color: white;
        }
        
        .btn-secondary {
            background: rgba(100, 116, 139, 0.1);
            color: #475569;
            border: 1px solid rgba(100, 116, 139, 0.2);
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
        }
        
        .no-qr {
            color: #f59e0b;
            font-size: 1.1rem;
            font-weight: 500;
            margin: 20px 0;
        }
        
        @media (max-width: 480px) {
            .container {
                padding: 30px 20px;
            }
            
            .header {
                font-size: 1.5rem;
            }
            
            .actions {
                flex-direction: column;
            }
            
            .btn {
                width: 100%;
                justify-content: center;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1 class="header">WhatsApp Bot</h1>
        <p class="subtitle">QR Code Connection</p>
        
        ${qrImageData ? `
            <div class="qr-container">
                <img src="${qrImageData}" alt="WhatsApp QR Code" class="qr-image">
            </div>
            <p class="status-message">${statusMessage}</p>
        ` : `
            <div class="no-qr">${statusMessage}</div>
        `}
        
        <div class="actions">
            <a href="javascript:location.reload()" class="btn btn-primary">
                🔄 Refresh
            </a>
            <a href="/dashboard" class="btn btn-secondary">
                🏠 Dashboard
            </a>
            ${!qrCode ? `
                <a href="/reset-session${RESET_TOKEN ? '?token=' + RESET_TOKEN : ''}" class="btn btn-secondary">
                    🔄 Reset Session
                </a>
                <a href="/pairing-code" class="btn btn-secondary">
                    📱 Pairing Code
                </a>
            ` : ''}
        </div>
    </div>
    
    <script>
        // Auto-refresh every 10 seconds if no QR code
        ${!qrCode ? 'setTimeout(() => location.reload(), 10000);' : ''}
    </script>
</body>
</html>`;
        
        res.send(html);
    } else {
        // Original API behavior for non-browser requests
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

app.get('/status', requireAuthOrRedirect, (req, res) => {
    const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
    
    const statusData = {
        connected: sock?.ws?.readyState === 1,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    };
    
    if (acceptsHtml) {
        // Serve styled HTML page for browsers
        const formatUptime = (seconds) => {
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);
            
            if (days > 0) return `${days}d ${hours}h ${minutes}m`;
            if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
            if (minutes > 0) return `${minutes}m ${secs}s`;
            return `${secs}s`;
        };
        
        const formatMemory = (bytes) => {
            const mb = (bytes / 1024 / 1024).toFixed(1);
            return `${mb} MB`;
        };
        
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bot - Status</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        
        .header {
            text-align: center;
            margin-bottom: 40px;
        }
        
        .title {
            background: linear-gradient(135deg, #25D366, #128C7E);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 10px;
        }
        
        .subtitle {
            color: rgba(255, 255, 255, 0.8);
            font-size: 1.1rem;
            font-weight: 400;
        }
        
        .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .status-card {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(20px);
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            text-align: center;
            transition: transform 0.2s ease;
        }
        
        .status-card:hover {
            transform: translateY(-5px);
        }
        
        .status-icon {
            font-size: 2.5rem;
            margin-bottom: 15px;
            display: block;
        }
        
        .status-label {
            color: #64748b;
            font-size: 0.9rem;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
        }
        
        .status-value {
            color: #1e293b;
            font-size: 1.5rem;
            font-weight: 600;
            margin-bottom: 5px;
        }
        
        .status-detail {
            color: #64748b;
            font-size: 0.85rem;
        }
        
        .connected {
            color: #10b981;
        }
        
        .disconnected {
            color: #ef4444;
        }
        
        .actions {
            display: flex;
            gap: 15px;
            justify-content: center;
            flex-wrap: wrap;
            margin-top: 30px;
        }
        
        .btn {
            padding: 12px 24px;
            border: none;
            border-radius: 12px;
            font-weight: 500;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease;
            cursor: pointer;
            font-size: 0.9rem;
            background: rgba(255, 255, 255, 0.9);
            color: #475569;
            border: 1px solid rgba(255, 255, 255, 0.3);
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
            background: white;
        }
        
        .auto-refresh {
            text-align: center;
            color: rgba(255, 255, 255, 0.7);
            font-size: 0.85rem;
            margin-top: 20px;
        }
        
        @media (max-width: 768px) {
            .title {
                font-size: 2rem;
            }
            
            .status-grid {
                grid-template-columns: 1fr;
            }
            
            .actions {
                flex-direction: column;
                align-items: center;
            }
            
            .btn {
                width: 200px;
                justify-content: center;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 class="title">Bot Status</h1>
            <p class="subtitle">Real-time monitoring dashboard</p>
        </div>
        
        <div class="status-grid">
            <div class="status-card">
                <span class="status-icon">${statusData.connected ? '🟢' : '🔴'}</span>
                <div class="status-label">Connection</div>
                <div class="status-value ${statusData.connected ? 'connected' : 'disconnected'}">
                    ${statusData.connected ? 'Connected' : 'Disconnected'}
                </div>
                <div class="status-detail">WhatsApp WebSocket</div>
            </div>
            
            <div class="status-card">
                <span class="status-icon">⏱️</span>
                <div class="status-label">Uptime</div>
                <div class="status-value">${formatUptime(statusData.uptime)}</div>
                <div class="status-detail">Since last restart</div>
            </div>
            
            <div class="status-card">
                <span class="status-icon">💾</span>
                <div class="status-label">Memory Usage</div>
                <div class="status-value">${formatMemory(statusData.memory.rss)}</div>
                <div class="status-detail">RSS: ${formatMemory(statusData.memory.rss)} | Heap: ${formatMemory(statusData.memory.heapUsed)}</div>
            </div>
        </div>
        
        <div class="actions">
            <a href="/dashboard" class="btn">
                🏠 Dashboard
            </a>
            <a href="/qr" class="btn">
                📱 QR Code
            </a>
            <a href="/debug" class="btn">
                🔧 Debug Info
            </a>
        </div>
        
        <div class="auto-refresh">
            Auto-refreshing every 5 seconds...
        </div>
    </div>
    
    <script>
        // Auto-refresh every 5 seconds
        setInterval(async () => {
            try {
                const response = await fetch('/status', {
                    headers: { 'Accept': 'application/json' }
                });
                const data = await response.json();
                
                // Update connection status
                const connectionCard = document.querySelector('.status-grid .status-card:first-child');
                const connectionIcon = connectionCard.querySelector('.status-icon');
                const connectionValue = connectionCard.querySelector('.status-value');
                
                connectionIcon.textContent = data.connected ? '🟢' : '🔴';
                connectionValue.textContent = data.connected ? 'Connected' : 'Disconnected';
                connectionValue.className = 'status-value ' + (data.connected ? 'connected' : 'disconnected');
                
                // Update uptime
                const formatUptime = (seconds) => {
                    const days = Math.floor(seconds / 86400);
                    const hours = Math.floor((seconds % 86400) / 3600);
                    const minutes = Math.floor((seconds % 3600) / 60);
                    const secs = Math.floor(seconds % 60);
                    
                    if (days > 0) return \`\${days}d \${hours}h \${minutes}m\`;
                    if (hours > 0) return \`\${hours}h \${minutes}m \${secs}s\`;
                    if (minutes > 0) return \`\${minutes}m \${secs}s\`;
                    return \`\${secs}s\`;
                };
                
                const uptimeValue = document.querySelector('.status-grid .status-card:nth-child(2) .status-value');
                uptimeValue.textContent = formatUptime(data.uptime);
                
                // Update memory
                const formatMemory = (bytes) => {
                    const mb = (bytes / 1024 / 1024).toFixed(1);
                    return \`\${mb} MB\`;
                };
                
                const memoryCard = document.querySelector('.status-grid .status-card:nth-child(3)');
                const memoryValue = memoryCard.querySelector('.status-value');
                const memoryDetail = memoryCard.querySelector('.status-detail');
                
                memoryValue.textContent = formatMemory(data.memory.rss);
                memoryDetail.textContent = \`RSS: \${formatMemory(data.memory.rss)} | Heap: \${formatMemory(data.memory.heapUsed)}\`;
                
            } catch (error) {
                console.error('Failed to refresh status:', error);
            }
        }, 5000);
    </script>
</body>
</html>`;
        
        res.send(html);
    } else {
        // Original JSON response for API clients
        res.json(statusData);
    }
});

// Send message endpoint (for external integrations)
app.post('/send-message', requireAuth, async (req, res) => {
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

// Serve static dashboard assets
app.use(express.static(path.join(__dirname, 'public')));
app.get('/dashboard', requireAuthOrRedirect, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

function saveBotResponses(mapOrEntries) {
  const filePath = path.join(__dirname, 'bot-messages.txt');
  const lines = [];
  if (Array.isArray(mapOrEntries)) {
    for (const e of mapOrEntries) {
      const key = String(e.key || '').trim();
      const resp = String(e.response || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const matchType = e.matchType === 'contains' ? 'contains' : 'exact';
      const scope = e.scope === 'group' ? 'group' : (e.scope === 'dm' ? 'dm' : 'global');
      if (!key) continue;
      lines.push(`${key}|${resp}|${matchType}|${scope}`);
    }
  } else {
    for (const [cmd, resp] of Object.entries(mapOrEntries || {})) {
      const cleanCmd = String(cmd).trim();
      const cleanResp = String(resp).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (!cleanCmd) continue;
      lines.push(`${cleanCmd}|${cleanResp}|exact|global`);
    }
  }
  fs.writeFileSync(filePath, lines.join('\n'));
}

app.get('/bot-responses', requireAuth, (req, res) => {
  try {
    const entries = loadBotResponseEntries();
    res.json({ prefix: botConfig.prefix, entries });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read responses', message: e?.message || String(e) });
  }
});

app.post('/bot-responses', requireAuth, (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
    const map = req.body?.responses && typeof req.body.responses === 'object' ? req.body.responses : null;
    if (!entries && !map) {
      return res.status(400).json({ error: 'Provide entries array or responses map' });
    }
    saveBotResponses(entries || map);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save responses', message: e?.message || String(e) });
  }
});

app.post('/ai-reply', async (req, res) => {
  try {
    const prompt = (req.body?.prompt || '').trim();
    if (!prompt) {
      return res.status(400).json({ error: 'Provide { prompt: "text" }' });
    }
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';
    // Try local Ollama first
    try {
      const r = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false })
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Ollama error ${r.status}: ${t}`);
      }
      const data = await r.json();
      return res.json({ provider: 'ollama', model, reply: data.response });
    } catch (e) {
      // Fallback: simple rule-based echo to ensure zero-cost without dependencies
      const reply = `Echo: ${prompt}`;
      return res.json({ provider: 'fallback', reply, note: 'Install Ollama for AI replies: https://ollama.com/' });
    }
  } catch (error) {
    res.status(500).json({ error: 'AI reply failed', message: error?.message || String(error) });
  }
});