const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const logger = pino({ level: 'info' });

const FASTAPI_URL = process.env.FASTAPI_URL || 'http://localhost:8001';
const PORT = process.env.PORT || 3002;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'elexart_whatsapp';

let sock = null;
let qrCode = null;
let qrCodeBase64 = null;
let connectionStatus = 'disconnected';
let connectedUser = null;
let mongoClient = null;
let db = null;
let isInitializing = false;
let retryCount = 0;
const MAX_RETRIES = 5;

async function useMongoDBAuthState(collectionName = 'whatsapp_auth') {
    const collection = db.collection(collectionName);
    
    const writeData = async (key, data) => {
        try {
            await collection.updateOne(
                { _id: key },
                { $set: { data: JSON.stringify(data), updatedAt: new Date() } },
                { upsert: true }
            );
        } catch (e) {
            logger.error('Write data error:', e.message);
        }
    };
    
    const readData = async (key) => {
        try {
            const doc = await collection.findOne({ _id: key });
            if (doc && doc.data) {
                return JSON.parse(doc.data);
            }
        } catch (e) {
            logger.error('Read data error:', e.message);
        }
        return null;
    };
    
    const removeData = async (key) => {
        try {
            await collection.deleteOne({ _id: key });
        } catch (e) {
            logger.error('Remove data error:', e.message);
        }
    };
    
    const creds = await readData('creds');
    
    return {
        state: {
            creds: creds || {},
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
        saveCreds: async (newCreds) => {
            await writeData('creds', newCreds || creds);
        }
    };
}

async function connectMongo() {
    try {
        if (mongoClient) {
            try { await mongoClient.close(); } catch(e) {}
        }
        mongoClient = new MongoClient(MONGO_URL);
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        logger.info('Connected to MongoDB');
        return true;
    } catch (error) {
        logger.error('MongoDB connection error:', error.message);
        return false;
    }
}

async function initWhatsApp() {
    if (isInitializing) {
        logger.info('Already initializing, skipping...');
        return;
    }
    
    if (retryCount >= MAX_RETRIES) {
        logger.error('Max retries reached. Waiting 30 seconds before next attempt.');
        retryCount = 0;
        setTimeout(initWhatsApp, 30000);
        return;
    }
    
    isInitializing = true;
    retryCount++;
    
    try {
        if (!db) {
            const connected = await connectMongo();
            if (!connected) {
                connectionStatus = 'db_error';
                isInitializing = false;
                setTimeout(initWhatsApp, 5000);
                return;
            }
        }
        
        const { state, saveCreds } = await useMongoDBAuthState('whatsapp_auth');
        const { version } = await fetchLatestBaileysVersion();
        
        logger.info('Using WA version: ' + version.join('.'));

        if (sock) {
            try { sock.end(); } catch (e) {}
            sock = null;
        }

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['Elexart CRM', 'Chrome', '120.0.0'],
            logger: pino({ level: 'silent' }),
            version,
            connectTimeoutMs: 60000,
            getMessage: async () => ({ conversation: '' })
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrCode = qr;
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr, { width: 300 });
                    connectionStatus = 'waiting_scan';
                    retryCount = 0;
                    logger.info('QR Code generated - waiting for scan');
                } catch (err) {
                    logger.error('QR generation error:', err.message);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                logger.info('Connection closed. Status: ' + statusCode);
                
                connectionStatus = 'disconnected';
                connectedUser = null;
                isInitializing = false;
                
                if (shouldReconnect) {
                    const delay = Math.min(5000 * retryCount, 30000);
                    logger.info('Reconnecting in ' + delay + 'ms...');
                    setTimeout(initWhatsApp, delay);
                } else {
                    logger.info('Logged out - clearing auth');
                    if (db) {
                        await db.collection('whatsapp_auth').deleteMany({});
                    }
                    qrCode = null;
                    qrCodeBase64 = null;
                    retryCount = 0;
                    setTimeout(initWhatsApp, 3000);
                }
            }

            if (connection === 'open') {
                connectionStatus = 'connected';
                qrCode = null;
                qrCodeBase64 = null;
                isInitializing = false;
                retryCount = 0;
                
                const user = sock.user;
                connectedUser = {
                    id: user?.id,
                    name: user?.name || user?.verifiedName || 'WhatsApp User',
                    phone: user?.id?.split(':')[0] || user?.id?.split('@')[0]
                };
                
                logger.info('Connected as: ' + connectedUser.name);
                
                try {
                    await axios.post(FASTAPI_URL + '/api/whatsapp-web/connected', {
                        user: connectedUser
                    }, { timeout: 5000 });
                } catch (e) {
                    logger.warn('Could not notify backend');
                }
            }
        });

        sock.ev.on('creds.update', async (creds) => {
            await saveCreds(creds);
        });

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

                logger.info('Message from ' + pushName + ': ' + messageContent);

                try {
                    await axios.post(FASTAPI_URL + '/api/whatsapp-web/webhook', {
                        from: phoneNumber,
                        name: pushName,
                        message: messageContent,
                        messageId: message.key.id,
                        timestamp: message.messageTimestamp
                    }, { timeout: 10000 });
                } catch (error) {
                    logger.error('Backend error:', error.message);
                }
            }
        });

    } catch (error) {
        logger.error('WhatsApp init error:', error.message);
        connectionStatus = 'error';
        isInitializing = false;
        const delay = Math.min(5000 * retryCount, 30000);
        setTimeout(initWhatsApp, delay);
    }
}

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
        return res.json({ status: 'connected', user: connectedUser });
    }
    res.json({ qr: qrCode, qr_base64: qrCodeBase64, status: connectionStatus });
});

app.post('/send', async (req, res) => {
    const { phone_number, message } = req.body;
    
    if (!sock || connectionStatus !== 'connected') {
        return res.status(503).json({ success: false, error: 'Not connected' });
    }
    
    try {
        let jid = phone_number.includes('@') ? phone_number : phone_number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, to: jid });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        if (db) await db.collection('whatsapp_auth').deleteMany({});
        connectionStatus = 'disconnected';
        connectedUser = null;
        qrCode = null;
        qrCodeBase64 = null;
        isInitializing = false;
        retryCount = 0;
        setTimeout(initWhatsApp, 2000);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/reconnect', async (req, res) => {
    connectionStatus = 'reconnecting';
    isInitializing = false;
    retryCount = 0;
    if (sock) { try { sock.end(); } catch(e) {} sock = null; }
    setTimeout(initWhatsApp, 1000);
    res.json({ success: true, message: 'Reconnecting...' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', whatsapp: connectionStatus, mongodb: db ? 'connected' : 'disconnected' });
});

app.get('/', (req, res) => {
    res.json({ service: 'Elexart WhatsApp Service', status: connectionStatus });
});

async function start() {
    const mongoConnected = await connectMongo();
    if (!mongoConnected) {
        logger.error('MongoDB failed. Retrying in 5 seconds...');
        setTimeout(start, 5000);
        return;
    }
    
    app.listen(PORT, '0.0.0.0', () => {
        logger.info('WhatsApp service running on port ' + PORT);
        setTimeout(initWhatsApp, 2000);
    });
}

start();
