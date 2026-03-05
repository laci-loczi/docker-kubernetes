const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ROLE = process.env.ROLE || 'all'; 

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const os = require('os');
const crypto = require('crypto');
const Redis = require('ioredis');
const { Blob } = require('buffer');


const REDIS_HOST = process.env.REDIS_HOST || 'redis-service'; 
const redisMaster = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); 
const redisWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); 
const redisSub = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); 
const redisTranslateWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); 
const redisAiWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });

redisMaster.on('error', (err) => console.error('Redis Master error'));
redisWorker.on('error', (err) => console.error('Redis Worker error'));
redisSub.on('error', (err) => console.error('Redis Sub error'));
redisTranslateWorker.on('error', (err) => console.error('Redis Translate error'));

process.on('uncaughtException', (err) => console.error('Critical error:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

let startUsage = process.cpuUsage();
let startTime = process.hrtime.bigint();
let currentMode = 'normal';
let memoryHog = [];

redisSub.subscribe('system_mode');


if (ROLE === 'api' || ROLE === 'all') {
    const clients = {}; 
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { maxHttpBufferSize: 2e6 });
    const PORT = 3000;
    
    const activeTranslations = {};
    const activeAiTasks = {}; // optimization: track the open ai requests

    app.use(express.json({ limit: '2mb' }));
    app.use(express.static('public'));

    // liveness & readiness probe endpoint for kubernetes
    app.get('/healthz', (req, res) => res.status(200).send('OK'));

    app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

    // subscribe to the single redisSub connection for everything!
    redisSub.psubscribe('job_results_*', 'sub_result_*', 'ai_result_*');
    redisSub.subscribe('system_stats');

    redisSub.on('pmessage', (pattern, channel, message) => {
        if (pattern === 'job_results_*') {
            const jobId = channel.replace('job_results_', '');
            if (clients[jobId]) clients[jobId].emit('render result', JSON.parse(message));
        } 
        else if (pattern === 'sub_result_*') {
            const data = JSON.parse(message);
            const jobId = channel.replace('sub_result_', '');
            const job = activeTranslations[jobId];
            if (!job) return; 

            // we get multiple thousands of lines back at once, we need to fit them in the right place
            data.translatedItems.forEach((transText, i) => {
                if (job.lines[data.startIndex + i]) {
                    job.lines[data.startIndex + i].text = transText;
                }
            });
            job.received++; // one batch processed

            // calculate the real number of sentences to the ui
            const currentLinesDone = Math.min(job.received * 30, job.lines.length);
            const progress = Math.round((job.received / job.total) * 100);
            job.socket.emit('subtitle progress', { progress, received: currentLinesDone, total: job.lines.length });

            if (job.received === job.total) {
                try {
                    const translatedSrt = job.parser.toSrt(job.lines);
                    job.socket.emit('subtitle done', { srt: translatedSrt });
                } catch (e) { console.error("[API] SRT Fájl generálási hiba:", e); }
                delete activeTranslations[jobId];
            }
        }
        else if (pattern === 'ai_result_*') {
            const taskId = channel.replace('ai_result_', '');
            if (activeAiTasks[taskId]) {
                activeAiTasks[taskId](JSON.parse(message)); // execute the callback
                delete activeAiTasks[taskId]; // free the memory
            }
        }
    });

    redisSub.on('message', (channel, message) => {
        if (channel === 'system_mode') {
            const data = JSON.parse(message);
            currentMode = data.mode;
            if (currentMode === 'normal') {
                memoryHog = [];
                if (global.gc) { global.gc(); }
            }
        } else if (channel === 'system_stats') {
            io.emit('stats update', JSON.parse(message)); 
        }
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
                    jobId: jobId, chunkId: chunk.chunkId, width: chunk.width,
                    height: chunk.height, globalX: chunk.globalX, globalY: chunk.globalY, 
                    aiBoxes: data.aiBoxes, mode: data.mode, pixels: chunk.pixels
                }));
            });
            await pipeline.exec();
        });
        
        socket.on('analyze image', async (data, callback) => {
            const taskId = 'ai_' + crypto.randomUUID();
            activeAiTasks[taskId] = callback; // Eltároljuk a callbacket memóriában
            
            await redisMaster.lpush('ai_tasks', JSON.stringify({
                taskId: taskId, image: data.image
            }));
        });

        socket.on('translate subtitle', async (srtText) => {
            try {
                const srtParserModule = await import("srt-parser-2");
                const ParserClass = srtParserModule.default?.default || srtParserModule.default || srtParserModule;
                const parser = new ParserClass();
                
                const srtArray = parser.fromSrt(srtText);
                if (!srtArray || srtArray.length === 0) {
                    socket.emit('subtitle error', 'A fájl üres vagy hibás SRT formátumú.');
                    return;
                }

                const jobId = 'sub_' + crypto.randomUUID();
                
                // smart batching: pack 30 time slots into one
                const BATCH_SIZE = 30; 
                const tasks = [];
                for (let i = 0; i < srtArray.length; i += BATCH_SIZE) {
                    tasks.push({
                        jobId: jobId,
                        startIndex: i,
                        items: srtArray.slice(i, i + BATCH_SIZE).map(c => c.text) // send only the text
                    });
                }

                // 'total' now is the number of batches, not the number of lines!
                activeTranslations[jobId] = {
                    total: tasks.length, 
                    received: 0, 
                    lines: srtArray, 
                    socket: socket, 
                    parser: parser 
                };

                socket.emit('subtitle progress', { progress: 0, received: 0, total: srtArray.length });

                const pipeline = redisMaster.pipeline();
                tasks.forEach(t => {
                    pipeline.lpush('translate_tasks', JSON.stringify(t));
                });
                await pipeline.exec();

            } catch (err) {
                socket.emit('subtitle error', 'Hiba a fájl feldolgozásakor: ' + err.message);
            }
        });

        socket.on('disconnect', () => { delete clients[socket.id]; });
    });

    server.listen(PORT, () => console.log(`[API] Server running on ${PORT}`));
}

function generateLoad() {
    crypto.pbkdf2Sync('titkos', 'só', 1000, 64, 'sha512');
    if (currentMode === 'stress') memoryHog.push(new Array(50000).join('A')); 
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
        cpu: cpuPercentage.toFixed(1), mem: memPercentage.toFixed(2),
        memUsed: memUsage.rss, memTotal: totalSystemMem, hostname: os.hostname() 
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
    
    // simple healthcheck server for the worker
    if (ROLE === 'worker') {
        http.createServer((req, res) => {
            if (req.url === '/healthz') { res.writeHead(200); res.end('OK'); }
        }).listen(3001);
    }

    let objectDetectorPipeline = null;
    let translatorPipeline = null; 

    async function getAiPipeline() {
        if (!objectDetectorPipeline) {
            console.log(`[WORKER] Object Detector AI betöltése...`);
            const { pipeline, env } = await import('@huggingface/transformers');
            env.allowLocalModels = false; 
            objectDetectorPipeline = await pipeline('object-detection', 'Xenova/detr-resnet-50');
        }
        return objectDetectorPipeline;
    }

    async function getTranslatorPipeline() {
        if (!translatorPipeline) {
            console.log(`[WORKER] NLP Fordító AI letöltése/betöltése...`);
            const { pipeline, env } = await import('@huggingface/transformers');
            env.allowLocalModels = false;
            env.backends.onnx.wasm.numThreads = 2; // optimization: enable multi-threading
            translatorPipeline = await pipeline('translation', 'Xenova/opus-mt-en-hu');
        }
        return translatorPipeline;
    }

    // WARMUP OPTIMIZATION: start them on startup, so the first request is already lightning fast
    console.log(`[WORKER] Modellek előtöltése a gyorsítótárba (Warmup)...`);
    getAiPipeline().catch(console.error);
    getTranslatorPipeline().catch(console.error);

    async function aiWorkerLoop() {
        let taskRaw = null; 
        try {
            taskRaw = await redisAiWorker.brpop('ai_tasks', 1);
            if (taskRaw) {
                const task = JSON.parse(taskRaw[1]);
                const detector = await getAiPipeline();
                const base64Data = task.image.replace(/^data:image\/\w+;base64,/, "");
                const imageBuffer = Buffer.from(base64Data, 'base64');             
                const imageBlob = new Blob([imageBuffer], { type: 'image/jpeg' });
                
                const rawPredictions = await detector(imageBlob, { threshold: 0.5, percentage: false });
                
                const predictions = rawPredictions.map(p => ({
                    class: p.label, score: p.score,
                    bbox: [p.box.xmin, p.box.ymin, p.box.xmax - p.box.xmin, p.box.ymax - p.box.ymin]
                }));

                const workerName = os.hostname();
                redisMaster.publish(`ai_result_${task.taskId}`, JSON.stringify({ 
                    predictions: predictions, podName: workerName, podColor: stringToColor(workerName)
                }));
            }
        } catch (err) {
            if (taskRaw) {
                const task = JSON.parse(taskRaw[1]);
                redisMaster.publish(`ai_result_${task.taskId}`, JSON.stringify({ error: err.message }));
            }
        }
        setImmediate(aiWorkerLoop);
    }

    async function translateWorkerLoop() {
        try {
            const taskRaw = await redisTranslateWorker.brpop('translate_tasks', 1);
            if (taskRaw) {
                const task = JSON.parse(taskRaw[1]); // { jobId, startIndex, items: [...] }
                
                try {
                    const translator = await getTranslatorPipeline();
                    
                    let flatLines = [];
                    let lineMapping = []; // remember which sentence belongs to which SRT time slot

                    // 1. clean every time slot and expand the lines
                    task.items.forEach((itemText, itemIdx) => {
                        const cleanText = itemText ? itemText.replace(/<[^>]*>?/gm, '').trim() : "";
                        const subLines = cleanText.split('\n');
                        subLines.forEach(sl => {
                            flatLines.push(sl.trim());
                            lineMapping.push(itemIdx);
                        });
                    });

                    // 2. filter out the empty lines for the batching
                    const validIndices = [];
                    const validLinesToTranslate = [];
                    flatLines.forEach((line, idx) => {
                        if (line !== "") {
                            validIndices.push(idx);
                            validLinesToTranslate.push(line);
                        }
                    });

                    // 3. the mega batch: send all lines to the ai at once!
                    let translatedValidLines = [];
                    for (const line of validLinesToTranslate) {
                        // translate one by one to keep the ai's attention at 100%
                        const result = await translator(line, { max_new_tokens: 60 });
                        let text = result[0].translation_text || "";
                        
                        // punctuation: if there are more than 3 (e.g. "?????"), truncate to 3
                        text = text.replace(/([.?!,])\1{2,}/g, '$1$1$1'); 
                        
                        // hallucinations: remove the "explanations" in parentheses (e.g. "(Külsőség)")
                        text = text.replace(/\(.*?\)/g, ''); 
                        text = text.replace(/\[.*?\]/g, ''); 
                        
                        // infinite repetition: if it gets too long, truncate it
                        if (text.length > 120) {
                            text = text.substring(0, 117) + "...";
                        }
                        
                        translatedValidLines.push(text.trim());
                    }

                    // 4. rebuild the expanded array with the translated texts
                    const finalFlatLines = [...flatLines];
                    validIndices.forEach((flatIdx, i) => {
                        finalFlatLines[flatIdx] = translatedValidLines[i];
                    });

                    // 5. repack the expanded lines into the original 30 SRT time slots
                    const translatedItems = new Array(task.items.length).fill("");
                    finalFlatLines.forEach((line, flatIdx) => {
                        const itemIdx = lineMapping[flatIdx];
                        if (translatedItems[itemIdx] === "") {
                            translatedItems[itemIdx] = line;
                        } else {
                            translatedItems[itemIdx] += '\n' + line;
                        }
                    });

                    redisMaster.publish(`sub_result_${task.jobId}`, JSON.stringify({
                        startIndex: task.startIndex,
                        translatedItems: translatedItems
                    }));
                } catch (aiErr) {
                    console.error("AI Fordítási hiba a csomagban:", aiErr);
                    // if there is an error, we need to send the original batch with an error message
                    redisMaster.publish(`sub_result_${task.jobId}`, JSON.stringify({
                        startIndex: task.startIndex,
                        translatedItems: task.items.map(t => `[HIBA]`)
                    }));
                }
            }
        } catch (err) {}
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
                                const bLeft = Math.floor(bx), bTop = Math.floor(by);
                                const bRight = Math.floor(bx + bw), bBottom = Math.floor(by + bh);

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

                redisMaster.publish(`job_results_${jobId}`, JSON.stringify({ 
                    chunkId: chunkId, podName: workerName, podColor: podColor, html: asciiHTML 
                }));        
            }
        } catch (err) {}
        setImmediate(workerLoop);
    }
    
    aiWorkerLoop();
    translateWorkerLoop();
    workerLoop();
}