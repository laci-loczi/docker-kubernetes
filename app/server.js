const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; //stored in secret
const ROLE = process.env.ROLE || 'all'; // 'api', 'worker', or 'all'

const express = require('express'); // web server
const http = require('http'); // http
const { Server } = require("socket.io"); // socket.io
const os = require('os'); // operating system
const crypto = require('crypto'); // crypto
const Redis = require('ioredis'); // redis
const { Blob } = require('buffer'); // blob

// -------------------------------------------------------------
const REDIS_HOST = process.env.REDIS_HOST || 'redis-service'; // redis host
const redisMaster = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); // redis master
const redisWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); // redis worker
const redisSub = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); // redis sub
const redisTranslateWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); // redis translate worker

redisMaster.on('error', (err) => console.error('Redis Master error'));
redisWorker.on('error', (err) => console.error('Redis Worker error'));
redisSub.on('error', (err) => console.error('Redis Sub error'));
redisTranslateWorker.on('error', (err) => console.error('Redis Translate Worker error'));

const redisAiWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); // redis ai worker

process.on('uncaughtException', (err) => {
    console.error('Critical error:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection:', reason);
});
// -------------------------------------------------------------

let startUsage = process.cpuUsage(); // start usage
let startTime = process.hrtime.bigint(); // start time
let currentMode = 'normal'; // current mode
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
    
    // store the translations in memory for the api
    const activeTranslations = {};

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
            
            const sub = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });
            await sub.subscribe(responseChannel);
            
            sub.on('message', (channel, message) => {
                if (channel === responseChannel) {
                    callback(JSON.parse(message)); 
                    sub.unsubscribe(responseChannel);
                    sub.quit();
                }
            });

            await redisMaster.lpush('ai_tasks', JSON.stringify({
                taskId: taskId,
                image: data.image
            }));
        });

        // subtitle translation api logic
        socket.on('translate subtitle', async (srtText) => {
            try {
                // dynamic esm import (bulletproof version)
                const srtParserModule = await import("srt-parser-2");
                const ParserClass = srtParserModule.default?.default || srtParserModule.default || srtParserModule;
                const parser = new ParserClass();
                
                const srtArray = parser.fromSrt(srtText);
                console.log(`[API] SRT fájl feldolgozva, ${srtArray.length} sor küldése a workereknek...`);
                
                if (!srtArray || srtArray.length === 0) {
                    socket.emit('subtitle error', 'A fájl üres vagy hibás SRT formátumú.');
                    return;
                }

                const jobId = 'sub_' + crypto.randomUUID();

                activeTranslations[jobId] = {
                    total: srtArray.length,
                    received: 0,
                    lines: srtArray,
                    socket: socket
                };

                const sub = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });
                await sub.subscribe(`sub_result_${jobId}`);
                
                sub.on('message', (channel, message) => {
                    const data = JSON.parse(message);
                    const job = activeTranslations[jobId];
                    if (!job) return;

                    job.lines[data.index].text = data.translatedText;
                    job.received++;

                    const progress = Math.round((job.received / job.total) * 100);
                    job.socket.emit('subtitle progress', { progress, received: job.received, total: job.total });

                    if (job.received === job.total) {
                        const translatedSrt = parser.toSrt(job.lines);
                        job.socket.emit('subtitle done', { srt: translatedSrt });
                        delete activeTranslations[jobId];
                        sub.unsubscribe();
                        sub.quit();
                    }
                });

                const pipeline = redisMaster.pipeline();
                srtArray.forEach((line, index) => {
                    pipeline.lpush('translate_tasks', JSON.stringify({
                        jobId: jobId,
                        index: index,
                        text: line.text
                    }));
                });
                await pipeline.exec();
                
                // immediate response to the client, that the request has been successfully added to the Redis!
                socket.emit('subtitle progress', { progress: 0, received: 0, total: srtArray.length });

            } catch (err) {
                console.error("[API] SRT feldolgozási hiba:", err);
                socket.emit('subtitle error', 'Hiba a fájl feldolgozásakor: ' + err.message);
            }
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
        hash = str.charCodeAt(i) + ((hash << 5) - hash); // hash calculation
    }
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase(); // color calculation
    return '#' + '00000'.substring(0, 6 - c.length) + c;
}

if (ROLE === 'worker' || ROLE === 'all') {
    console.log(`[WORKER] Inicializálva a ${os.hostname()} node-on.`);
    
    let objectDetectorPipeline = null;
    let translatorPipeline = null; // subtitle translation ai

    async function getAiPipeline() {
        if (!objectDetectorPipeline) {
            console.log(`[WORKER ${os.hostname()}] Object Detector AI Modell betöltése a memóriába...`);
            const { pipeline, env } = await import('@huggingface/transformers');
            env.allowLocalModels = false; 
            objectDetectorPipeline = await pipeline('object-detection', 'Xenova/detr-resnet-50');
            console.log(`[WORKER ${os.hostname()}] Object Detector KÉSZ!`);
        }
        return objectDetectorPipeline;
    }

    // subtitle translation ai initialization
    async function getTranslatorPipeline() {
        if (!translatorPipeline) {
            console.log(`[WORKER ${os.hostname()}] NLP Fordító AI letöltése és inicializálása...`);
            const { pipeline, env } = await import('@huggingface/transformers');
            env.allowLocalModels = false;
            
            // magic: progress_callback, so you can see the download in the logs!
            translatorPipeline = await pipeline('translation', 'Xenova/opus-mt-en-hu', {
                progress_callback: (info) => {
                    if (info.status === 'progress') {
                        console.log(`[WORKER] Modell letöltés (${info.file}): ${Math.round(info.progress)}%`);
                    } else if (info.status === 'ready') {
                        console.log(`[WORKER] Fájl kész: ${info.file}`);
                    }
                }
            });
            
            console.log(`[WORKER ${os.hostname()}] NLP Fordító AI KÉSZ!`);
        }
        return translatorPipeline;
    }

    async function aiWorkerLoop() {
        let taskRaw = null; 
        try {
            taskRaw = await redisAiWorker.brpop('ai_tasks', 1);
            if (taskRaw) {
                const task = JSON.parse(taskRaw[1]);
                console.log(`[WORKER ${os.hostname()}] AI Kép elemzése elindult...`);
                
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

                const workerName = os.hostname();
                redisMaster.publish(`ai_result_${task.taskId}`, JSON.stringify({ 
                    predictions: predictions,
                    podName: workerName,
                    podColor: stringToColor(workerName)
                }));
                console.log(`[WORKER ${os.hostname()}] AI Elemzés kész, eredmény elküldve.`);
            }
        } catch (err) {
            console.error("AI Worker hiba:", err);
            if (taskRaw) {
                const task = JSON.parse(taskRaw[1]);
                redisMaster.publish(`ai_result_${task.taskId}`, JSON.stringify({ error: err.message }));
            }
        }
        setImmediate(aiWorkerLoop);
    }

    // subtitle translation worker loop
    async function translateWorkerLoop() {
        try {
            const taskRaw = await redisTranslateWorker.brpop('translate_tasks', 1);
            if (taskRaw) {
                const task = JSON.parse(taskRaw[1]);
                
                try {
                    let finalTranslatedText = task.text;
                    
                    if (task.text && task.text.trim() !== "") {
                        // CLEANING: remove all html tags, but keep the line breaks (\n)
                        const cleanText = task.text.replace(/<[^>]*>?/gm, '').trim();
                        
                        // break the subtitle block into individual lines (usually 1 or 2 lines)
                        const lines = cleanText.split('\n');
                        const translatedLines = [];
                        
                        const translator = await getTranslatorPipeline();
                        
                        // iterate through the lines, and submit them one by one to the ai model
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i].trim();
                            if (line === "") {
                                translatedLines.push("");
                            } else {
                                // translate the clean line
                                const result = await translator(line);
                                translatedLines.push(result[0].translation_text);
                            }
                        }
                        
                        // reassemble the block with the original line breaks
                        finalTranslatedText = translatedLines.join('\n');
                    }

                    // publish the result to the api
                    redisMaster.publish(`sub_result_${task.jobId}`, JSON.stringify({
                        index: task.index,
                        translatedText: finalTranslatedText
                    }));
                    
                } catch (aiErr) {
                    console.error(`[WORKER ${os.hostname()}] !!! AI Fordítási hiba:`, aiErr.message);
                    redisMaster.publish(`sub_result_${task.jobId}`, JSON.stringify({
                        index: task.index,
                        translatedText: `[HIBA: ${task.text}]` 
                    }));
                }
            }
        } catch (err) {
            console.error("Translate Worker Redis hiba:", err.message);
        }
        setImmediate(translateWorkerLoop);
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
    
    // start all three worker processes in parallel
    aiWorkerLoop();
    translateWorkerLoop();
    workerLoop();
}