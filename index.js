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

var sock = null;
var qrCode = null;
var qrCodeBase64 = null;
var connectionStatus = 'initializing';
var connectedUser = null;
var mongoClient = null;
var db = null;
var qrGeneratedAt = 0;
var qrAttempts = 0;
var isConnecting = false;
var pendingMessages = [];
var MAX_PENDING_MESSAGES = 100;

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
        var collection = db.collection('whatsapp_auth_files');
        var files = await collection.find({}).toArray();
        if (files.length > 0) {
            logger.info('Restoring ' + files.length + ' auth files');
            for (var i = 0; i < files.length; i++) {
                var file = files[i];
                var filePath = path.join(AUTH_FOLDER, file.filename);
                fs.writeFileSync(filePath, file.content);
            }
        }
    } catch (e) {
        logger.error('Restore auth error: ' + e.message);
    }
}

async function saveAuthToMongo() {
    try {
        if (!db || !fs.existsSync(AUTH_FOLDER)) return;
        var collection = db.collection('whatsapp_auth_files');
        var files = fs.readdirSync(AUTH_FOLDER);
        for (var i = 0; i < files.length; i++) {
            var filename = files[i];
            var filePath = path.join(AUTH_FOLDER, filename);
            var content = fs.readFileSync(filePath, 'utf8');
            await collection.updateOne(
                { filename: filename },
                { $set: { filename: filename, content: content, updatedAt: new Date() } },
                { upsert: true }
            );
        }
        logger.info('Saved ' + files.length + ' auth files');
    } catch (e) {
        logger.error('Save auth error: ' + e.message);
    }
}

async function clearAuth() {
    try {
        if (fs.existsSync(AUTH_FOLDER)) {
            var files = fs.readdirSync(AUTH_FOLDER);
            for (var i = 0; i < files.length; i++) {
                fs.unlinkSync(path.join(AUTH_FOLDER, files[i]));
            }
        }
        if (db) {
            await db.collection('whatsapp_auth_files').deleteMany({});
        }
        logger.info('Auth cleared');
    } catch (e) {
        logger.error('Clear auth error: ' + e.message);
    }
}
async function initWhatsApp() {
    if (isConnecting) {
        logger.info('Connection in progress, skipping');
        return;
    }
    isConnecting = true;
    try {
        connectionStatus = 'initializing';
        qrAttempts = 0;
        var authResult = await useMultiFileAuthState(AUTH_FOLDER);
        var state = authResult.state;
        var saveCreds = authResult.saveCreds;
        var versionResult = await fetchLatestBaileysVersion();
        var version = versionResult.version;
        logger.info('Using WA version: ' + version.join('.'));
        if (sock) {
            try { sock.ev.removeAllListeners(); sock.end(); } catch (e) {}
            sock = null;
        }
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['Elexart CRM', 'Desktop', '4.0.0'],
            logger: pino({ level: 'silent' }),
            version: version,
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            qrTimeout: 120000,
            retryRequestDelayMs: 500,
            msgRetryCounterCache: new Map(),
            getMessage: async function() { return undefined; },
            syncFullHistory: false,
            fireInitQueries: true,
            generateHighQualityLinkPreview: false,
            markOnlineOnConnect: true
        });
        sock.ev.on('connection.update', async function(update) {
            var connection = update.connection;
            var lastDisconnect = update.lastDisconnect;
            var qr = update.qr;
            var statusCode = null;
            if (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output) {
                statusCode = lastDisconnect.error.output.statusCode;
            }
            logger.info('Connection update: ' + connection + ', hasQR: ' + !!qr);
            if (qr) {
                qrAttempts++;
                qrCode = qr;
                qrGeneratedAt = Date.now();
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr, { width: 512, margin: 3, errorCorrectionLevel: 'H' });
                    connectionStatus = 'waiting_scan';
                    logger.info('QR Code generated');
                } catch (err) {
                    logger.error('QR error: ' + err.message);
                }
            }
            if (connection === 'close') {
                isConnecting = false;
                connectionStatus = 'disconnected';
                connectedUser = null;
                if (statusCode === DisconnectReason.loggedOut) {
                    await clearAuth();
                    qrCode = null;
                    qrCodeBase64 = null;
                    qrAttempts = 0;
                    setTimeout(initWhatsApp, 5000);
                } else if (statusCode === DisconnectReason.connectionReplaced) {
                    connectionStatus = 'replaced';
                } else if (statusCode === DisconnectReason.timedOut) {
                    qrCode = null;
                    qrCodeBase64 = null;
                    setTimeout(initWhatsApp, 3000);
                } else if (statusCode === 515) {
                    setTimeout(initWhatsApp, 10000);
                } else if (statusCode === DisconnectReason.multideviceMismatch) {
                    await clearAuth();
                    qrCode = null;
                    qrCodeBase64 = null;
                    setTimeout(initWhatsApp, 5000);
                } else {
                    var delay = qrAttempts > 3 ? 20000 : 8000;
                    setTimeout(initWhatsApp, delay);
                }
            }
            if (connection === 'open') {
                isConnecting = false;
                connectionStatus = 'connected';
                qrCode = null;
                qrCodeBase64 = null;
                qrAttempts = 0;
                var user = sock.user;
                connectedUser = {
                    id: user ? user.id : null,
                    name: user ? (user.name || user.verifiedName || 'WhatsApp User') : 'WhatsApp User',
                    phone: user && user.id ? user.id.split(':')[0] : ''
                };
                logger.info('Connected as: ' + connectedUser.name);
                await saveAuthToMongo();
                try {
                    await axios.post(FASTAPI_URL + '/api/whatsapp-web/connected', { user: connectedUser }, { timeout: 10000 });
                } catch (e) {
                    logger.warn('Backend notify failed: ' + e.message);
                }
            }
            if (connection === 'connecting') {
                connectionStatus = 'connecting';
            }
        });
        sock.ev.on('creds.update', async function() {
            await saveCreds();
            await saveAuthToMongo();
        });
        sock.ev.on('messages.upsert', async function(data) {
            var messages = data.messages;
            var type = data.type;
            if (type !== 'notify') return;
            for (var i = 0; i < messages.length; i++) {
                var message = messages[i];
                if (message.key.fromMe) continue;
                var from = message.key.remoteJid;
                if (!from || from.indexOf('@g.us') !== -1 || from.indexOf('@broadcast') !== -1) continue;
                var isLid = from.indexOf('@lid') !== -1;
                var phoneNumber = from.replace('@s.whatsapp.net', '').replace('@lid', '');
                var pushName = message.pushName || 'Unknown';
                var messageContent = '[Media]';
                if (message.message) {
                    if (message.message.conversation) {
                        messageContent = message.message.conversation;
                    } else if (message.message.extendedTextMessage) {
                        messageContent = message.message.extendedTextMessage.text || '[Media]';
                    }
                }
                logger.info('Message from ' + pushName + ': ' + messageContent);
                var msgData = {
                    id: message.key.id,
                    phone_number: phoneNumber,
                    push_name: pushName,
                    message: messageContent,
                    message_id: message.key.id,
                    timestamp: message.messageTimestamp,
                    original_jid: from,
                    is_lid: isLid,
                    received_at: Date.now()
                };
                var forwarded = false;
                try {
                    await axios.post(FASTAPI_URL + '/api/whatsapp-web/message', msgData, { timeout: 15000 });
                    forwarded = true;
                } catch (error) {
                    logger.error('Backend error: ' + error.message);
                }
                if (!forwarded) {
                    pendingMessages.push(msgData);
                    if (pendingMessages.length > MAX_PENDING_MESSAGES) {
                        pendingMessages = pendingMessages.slice(-MAX_PENDING_MESSAGES);
                    }
                }
            }
        });
    } catch (error) {
        logger.error('Init error: ' + error.message);
        isConnecting = false;
        connectionStatus = 'error';
        setTimeout(initWhatsApp, 15000);
    }
}
app.get('/status', function(req, res) {
    var now = Date.now();
    var qrAge = qrGeneratedAt > 0 ? Math.round((now - qrGeneratedAt) / 1000) : 0;
    res.json({
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        user: connectedUser,
        mongodb: db ? 'connected' : 'disconnected',
        qr_attempts: qrAttempts,
        qr_age_seconds: qrAge,
        qr_valid: qrAge < 120
    });
});

app.get('/qr', function(req, res) {
    var accept = req.headers.accept || '';
    if (accept.indexOf('application/json') !== -1) {
        if (connectionStatus === 'connected') {
            return res.json({ status: 'connected', qr: null, qr_base64: null, user: connectedUser });
        }
        return res.json({ qr: qrCode, qr_base64: qrCodeBase64, status: connectionStatus });
    }
    if (connectionStatus === 'connected') {
        var userName = connectedUser ? connectedUser.name : 'User';
        var userPhone = connectedUser ? connectedUser.phone : '';
        res.send('<html><head><title>WhatsApp Connected</title><style>body{font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;background:#25D366;margin:0}.box{background:white;padding:40px;border-radius:20px;text-align:center}h1{color:#25D366}a{display:inline-block;margin-top:20px;padding:10px 20px;background:#667eea;color:white;text-decoration:none;border-radius:10px}</style></head><body><div class="box"><h1>WhatsApp Connected!</h1><p>' + userName + '</p><p>+' + userPhone + '</p><a href="https://chat.tripgo.id/dashboard/channels">Back to Dashboard</a></div></body></html>');
        return;
    }
    if (!qrCodeBase64 || connectionStatus === 'initializing' || connectionStatus === 'connecting') {
        res.send('<html><head><title>Loading</title><meta http-equiv="refresh" content="2"><style>body{font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;background:#667eea;margin:0}.box{background:white;padding:40px;border-radius:20px;text-align:center}.loader{border:5px solid #f3f3f3;border-top:5px solid #25D366;border-radius:50%;width:50px;height:50px;animation:spin 1s linear infinite;margin:0 auto 20px}@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style></head><body><div class="box"><div class="loader"></div><h2>Loading WhatsApp...</h2><p>Status: ' + connectionStatus + '</p></div></body></html>');
        return;
    }
    var qrAge = Math.round((Date.now() - qrGeneratedAt) / 1000);
    var timeLeft = Math.max(0, 120 - qrAge);
    res.send('<html><head><title>Scan QR</title><style>body{font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;background:#667eea;margin:0}.box{background:white;padding:30px;border-radius:20px;text-align:center;max-width:400px}img{max-width:300px;border-radius:10px}.timer{background:#333;color:white;padding:5px 15px;border-radius:20px;display:inline-block;margin-bottom:15px}.instructions{background:#e8f5e9;padding:15px;border-radius:10px;text-align:left;margin:15px 0}ol{margin:0;padding-left:20px}button{margin-top:15px;padding:10px 20px;background:#667eea;color:white;border:none;border-radius:10px;cursor:pointer}</style><script>var t=' + timeLeft + ';setInterval(function(){t--;var e=document.getElementById("t");if(e){e.textContent=t+"s";if(t<=0)e.textContent="Expired"}},1000);setInterval(function(){fetch("/status").then(function(r){return r.json()}).then(function(d){if(d.status==="connected")location.reload()})},3000)</script></head><body><div class="box"><h2>Scan QR Code</h2><div class="timer"><span id="t">' + timeLeft + 's</span></div><img src="' + qrCodeBase64 + '" /><div class="instructions"><strong>How to scan:</strong><ol><li>Open WhatsApp on your phone</li><li>Tap Menu then Linked Devices</li><li>Tap Link a Device</li><li>Point camera at QR code</li></ol></div><button onclick="location.href=\'/reconnect-page\'">Get New QR</button></div></body></html>');
});

app.get('/reconnect-page', async function(req, res) {
    qrCode = null;
    qrCodeBase64 = null;
    qrAttempts = 0;
    if (sock) {
        try { sock.ev.removeAllListeners(); sock.end(); } catch(e) {}
        sock = null;
    }
    isConnecting = false;
    connectionStatus = 'initializing';
    setTimeout(initWhatsApp, 1000);
    res.redirect('/qr');
});

app.get('/qr-image', function(req, res) {
    res.redirect('/qr');
});

app.post('/send', async function(req, res) {
    var phone = req.body.phone_number;
    var msg = req.body.message;
    if (!sock || connectionStatus !== 'connected') {
        return res.status(503).json({ success: false, error: 'Not connected' });
    }
    try {
        var jid;
        if (phone.indexOf('@') !== -1) {
            jid = phone;
        } else if (phone.indexOf('WA:') === 0 || phone.length > 15) {
            jid = phone.replace('WA:', '').replace(/[^0-9]/g, '') + '@lid';
        } else {
            jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        }
        await sock.sendMessage(jid, { text: msg });
        res.json({ success: true, to: jid });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/logout', async function(req, res) {
    try {
        if (sock) {
            try { await sock.logout(); } catch(e) {}
        }
        await clearAuth();
        connectionStatus = 'disconnected';
        connectedUser = null;
        qrCode = null;
        qrCodeBase64 = null;
        qrAttempts = 0;
        isConnecting = false;
        setTimeout(initWhatsApp, 3000);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/reconnect', async function(req, res) {
    connectionStatus = 'reconnecting';
    qrCode = null;
    qrCodeBase64 = null;
    qrAttempts = 0;
    if (sock) {
        try { sock.ev.removeAllListeners(); sock.end(); } catch(e) {}
        sock = null;
    }
    isConnecting = false;
    setTimeout(initWhatsApp, 2000);
    res.json({ success: true });
});

app.get('/health', function(req, res) {
    res.json({
        status: 'healthy',
        whatsapp: connectionStatus,
        mongodb: db ? 'connected' : 'disconnected',
        pending_messages: pendingMessages.length
    });
});

app.get('/pending-messages', function(req, res) {
    res.json({
        success: true,
        count: pendingMessages.length,
        messages: pendingMessages
    });
});

app.post('/clear-pending', function(req, res) {
    var ids = req.body && req.body.message_ids ? req.body.message_ids : null;
    if (ids && Array.isArray(ids) && ids.length > 0) {
        pendingMessages = pendingMessages.filter(function(m) {
            return ids.indexOf(m.message_id) === -1;
        });
        res.json({ success: true, cleared: ids.length, remaining: pendingMessages.length });
    } else {
        var count = pendingMessages.length;
        pendingMessages = [];
        res.json({ success: true, cleared: count, remaining: 0 });
    }
});

app.get('/', function(req, res) {
    res.json({
        service: 'Elexart WhatsApp Service',
        status: connectionStatus,
        connected_user: connectedUser ? connectedUser.name : null,
        qr_url: '/qr',
        status_url: '/status'
    });
});

async function start() {
    await connectMongo();
    app.listen(PORT, '0.0.0.0', function() {
        logger.info('WhatsApp service running on port ' + PORT);
        setTimeout(initWhatsApp, 2000);
    });
}

start();
