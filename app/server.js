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

// --- SEGÉDFÜGGVÉNY: CPU IDŐK LEKÉRÉSE ---
// Ez összegzi az összes mag (core) idejét
function getCpuInfo() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;

    for (const cpu of cpus) {
        for (const type in cpu.times) {
            total += cpu.times[type];
        }
        idle += cpu.times.idle;
    }
    return { idle, total };
}

// Kezdeti mérés
let startMeasure = getCpuInfo();
let currentMode = 'normal';
let memoryHog = []; // Ez fogja enni a RAM-ot

io.on('connection', (socket) => {
    socket.on('change mode', (data) => {
        if (data.mode === 'stress') {
            if (data.password === ADMIN_PASSWORD) {
                currentMode = 'stress';
            } else {
                socket.emit('auth error', 'Hibás jelszó!');
            }
        } else {
            currentMode = 'normal';
            memoryHog = []; // Felszabadítjuk a RAM-ot
            if (global.gc) { global.gc(); }
        }
    });
});

// --- TERHELÉS GENERÁTOR (Stressz módhoz) ---
// Ez azért kell, hogy legyen mit mérni. Ha nem fut semmi, a CPU 0% lesz.
function generateLoad() {
    // 1. CPU Égetés: Nehéz matematika
    crypto.pbkdf2Sync('titkos', 'só', 1000, 64, 'sha512');
    
    // 2. RAM Égetés: Nagy tömbök
    if (currentMode === 'stress') {
        memoryHog.push(new Array(50000).join('A')); 
    }
}

// --- FŐ MÉRŐ CIKLUS (1 másodpercenként) ---
setInterval(() => {
    
    // Ha be van kapcsolva a stressz, dolgoztatjuk a gépet
    if (currentMode === 'stress') {
        // Csinálunk egy kis mesterséges terhelést, hogy megugorjon a grafikon
        // De a mérés VALÓS lesz!
        const start = Date.now();
        while (Date.now() - start < 500) { // 500ms-ig folyamatosan dolgozik
            generateLoad();
        }
    }

    // --- 1. VALÓS CPU SZÁMÍTÁS (Delta módszer) ---
    const endMeasure = getCpuInfo();
    
    // Kiszámoljuk a különbséget az előző mérés óta
    const idleDifference = endMeasure.idle - startMeasure.idle;
    const totalDifference = endMeasure.total - startMeasure.total;
    
    // A százalék: (Összes - Üresjárat) / Összes
    const cpuPercentage = 100 - Math.floor((100 * idleDifference) / totalDifference);
    
    // Frissítjük a kezdőértéket a következő körre
    startMeasure = endMeasure;

    // --- 2. VALÓS MEMÓRIA MÉRÉS ---
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem; // Node.js-en ez a teljes rendszer memóriája
    const memPercentage = Math.floor((usedMem / totalMem) * 100);

    // Adatok küldése
    io.emit('stats update', {
        cpu: cpuPercentage,
        mem: memPercentage
    });

}, 1000);

server.listen(PORT, () => {
    console.log(`🚀 System Monitor running on ${PORT}`);
});