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
let lastQrTime = 0;
const QR_MIN_INTERVAL = 15000;

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
            version,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            qrTimeout: 60000,
            retryRequestDelayMs: 500,
            msgRetryCounterCache: new Map(),
            getMessage: async (key) => undefined
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            logger.info('Connection update: ' + JSON.stringify({ connection, hasQR: !!qr }));
            
            if (qr) {
                const now = Date.now();
                if (now - lastQrTime >= QR_MIN_INTERVAL) {
                    qrCode = qr;
                    lastQrTime = now;
                    try {
                        qrCodeBase64 = await QRCode.toDataURL(qr, { 
                            width: 400, 
                            margin: 2,
                            color: { dark: '#000000', light: '#ffffff' }
                        });
                        connectionStatus = 'waiting_scan';
                        logger.info('QR Code generated - valid for 60 seconds');
                    } catch (err) {
                        logger.error('QR error:', err.message);
                    }
                } else {
                    logger.info('QR update skipped - too soon');
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || 'Unknown';
                logger.info(`Connection closed. Code: ${statusCode}, Reason: ${reason}`);
                connectionStatus = 'disconnected';
                connectedUser = null;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    logger.info('Logged out - clearing auth');
                    await clearAuth();
                    qrCode = null;
                    qrCodeBase64 = null;
                    lastQrTime = 0;
                }
                
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    const delay = statusCode === 515 ? 15000 : 8000;
                    logger.info(`Reconnecting in ${delay/1000} seconds...`);
                    setTimeout(initWhatsApp, delay);
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
                
                logger.info('Connected as: ' + connectedUser.name);
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
            await saveAuthToMongo();
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const message of messages) {
                if (message.key.fromMe) continue;
                
                const from = message.key.remoteJid;
                if (!from || from.includes('@g.us') || from.includes('@broadcast')) continue;

                const isLid = from.includes('@lid');
                const phoneNumber = from.replace('@s.whatsapp.net', '').replace('@lid', '');
                const pushName = message.pushName || 'Unknown';
                const messageContent = message.message?.conversation || 
                                      message.message?.extendedTextMessage?.text ||
                                      '[Media]';

                logger.info('Message from ' + pushName + ' (' + from + '): ' + messageContent);

                try {
                    await axios.post(FASTAPI_URL + '/api/whatsapp-web/message', {
                        phone_number: phoneNumber,
                        push_name: pushName,
                        message: messageContent,
                        message_id: message.key.id,
                        timestamp: message.messageTimestamp,
                        original_jid: from,
                        is_lid: isLid
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
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        if (connectionStatus === 'connected') {
            return res.json({ status: 'connected', qr: null, qr_base64: null, user: connectedUser });
        }
        return res.json({ qr: qrCode, qr_base64: qrCodeBase64, status: connectionStatus });
    }
    
    if (connectionStatus === 'connected') {
        return res.send(`<!DOCTYPE html><html><head><title>WhatsApp Connected</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.container{background:#fff;border-radius:20px;padding:40px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:400px;width:100%}.success-icon{width:80px;height:80px;background:#25D366;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:40px;color:#fff}h1{color:#25D366;margin-bottom:10px;font-size:24px}.user-name{color:#333;font-size:20px;margin-bottom:5px}.user-phone{color:#666;font-size:16px}.back-btn{display:inline-block;margin-top:30px;padding:12px 30px;background:#667eea;color:#fff;text-decoration:none;border-radius:25px;font-weight:500}</style></head><body><div class="container"><div class="success-icon">✓</div><h1>WhatsApp Terhubung!</h1><p class="user-name">${connectedUser?.name || 'WhatsApp User'}</p><p class="user-phone">${connectedUser?.phone || ''}</p><a href="https://chat.tripgo.id/dashboard/channels" class="back-btn">Kembali ke Dashboard</a></div></body></html>`);
    }
    
    if (!qrCodeBase64) {
        return res.send(`<!DOCTYPE html><html><head><title>Memuat QR</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.container{background:#fff;border-radius:20px;padding:40px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:400px;width:100%}.loader{width:60px;height:60px;border:4px solid #f3f3f3;border-top:4px solid #25D366;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px}@keyframes spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}h2{color:#333;margin-bottom:10px}p{color:#666}</style></head><body><div class="container"><div class="loader"></div><h2>Memuat QR Code...</h2><p>Status: ${connectionStatus}</p><p style="margin-top:10px;font-size:14px">Halaman refresh otomatis</p></div></body></html>`);
    }
    
    res.send(`<!DOCTYPE html><html><head><title>Scan QR WhatsApp</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.container{background:#fff;border-radius:20px;padding:30px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:420px;width:100%}.logo{width:60px;height:60px;background:#25D366;border-radius:15px;display:flex;align-items:center;justify-content:center;margin:0 auto 15px;font-size:30px}h1{color:#333;font-size:22px;margin-bottom:5px}.subtitle{color:#666;font-size:14px;margin-bottom:20px}.qr-container{background:#f8f9fa;border-radius:15px;padding:20px;margin-bottom:20px}.qr-container img{max-width:100%;height:auto;border-radius:10px}.instructions{background:#e8f5e9;border-radius:10px;padding:15px;text-align:left;margin-bottom:15px}.instructions h3{color:#25D366;font-size:14px;margin-bottom:10px}.instructions ol{color:#333;font-size:13px;padding-left:20px}.instructions li{margin-bottom:5px}.status{background:#fff3cd;color:#856404;padding:10px 15px;border-radius:8px;font-size:13px;display:flex;align-items:center;justify-content:center;gap:8px}.pulse{width:10px;height:10px;background:#ffc107;border-radius:50%;animation:pulse 1.5s infinite}@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.2)}}.refresh-btn{display:inline-block;margin-top:15px;padding:10px 25px;background:#667eea;color:#fff;text-decoration:none;border-radius:20px;font-size:14px;border:none;cursor:pointer}.refresh-btn:hover{background:#5a6fd6}</style><script>setInterval(async()=>{try{const r=await fetch('/status');const d=await r.json();if(d.status==='connected')location.reload()}catch(e){}},3000)</script></head><body><div class="container"><div class="logo">📱</div><h1>Hubungkan WhatsApp</h1><p class="subtitle">Scan QR code dengan WhatsApp di HP Anda</p><div class="qr-container"><img src="${qrCodeBase64}" alt="QR Code"/></div><div class="instructions"><h3>📋 Cara Scan:</h3><ol><li>Buka <strong>WhatsApp</strong> di HP</li><li>Ketuk <strong>Menu (⋮)</strong> → <strong>Linked Devices</strong></li><li>Ketuk <strong>Link a Device</strong></li><li>Arahkan kamera ke QR code ini</li></ol></div><div class="status"><span class="pulse"></span>Menunggu scan... QR berlaku 60 detik</div><button class="refresh-btn" onclick="location.reload()">🔄 Refresh QR</button></div></body></html>`);
});

app.get('/qr-image', (req, res) => res.redirect('/qr'));

app.post('/send', async (req, res) => {
    const { phone_number, message } = req.body;
    if (!sock || connectionStatus !== 'connected') {
        return res.status(503).json({ success: false, error: 'Not connected' });
    }
    try {
        let jid;
        if (phone_number.includes('@')) {
            jid = phone_number;
        } else if (phone_number.startsWith('WA:') || phone_number.length > 15) {
            const cleanNumber = phone_number.replace('WA:', '').replace(/[^0-9]/g, '');
            jid = cleanNumber + '@lid';
        } else {
            const cleanNumber = phone_number.replace(/[^0-9]/g, '');
            jid = cleanNumber + '@s.whatsapp.net';
        }
        logger.info('Sending message to: ' + jid);
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, to: jid });
    } catch (error) {
        logger.error('Send error: ' + error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/logout', async (req, res) => {
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
