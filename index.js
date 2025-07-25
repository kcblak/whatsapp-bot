// index.js
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require("qrcode");
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

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
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        sock = makeWASocket({
            auth: state,
            logger: logger,
            printQRInTerminal: false, // We'll handle QR code differently for web deployment
            browser: ['My WhatsApp Bot', 'Chrome', '1.0.0'],
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            getMessage: async (key) => {
                // This is important for poll votes and other features
                return null;
            }
        });
        
        // Handle connection updates
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
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
        sock.ev.on('creds.update', saveCreds);
        
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

// Start server
app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    connectToWhatsApp();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    if (sock) {
        await sock.logout();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Shutting down gracefully...');
    if (sock) {
        await sock.logout();
    }
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Keep-alive interval to prevent inactivity
setInterval(async () => {
    try {
        logger.info('Performing health check ping...');
        const response = await fetch('https://messenger.ukporpatriotsuk.org/health', {
            method: 'GET',
            timeout: 20000
        });
        logger.info(`Health check ping status: ${response.status}`);
    } catch (error) {
        logger.error('Health check ping failed:', error.message);
    }
}, 60000); // every minute