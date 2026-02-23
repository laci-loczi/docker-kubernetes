const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; //stored in secret
const ROLE = process.env.ROLE || 'all'; // 'api', 'worker', vagy 'all'

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const os = require('os');
const crypto = require('crypto');
const Redis = require('ioredis');
const { Blob } = require('buffer'); // <-- ÚJ SOR: Importáljuk a Blob-ot a biztonság kedvéért

// -------------------------------------------------------------
const REDIS_HOST = process.env.REDIS_HOST || 'redis-service'; 
const redisMaster = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });
const redisWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });
const redisSub = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });

redisMaster.on('error', (err) => console.error('Redis Master hiba (keresem a kapcsolatot...)'));
redisWorker.on('error', (err) => console.error('Redis Worker hiba (keresem a kapcsolatot...)'));
redisSub.on('error', (err) => console.error('Redis Sub hiba (keresem a kapcsolatot...)'));

const redisAiWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });

process.on('uncaughtException', (err) => {
    console.error('Kritikus hiba:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Kezeletlen Promise hiba:', reason);
});
// -------------------------------------------------------------

let startUsage = process.cpuUsage();
let startTime = process.hrtime.bigint();
let currentMode = 'normal';
let memoryHog = [];

redisSub.subscribe('system_mode');
redisSub.on('message', (channel, message) => {
    if (channel === 'system_mode') {
        const data = JSON.parse(message);
        currentMode = data.mode;
        if (currentMode === 'normal') {
            memoryHog = [];
            if (global.gc) { global.gc(); }
        }
    }
});


if (ROLE === 'api' || ROLE === 'all') {
    const clients = {}; 
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { maxHttpBufferSize: 2e6 });
    const PORT = 3000;

    app.use(express.json({ limit: '2mb' }));
    app.use(express.static('public'));

    app.get('/', (req, res) => {
        res.sendFile(__dirname + '/public/index.html');
    });

    io.on('connection', (socket) => {
        socket.emit('init info', { hostname: os.hostname() });
        clients[socket.id] = socket;

        socket.on('change mode', (data) => {
            if (data.mode === 'stress' && data.password !== ADMIN_PASSWORD) {
                socket.emit('auth error', 'Hibás jelszó!');
                return;
            }
            redisMaster.publish('system_mode', JSON.stringify({ mode: data.mode }));
        });

        socket.on('start render row', async (data) => {
            const jobId = socket.id; 
            const pipeline = redisMaster.pipeline();
            
            data.chunks.forEach(chunk => {
                pipeline.lpush('render_tasks', JSON.stringify({
                    jobId: jobId,
                    chunkId: chunk.chunkId,
                    width: chunk.width,
                    height: chunk.height,
                    globalX: chunk.globalX, 
                    globalY: chunk.globalY, 
                    aiBoxes: data.aiBoxes,  
                    mode: data.mode,
                    pixels: chunk.pixels
                }));
            });
            await pipeline.exec();
        });
        socket.on('analyze image', async (data, callback) => {
            const taskId = 'ai_' + crypto.randomUUID();
            const responseChannel = `ai_result_${taskId}`;
            
            // 1. LÉPÉS: ELŐBB feliratkozunk a válaszra!
            const sub = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });
            await sub.subscribe(responseChannel);
            
            sub.on('message', (channel, message) => {
                if (channel === responseChannel) {
                    callback(JSON.parse(message)); 
                    sub.unsubscribe(responseChannel);
                    sub.quit();
                }
            });

            // 2. LÉPÉS: CSAK UTÁNA dobjuk be a feladatot a közösbe!
            await redisMaster.lpush('ai_tasks', JSON.stringify({
                taskId: taskId,
                image: data.image
            }));
        });

        socket.on('disconnect', () => { delete clients[socket.id]; });
    });

    redisSub.psubscribe('job_results_*');
    redisSub.subscribe('system_stats');

    redisSub.on('pmessage', (pattern, channel, message) => {
        const jobId = channel.replace('job_results_', '');
        if (clients[jobId]) {
            clients[jobId].emit('render result', JSON.parse(message));
        }
    });

    redisSub.on('message', (channel, message) => {
        if (channel === 'system_stats') {
            io.emit('stats update', JSON.parse(message)); 
        }
    });

    server.listen(PORT, () => {
        console.log(`[API] Server running on ${PORT}`);
    });
}


function generateLoad() {
    crypto.pbkdf2Sync('titkos', 'só', 1000, 64, 'sha512');
    if (currentMode === 'stress') {
        memoryHog.push(new Array(50000).join('A')); 
    }
}

setInterval(() => {
    if (currentMode === 'stress') {
        const startLoop = Date.now();
        while (Date.now() - startLoop < 500) { generateLoad(); }
    }

    const endUsage = process.cpuUsage(startUsage);
    const endTime = process.hrtime.bigint();
    
    const elapsedNs = Number(endTime - startTime);
    const cpuNs = (endUsage.user + endUsage.system) * 1000;
    let cpuPercentage = (cpuNs / elapsedNs) * 100;
    
    startUsage = process.cpuUsage();
    startTime = process.hrtime.bigint();

    const memUsage = process.memoryUsage();
    const totalSystemMem = os.totalmem();
    const memPercentage = (memUsage.rss / totalSystemMem) * 100;

    redisMaster.publish('system_stats', JSON.stringify({
        cpu: cpuPercentage.toFixed(1),
        mem: memPercentage.toFixed(2),
        memUsed: memUsage.rss, 
        memTotal: totalSystemMem,
        hostname: os.hostname() 
    }));
}, 1000);


function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '00000'.substring(0, 6 - c.length) + c;
}

if (ROLE === 'worker' || ROLE === 'all') {
    console.log(`[WORKER] Inicializálva a ${os.hostname()} node-on.`);
    
    let objectDetectorPipeline = null;

    async function getAiPipeline() {
        if (!objectDetectorPipeline) {
            console.log(`[WORKER ${os.hostname()}] AI Modell betöltése a memóriába...`);
            // Node.js dinamikus import a Transformers.js-hez
            const { pipeline, env } = await import('@huggingface/transformers');
            // Kikapcsoljuk a helyi fájlkeresést, a HuggingFace-ről húzza le
            env.allowLocalModels = false; 
            objectDetectorPipeline = await pipeline('object-detection', 'Xenova/detr-resnet-50');
            console.log(`[WORKER ${os.hostname()}] AI Modell KÉSZ!`);
        }
        return objectDetectorPipeline;
    }

    async function aiWorkerLoop() {
        let taskRaw = null; 
        try {
            taskRaw = await redisAiWorker.brpop('ai_tasks', 1);
            if (taskRaw) {
                const task = JSON.parse(taskRaw[1]);
                const workerName = os.hostname();

                redisMaster.publish('system_stats', JSON.stringify({
                    aiStatus: 'working',
                    aiPod: workerName,
                    taskId: task.taskId
                }));

                const detector = await getAiPipeline();
                const base64Data = task.image.replace(/^data:image\/\w+;base64,/, "");
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const imageBlob = new Blob([imageBuffer], { type: 'image/jpeg' });
                
                const rawPredictions = await detector(imageBlob, { threshold: 0.5, percentage: false });
                
                const predictions = rawPredictions.map(p => ({
                    class: p.label,
                    score: p.score,
                    bbox: [p.box.xmin, p.box.ymin, p.box.xmax - p.box.xmin, p.box.ymax - p.box.ymin]
                }));

                redisMaster.publish(`ai_result_${task.taskId}`, JSON.stringify({ predictions }));
                redisMaster.publish('system_stats', JSON.stringify({
                    aiStatus: 'idle',
                    aiPod: null
                }));
            }
        } catch (err) {
            console.error("AI Worker hiba:", err);
            redisMaster.publish('system_stats', JSON.stringify({ aiStatus: 'idle', aiPod: null }));
            if (taskRaw) {
                const task = JSON.parse(taskRaw[1]);
                redisMaster.publish(`ai_result_${task.taskId}`, JSON.stringify({ error: err.message }));
            }
        }
        setImmediate(aiWorkerLoop);
    }

    async function workerLoop() {
        try {
            const taskRaw = await redisWorker.brpop('render_tasks', 0);        
            if (taskRaw) {
                const task = JSON.parse(taskRaw[1]);
                const { jobId, chunkId, pixels, width, height, mode, globalX, globalY, aiBoxes } = task;
                
                const chars = [' ', '.', ',', '-', '~', ':', ';', '=', '!', '*', 'x', '%', '#', '@'];
                let asciiHTML = '';
                
                const workerName = os.hostname();
                const podColor = stringToColor(workerName);

                for (let y = 0; y < height; y += 2) { 
                    for (let x = 0; x < width; x++) {
                        const index = (y * width + x) * 4;
                        const r = pixels[index];
                        const g = pixels[index + 1];
                        const b = pixels[index + 2];
                        
                        const gX = globalX + x;
                        const gY = globalY + y;

                        const brightness = (0.299 * r + 0.587 * g + 0.114 * b);
                        const charIndex = Math.floor((brightness / 255) * (chars.length - 1));
                        
                        let charToDraw = chars[charIndex];
                        let finalColor = `rgb(${r}, ${g}, ${b})`; 
                        let isAiOverlay = false;

                        if (aiBoxes && aiBoxes.length > 0) {
                            for (let i = 0; i < aiBoxes.length; i++) {
                                const box = aiBoxes[i];
                                const [bx, by, bw, bh] = box.bbox;
                                const bLeft = Math.floor(bx);
                                const bTop = Math.floor(by);
                                const bRight = Math.floor(bx + bw);
                                const bBottom = Math.floor(by + bh);

                                const isTop = Math.abs(gY - bTop) <= 1 && gX >= bLeft && gX <= bRight;
                                const isBottom = Math.abs(gY - bBottom) <= 1 && gX >= bLeft && gX <= bRight;
                                const isLeft = gX === bLeft && gY >= bTop && gY <= bBottom;
                                const isRight = gX === bRight && gY >= bTop && gY <= bBottom;

                                if (isTop || isBottom || isLeft || isRight) {
                                    isAiOverlay = true;
                                    finalColor = '#ef4444'; 
                                    charToDraw = '+';

                                    if (isTop) {
                                        const label = `[ ${box.class.toUpperCase()} ${Math.round(box.score * 100)}% ]`;
                                        const textStartX = bLeft + 2;
                                        if (gX >= textStartX && gX < textStartX + label.length) {
                                            charToDraw = label[gX - textStartX];
                                            finalColor = '#10b981'; 
                                        }
                                    }
                                    break; 
                                }
                            }
                        }

                        if (!isAiOverlay) {
                            if (mode === 'topology') finalColor = podColor;
                            else if (mode === 'matrix') finalColor = '#10b981'; 
                        }

                        asciiHTML += `<span style="color: ${finalColor}; font-weight: ${isAiOverlay ? '900' : 'normal'}">${charToDraw}</span>`;
                    }
                    asciiHTML += '\n'; 
                }

                if (currentMode === 'stress') {
                    const start = Date.now();
                    while (Date.now() - start < 100) {} 
                }

                const resultPayload = { 
                    chunkId: chunkId, 
                    podName: workerName, 
                    podColor: podColor, 
                    html: asciiHTML 
                };
                redisMaster.publish(`job_results_${jobId}`, JSON.stringify(resultPayload));        
            }
        } catch (err) {
            console.error("Worker hiba történt:", err);
        }
        setImmediate(workerLoop);
    }
    aiWorkerLoop();
    workerLoop();
}