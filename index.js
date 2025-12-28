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
let qrGeneratedAt = 0;
let qrAttempts = 0;
let isConnecting = false;

let pendingMessages = [];
const MAX_PENDING_MESSAGES = 100;

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

function getConnectedHTML() {
    var userName = connectedUser && connectedUser.name ? connectedUser.name : 'WhatsApp User';
    var userPhone = connectedUser && connectedUser.phone ? connectedUser.phone : '';
    return '<!DOCTYPE html><html><head><title>WhatsApp Terhubung</title><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,Roboto,sans-serif;background:linear-gradient(135deg,#25D366 0%,#128C7E 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.container{background:white;border-radius:24px;padding:50px 40px;text-align:center;box-shadow:0 25px 80px rgba(0,0,0,0.3);max-width:420px;width:100%}.success-icon{width:100px;height:100px;background:#25D366;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 25px;font-size:50px;color:white}h1{color:#25D366;margin-bottom:15px;font-size:28px}.user-name{color:#333;font-size:22px;margin-bottom:8px;font-weight:600}.user-phone{color:#666;font-size:18px}.back-btn{display:inline-block;margin-top:35px;padding:15px 40px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;text-decoration:none;border-radius:30px;font-weight:600;font-size:16px}</style></head><body><div class=\"container\"><div class=\"success-icon\">✓</div><h1>WhatsApp Terhubung!</h1><p class=\"user-name\">' + userName + '</p><p class=\"user-phone\">+' + userPhone + '</p><a href=\"https://chat.tripgo.id/dashboard/channels\" class=\"back-btn\">Kembali ke Dashboard</a></div></body></html>';
}

function getLoadingHTML() {
    return '<!DOCTYPE html><html><head><title>Memuat WhatsApp</title><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.container{background:white;border-radius:24px;padding:50px 40px;text-align:center;box-shadow:0 25px 80px rgba(0,0,0,0.3);max-width:420px;width:100%}.loader{width:70px;height:70px;border:5px solid #f0f0f0;border-top:5px solid #25D366;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 25px}@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}h2{color:#333;margin-bottom:15px;font-size:24px}p{color:#666;font-size:16px;line-height:1.6}.status-badge{display:inline-block;background:#fff3cd;color:#856404;padding:8px 20px;border-radius:20px;font-size:14px;margin-top:20px}.refresh-btn{display:inline-block;margin-top:25px;padding:12px 30px;background:#667eea;color:white;text-decoration:none;border-radius:25px;border:none;cursor:pointer;font-size:15px}</style><script>setInterval(function(){fetch(\"/status\").then(function(r){return r.json()}).then(function(d){if(d.status===\"waiting_scan\"||d.status===\"connected\"){location.reload()}}).catch(function(){})},2000)</script></head><body><div class=\"container\"><div class=\"loader\"></div><h2>Menyiapkan WhatsApp...</h2><p>Sedang menghubungkan ke server WhatsApp.<br>Mohon tunggu sebentar.</p><div class=\"status-badge\">Status: ' + connectionStatus + '</div><br><button class=\"refresh-btn\" onclick=\"location.reload()\">Refresh</button></div></body></html>';
}

function getQRHTML(qrBase64, timeRemaining) {
    return '<!DOCTYPE html><html><head><title>Scan QR WhatsApp</title><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.container{background:white;border-radius:24px;padding:35px;text-align:center;box-shadow:0 25px 80px rgba(0,0,0,0.3);max-width:480px;width:100%}.header{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:10px}.wa-logo{width:45px;height:45px;background:#25D366;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px}h1{color:#333;font-size:24px}.subtitle{color:#666;font-size:15px;margin-bottom:25px}.qr-wrapper{background:#f8f9fa;border-radius:20px;padding:25px;margin-bottom:25px;position:relative}.qr-wrapper img{max-width:100%;height:auto;border-radius:15px;display:block;margin:0 auto}.timer{position:absolute;top:15px;right:15px;background:rgba(0,0,0,0.7);color:white;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:500}.timer.warning{background:#dc3545}.instructions{background:linear-gradient(135deg,#e8f5e9 0%,#c8e6c9 100%);border-radius:16px;padding:20px;text-align:left;margin-bottom:20px}.instructions h3{color:#2e7d32;font-size:15px;margin-bottom:12px}.instructions ol{color:#333;font-size:14px;padding-left:22px;line-height:1.8}.instructions li{margin-bottom:4px}.instructions strong{color:#1b5e20}.status-bar{background:#fff8e1;border:1px solid #ffcc02;color:#856404;padding:12px 20px;border-radius:12px;font-size:14px;display:flex;align-items:center;justify-content:center;gap:10px}.pulse-dot{width:12px;height:12px;background:#ffc107;border-radius:50%;animation:pulse 1.5s infinite}@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(1.3)}}.actions{display:flex;gap:12px;margin-top:20px;justify-content:center}.btn{padding:12px 28px;border-radius:25px;font-size:14px;font-weight:500;cursor:pointer;border:none;text-decoration:none}.btn-secondary{background:#f5f5f5;color:#333}.btn-secondary:hover{background:#e8e8e8}.attempt-info{color:#999;font-size:12px;margin-top:15px}</style><script>var timeRemaining=' + timeRemaining + ';setInterval(function(){timeRemaining--;var el=document.getElementById(\"timer\");if(el){el.textContent=timeRemaining+\"s\";if(timeRemaining<=20){el.parentElement.classList.add(\"warning\")}if(timeRemaining<=0){el.textContent=\"Expired\"}}},1000);setInterval(function(){fetch(\"/status\").then(function(r){return r.json()}).then(function(d){if(d.status===\"connected\"){location.reload()}}).catch(function(){})},3000)</script></head><body><div class=\"container\"><div class=\"header\"><div class=\"wa-logo\">📱</div><h1>Hubungkan WhatsApp</h1></div><p class=\"subtitle\">Scan QR code dengan WhatsApp di HP Anda</p><div class=\"qr-wrapper\"><div class=\"timer\"><span id=\"timer\">' + timeRemaining + 's</span></div><img src=\"' + qrBase64 + '\" alt=\"WhatsApp QR Code\" /></div><div class=\"instructions\"><h3>Cara Scan QR Code:</h3><ol><li>Buka <strong>WhatsApp</strong> di HP Anda</li><li>Ketuk <strong>Menu</strong> (pojok kanan atas)</li><li>Pilih <strong>Linked Devices</strong></li><li>Ketuk <strong>Link a Device</strong></li><li>Arahkan kamera HP ke QR code di atas</li></ol></div><div class=\"status-bar\"><span class=\"pulse-dot\"></span>Menunggu scan... QR berlaku selama 2 menit</div><div class=\"actions\"><button class=\"btn btn-secondary\" onclick=\"location.href='/reconnect-page'\">QR Baru</button><a href=\"https://chat.tripgo.id/dashboard/channels\" class=\"btn btn-secondary\">Kembali</a></div><p class=\"attempt-info\">QR Code #' + qrAttempts + '</p></div></body></html>';
}

async function initWhatsApp() {
    if (isConnecting) {
        logger.info('Connection already in progress, skipping...');
        return;
    }
    
    isConnecting = true;
    
    try {
        connectionStatus = 'initializing';
        qrAttempts = 0;
        
        var authState = await useMultiFileAuthState(AUTH_FOLDER);
        var state = authState.state;
        var saveCreds = authState.saveCreds;
        var versionInfo = await fetchLatestBaileysVersion();
        var version = versionInfo.version;
        
        logger.info('Using WA version: ' + version.join('.'));

        if (sock) {
            try { 
                sock.ev.removeAllListeners();
                sock.end(); 
            } catch (e) {}
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
            getMessage: async function(key) { return undefined; },
            syncFullHistory: false,
            fireInitQueries: true,
            generateHighQualityLinkPreview: false,
            markOnlineOnConnect: true
        });

        sock.ev.on('connection.update', async function(update) {
            var connection = update.connection;
            var lastDisconnect = update.lastDisconnect;
            var qr = update.qr;
            
            var statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : null;
            
            logger.info('Connection update: connection=' + connection + ', hasQR=' + !!qr + ', statusCode=' + statusCode);
            
            if (qr) {
                qrAttempts++;
                qrCode = qr;
                qrGeneratedAt = Date.now();
                
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr, { 
                        width: 512,
                        margin: 3,
                        errorCorrectionLevel: 'H',
                        color: { dark: '#000000', light: '#ffffff' }
                    });
                    connectionStatus = 'waiting_scan';
                    logger.info('QR Code #' + qrAttempts + ' generated');
                } catch (err) {
                    logger.error('QR error:', err.message);
                }
            }

            if (connection === 'close') {
                var reason = lastDisconnect && lastDisconnect.error ? lastDisconnect.error.message : 'Unknown';
                logger.info('Connection closed. Code: ' + statusCode + ', Reason: ' + reason);
                
                isConnecting = false;
                connectionStatus = 'disconnected';
                connectedUser = null;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    logger.info('Logged out - clearing auth');
                    await clearAuth();
                    qrCode = null;
                    qrCodeBase64 = null;
                    qrAttempts = 0;
                    setTimeout(initWhatsApp, 5000);
                } else if (statusCode === DisconnectReason.connectionReplaced) {
                    logger.info('Connection replaced by another device');
                    connectionStatus = 'replaced';
                } else if (statusCode === DisconnectReason.timedOut) {
                    logger.info('Connection timed out - restarting...');
                    qrCode = null;
                    qrCodeBase64 = null;
                    setTimeout(initWhatsApp, 3000);
                } else if (statusCode === 515) {
                    logger.info('Restart required by WhatsApp');
                    setTimeout(initWhatsApp, 10000);
                } else if (statusCode === DisconnectReason.multideviceMismatch) {
                    logger.info('Multi-device mismatch - clearing auth');
                    await clearAuth();
                    qrCode = null;
                    qrCodeBase64 = null;
                    setTimeout(initWhatsApp, 5000);
                } else if (statusCode !== DisconnectReason.connectionReplaced) {
                    var delay = qrAttempts > 3 ? 20000 : 8000;
                    logger.info('Reconnecting in ' + (delay/1000) + ' seconds...');
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
                
                logger.info('Connected as: ' + connectedUser.name + ' (' + connectedUser.phone + ')');
                await saveAuthToMongo();
                
                try {
                    await axios.post(FASTAPI_URL + '/api/whatsapp-web/connected', {
                        user: connectedUser
                    }, { timeout: 10000 });
                    logger.info('Backend notified of connection');
                } catch (e) {
                    logger.warn('Could not notify backend:', e.message);
                }
            }
            
            if (connection === 'connecting') {
                connectionStatus = 'connecting';
                logger.info('Connecting to WhatsApp...');
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
                if (!from || from.includes('@g.us') || from.includes('@broadcast')) continue;

                var isLid = from.includes('@lid');
                var phoneNumber = from.replace('@s.whatsapp.net', '').replace('@lid', '');
                var pushName = message.pushName || 'Unknown';
                var messageContent = '[Media]';
                
                if (message.message) {
                    if (message.message.conversation) {
                        messageContent = message.message.conversation;
                    } else if (message.message.extendedTextMessage && message.message.extendedTextMessage.text) {
                        messageContent = message.message.extendedTextMessage.text;
                    }
                }

                logger.info('Message from ' + pushName + ' (' + from + '): ' + messageContent);

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

                var forwardedToBackend = false;
                try {
                    await axios.post(FASTAPI_URL + '/api/whatsapp-web/message', msgData, { timeout: 15000 });
                    logger.info('Message forwarded to backend');
                    forwardedToBackend = true;
                } catch (error) {
                    logger.error('Backend error (will store for sync):', error.message);
                }

                if (!forwardedToBackend) {
                    pendingMessages.push(msgData);
                    if (pendingMessages.length > MAX_PENDING_MESSAGES) {
                        pendingMessages = pendingMessages.slice(-MAX_PENDING_MESSAGES);
                    }
                    logger.info('Message stored for frontend sync. Pending count: ' + pendingMessages.length);
                }
            }
        });

    } catch (error) {
        logger.error('Init error:', error.message);
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
    var acceptHeader = req.headers.accept || '';
    
    if (acceptHeader.includes('application/json')) {
        if (connectionStatus === 'connected') {
            return res.json({ status: 'connected', qr: null, qr_base64: null, user: connectedUser });
        }
        return res.json({ qr: qrCode, qr_base64: qrCodeBase64, status: connectionStatus });
    }
    
    if (connectionStatus === 'connected') {
        return res.send(getConnectedHTML());
    }
    
    if (!qrCodeBase64 || connectionStatus === 'initializing' || connectionStatus === 'connecting') {
        return res.send(getLoadingHTML());
    }
    
    var qrAgeSeconds = Math.round((Date.now() - qrGeneratedAt) / 1000);
    var qrTimeRemaining = Math.max(0, 120 - qrAgeSeconds);
    
    res.send(getQRHTML(qrCodeBase64, qrTimeRemaining));
});

app.get('/reconnect-page', async function(req, res) {
    qrCode = null;
    qrCodeBase64 = null;
    qrAttempts = 0;
    
    if (sock) {
        try { 
            sock.ev.removeAllListeners();
            sock.end(); 
        } catch(e) {}
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
    var phone_number = req.body.phone_number;
    var message = req.body.message;
    
    if (!sock || connectionStatus !== 'connected') {
        return res.status(503).json({ success: false, error: 'Not connected' });
    }
    
    try {
        var jid;
        
        if (phone_number.includes('@')) {
            jid = phone_number;
        } else if (phone_number.startsWith('WA:') || phone_number.length > 15) {
            var cleanNumber = phone_number.replace('WA:', '').replace(/[^0-9]/g, '');
            jid = cleanNumber + '@lid';
        } else {
            var cleanNumber = phone_number.replace(/[^0-9]/g, '');
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
        try { 
            sock.ev.removeAllListeners();
            sock.end(); 
        } catch(e) {} 
        sock = null; 
    }
    
    isConnecting = false;
    setTimeout(initWhatsApp, 2000);
    res.json({ success: true, message: 'Reconnecting...' });
});

app.get('/health', function(req, res) {
    res.json({ 
        status: 'healthy', 
        whatsapp: connectionStatus, 
        mongodb: db ? 'connected' : 'disconnected',
        uptime: process.uptime(),
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
    var body = req.body || {};
    var message_ids = body.message_ids;
    
    if (message_ids && Array.isArray(message_ids) && message_ids.length > 0) {
        pendingMessages = pendingMessages.filter(function(m) {
            return !message_ids.includes(m.message_id);
        });
        res.json({ success: true, cleared: message_ids.length, remaining: pendingMessages.length });
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
"
