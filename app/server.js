const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// --- SZIMULÁCIÓS ÁLLAPOT ---
let currentMode = 'normal'; // 'normal' vagy 'stress'
let currentRPS = 10;        // Kezdő Requests Per Second

io.on('connection', (socket) => {
    console.log('Dashboard connected');

    // Frontendről érkező parancs fogadása
    socket.on('change mode', (mode) => {
        currentMode = mode;
        console.log(`Üzemmód váltás: ${mode}`);
        // Azonnali visszajelzés minden kliensnek (pl. mások is látják ha átkapcsolod)
    });
});

// --- NODE.JS EVENT LOOP SZIMULÁCIÓ ---
// 500ms-enként frissítjük az adatokat és küldjük ki
setInterval(() => {
    // 1. Logika: Forgalom generálás az üzemmód alapján
    let targetRPS = currentMode === 'stress' ? 90 : 15;
    
    // Kicsit "remegjen" az érték, hogy valósnak tűnjön (Random faktor)
    const fluctuation = Math.floor(Math.random() * 10) - 5; 
    
    // Finom átmenet az értékek között (nem ugrik egyből 90-re)
    if (currentRPS < targetRPS) currentRPS += 5;
    if (currentRPS > targetRPS) currentRPS -= 5;
    
    let displayRPS = currentRPS + fluctuation;
    if (displayRPS < 0) displayRPS = 0;

    // 2. Logika: CPU Terhelés számítása az RPS alapján
    let serverLoad = Math.floor((displayRPS / 100) * 100); 

    // 3. Adatcsomag összeállítása
    const data = {
        hostname: os.hostname(),
        rps: displayRPS,
        load: serverLoad,
        timestamp: new Date().toLocaleTimeString()
    };

    // 4. KÜLDÉS (Emit)
    io.emit('dashboard update', data);

}, 800); // 800ms frissítési ráta

server.listen(PORT, () => {
    console.log(`🚀 Traffic Simulator running on ${PORT}`);
});