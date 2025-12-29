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

const lidToPhoneMap = new Map();
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
                
                const user = sock.user;
                connectedUser = user;
                logger.info('WhatsApp connected successfully!');
                
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

        let referral = null;
        let contextInfo = null;
        let quotedMessage = null;
        
        if (message.message?.extendedTextMessage?.contextInfo) {
            contextInfo = message.message.extendedTextMessage.contextInfo;
        }
        if (!contextInfo && message.message?.imageMessage?.contextInfo) {
            contextInfo = message.message.imageMessage.contextInfo;
        }
        if (!contextInfo && message.message?.videoMessage?.contextInfo) {
            contextInfo = message.message.videoMessage.contextInfo;
        }
        
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

app.get('/qr', async (req, res) => {
    res.json({ 
        qr: qrCode,
        qr_base64: qrCodeBase64,
        status: connectionStatus
    });
});

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

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

app.get('/contacts', async (req, res) => {
    try {
        const contactList = Array.from(contactsStore.values());
        res.json({ contacts: contactList });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    logger.info(`WhatsApp Web Service running on port ${PORT}`);
    logger.info(`FastAPI backend URL: ${FASTAPI_URL}`);
    initWhatsApp();
});
