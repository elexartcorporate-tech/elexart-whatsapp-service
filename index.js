/**
 * WhatsApp Web Service for Elexart CRM
 * Version: 2.2.0 - Anti-Sleep & Stable Connection
 */

const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');
const WebSocket = require('ws');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const logger = pino({ level: 'info' });
const FASTAPI_URL = process.env.FASTAPI_URL || 'https://social-crm-hub-2.preview.emergentagent.com';
const PORT = process.env.PORT || 3002;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

let sock = null;
let qrCode = null;
let qrCodeBase64 = null;
let connectionStatus = 'disconnected';
let connectedUser = null;
let keepAliveInterval = null;
let selfPingInterval = null;
let reconnectAttempts = 0;
let lastActivityTime = Date.now();

const lidToPhoneMap = new Map();
const contactsStore = new Map();
const wsClients = new Set();

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;
const KEEP_ALIVE_INTERVAL = 45000; // 45s for WhatsApp presence
const SELF_PING_INTERVAL = 600000; // 10 minutes - self-ping to prevent Render.com sleep

function broadcastStatus() {
    const data = JSON.stringify({
        type: 'status',
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        reconnect_attempts: reconnectAttempts,
        user: connectedUser ? { id: connectedUser.id, name: connectedUser.name } : null,
        timestamp: new Date().toISOString()
    });
    wsClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
}

function startKeepAlive() {
    stopKeepAlive();
    keepAliveInterval = setInterval(async () => {
        if (sock && connectionStatus === 'connected') {
            try {
                await sock.sendPresenceUpdate('available');
                logger.info('Keep-alive sent (45s interval)');
            } catch (err) {
                // Don't trigger reconnect on keep-alive failure, just log it
                logger.warn('Keep-alive warning (non-critical):', err.message);
            }
        }
    }, KEEP_ALIVE_INTERVAL);
    logger.info('Keep-alive started (45s interval)');
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

// Self-ping to prevent Render.com from sleeping the service
function startSelfPing() {
    if (selfPingInterval) clearInterval(selfPingInterval);
    
    selfPingInterval = setInterval(async () => {
        try {
            // Ping our own endpoint to keep the service awake
            const response = await axios.get(`${SELF_URL}/ping`, { timeout: 10000 });
            logger.info(`Self-ping: OK (uptime: ${Math.floor(process.uptime())}s, status: ${connectionStatus})`);
            lastActivityTime = Date.now();
        } catch (err) {
            logger.warn(`Self-ping failed: ${err.message}`);
        }
    }, SELF_PING_INTERVAL);
    
    logger.info('Self-ping started (10 min interval) to prevent Render.com sleep');
}

function stopSelfPing() {
    if (selfPingInterval) {
        clearInterval(selfPingInterval);
        selfPingInterval = null;
    }
}

function getReconnectDelay() {
    return Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 120000);
}

async function initWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
        const { version } = await fetchLatestBaileysVersion();
        logger.info(`Starting WhatsApp with version ${version.join('.')}`);

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            browser: ['Elexart CRM', 'Chrome', '120.0.0'],
            logger: pino({ level: 'silent' }),
            version,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            retryRequestDelayMs: 1000,
            connectTimeoutMs: 90000,
            // REMOVED: keepAliveIntervalMs - using custom keep-alive instead to avoid conflict
            getMessage: async () => ({ conversation: '' })
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCode = qr;
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                    connectionStatus = 'waiting_scan';
                    broadcastStatus();
                    logger.info('QR Code ready');
                } catch (err) {
                    logger.error('QR error:', err);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                logger.info(`Disconnected. Code: ${statusCode}, Will reconnect: ${shouldReconnect}`);
                connectionStatus = 'disconnected';
                qrCode = null;
                qrCodeBase64 = null;
                connectedUser = null;
                stopKeepAlive();
                broadcastStatus();
                
                if (shouldReconnect) {
                    reconnectAttempts++;
                    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                        const delay = getReconnectDelay();
                        logger.info(`Reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay/1000}s`);
                        connectionStatus = 'reconnecting';
                        broadcastStatus();
                        setTimeout(initWhatsApp, delay);
                    } else {
                        connectionStatus = 'error';
                        broadcastStatus();
                        setTimeout(() => { reconnectAttempts = 0; initWhatsApp(); }, 300000);
                    }
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                qrCode = null;
                qrCodeBase64 = null;
                reconnectAttempts = 0;
                connectedUser = sock.user;
                logger.info(`Connected as ${sock.user?.name || sock.user?.id}`);
                startKeepAlive();
                broadcastStatus();
                try {
                    await axios.post(`${FASTAPI_URL}/api/whatsapp-web/connected`, {
                        phone: sock.user?.id?.split(':')[0] || '',
                        name: sock.user?.name || 'WhatsApp'
                    });
                } catch (e) { logger.warn('Backend notify failed'); }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (msg.message) await handleMessage(msg, msg.key.fromMe);
            }
        });
    } catch (error) {
        logger.error('Init error:', error);
        connectionStatus = 'error';
        reconnectAttempts++;
        if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            setTimeout(initWhatsApp, getReconnectDelay());
        }
    }
}

async function handleMessage(message, isFromMe = false) {
    try {
        const jid = message.key.remoteJid;
        let phone = jid.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');
        const name = message.pushName || '';
        
        if (jid.endsWith('@lid')) {
            const mapped = lidToPhoneMap.get(phone);
            if (mapped) phone = mapped;
        }
        
        phone = phone.replace(/\D/g, '');
        if (phone.startsWith('0')) phone = '62' + phone.substring(1);
        
        const text = message.message?.conversation ||
                    message.message?.extendedTextMessage?.text ||
                    message.message?.imageMessage?.caption || '';

        let referral = null;
        const ctx = message.message?.extendedTextMessage?.contextInfo || message.message?.imageMessage?.contextInfo;
        if (ctx?.externalAdReply) {
            const ad = ctx.externalAdReply;
            referral = { source_type: 'ctwa', title: ad.title || '', body: ad.body || '', source_url: ad.sourceUrl || '' };
        }

        let mediaType = null;
        if (message.message?.imageMessage) mediaType = 'image';
        else if (message.message?.videoMessage) mediaType = 'video';
        else if (message.message?.audioMessage) mediaType = 'audio';
        else if (message.message?.documentMessage) mediaType = 'document';

        if (!text && !mediaType) return;
        logger.info(`${isFromMe ? '→' : '←'} ${phone}: ${text.substring(0, 30)}`);
        contactsStore.set(jid, { phone, name, jid });

        try {
            const res = await axios.post(`${FASTAPI_URL}/api/whatsapp-web/message`, {
                phone_number: phone, message: text || `[${mediaType?.toUpperCase()}]`,
                message_id: message.key.id, timestamp: message.messageTimestamp,
                push_name: name, original_jid: jid, is_from_me: isFromMe, media_type: mediaType, referral
            });
            if (!isFromMe && res.data?.reply) await sendMessage(jid, res.data.reply);
        } catch (e) { logger.error('Backend error:', e.message); }
    } catch (e) { logger.error('Message handler error:', e); }
}

async function sendMessage(jid, text) {
    try {
        if (!sock || connectionStatus !== 'connected') throw new Error('Not connected');
        const target = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
        await sock.sendMessage(target, { text });
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

app.get('/qr', (req, res) => res.json({ qr: qrCode, qr_base64: qrCodeBase64, status: connectionStatus, reconnect_attempts: reconnectAttempts }));
app.get('/status', (req, res) => res.json({ status: connectionStatus, connected: connectionStatus === 'connected', reconnect_attempts: reconnectAttempts, user: connectedUser ? { id: connectedUser.id, name: connectedUser.name } : null }));
app.get('/health', (req, res) => res.json({ status: 'ok', wa_status: connectionStatus, reconnect_attempts: reconnectAttempts, uptime: process.uptime(), timestamp: new Date().toISOString() }));
app.get('/ping', (req, res) => res.json({ pong: true }));

app.post('/send', async (req, res) => {
    const { phone_number, message } = req.body;
    if (!phone_number || !message) return res.status(400).json({ error: 'Missing params' });
    res.json(await sendMessage(phone_number, message));
});

app.post('/logout', async (req, res) => {
    try {
        stopKeepAlive();
        if (sock) await sock.logout();
        connectionStatus = 'disconnected'; connectedUser = null; qrCode = null; qrCodeBase64 = null;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/reconnect', async (req, res) => {
    try {
        // Only reconnect if truly disconnected, avoid reconnect loops
        if (connectionStatus === 'connected') {
            return res.json({ success: true, message: 'Already connected, skipping reconnect' });
        }
        
        stopKeepAlive();
        if (sock) sock.end();
        connectionStatus = 'reconnecting'; reconnectAttempts = 0;
        await initWhatsApp();
        res.json({ success: true, message: 'Reconnecting...' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Alias for backward compatibility with backend monitor
app.post('/auto-reconnect', async (req, res) => {
    // Only auto-reconnect if in error state, not during normal reconnection
    if (connectionStatus === 'connected' || connectionStatus === 'reconnecting' || connectionStatus === 'waiting_scan') {
        return res.json({ success: true, message: `Skipped auto-reconnect, current status: ${connectionStatus}` });
    }
    
    try {
        stopKeepAlive();
        if (sock) sock.end();
        connectionStatus = 'reconnecting'; reconnectAttempts = 0;
        await initWhatsApp();
        res.json({ success: true, message: 'Auto-reconnecting...' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/reset-auth', async (req, res) => {
    try {
        stopKeepAlive();
        if (sock) sock.end();
        if (fs.existsSync('./auth_info')) fs.rmSync('./auth_info', { recursive: true, force: true });
        connectionStatus = 'disconnected'; qrCode = null; qrCodeBase64 = null; reconnectAttempts = 0;
        setTimeout(initWhatsApp, 1000);
        res.json({ success: true, message: 'Auth reset. Scan QR again.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/contacts', (req, res) => res.json({ contacts: Array.from(contactsStore.values()) }));

// Uptime and diagnostics endpoint
app.get('/diagnostics', (req, res) => res.json({
    version: '2.2.0',
    uptime: process.uptime(),
    uptime_human: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
    wa_status: connectionStatus,
    connected_user: connectedUser ? connectedUser.name : null,
    reconnect_attempts: reconnectAttempts,
    last_activity: new Date(lastActivityTime).toISOString(),
    memory: process.memoryUsage(),
    self_url: SELF_URL
}));

const server = app.listen(PORT, () => { 
    logger.info(`WhatsApp Service v2.2.0 on port ${PORT}`); 
    initWhatsApp();
    // Start self-ping after 1 minute to allow service to fully start
    setTimeout(startSelfPing, 60000);
});
const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection', (ws) => {
    wsClients.add(ws);
    lastActivityTime = Date.now();
    ws.send(JSON.stringify({ type: 'status', status: connectionStatus, connected: connectionStatus === 'connected', user: connectedUser ? { id: connectedUser.id, name: connectedUser.name } : null }));
    ws.on('close', () => wsClients.delete(ws));
});
