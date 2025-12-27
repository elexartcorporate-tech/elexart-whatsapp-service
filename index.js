const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = require('@whiskeysockets/baileys');
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

if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

async function connectMongo() {
    try {
        mongoClient = new MongoClient(MONGO_URL);
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        logger.info('Connected to MongoDB');
        await restoreAuthFromMongo();
        return true;
    } catch (error) {
        logger.error('MongoDB error: ' + error.message);
        return false;
    }
}

async function restoreAuthFromMongo() {
    try {
        const collection = db.collection('whatsapp_auth_files');
        const files = await collection.find({}).toArray();
        if (files.length > 0) {
            logger.info('Restoring ' + files.length + ' auth files');
            for (const file of files) {
                const filePath = path.join(AUTH_FOLDER, file.filename);
                fs.writeFileSync(filePath, file.content);
            }
        }
    } catch (e) {
        logger.error('Restore error: ' + e.message);
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
                { filename: filename },
                { $set: { filename: filename, content: content, updatedAt: new Date() } },
                { upsert: true }
            );
        }
        logger.info('Saved ' + files.length + ' auth files');
    } catch (e) {
        logger.error('Save error: ' + e.message);
    }
}

async function clearAuth() {
    try {
        if (fs.existsSync(AUTH_FOLDER)) {
            const files = fs.readdirSync(AUTH_FOLDER);
            for (const file of files) {
                fs.unlinkSync(path.join(AUTH_FOLDER, file));
            }
        }
        if (db) {
            await db.collection('whatsapp_auth_files').deleteMany({});
        }
        logger.info('Auth cleared');
    } catch (e) {
        logger.error('Clear error: ' + e.message);
    }
}

async function initWhatsApp() {
    try {
        connectionStatus = 'initializing';
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();
        logger.info('WA version: ' + version.join('.'));

        if (sock) {
            try { sock.end(); } catch (e) {}
            sock = null;
        }

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['Elexart CRM', 'Chrome', '120.0.0'],
            logger: pino({ level: 'silent' }),
            version: version
        });

        sock.ev.on('connection.update', async function(update) {
            var connection = update.connection;
            var lastDisconnect = update.lastDisconnect;
            var qr = update.qr;
            
            logger.info('Update: ' + (connection || 'qr'));
            
            if (qr) {
                qrCode = qr;
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr, { width: 300 });
                    connectionStatus = 'waiting_scan';
                    logger.info('QR generated!');
                } catch (err) {
                    logger.error('QR error');
                }
            }

            if (connection === 'close') {
                var statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : 0;
                logger.info('Closed. Code: ' + statusCode);
                connectionStatus = 'disconnected';
                connectedUser = null;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    await clearAuth();
                    qrCode = null;
                    qrCodeBase64 = null;
                }
                setTimeout(initWhatsApp, 5000);
            }

            if (connection === 'open') {
                connectionStatus = 'connected';
                qrCode = null;
                qrCodeBase64 = null;
                var user = sock.user;
                connectedUser = {
                    id: user ? user.id : null,
                    name: user ? (user.name || user.verifiedName || 'WhatsApp') : 'WhatsApp',
                    phone: user && user.id ? user.id.split(':')[0] : null
                };
                logger.info('Connected: ' + connectedUser.name);
                await saveAuthToMongo();
            }
        });

        sock.ev.on('creds.update', async function() {
            await saveCreds();
            await saveAuthToMongo();
        });

        sock.ev.on('messages.upsert', async function(m) {
            if (m.type !== 'notify') return;
            var messages = m.messages;
            for (var i = 0; i < messages.length; i++) {
                var message = messages[i];
                if (message.key.fromMe) continue;
                var from = message.key.remoteJid;
                if (!from || from.indexOf('@g.us') >= 0) continue;
                var phone = from.replace('@s.whatsapp.net', '').replace('@lid', '');
                var name = message.pushName || 'Unknown';
                var text = '';
                if (message.message) {
                    text = message.message.conversation || (message.message.extendedTextMessage ? message.message.extendedTextMessage.text : '[Media]');
                }
                logger.info('Msg from ' + name + ': ' + text);
                try {
                    await axios.post(FASTAPI_URL + '/api/whatsapp-web/webhook', {
                        from: phone, name: name, message: text,
                        messageId: message.key.id, timestamp: message.messageTimestamp
                    }, { timeout: 10000 });
                } catch (err) {}
            }
        });

    } catch (error) {
        logger.error('Init error: ' + error.message);
        connectionStatus = 'error';
        setTimeout(initWhatsApp, 10000);
    }
}

app.get('/status', function(req, res) {
    res.json({ status: connectionStatus, connected: connectionStatus === 'connected', user: connectedUser, mongodb: db ? 'connected' : 'disconnected' });
});

app.get('/qr', function(req, res) {
    if (connectionStatus === 'connected') {
        return res.json({ status: 'connected', user: connectedUser });
    }
    res.json({ qr: qrCode, qr_base64: qrCodeBase64, status: connectionStatus });
});

app.post('/send', async function(req, res) {
    var phone = req.body.phone_number;
    var message = req.body.message;
    if (!sock || connectionStatus !== 'connected') {
        return res.status(503).json({ success: false, error: 'Not connected' });
    }
    try {
        var jid = phone.indexOf('@') >= 0 ? phone : phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, to: jid });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/logout', async function(req, res) {
    try {
        if (sock) { try { await sock.logout(); } catch(e) {} }
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

app.post('/reconnect', function(req, res) {
    connectionStatus = 'reconnecting';
    if (sock) { try { sock.end(); } catch(e) {} sock = null; }
    setTimeout(initWhatsApp, 1000);
    res.json({ success: true, message: 'Reconnecting' });
});

app.get('/health', function(req, res) {
    res.json({ status: 'healthy', whatsapp: connectionStatus, mongodb: db ? 'connected' : 'disconnected' });
});

app.get('/', function(req, res) {
    res.json({ service: 'Elexart WhatsApp', status: connectionStatus });
});

async function start() {
    await connectMongo();
    app.listen(PORT, '0.0.0.0', function() {
        logger.info('Service on port ' + PORT);
        setTimeout(initWhatsApp, 2000);
    });
}

start();
