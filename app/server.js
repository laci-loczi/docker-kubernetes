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

// --- VALÓS FORGALOM SZÁMLÁLÓ ---
let requestCounter = 0;

// Ez a Middleware minden bejövő kérésnél lefut (kép, html, bármi)
app.use((req, res, next) => {
    requestCounter++; 
    next();
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

let currentMode = 'normal';

io.on('connection', (socket) => {
    // Kezdeti állapot küldése
    socket.emit('mode update', currentMode);

    socket.on('change mode', (data) => {
        if (data.mode === 'stress') {
            if (!ADMIN_PASSWORD) {
                socket.emit('auth error', 'Nincs jelszó beállítva a szerveren!');
                return;
            }
            if (data.password === ADMIN_PASSWORD) {
                 currentMode = 'stress';
                 io.emit('mode update', currentMode);
            } else {
                 socket.emit('auth error', 'Hibás jelszó!');
            }
        } 
        else if (data.mode === 'normal') {
            currentMode = 'normal';
            io.emit('mode update', currentMode);
        }
    });
});

// --- A "NEHÉZ MUNKA" FÜGGVÉNY ---
function performHeavyTask() {
    // Egyetlen nehéz titkosítási művelet
    crypto.createHash('sha256').update('titkosadat' + Math.random()).digest('hex');
}

// --- FŐ CIKLUS (1 másodpercenként) ---
setInterval(() => {
    
    // 1. Ha STRESSZ mód van, generálunk belső terhelést
    if (currentMode === 'stress') {
        // Lefuttatunk 500 nehéz műveletet
        // Ezt hozzáadjuk a számlálóhoz, mert ez VALÓS munka a szervernek
        for (let i = 0; i < 500; i++) {
            performHeavyTask();
            requestCounter++; 
        }
    }

    // 2. VALÓS RENDSZERTERHELÉS MÉRÉSE (Memória)
    // Nincs több random szám! Ez a gép tényleges állapota.
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const realLoadPercentage = Math.round((usedMem / totalMem) * 100);

    // 3. ADATCSOMAG ÖSSZEÁLLÍTÁSA
    const data = {
        hostname: os.hostname(),
        rps: requestCounter, // Ez a pontos szám (Külső kérés + Belső munka)
        load: realLoadPercentage, 
    };

    io.emit('dashboard update', data);

    // 4. SZÁMLÁLÓ NULLÁZÁSA a következő másodpercre
    requestCounter = 0;

}, 1000);

server.listen(PORT, () => {
    console.log(`🚀 Real Data Server running on ${PORT}`);
});