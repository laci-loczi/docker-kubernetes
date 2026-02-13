const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const os = require('os');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// --- SEGÉDFÜGGVÉNY: CPU HASZNÁLAT SZÁMÍTÁSA ---
let startUsage = process.cpuUsage();
let startTime = process.hrtime.bigint();

let currentMode = 'normal';
let memoryHog = [];

io.on('connection', (socket) => {
    // Azonnal elküldjük a pod nevét csatlakozáskor is
    socket.emit('init info', { hostname: os.hostname() });

    socket.on('change mode', (data) => {
        if (data.mode === 'stress') {
            if (data.password === ADMIN_PASSWORD) {
                currentMode = 'stress';
            } else {
                socket.emit('auth error', 'Hibás jelszó!');
            }
        } else {
            currentMode = 'normal';
            memoryHog = [];
            if (global.gc) { global.gc(); }
        }
    });
});

function generateLoad() {
    crypto.pbkdf2Sync('titkos', 'só', 1000, 64, 'sha512');
    if (currentMode === 'stress') {
        memoryHog.push(new Array(50000).join('A')); 
    }
}

// --- FŐ MÉRŐ CIKLUS (1 másodpercenként) ---
setInterval(() => {
    
    if (currentMode === 'stress') {
        const startLoop = Date.now();
        while (Date.now() - startLoop < 500) { 
            generateLoad();
        }
    }

    // --- 1. VALÓS CPU MÉRÉS (Process Level) ---
    const endUsage = process.cpuUsage(startUsage);
    const endTime = process.hrtime.bigint();
    
    const elapsedNs = Number(endTime - startTime);
    const cpuNs = (endUsage.user + endUsage.system) * 1000;
    let cpuPercentage = (cpuNs / elapsedNs) * 100;
    
    startUsage = process.cpuUsage();
    startTime = process.hrtime.bigint();

    // --- 2. VALÓS MEMÓRIA MÉRÉS (Process Level) ---
    const memUsage = process.memoryUsage();
    const totalSystemMem = os.totalmem();
    const usedMemBytes = memUsage.rss;
    const memPercentage = (usedMemBytes / totalSystemMem) * 100;

    // Adatok küldése
    io.emit('stats update', {
        cpu: cpuPercentage.toFixed(1),
        mem: memPercentage.toFixed(2),
        hostname: os.hostname() // <--- ITT A VISSZATÉRŐ VENDÉG!
    });

}, 1000);

server.listen(PORT, () => {
    console.log(`🚀 Precision Monitor running on ${PORT}`);
});