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
                    qrCodeBase64 = await QRCode.toDataURL(qr, { 
                        width: 512,
                        margin: 3,
                        errorCorrectionLevel: 'H'
                    });
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
Exit code: 0
