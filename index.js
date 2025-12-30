const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const logger = pino({ level: 'info' });

const FASTAPI_URL = process.env.FASTAPI_URL || 'http://localhost:8001';
const PORT = process.env.PORT || 3002;

let sock = null;
let qrCode = null;
let qrCodeBase64 = null;
let connectionStatus = 'disconnected';
let connectedUser = null;

// Store untuk mapping LID ke nomor telepon asli
const lidToPhoneMap = new Map();
// Store contacts from messages
const contactsStore = new Map();

// ========== ENHANCED KEEP-ALIVE MECHANISM ==========
let keepAliveInterval = null;
let healthCheckInterval = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 15; // Increased from 10
const BASE_RECONNECT_DELAY = 3000; // Reduced from 5000
const KEEP_ALIVE_INTERVAL = 20000; // 20 seconds (was 30)
const HEALTH_CHECK_INTERVAL = 60000; // 1 minute

// WebSocket clients for real-time status
const wsClients = new Set();

function broadcastStatus() {
    const statusData = JSON.stringify({
        type: 'status',
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        reconnect_attempts: reconnectAttempts,
        user: connectedUser ? {
            id: connectedUser.id,
            name: connectedUser.name
        } : null,
        timestamp: new Date().toISOString()
    });
    
    wsClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(statusData);
        }
    });
}

function startKeepAlive() {
    // Clear any existing intervals
    stopKeepAlive();
    
    // Send presence update every 20 seconds to keep connection alive
    keepAliveInterval = setInterval(async () => {
        if (sock && connectionStatus === 'connected') {
            try {
                // Send presence update to keep session alive
                await sock.sendPresenceUpdate('available');
                logger.info('Keep-alive: Presence update sent');
                
                // Also refresh connection state
                if (sock.ws) {
                    sock.ws.ping();
                }
            } catch (err) {
                logger.warn('Keep-alive failed:', err.message);
                
                // If keep-alive fails, trigger reconnect
                if (connectionStatus === 'connected') {
                    logger.info('Keep-alive failed, triggering reconnect...');
                    connectionStatus = 'reconnecting';
                    broadcastStatus();
                    initWhatsApp();
                }
            }
        }
    }, KEEP_ALIVE_INTERVAL);
    
    // Health check every 1 minute - verify connection is really alive
    healthCheckInterval = setInterval(async () => {
        if (sock && connectionStatus === 'connected') {
            try {
                // Check if socket is still alive
                const isAlive = sock.ws && sock.ws.readyState === WebSocket.OPEN;
                if (!isAlive) {
                    logger.warn('WebSocket not alive, reconnecting...');
                    connectionStatus = 'reconnecting';
                    broadcastStatus();
                    initWhatsApp();
                } else {
                    logger.info('Health check: Connection is alive');
                }
            } catch (err) {
                logger.error('Health check error:', err.message);
            }
        }
    }, HEALTH_CHECK_INTERVAL);
    
    logger.info('Keep-alive and health check started');
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }
    logger.info('Keep-alive stopped');
}

function getReconnectDelay() {
    // Exponential backoff: 3s, 6s, 12s, 24s, ... up to max 2 minutes
    const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 120000);
    return delay;
}

async function initWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
        const { version, isLatest } = await fetchLatestBaileysVersion();
        
        logger.info(`Using WA version: ${version.join('.')}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            browser: ['Elexart CRM', 'Chrome', '120.0.0'],
            logger: pino({ level: 'silent' }),
            version,
            // ========== STABILITY IMPROVEMENTS ==========
            syncFullHistory: false, // Don't sync full history to reduce load
            generateHighQualityLinkPreview: false, // Reduce processing
            markOnlineOnConnect: true, // Mark online when connected
            retryRequestDelayMs: 250, // Delay between retries
            getMessage: async (key) => {
                return { conversation: '' };
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCode = qr;
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                    connectionStatus = 'waiting_scan';
                    broadcastStatus();
                    logger.info('QR Code generated - waiting for scan');
                } catch (err) {
                    logger.error('QR generation error:', err);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                logger.info(`Connection closed. Status: ${statusCode}, Reconnecting: ${shouldReconnect}`);
                connectionStatus = 'disconnected';
                qrCode = null;
                qrCodeBase64 = null;
                connectedUser = null;
                
                // Stop keep-alive when disconnected
                stopKeepAlive();
                broadcastStatus();
                
                if (shouldReconnect) {
                    reconnectAttempts++;
                    
                    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                        const delay = getReconnectDelay();
                        logger.info(`Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay/1000}s`);
                        connectionStatus = 'reconnecting';
                        broadcastStatus();
                        setTimeout(initWhatsApp, delay);
                    } else {
                        logger.error('Max reconnect attempts reached. Manual intervention required.');
                        connectionStatus = 'error';
                        broadcastStatus();
                        
                        // Auto-reset after 5 minutes if max attempts reached
                        setTimeout(() => {
                            logger.info('Auto-reset: Trying to reconnect after cooldown');
                            reconnectAttempts = 0;
                            initWhatsApp();
                        }, 300000); // 5 minutes
                    }
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                qrCode = null;
                qrCodeBase64 = null;
                reconnectAttempts = 0; // Reset reconnect counter on successful connection
                
                const user = sock.user;
                connectedUser = user;
                logger.info('WhatsApp connected successfully!');
                
                // Start keep-alive mechanism
                startKeepAlive();
                broadcastStatus();
                
                try {
                    await axios.post(`${FASTAPI_URL}/api/whatsapp-web/connected`, {
                        phone: user?.id?.split(':')[0] || '',
                        name: user?.name || 'WhatsApp User'
                    });
                } catch (err) {
                    logger.error('Error notifying backend:', err.message);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Handle ALL messages - incoming AND outgoing (sent from phone)
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            
            for (const message of messages) {
                if (message.message) {
                    const isFromMe = message.key.fromMe;
                    await handleIncomingMessage(message, isFromMe);
                }
            }
        });

        sock.ev.on('contacts.update', (contacts) => {
            for (const contact of contacts) {
                if (contact.id && contact.lid) {
                    const phone = contact.id.replace('@s.whatsapp.net', '');
                    lidToPhoneMap.set(contact.lid.replace('@lid', ''), phone);
                    logger.info(`Mapped LID ${contact.lid} to phone ${phone}`);
                }
            }
        });

    } catch (error) {
        logger.error('WhatsApp initialization error:', error);
        connectionStatus = 'error';
        
        // Retry with exponential backoff
        reconnectAttempts++;
        if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            const delay = getReconnectDelay();
            logger.info(`Init error. Retry ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay/1000}s`);
            setTimeout(initWhatsApp, delay);
        }
    }
}

async function handleIncomingMessage(message, isFromMe = false) {
    try {
        const remoteJid = message.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');
        const isLid = remoteJid.endsWith('@lid');
        
        let phoneNumber = remoteJid
            .replace('@s.whatsapp.net', '')
            .replace('@g.us', '')
            .replace('@lid', '');
        
        const pushName = message.pushName || '';
        
        // Try to resolve LID to actual phone number
        if (isLid) {
            const mappedPhone = lidToPhoneMap.get(phoneNumber);
            if (mappedPhone) {
                phoneNumber = mappedPhone;
                logger.info(`Resolved LID from map: ${phoneNumber}`);
            } else {
                if (message.key.participant) {
                    const participantPhone = message.key.participant.replace('@s.whatsapp.net', '').replace('@lid', '');
                    if (participantPhone.length <= 15) {
                        phoneNumber = participantPhone;
                        lidToPhoneMap.set(remoteJid.replace('@lid', ''), phoneNumber);
                        logger.info(`Got phone from participant: ${phoneNumber}`);
                    }
                }
                
                if (message.verifiedBizName) {
                    const match = message.verifiedBizName.match(/\d{10,15}/);
                    if (match) {
                        phoneNumber = match[0];
                        lidToPhoneMap.set(remoteJid.replace('@lid', ''), phoneNumber);
                        logger.info(`Got phone from verifiedBizName: ${phoneNumber}`);
                    }
                }
                
                if (phoneNumber.length > 15) {
                    try {
                        const results = await sock.fetchStatus(remoteJid);
                        if (results && results.status) {
                            logger.info(`Got status for ${remoteJid}: ${JSON.stringify(results)}`);
                        }
                    } catch (e) {
                        // Ignore errors
                    }
                }
            }
        }
        
        phoneNumber = phoneNumber.replace(/\D/g, '');
        
        if (phoneNumber.startsWith('0')) {
            phoneNumber = '62' + phoneNumber.substring(1);
        }
        
        const messageText = message.message?.conversation ||
                           message.message?.extendedTextMessage?.text ||
                           message.message?.imageMessage?.caption ||
                           '';

        // ========== CAPTURE CLICK-TO-WHATSAPP ADS (CTWA) ==========
        let referral = null;
        let contextInfo = null;
        let quotedMessage = null;
        
        // Get context from extendedTextMessage (most common for CTWA)
        if (message.message?.extendedTextMessage?.contextInfo) {
            contextInfo = message.message.extendedTextMessage.contextInfo;
        }
        if (!contextInfo && message.message?.imageMessage?.contextInfo) {
            contextInfo = message.message.imageMessage.contextInfo;
        }
        if (!contextInfo && message.message?.videoMessage?.contextInfo) {
            contextInfo = message.message.videoMessage.contextInfo;
        }
        
        // Extract referral from context (Click-to-WhatsApp Ads)
        if (contextInfo) {
            if (contextInfo.externalAdReply) {
                const adReply = contextInfo.externalAdReply;
                referral = {
                    source_type: 'ctwa',
                    title: adReply.title || '',
                    body: adReply.body || '',
                    thumbnail_url: adReply.thumbnailUrl || adReply.previewType || '',
                    media_url: adReply.mediaUrl || '',
                    source_url: adReply.sourceUrl || '',
                    source_id: adReply.sourceId || '',
                    containsAutoReply: adReply.containsAutoReply || false,
                    renderLargerThumbnail: adReply.renderLargerThumbnail || false
                };
                logger.info(`📢 CTWA Ad detected! Title: ${referral.title}, URL: ${referral.source_url}`);
            }
            
            if (contextInfo.isForwarded) {
                if (!referral) referral = {};
                referral.is_forwarded = true;
                referral.forwarding_score = contextInfo.forwardingScore || 0;
            }
            
            if (contextInfo.quotedMessage) {
                quotedMessage = {
                    text: contextInfo.quotedMessage.conversation || 
                          contextInfo.quotedMessage.extendedTextMessage?.text || '',
                    stanza_id: contextInfo.stanzaId || '',
                    participant: contextInfo.participant || ''
                };
            }
        }
        
        // Also check message-level context
        if (message.contextInfo) {
            if (message.contextInfo.externalAdReply && !referral) {
                const adReply = message.contextInfo.externalAdReply;
                referral = {
                    source_type: 'ctwa',
                    title: adReply.title || '',
                    body: adReply.body || '',
                    thumbnail_url: adReply.thumbnailUrl || '',
                    media_url: adReply.mediaUrl || '',
                    source_url: adReply.sourceUrl || ''
                };
                logger.info(`📢 CTWA Ad (message level)! Title: ${referral.title}`);
            }
        }

        // Handle media messages
        let mediaType = null;
        
        if (message.message?.imageMessage) {
            mediaType = 'image';
        } else if (message.message?.videoMessage) {
            mediaType = 'video';
        } else if (message.message?.audioMessage) {
            mediaType = 'audio';
        } else if (message.message?.documentMessage) {
            mediaType = 'document';
        } else if (message.message?.stickerMessage) {
            mediaType = 'sticker';
        }

        if (!messageText && !mediaType) return;

        const displayPhone = phoneNumber.length > 15 ? `LID:${phoneNumber.substring(0,8)}...` : phoneNumber;
        
        const msgDirection = isFromMe ? 'OUTGOING (from phone)' : 'INCOMING';
        logger.info(`${msgDirection} message ${isFromMe ? 'to' : 'from'} ${displayPhone} (jid: ${remoteJid}): ${messageText.substring(0, 50)}...`);
        
        if (referral) {
            logger.info(`📢 Referral data: ${JSON.stringify(referral)}`);
        }

        contactsStore.set(remoteJid, {
            id: remoteJid,
            phone: phoneNumber,
            name: pushName || phoneNumber,
            jid: remoteJid,
            isLid: isLid
        });

        // Forward to FastAPI backend with all context data
        try {
            const response = await axios.post(`${FASTAPI_URL}/api/whatsapp-web/message`, {
                phone_number: phoneNumber,
                message: messageText || (mediaType ? `[${mediaType.toUpperCase()}]` : ''),
                message_id: message.key.id,
                timestamp: message.messageTimestamp,
                is_group: isGroup,
                push_name: pushName,
                original_jid: remoteJid,
                is_lid: isLid,
                is_from_me: isFromMe,
                media_type: mediaType,
                referral: referral,
                quoted_message: quotedMessage,
                is_forwarded: referral?.is_forwarded || false
            });

            if (!isFromMe && response.data?.reply) {
                await sendMessage(remoteJid, response.data.reply);
            }
        } catch (err) {
            logger.error('Error forwarding to backend:', err.message);
        }

    } catch (error) {
        logger.error('Error handling incoming message:', error);
    }
}

async function sendMessage(jid, text) {
    try {
        if (!sock || connectionStatus !== 'connected') {
            throw new Error('WhatsApp not connected');
        }

        let formattedJid = jid;
        if (!jid.includes('@')) {
            formattedJid = `${jid}@s.whatsapp.net`;
        }
        
        await sock.sendMessage(formattedJid, { text });
        logger.info(`Message sent to ${formattedJid}`);
        return { success: true };

    } catch (error) {
        logger.error('Error sending message:', error);
        return { success: false, error: error.message };
    }
}

// REST API Endpoints
app.get('/qr', async (req, res) => {
    res.json({ 
        qr: qrCode,
        qr_base64: qrCodeBase64,
        status: connectionStatus,
        reconnect_attempts: reconnectAttempts
    });
});

app.get('/status', (req, res) => {
    res.json({
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        reconnect_attempts: reconnectAttempts,
        user: connectedUser ? {
            id: connectedUser.id,
            name: connectedUser.name
        } : null
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        wa_status: connectionStatus,
        reconnect_attempts: reconnectAttempts,
        uptime: process.uptime(),
        keep_alive_active: keepAliveInterval !== null,
        health_check_active: healthCheckInterval !== null
    });
});

// Enhanced ping endpoint to keep service warm
app.get('/ping', (req, res) => {
    res.json({ pong: true, timestamp: Date.now() });
});

// Auto-reconnect endpoint - triggered by external monitor
app.post('/auto-reconnect', async (req, res) => {
    if (connectionStatus === 'disconnected' || connectionStatus === 'error') {
        logger.info('Auto-reconnect triggered by external service');
        reconnectAttempts = 0;
        connectionStatus = 'reconnecting';
        broadcastStatus();
        await initWhatsApp();
        res.json({ success: true, message: 'Auto-reconnect initiated' });
    } else {
        res.json({ success: false, message: `Current status: ${connectionStatus}`, status: connectionStatus });
    }
});

app.post('/send', async (req, res) => {
    const { phone_number, message } = req.body;
    
    if (!phone_number || !message) {
        return res.status(400).json({ error: 'phone_number and message are required' });
    }

    const result = await sendMessage(phone_number, message);
    res.json(result);
});

app.post('/logout', async (req, res) => {
    try {
        stopKeepAlive();
        if (sock) {
            await sock.logout();
        }
        connectionStatus = 'disconnected';
        connectedUser = null;
        qrCode = null;
        qrCodeBase64 = null;
        reconnectAttempts = 0;
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/reconnect', async (req, res) => {
    try {
        stopKeepAlive();
        if (sock) {
            sock.end();
        }
        connectionStatus = 'reconnecting';
        reconnectAttempts = 0; // Reset counter for manual reconnect
        await initWhatsApp();
        res.json({ success: true, message: 'Reconnecting...' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Reset auth endpoint - use when QR keeps regenerating
app.post('/reset-auth', async (req, res) => {
    try {
        stopKeepAlive();
        if (sock) {
            sock.end();
        }
        
        // Clear auth folder
        const fs = require('fs');
        const path = require('path');
        const authPath = './auth_info';
        
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            logger.info('Auth folder cleared');
        }
        
        connectionStatus = 'disconnected';
        connectedUser = null;
        qrCode = null;
        qrCodeBase64 = null;
        reconnectAttempts = 0;
        
        // Restart connection
        setTimeout(initWhatsApp, 1000);
        
        res.json({ success: true, message: 'Auth reset. Please scan QR code again.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/contacts', async (req, res) => {
    try {
        const contactList = Array.from(contactsStore.values());
        res.json({ contacts: contactList });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// WebSocket server for real-time status
const server = app.listen(PORT, () => {
    logger.info(`WhatsApp Web Service running on port ${PORT}`);
    logger.info(`FastAPI backend URL: ${FASTAPI_URL}`);
    initWhatsApp();
});

// Create WebSocket server
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
    logger.info('WebSocket client connected');
    wsClients.add(ws);
    
    // Send current status immediately
    ws.send(JSON.stringify({
        type: 'status',
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        reconnect_attempts: reconnectAttempts,
        user: connectedUser ? {
            id: connectedUser.id,
            name: connectedUser.name
        } : null,
        timestamp: new Date().toISOString()
    }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            } else if (data.type === 'reconnect' && connectionStatus !== 'connected') {
                logger.info('Reconnect requested via WebSocket');
                reconnectAttempts = 0;
                initWhatsApp();
            }
        } catch (err) {
            logger.warn('Invalid WebSocket message:', err.message);
        }
    });
    
    ws.on('close', () => {
        logger.info('WebSocket client disconnected');
        wsClients.delete(ws);
    });
    
    // Ping client every 30 seconds to keep connection alive
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        } else {
            clearInterval(pingInterval);
        }
    }, 30000);
});

logger.info('WebSocket server ready on /ws');
