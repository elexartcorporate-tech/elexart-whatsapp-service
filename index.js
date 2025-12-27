"const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
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

// MongoDB Auth State Management
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
    
    // Load existing creds
    const creds = await readData('creds') || undefined;
    
    return {
        state: {
            creds: creds,
            keys: makeCacheableSignalKeyStore({
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
            }, logger)
        },
        saveCreds: async () => {
            if (sock && sock.authState && sock.authState.creds) {
                await writeData('creds', sock.authState.creds);
            }
        }
    };
}

async function connectMongo() {
    try {
        if (mongoClient) {
            await mongoClient.close();
        }
        mongoClient = new MongoClient(MONGO_URL);
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        logger.info('✅ Connected to MongoDB');
        return true;
    } catch (error) {
        logger.error('❌ MongoDB connection error:', error.message);
        return false;
    }
}

async function initWhatsApp() {
    if (isInitializing) {
        logger.info('Already initializing, skipping...');
        return;
    }
    
    isInitializing = true;
    
    try {
        // Ensure MongoDB is connected
        if (!db) {
            const connected = await connectMongo();
            if (!connected) {
                logger.error('Cannot initialize WhatsApp without MongoDB');
                connectionStatus = 'db_error';
                isInitializing = false;
                return;
            }
        }
        
        const { state, saveCreds } = await useMongoDBAuthState('whatsapp_auth');
        const { version } = await fetchLatestBaileysVersion();
        
        logger.info(`Using WA version: ${version.join('.')}`);

        // Close existing socket
        if (sock) {
            try {
                sock.end();
            } catch (e) {}
            sock = null;
        }

        sock = makeWASocket({
            auth: {
                creds: state.creds || {},
                keys: state.keys
            },
            printQRInTerminal: false,
            browser: ['Elexart CRM', 'Chrome', '120.0.0'],
            logger: pino({ level: 'silent' }),
            version,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            getMessage: async () => ({ conversation: '' })
        });

        // Store auth state reference
        sock.authState = { creds: state.creds };

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            logger.info(`Connection update: ${connection || 'qr'}`);

            if (qr) {
                qrCode = qr;
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr, { width: 300 });
                    connectionStatus = 'waiting_scan';
                    logger.info('✅ QR Code generated - waiting for scan');
                } catch (err) {
                    logger.error('QR generation error:', err.message);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                logger.info(`Connection closed. Status: ${statusCode}, Reconnect: ${shouldReconnect}`);
                
                connectionStatus = 'disconnected';
                connectedUser = null;
                isInitializing = false;
                
                if (shouldReconnect) {
                    // Wait before reconnecting to avoid rapid loops
                    logger.info('Reconnecting in 5 seconds...');
                    setTimeout(initWhatsApp, 5000);
                } else {
                    // Logged out - clear auth
                    logger.info('Logged out - clearing auth data');
                    if (db) {
                        await db.collection('whatsapp_auth').deleteMany({});
                    }
                    qrCode = null;
                    qrCodeBase64 = null;
                    // Restart to get new QR
                    setTimeout(initWhatsApp, 3000);
                }
            }

            if (connection === 'open') {
                connectionStatus = 'connected';
                qrCode = null;
                qrCodeBase64 = null;
                isInitializing = false;
                
                const user = sock.user;
                connectedUser = {
                    id: user?.id,
                    name: user?.name || user?.verifiedName || 'WhatsApp User',
                    phone: user?.id?.split(':')[0] || user?.id?.split('@')[0]
                };
                
                logger.info('✅ Connected as:', connectedUser.name);
                
                // Notify Elexart backend
                try {
                    await axios.post(`${FASTAPI_URL}/api/whatsapp-web/connected`, {
                        user: connectedUser
                    }, { timeout: 5000 });
                } catch (e) {
                    logger.warn('Could not notify backend:', e.message);
                }
            }
        });

        sock.ev.on('creds.update', async () => {
            logger.info('Credentials updated, saving...');
            await saveCreds();
        });

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

                logger.info(`📩 Message from ${pushName} (${phoneNumber}): ${messageContent}`);

                // Send to Elexart backend
                try {
                    await axios.post(`${FASTAPI_URL}/api/whatsapp-web/webhook`, {
                        from: phoneNumber,
                        name: pushName,
                        message: messageContent,
                        messageId,
                        timestamp
                    }, { timeout: 10000 });
                } catch (error) {
                    logger.error('Error sending to backend:', error.message);
                }
            }
        });

    } catch (error) {
        logger.error('WhatsApp init error:', error.message);
        connectionStatus = 'error';
        isInitializing = false;
        setTimeout(initWhatsApp, 10000);
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
        isInitializing = false;
        
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
        isInitializing = false;
        
        if (sock) {
            try { sock.end(); } catch(e) {}
            sock = null;
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

app.get('/', (req, res) => {
    res.json({ 
        service: 'Elexart WhatsApp Service',
        status: connectionStatus,
        endpoints: ['/status', '/qr', '/send', '/logout', '/reconnect', '/health']
    });
});

// Start server
async function start() {
    // Connect to MongoDB first
    const mongoConnected = await connectMongo();
    
    if (!mongoConnected) {
        logger.error('Failed to connect to MongoDB. Retrying in 5 seconds...');
        setTimeout(start, 5000);
        return;
    }
    
    // Start Express server
    app.listen(PORT, '0.0.0.0', () => {
        logger.info(`🚀 WhatsApp service running on port ${PORT}`);
        
        // Initialize WhatsApp after short delay
        setTimeout(initWhatsApp, 2000);
    });
}

start();
"
