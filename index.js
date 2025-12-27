const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const logger = pino({ level: 'info' });

// Environment variables
const FASTAPI_URL = process.env.FASTAPI_URL || 'http://localhost:8001';
const PORT = process.env.PORT || 3002;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'elexart_whatsapp';
const API_SECRET = process.env.API_SECRET || '';

let sock = null;
let qrCode = null;
let qrCodeBase64 = null;
let connectionStatus = 'disconnected';
let connectedUser = null;
let mongoClient = null;
let db = null;

// MongoDB Auth State Management
async function useMongoDBAuthState(collectionName = 'whatsapp_auth') {
    const collection = db.collection(collectionName);
    
    const writeData = async (key, data) => {
        await collection.updateOne(
            { _id: key },
            { $set: { data: JSON.stringify(data), updatedAt: new Date() } },
            { upsert: true }
        );
    };
    
    const readData = async (key) => {
        const doc = await collection.findOne({ _id: key });
        if (doc && doc.data) {
            try {
                return JSON.parse(doc.data);
            } catch (e) {
                return null;
            }
        }
        return null;
    };
    
    const removeData = async (key) => {
        await collection.deleteOne({ _id: key });
    };
    
    // Load existing creds
    const creds = await readData('creds') || {};
    
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const value = await readData(`${type}-${id}`);
                        if (value) {
                            data[id] = value;
                        }
                    }
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                await writeData(key, value);
                            } else {
                                await removeData(key);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        }
    };
}

async function connectMongo() {
    try {
        mongoClient = new MongoClient(MONGO_URL);
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        logger.info('Connected to MongoDB');
        return true;
    } catch (error) {
        logger.error('MongoDB connection error:', error);
        return false;
    }
}

async function initWhatsApp() {
    try {
        // Ensure MongoDB is connected
        if (!db) {
            const connected = await connectMongo();
            if (!connected) {
                logger.error('Cannot initialize WhatsApp without MongoDB');
                connectionStatus = 'db_error';
                return;
            }
        }
        
        const { state, saveCreds } = await useMongoDBAuthState('whatsapp_auth');
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
                    qrCodeBase64 = await QRCode.toDataURL(qr, { width: 300 });
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
                connectedUser = null;
                
                if (shouldReconnect) {
                    setTimeout(initWhatsApp, 3000);
                } else {
                    // Clear auth on logout
                    if (db) {
                        await db.collection('whatsapp_auth').deleteMany({});
                    }
                    qrCode = null;
                    qrCodeBase64 = null;
                }
            }

            if (connection === 'open') {
                connectionStatus = 'connected';
                qrCode = null;
                qrCodeBase64 = null;
                
                const user = sock.user;
                connectedUser = {
                    id: user?.id,
                    name: user?.name || user?.verifiedName || 'WhatsApp User',
                    phone: user?.id?.split(':')[0] || user?.id?.split('@')[0]
                };
                
                logger.info('Connected as:', connectedUser.name);
                
                // Notify Elexart backend
                try {
                    await axios.post(`${FASTAPI_URL}/api/whatsapp-web/connected`, {
                        user: connectedUser,
                        secret: API_SECRET
                    });
                } catch (e) {
                    logger.warn('Could not notify backend:', e.message);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Handle incoming messages
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const message of messages) {
                if (message.key.fromMe) continue;
                
                const from = message.key.remoteJid;
                if (!from || from.includes('@g.us') || from.includes('@broadcast')) continue;

                const phoneNumber = from.replace('@s.whatsapp.net', '').replace('@lid', '');
                const pushName = message.pushName || 'Unknown';
                const messageContent = message.message?.conversation || 
                                      message.message?.extendedTextMessage?.text ||
                                      message.message?.imageMessage?.caption ||
                                      '[Media]';
                const messageId = message.key.id;
                const timestamp = message.messageTimestamp;

                logger.info(`Message from ${pushName} (${phoneNumber}): ${messageContent}`);

                // Send to Elexart backend
                try {
                    await axios.post(`${FASTAPI_URL}/api/whatsapp-web/webhook`, {
                        from: phoneNumber,
                        name: pushName,
                        message: messageContent,
                        messageId,
                        timestamp,
                        secret: API_SECRET
                    });
                } catch (error) {
                    logger.error('Error sending to backend:', error.message);
                }
            }
        });

    } catch (error) {
        logger.error('WhatsApp init error:', error);
        connectionStatus = 'error';
        setTimeout(initWhatsApp, 5000);
    }
}

// API Endpoints
app.get('/status', (req, res) => {
    res.json({
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        user: connectedUser,
        mongodb: db ? 'connected' : 'disconnected'
    });
});

app.get('/qr', (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ 
            status: 'connected', 
            user: connectedUser,
            message: 'Already connected'
        });
    }
    
    res.json({
        qr: qrCode,
        qr_base64: qrCodeBase64,
        status: connectionStatus
    });
});

app.post('/send', async (req, res) => {
    const { phone_number, message } = req.body;
    
    if (!sock || connectionStatus !== 'connected') {
        return res.status(503).json({ 
            success: false, 
            error: 'WhatsApp not connected' 
        });
    }
    
    try {
        let jid = phone_number;
        if (!jid.includes('@')) {
            jid = jid.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        }
        
        await sock.sendMessage(jid, { text: message });
        
        res.json({ 
            success: true, 
            message: 'Message sent',
            to: jid
        });
    } catch (error) {
        logger.error('Send error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        
        // Clear MongoDB auth
        if (db) {
            await db.collection('whatsapp_auth').deleteMany({});
        }
        
        connectionStatus = 'disconnected';
        connectedUser = null;
        qrCode = null;
        qrCodeBase64 = null;
        
        // Reinitialize
        setTimeout(initWhatsApp, 2000);
        
        res.json({ 
            success: true, 
            message: 'Logged out successfully' 
        });
    } catch (error) {
        logger.error('Logout error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.post('/reconnect', async (req, res) => {
    try {
        connectionStatus = 'reconnecting';
        
        if (sock) {
            sock.end();
        }
        
        setTimeout(initWhatsApp, 1000);
        
        res.json({ 
            success: true, 
            message: 'Reconnecting...' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Health check for Render
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        whatsapp: connectionStatus,
        mongodb: db ? 'connected' : 'disconnected'
    });
});

// Start server
async function start() {
    // Connect to MongoDB first
    await connectMongo();
    
    // Start Express server
    app.listen(PORT, '0.0.0.0', () => {
        logger.info(`WhatsApp service running on port ${PORT}`);
        
        // Initialize WhatsApp
        initWhatsApp();
    });
}

start();
