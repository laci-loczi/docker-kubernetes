const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; //stored in secret

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

// cpu usage 
let startUsage = process.cpuUsage();
let startTime = process.hrtime.bigint();

let currentMode = 'normal';
let memoryHog = [];

io.on('connection', (socket) => {
    // name of the pod
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

// updating every 1 second
setInterval(() => {
    
    if (currentMode === 'stress') {
        const startLoop = Date.now();
        while (Date.now() - startLoop < 500) { 
            generateLoad();
        }
    }

    // real time cpu usage
    const endUsage = process.cpuUsage(startUsage);
    const endTime = process.hrtime.bigint();
    
    const elapsedNs = Number(endTime - startTime);
    const cpuNs = (endUsage.user + endUsage.system) * 1000;
    let cpuPercentage = (cpuNs / elapsedNs) * 100;
    
    startUsage = process.cpuUsage();
    startTime = process.hrtime.bigint();

    // real time memory 
    const memUsage = process.memoryUsage();
    const totalSystemMem = os.totalmem();
    const usedMemBytes = memUsage.rss;
    const memPercentage = (usedMemBytes / totalSystemMem) * 100;

    // sending data
    io.emit('stats update', {
        cpu: cpuPercentage.toFixed(1),
        mem: memPercentage.toFixed(2),
        memUsed: usedMemBytes, 
        memTotal: totalSystemMem,
        hostname: os.hostname() 
    });

}, 1000);

server.listen(PORT, () => {
    console.log(`Monitor running on ${PORT}`);
});