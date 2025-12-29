const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');

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
            getMessage: async (key) => {
                return { conversation: '' };
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCode = qr;
                // Generate base64 QR image
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                    connectionStatus = 'waiting_scan';
                    logger.info('QR Code generated - waiting for scan');
                } catch (err) {
                    logger.error('QR generation error:', err);
                }
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                logger.info('Connection closed, reconnecting:', shouldReconnect);
                connectionStatus = 'disconnected';
                qrCode = null;
                qrCodeBase64 = null;
                connectedUser = null;
                
                if (shouldReconnect) {
                    setTimeout(initWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                qrCode = null;
                qrCodeBase64 = null;
                
                // Get connected user info
                const user = sock.user;
                connectedUser = user;
                logger.info('WhatsApp connected successfully!');
                
                // Notify backend
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

        // Handle incoming messages
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            
            for (const message of messages) {
                // Process ALL messages - both incoming AND outgoing (sent from phone)
                if (message.message) {
                    const isFromMe = message.key.fromMe;
                    await handleIncomingMessage(message, isFromMe);
                }
            }
        });

        // Listen for contacts update to map LID to phone
        sock.ev.on('contacts.update', (contacts) => {
            for (const contact of contacts) {
                if (contact.id && contact.lid) {
                    // Map LID to phone number
                    const phone = contact.id.replace('@s.whatsapp.net', '');
                    lidToPhoneMap.set(contact.lid.replace('@lid', ''), phone);
                    logger.info(`Mapped LID ${contact.lid} to phone ${phone}`);
                }
            }
        });

    } catch (error) {
        logger.error('WhatsApp initialization error:', error);
        connectionStatus = 'error';
        setTimeout(initWhatsApp, 10000);
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
        
        // Try to resolve LID to actual phone number using various methods
        if (isLid) {
            // Method 1: Check our local map
            const mappedPhone = lidToPhoneMap.get(phoneNumber);
            if (mappedPhone) {
                phoneNumber = mappedPhone;
                logger.info(`Resolved LID from map: ${phoneNumber}`);
            } else {
                // Method 2: Try participant field
                if (message.key.participant) {
                    const participantPhone = message.key.participant.replace('@s.whatsapp.net', '').replace('@lid', '');
                    if (participantPhone.length <= 15) {
                        phoneNumber = participantPhone;
                        lidToPhoneMap.set(remoteJid.replace('@lid', ''), phoneNumber);
                        logger.info(`Got phone from participant: ${phoneNumber}`);
                    }
                }
                
                // Method 3: Try to get from message verifiedBizName
                if (message.verifiedBizName) {
                    const match = message.verifiedBizName.match(/\d{10,15}/);
                    if (match) {
                        phoneNumber = match[0];
                        lidToPhoneMap.set(remoteJid.replace('@lid', ''), phoneNumber);
                        logger.info(`Got phone from verifiedBizName: ${phoneNumber}`);
                    }
                }
                
                // Method 4: Try to fetch using onWhatsApp
                if (phoneNumber.length > 15) {
                    try {
                        // For LID, we might need to query with the LID itself
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
        
        // Clean the phone number
        phoneNumber = phoneNumber.replace(/\D/g, '');
        
        // Convert 0 prefix to 62 (Indonesia)
        if (phoneNumber.startsWith('0')) {
            phoneNumber = '62' + phoneNumber.substring(1);
        }
        
        const messageText = message.message?.conversation ||
                           message.message?.extendedTextMessage?.text ||
                           message.message?.imageMessage?.caption ||
                           '';

        // ========== CAPTURE REFERRAL/CONTEXT FROM CLICK-TO-WHATSAPP ADS ==========
        // Check for context info (Click-to-WhatsApp ads, shared links, etc)
        let referral = null;
        let contextInfo = null;
        let quotedMessage = null;
        
        // Get context from extendedTextMessage (most common for CTWA)
        if (message.message?.extendedTextMessage?.contextInfo) {
            contextInfo = message.message.extendedTextMessage.contextInfo;
        }
        // Or from other message types
        if (!contextInfo && message.message?.imageMessage?.contextInfo) {
            contextInfo = message.message.imageMessage.contextInfo;
        }
        if (!contextInfo && message.message?.videoMessage?.contextInfo) {
            contextInfo = message.message.videoMessage.contextInfo;
        }
        
        // Extract referral from context (Click-to-WhatsApp Ads)
        if (contextInfo) {
            // Check for external ad reply (CTWA - Click to WhatsApp Ads)
            if (contextInfo.externalAdReply) {
                const adReply = contextInfo.externalAdReply;
                referral = {
                    source_type: 'ctwa',  // Click-to-WhatsApp Ad
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
            
            // Check for forwarded info
            if (contextInfo.isForwarded) {
                if (!referral) referral = {};
                referral.is_forwarded = true;
                referral.forwarding_score = contextInfo.forwardingScore || 0;
            }
            
            // Check for quoted message (reply to specific message)
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
        let mediaUrl = null;
        
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

        // Skip if no text and no media
        if (!messageText && !mediaType) return;

        // For LID numbers that we couldn't resolve, use pushName as identifier hint
        const displayPhone = phoneNumber.length > 15 ? `LID:${phoneNumber.substring(0,8)}...` : phoneNumber;
        
        const msgDirection = isFromMe ? 'OUTGOING (from phone)' : 'INCOMING';
        logger.info(`${msgDirection} message ${isFromMe ? 'to' : 'from'} ${displayPhone} (jid: ${remoteJid}): ${messageText.substring(0, 50)}...`);
        
        // Log referral if exists
        if (referral) {
            logger.info(`📢 Referral data: ${JSON.stringify(referral)}`);
        }

        // Store contact for later use
        contactsStore.set(remoteJid, {
            id: remoteJid,
            phone: phoneNumber,
            name: pushName || phoneNumber,
            jid: remoteJid,
            isLid: isLid
        });

        // Forward to FastAPI backend - include all context data
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
                // NEW: Referral/Ad context data
                referral: referral,
                quoted_message: quotedMessage,
                is_forwarded: referral?.is_forwarded || false
            });

            // Send auto-reply if backend returns one (only for incoming messages)
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

        // Format JID if needed - handle both phone and LID
        let formattedJid = jid;
        if (!jid.includes('@')) {
            // Try phone number first
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

// Get QR code for scanning
app.get('/qr', async (req, res) => {
    res.json({ 
        qr: qrCode,
        qr_base64: qrCodeBase64,
        status: connectionStatus
    });
});

// Get connection status
app.get('/status', (req, res) => {
    res.json({
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        user: connectedUser ? {
            id: connectedUser.id,
            name: connectedUser.name
        } : null
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Send message endpoint
app.post('/send', async (req, res) => {
    const { phone_number, message } = req.body;
    
    if (!phone_number || !message) {
        return res.status(400).json({ error: 'phone_number and message are required' });
    }

    const result = await sendMessage(phone_number, message);
    res.json(result);
});

// Logout endpoint
app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        connectionStatus = 'disconnected';
        connectedUser = null;
        qrCode = null;
        qrCodeBase64 = null;
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Reconnect endpoint
app.post('/reconnect', async (req, res) => {
    try {
        if (sock) {
            sock.end();
        }
        connectionStatus = 'reconnecting';
        await initWhatsApp();
        res.json({ success: true, message: 'Reconnecting...' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get contacts endpoint for broadcast
app.get('/contacts', async (req, res) => {
    try {
        const contactList = Array.from(contactsStore.values());
        res.json({ contacts: contactList });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    logger.info(`WhatsApp Web Service running on port ${PORT}`);
    logger.info(`FastAPI backend URL: ${FASTAPI_URL}`);
    initWhatsApp();
});
Exit code: 0
