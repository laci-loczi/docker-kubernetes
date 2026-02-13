const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const os = require('os');
const crypto = require('crypto'); // Ezzel fogunk nehéz titkosítást számolni

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

let currentMode = 'normal';


// Ezt a jelszót csak te tudod (a környezeti változóból még profibb lenne, de most jó így)

io.on('connection', (socket) => {
    // ...
    socket.on('change mode', (data) => {
        
        // 1. ESET: STRESS MÓD (Jelszót kér)
        if (data.mode === 'stress') {
            
            // Biztonsági ellenőrzés: Van-e beállítva jelszó?
            if (!ADMIN_PASSWORD) {
                console.log("HIBA: Nincs beállítva admin jelszó a szerveren!");
                socket.emit('auth error', 'Szerver konfigurációs hiba (nincs jelszó)!');
                return;
            }

            // Jelszó ellenőrzés
            if (data.password === ADMIN_PASSWORD) {
                 currentMode = 'stress';
                 console.log("⚠️ Módváltás: STRESS");
                 io.emit('mode update', currentMode);
            } else {
                 socket.emit('auth error', 'Hibás jelszó!');
            }
        } 
        
        // 2. ESET: NORMAL MÓD (Ide hiányzott a kód!)
        // Ha nem 'stress' a parancs, akkor feltételezzük, hogy 'normal'
        else if (data.mode === 'normal') {
            currentMode = 'normal';
            console.log("✅ Módváltás: NORMAL");
            
            // Értesítünk mindenkit, hogy vége a riadónak
            io.emit('mode update', currentMode);
        }
    });
});

// ... (A setInterval és a server.listen marad)

// --- CPU ÉGETŐ FÜGGVÉNY ---
function stressCPU() {
    // Ez a függvény kb. 200 milliszekundumig folyamatosan SHA256 hasht számol
    // Ez "blokkolja" a processzort, tehát 100%-on pörgeti az adott magot.
    const start = Date.now();
    while (Date.now() - start < 200) {
        crypto.createHash('sha256').update('izzadjon a processzor' + Math.random()).digest('hex');
    }
}

setInterval(() => {
    let load = 0;

    // Ha STRESS mód van, akkor meghívjuk a nehéz függvényt
    if (currentMode === 'stress') {
        stressCPU();
        load = 80 + Math.floor(Math.random() * 20); // 80-100%
    } else {
        load = 5 + Math.floor(Math.random() * 10); // 5-15%
    }

    const data = {
        hostname: os.hostname(),
        rps: currentMode === 'stress' ? 500 : 10, // Csak a grafikonnak
        load: load, 
        timestamp: new Date().toLocaleTimeString()
    };

    io.emit('dashboard update', data);

}, 500); // Fél másodpercenként fut

server.listen(PORT, () => {
    console.log(`🚀 Real Stress Server running on ${PORT}`);
});