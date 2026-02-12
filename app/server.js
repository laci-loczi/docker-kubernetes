const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

// Statikus fájlok kiszolgálása (CSS, JS a frontendhez)
app.use(express.static('public'));

// Ha valaki megnyitja az oldalt
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Socket.io kapcsolat kezelése
io.on('connection', (socket) => {
    console.log('Egy felhasználó csatlakozott!');

    // Üzenet fogadása a klienstől és továbbküldése mindenkinek
    socket.on('chat message', (msg) => {
        io.emit('chat message', msg);
    });

    // Rendszeradatok küldése 2 másodpercenként
    const metricsInterval = setInterval(() => {
        const usage = process.memoryUsage();
        const stats = {
            hostname: os.hostname(),
            uptime: Math.floor(process.uptime()),
            memory: Math.round(usage.heapUsed / 1024 / 1024) + ' MB',
            cpu: os.loadavg()[0] // 1 perces átlag terhelés
        };
        socket.emit('system stats', stats);
    }, 2000);

    socket.on('disconnect', () => {
        clearInterval(metricsInterval);
        console.log('Felhasználó kilépett');
    });
});

server.listen(PORT, () => {
    console.log(`🚀 OpsRoom fut a ${PORT}-es porton`);
});