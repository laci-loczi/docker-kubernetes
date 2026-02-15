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

app.use(express.json({ limit: '50mb' }));
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

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '00000'.substring(0, 6 - c.length) + c;
}

// experiment part
app.post('/api/render', (req, res) => {
    const { pixels, width, height, mode } = req.body;
    
    const chars = [' ', '.', ',', '-', '~', ':', ';', '=', '!', '*', 'x', '%', '#', '@'];
    let asciiHTML = '';
    
    const podColor = stringToColor(os.hostname());

    for (let y = 0; y < height; y += 2) { 
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            const r = pixels[index];
            const g = pixels[index + 1];
            const b = pixels[index + 2];
            
            const brightness = (0.299 * r + 0.587 * g + 0.114 * b);
            const charIndex = Math.floor((brightness / 255) * (chars.length - 1));
            const char = chars[charIndex];
            let finalColor = `rgb(${r}, ${g}, ${b})`; 
            
            if (mode === 'topology') {
                finalColor = podColor;
            } else if (mode === 'matrix') {
                finalColor = '#10b981'; 
            }

            asciiHTML += `<span style="color: ${finalColor}">${char}</span>`;
        }
        asciiHTML += '\n'; 
    }

    if (currentMode === 'stress') {
        const start = Date.now();
        while (Date.now() - start < 100) {} 
    }

    res.json({
        podName: os.hostname(),
        podColor: podColor,
        html: asciiHTML
    });
});