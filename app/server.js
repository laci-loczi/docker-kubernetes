const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; //stored in secret

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const os = require('os');
const crypto = require('crypto');

// --- ÚJ: Redis Importok ---
const Redis = require('ioredis');
// 1. A feladatok bedobálására és olvasására (Queue)
const redisQueue = new Redis({ host: '127.0.0.1', port: 6379 });
// 2. A "Kész vagyok" üzenetek hallgatására (Pub/Sub)
const redisSub = new Redis({ host: '127.0.0.1', port: 6379 });

// A kliensek tárolása (hogy tudjuk, kinek kell visszaküldeni az eredményt)
const clients = {}; 

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
    
    // Regisztráljuk a klienst, amikor csatlakozik (A Redis Master logikához)
    clients[socket.id] = socket;

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

    // === ÚJ RÉSZ: A Master fogadja a csomagot a klienstől ===
    socket.on('start render', async (data) => {
        const jobId = socket.id; 
        const pipeline = redisQueue.pipeline(); 

        // Végigmegyünk a kockákon, és bedobáljuk őket a Redis közös asztalára
        data.chunks.forEach(chunk => {
            pipeline.lpush('render_tasks', JSON.stringify({
                jobId: jobId,
                chunkId: chunk.chunkId,
                width: chunk.width,
                height: chunk.height,
                mode: data.mode,
                pixels: chunk.pixels
            }));
        });
        
        // Egyetlen mozdulattal beküldjük az egészet a bázisba
        await pipeline.exec();
    });

    socket.on('disconnect', () => {
        delete clients[socket.id]; // Takarítás, ha elmegy a user
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

// ==========================================
// ÚJ: 1. A MASTER LOGIKA (Eredmények fogadása Redisen keresztül)
// ==========================================
redisSub.psubscribe('job_results_*');
redisSub.on('pmessage', (pattern, channel, message) => {
    const jobId = channel.replace('job_results_', '');
    // Ha a kliens ehhez a Podhoz van csatlakozva, továbbítjuk neki az eredményt
    if (clients[jobId]) {
        clients[jobId].emit('render result', JSON.parse(message));
    }
});

// ==========================================
// ÚJ: 2. A WORKER LOGIKA (Folyamatosan fut a háttérben, várja a feladatot)
// ==========================================
async function workerLoop() {
    try {
        // Blokkoló lekérés: csak akkor megy tovább, ha van munka a Redisben
        const taskRaw = await redisQueue.brpop('render_tasks', 0);
        
        if (taskRaw) {
            const task = JSON.parse(taskRaw[1]);
            const { jobId, chunkId, pixels, width, height, mode } = task;
            
            const chars = [' ', '.', ',', '-', '~', ':', ';', '=', '!', '*', 'x', '%', '#', '@'];
            let asciiHTML = '';
            
            // Lekérjük a JELENLEGI pod nevét, aki a munkát végzi
            const workerName = os.hostname();
            const podColor = stringToColor(workerName);

            // Matek elvégzése
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

            // Kész az eredmény! Publikáljuk a Redis csatornára.
            const resultPayload = { 
                chunkId: chunkId, 
                podName: workerName, 
                podColor: podColor, 
                html: asciiHTML 
            };
            redisQueue.publish(`job_results_${jobId}`, JSON.stringify(resultPayload));
        }
    } catch (err) {
        console.error("Worker error:", err);
    }
    // Azonnali újraindítás
    setImmediate(workerLoop);
}

// Elindítjuk a Munkást!
workerLoop();