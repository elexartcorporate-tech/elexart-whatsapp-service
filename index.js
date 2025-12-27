"const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = require('@whiskeysockets/baileys');
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

const FASTAPI_URL = process.env.FASTAPI_URL || 'http://localhost:8001';
const PORT = process.env.PORT || 3002;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'elexart_whatsapp';
const AUTH_FOLDER = './auth_info';

let sock = null;
let qrCode = null;
let qrCodeBase64 = null;
let connectionStatus = 'initializing';
let connectedUser = null;
let mongoClient = null;
let db = null;

// Ensure auth folder exists
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

async function connectMongo() {
    try {
        mongoClient = new MongoClient(MONGO_URL);
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        logger.info('Connected to MongoDB');
        
        // Try to restore auth from MongoDB
        await restoreAuthFromMongo();
        return true;
    } catch (error) {
        logger.error('MongoDB error:', error.message);
        return false;
    }
}

async function restoreAuthFromMongo() {
    try {
        const collection = db.collection('whatsapp_auth_files');
        const files = await collection.find({}).toArray();
        
        if (files.length > 0) {
            logger.info('Restoring ' + files.length + ' auth files from MongoDB');
            for (const file of files) {
                const filePath = path.join(AUTH_FOLDER, file.filename);
                fs.writeFileSync(filePath, file.content);
            }
        }
    } catch (e) {
        logger.error('Restore auth error:', e.message);
    }
}

async function saveAuthToMongo() {
    try {
        if (!db || !fs.existsSync(AUTH_FOLDER)) return;
        
        const collection = db.collection('whatsapp_auth_files');
        const files = fs.readdirSync(AUTH_FOLDER);
        
        for (const filename of files) {
            const filePath = path.join(AUTH_FOLDER, filename);
            const content = fs.readFileSync(filePath, 'utf8');
            
            await collection.updateOne(
                { filename },
                { $set: { filename, content, updatedAt: new Date() } },
                { upsert: true }
            );
        }
        logger.info('Saved ' + files.length + ' auth files to MongoDB');
    } catch (e) {
        logger.error('Save auth error:', e.message);
    }
}

async function clearAuth() {
    try {
        // Clear local files
        if (fs.existsSync(AUTH_FOLDER)) {
            const files = fs.readdirSync(AUTH_FOLDER);
            for (const file of files) {
                fs.unlinkSync(path.join(AUTH_FOLDER, file));
            }
        }
        
        // Clear MongoDB
        if (db) {
            await db.collection('whatsapp_auth_files').deleteMany({});
        }
        
        logger.info('Auth cleared');
    } catch (e) {
        logger.error('Clear auth error:', e.message);
    }
}

async function initWhatsApp() {
    try {
        connectionStatus = 'initializing';
        
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
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
            version
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            logger.info('Connection update: ' + JSON.stringify({ connection, hasQR: !!qr }));
            
            if (qr) {
                qrCode = qr;
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr, { width: 300 });
                    connectionStatus = 'waiting_scan';
                    logger.info('QR Code generated!');
                } catch (err) {
                    logger.error('QR error:', err.message);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                logger.info('Connection closed. Code: ' + statusCode);
                
                connectionStatus = 'disconnected';
                connectedUser = null;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    logger.info('Logged out - clearing auth');
                    await clearAuth();
                    qrCode = null;
                    qrCodeBase64 = null;
                }
                
                // Always try to reconnect after delay
                setTimeout(initWhatsApp, 5000);
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
                
                logger.info('Connected as: ' + connectedUser.name);
                
                // Save auth to MongoDB for persistence
                await saveAuthToMongo();
                
                try {
                    await axios.post(FASTAPI_URL + '/api/whatsapp-web/connected', {
                        user: connectedUser
                    }, { timeout: 5000 });
                } catch (e) {}
            }
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            // Also save to MongoDB
            await saveAuthToMongo();
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
        logger.error('Init error:', error.message);
        connectionStatus = 'error';
        setTimeout(initWhatsApp, 10000);
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
        if (sock) {
            try { await sock.logout(); } catch(e) {}
        }
        await clearAuth();
        connectionStatus = 'disconnected';
        connectedUser = null;
        qrCode = null;
        qrCodeBase64 = null;
        setTimeout(initWhatsApp, 2000);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/reconnect', async (req, res) => {
    connectionStatus = 'reconnecting';
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
    await connectMongo();
    
    app.listen(PORT, '0.0.0.0', () => {
        logger.info('WhatsApp service on port ' + PORT);
        setTimeout(initWhatsApp, 2000);
    });
}

start();
"
