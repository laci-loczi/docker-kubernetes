const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ROLE = process.env.ROLE || 'all'; 

const express = require('express'); // express is a web framework for node.js
const http = require('http'); // http is a module for creating http servers
const { Server } = require("socket.io"); // socket.io is a module for creating websocket servers
const os = require('os'); // os is a module for getting information about the operating system
const crypto = require('crypto'); // crypto is a module for creating cryptographic hash functions
const Redis = require('ioredis'); // ioredis is a module for interacting with redis databases
const { Blob } = require('buffer'); // buffer is a module for creating buffers

const REDIS_HOST = process.env.REDIS_HOST || 'redis-service'; 
const redisMaster = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); // redisMaster is a redis client for interacting with the master redis database
const redisWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); // redisWorker is a redis client for interacting with the worker redis database
const redisSub = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); // redisSub is a redis client for interacting with the subscriber redis database
const redisTranslateWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); // redisTranslateWorker is a redis client for interacting with the translate worker redis database
const redisAiWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); // redisAiWorker is a redis client for interacting with the ai worker redis database
const redisMeetingWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });

//deepl exper
const redisDeeplWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null }); 
const redisGeminiWorker = new Redis({ host: REDIS_HOST, port: 6379, maxRetriesPerRequest: null });

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
    const activeDeeplTranslations = {}; // deepl
    const activeGeminiTranslations = {}; //gemini
    const activeMeetingJobs = {};

    app.use(express.json({ limit: '2mb' }));
    app.use(express.static('public'));

    // liveness & readiness probe endpoint for kubernetes
    app.get('/healthz', (req, res) => res.status(200).send('OK'));

    app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

    // subscribe to the single redisSub connection for everything!
    redisSub.psubscribe('job_results_*', 'sub_result_*', 'ai_result_*', 'meeting_result_*', 'meeting_progress_*');
    redisSub.subscribe('system_stats');
    //deepl and gemini
    redisSub.psubscribe('job_results_*', 'sub_result_*', 'ai_result_*', 'deepl_sub_result_*', 'gemini_sub_result_*');

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

        //deepl
        else if (pattern === 'deepl_sub_result_*') {
            const data = JSON.parse(message);
            const jobId = channel.replace('deepl_sub_result_', '');
            const job = activeDeeplTranslations[jobId];
            if (!job) return; 

            data.translatedItems.forEach((transText, i) => {
                if (job.lines[data.startIndex + i]) job.lines[data.startIndex + i].text = transText;
            });
            job.received++; 

            const currentLinesDone = Math.min(job.received * 30, job.lines.length);
            const progress = Math.round((job.received / job.total) * 100);
            job.socket.emit('deepl progress', { progress, received: currentLinesDone, total: job.lines.length });

            if (job.received === job.total) {
                try {
                    const translatedSrt = job.parser.toSrt(job.lines);
                    job.socket.emit('deepl done', { srt: translatedSrt });
                } catch (e) { console.error("[API] DeepL SRT generálási hiba:", e); }
                delete activeDeeplTranslations[jobId];
            }
        }
        else if (pattern === 'gemini_sub_result_*') {
            const data = JSON.parse(message);
            const jobId = channel.replace('gemini_sub_result_', '');
            const job = activeGeminiTranslations[jobId];
            if (!job) return; 

            data.translatedItems.forEach((transText, i) => {
                if (job.lines[data.startIndex + i]) job.lines[data.startIndex + i].text = transText;
            });
            job.received++; 

            const currentLinesDone = Math.min(job.received * 30, job.lines.length);
            const progress = Math.round((job.received / job.total) * 100);
            job.socket.emit('gemini progress', { progress, received: currentLinesDone, total: job.lines.length });

            if (job.received === job.total) {
                try {
                    const translatedSrt = job.parser.toSrt(job.lines);
                    job.socket.emit('gemini done', { srt: translatedSrt });
                } catch (e) { console.error("[API] Gemini SRT hiba:", e); }
                delete activeGeminiTranslations[jobId];
            }
        }
        else if (pattern === 'ai_result_*') {
            const taskId = channel.replace('ai_result_', '');
            if (activeAiTasks[taskId]) {
                activeAiTasks[taskId](JSON.parse(message)); // execute the callback
                delete activeAiTasks[taskId]; // free memory
            }
        }

        else if (pattern === 'meeting_progress_*') {
            const jobId = channel.replace('meeting_progress_', '');
            const job = activeMeetingJobs[jobId];
            if (job) job.socket.emit('meeting progress', JSON.parse(message));
        }
        else if (pattern === 'meeting_result_*') {
            const jobId = channel.replace('meeting_result_', '');
            const job = activeMeetingJobs[jobId];
            if (!job) return;
     
            const data = JSON.parse(message);
     
            // Forward transcript first so UI can show it fast
            if (data.transcript) {
                const words = data.transcript.split(/\s+/).filter(Boolean).length;
                job.socket.emit('meeting transcript', {
                    text: data.transcript,
                    wordCount: words,
                    duration: data.duration ?? null
                });
            }
     
            // Then send the full structured result
            job.socket.emit('meeting result', data);
            delete activeMeetingJobs[jobId];
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
            activeAiTasks[taskId] = callback; // store the callback in memory
            
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


        socket.on('analyze meeting', async (data) => {
            try {
                const jobId = 'meet_' + crypto.randomUUID();
     
                activeMeetingJobs[jobId] = { socket };
     
                // Emit initial ack so UI shows progress immediately
                socket.emit('meeting progress', { stage: 'Queued in Redis...', pct: 2, detail: '' });
     
                await redisMaster.lpush('meeting_tasks', JSON.stringify({
                    jobId,
                    audioBase64: data.audioBase64,
                    mimeType:    data.mimeType   ?? 'audio/webm',
                    fileName:    data.fileName   ?? 'audio.webm',
                    audioLang:   data.audioLang  ?? 'en',
                    summaryLang: data.summaryLang ?? 'en',
                    options:     data.options    ?? {}
                }));
            } catch (err) {
                socket.emit('meeting error', 'Failed to queue task: ' + err.message);
            }
        });

        //deepl and gemini
        const handleVipTranslation = async (prefix, data, activeJobs, socket) => {
            try {
                if (data.password !== ADMIN_PASSWORD) {
                    socket.emit(`${prefix} error`, 'Hibás admin jelszó!'); return;
                }
                const srtParserModule = await import("srt-parser-2");
                const ParserClass = srtParserModule.default?.default || srtParserModule.default || srtParserModule;
                const parser = new ParserClass();
                const srtArray = parser.fromSrt(data.srtText);
                
                if (!srtArray || srtArray.length === 0) {
                    socket.emit(`${prefix} error`, 'A fájl üres vagy hibás SRT formátumú.'); return;
                }

                const jobId = `${prefix}_` + crypto.randomUUID();
                const tasks = [];
                for (let i = 0; i < srtArray.length; i += 30) {
                    tasks.push({ jobId: jobId, startIndex: i, items: srtArray.slice(i, i + 30).map(c => c.text) });
                }

                activeJobs[jobId] = { total: tasks.length, received: 0, lines: srtArray, socket: socket, parser: parser };
                socket.emit(`${prefix} progress`, { progress: 0, received: 0, total: srtArray.length });

                const pipeline = redisMaster.pipeline();
                tasks.forEach(t => { pipeline.lpush(`translate_tasks_${prefix}`, JSON.stringify(t)); });
                await pipeline.exec();
            } catch (err) { socket.emit(`${prefix} error`, 'Hiba: ' + err.message); }
        };

        socket.on('translate subtitle deepl', (data) => handleVipTranslation('deepl', data, activeDeeplTranslations, socket));
        socket.on('translate subtitle gemini', (data) => handleVipTranslation('gemini', data, activeGeminiTranslations, socket));

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
        cpu: cpuPercentage.toFixed(2), mem: memPercentage.toFixed(2),
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
    let isAiReady = false;
    if (ROLE === 'worker') {
        http.createServer((req, res) => {
            if (req.url === '/healthz') { 
                res.writeHead(200); res.end('OK'); // liveness (don't kill me!)
            } else if (req.url === '/ready') {
                if (isAiReady) {
                    res.writeHead(200); res.end('Ready'); // readiness (i'm ready, the autoscaler can scale me!)
                } else {
                    res.writeHead(503); res.end('Loading AI...'); // still loading the ai!
                }
            }
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


    console.log(`[WORKER] Modellek előtöltése a gyorsítótárba (Warmup)...`);
    Promise.all([getAiPipeline(), getTranslatorPipeline()]).then(() => {
        isAiReady = true; // now the /ready endpoint will return 200 OK!
        console.log(`[WORKER] *** AI WARMUP KÉSZ! A pod mostantól READY állapotban van a K8s számára. ***`);
    }).catch(console.error);

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

                    // 3. local processing: without network latency, but one by one to the ai, so it doesn't get confused!
                    let translatedValidLines = [];
                    for (const line of validLinesToTranslate) {
                        const result = await translator(line, { max_new_tokens: 60 });
                        let text = result[0].translation_text || "";
                        
                        // aggressive cleaning: remove hallucinations and limit the length
                        text = text.replace(/([.?!,])\1{2,}/g, '$1$1$1'); // punctuation limit
                        text = text.replace(/\(.*?\)/g, ''); // remove parentheses
                        text = text.replace(/\[.*?\]/g, ''); 
                        if (text.length > 120) text = text.substring(0, 117) + "..."; // length limit
                        
                        translatedValidLines.push(text.trim());
                    }

                    // 4. rebuild the expanded array with the translated texts
                    const finalFlatLines = [...flatLines];
                    validIndices.forEach((flatIdx, i) => {
                        finalFlatLines[flatIdx] = translatedValidLines[i];
                    });

                    // 5. repack the expanded lines into the original SRT time slots
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
                    // if there is an error, send the original batch with an error message
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

    //deepl not chunking
    // --- DEEPL XML WORKER ---
    async function deeplWorkerLoop() {
        try {
            const taskRaw = await redisDeeplWorker.brpop('translate_tasks_deepl', 1);
            if (taskRaw) {
                const task = JSON.parse(taskRaw[1]); 
                try {
                    const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
                    let xmlDocument = "";
                    task.items.forEach((itemText, idx) => {
                        const cleanText = itemText ? itemText.replace(/<[^>]*>?/gm, '').trim() : "";
                        xmlDocument += `<s${idx}>${cleanText}</s${idx}>\n`;
                    });

                    let translatedItems = new Array(task.items.length).fill("");
                    
                    if (xmlDocument.trim() !== "" && DEEPL_API_KEY) {
                        const response = await fetch('https://api-free.deepl.com/v2/translate', {
                            method: 'POST',
                            headers: { 'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                text: [xmlDocument], target_lang: 'HU', source_lang: 'EN',
                                formality: 'prefer_less', tag_handling: 'xml'
                            })
                        });
                        if (response.ok) {
                            const responseData = await response.json();
                            const translatedXml = responseData.translations[0].text;
                            task.items.forEach((_, idx) => {
                                const match = translatedXml.match(new RegExp(`<s${idx}>([\\s\\S]*?)</s${idx}>`, 'i'));
                                translatedItems[idx] = (match && match[1]) ? match[1].trim() : " ";
                            });
                        }
                    }
                    redisMaster.publish(`deepl_sub_result_${task.jobId}`, JSON.stringify({ startIndex: task.startIndex, translatedItems: translatedItems }));
                } catch (err) {
                    redisMaster.publish(`deepl_sub_result_${task.jobId}`, JSON.stringify({ startIndex: task.startIndex, translatedItems: task.items.map(t => `[DEEPL HIBA]`) }));
                }
            }
        } catch (err) {}
        setImmediate(deeplWorkerLoop);
    }

 //
 async function geminiWorkerLoop() {
    try {
        const taskRaw = await redisGeminiWorker.brpop('translate_tasks_gemini', 1);
        if (taskRaw) {
            const task = JSON.parse(taskRaw[1]); 
            console.log(`[WORKER] Gemini fordítás indítása (${task.items.length} sor)...`);
            
            try {
                const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
                if (!GEMINI_API_KEY) throw new Error("A GEMINI_API_KEY nincs beállítva!");

                let xmlDocument = "";
                task.items.forEach((itemText, idx) => {
                    const cleanText = itemText ? itemText.replace(/<[^>]*>?/gm, '').trim() : "";
                    xmlDocument += `<s${idx}>${cleanText}</s${idx}>\n`;
                });

                let translatedItems = new Array(task.items.length).fill("");
                
                if (xmlDocument.trim() !== "" && GEMINI_API_KEY) {
                    
                    const systemPrompt = "You are a professional Netflix subtitle translator translating English to Hungarian. CRITICAL RULE: The user will give you an XML structure (<s0> text </s0>). You MUST return the EXACT SAME XML tags wrapping the Hungarian translation. Never omit the tags.";

                    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            systemInstruction: { parts: [{ text: systemPrompt }] },
                            contents: [{ parts: [{ text: xmlDocument }] }],
                            generationConfig: { temperature: 0.1 },
                            safetySettings: [
                                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                            ]
                        })
                    });
                    
                    if (!response.ok) {
                        const errText = await response.text();
                        throw new Error(`HTTP ${response.status} - ${errText}`);
                    }

                    const responseData = await response.json();
                    
                    if (!responseData.candidates || !responseData.candidates[0].content) {
                        throw new Error("A Gemini megtagadta a választ (Safety Block).");
                    }

                    let translatedXml = responseData.candidates[0].content.parts[0].text;
                    
                    console.log("\n--- GEMINI-2.5-FLASH NYERS VÁLASZ ---");
                    console.log(translatedXml);
                    console.log("-------------------------------\n");

                    translatedXml = translatedXml.replace(/^```xml/im, '').replace(/```$/im, '').trim();

                    let missingTagsCount = 0;

                    // Visszaparzoljuk az XML-t a helyére
                    task.items.forEach((_, idx) => {
                        const match = translatedXml.match(new RegExp(`<s${idx}>([\\s\\S]*?)</s${idx}>`, 'i'));
                        if (match && match[1]) {
                            translatedItems[idx] = match[1].trim();
                        } else {
                            translatedItems[idx] = " "; 
                            missingTagsCount++;
                        }
                    });

                    // Mentőöv (Fallback), ha elrontaná az XML-t
                    if (missingTagsCount > task.items.length / 2) {
                        console.warn("[WORKER] A Gemini ignorálta az XML-t! Próbálkozás nyers sorolvasással...");
                        const rawLines = translatedXml.replace(/<s\d+>/g, '').replace(/<\/s\d+>/g, '').split('\n').map(l => l.trim()).filter(l => l !== '');
                        
                        if (rawLines.length === task.items.length) {
                            translatedItems = rawLines;
                            console.log("[WORKER] Nyers igazítás sikeres!");
                        }
                    }
                }
                
                // Kész, visszaküldjük a Redis-nek!
                redisMaster.publish(`gemini_sub_result_${task.jobId}`, JSON.stringify({ startIndex: task.startIndex, translatedItems: translatedItems }));
            } catch (err) {
                console.error("[WORKER] Gemini Hiba:", err.message);
                redisMaster.publish(`gemini_sub_result_${task.jobId}`, JSON.stringify({ startIndex: task.startIndex, translatedItems: task.items.map(t => `[GEMINI HIBA]`) }));
            }
        }
    } catch (err) {}
    
    // 2 másodperc szünet Google Rate Limit ellen
    setTimeout(geminiWorkerLoop, 2000);
}

async function meetingWorkerLoop() {
    try {
        // Use a 5-second timeout so the worker isn't permanently blocked if
        // the queue is empty — same pattern as your other worker loops.
        const taskRaw = await redisMeetingWorker.brpop('meeting_tasks', 5);
 
        if (taskRaw) {
            const task = JSON.parse(taskRaw[1]);
            const { jobId, audioBase64, mimeType, audioLang, summaryLang, options } = task;
 
            const pub = (stage, pct, detail = '') =>
                redisMaster.publish(`meeting_progress_${jobId}`, JSON.stringify({ stage, pct, detail }));
 
            try {
                // ── Step 1: Decode audio ─────────────────────────────────────
                await pub('Decoding audio...', 8);
                const audioBuffer = Buffer.from(audioBase64, 'base64');
 
                // ── Step 2: Whisper transcription ─────────────────────────────
                await pub('Transcribing with Whisper...', 15, 'Loading model (cached after first run)');
 
                const { pipeline, env } = await import('@huggingface/transformers');
                env.allowLocalModels = false;
 
                // Lazy-load Whisper (reuse across calls via module-level cache)
                if (!global._whisperPipeline) {
                    console.log('[WORKER-MEETING] Loading Whisper model...');
                    // whisper-base is a good balance: ~145 MB, runs on CPU in ~2-4x realtime
                    global._whisperPipeline = await pipeline(
                        'automatic-speech-recognition',
                        'Xenova/whisper-base',
                        { chunk_length_s: 30, stride_length_s: 5 }
                    );
                    console.log('[WORKER-MEETING] Whisper ready.');
                }
 
                await pub('Transcribing...', 25, 'Sending audio to Whisper');
 
                // Build a Blob from the buffer for HuggingFace transformers
                const { Blob } = require('buffer');
                const audioBlob = new Blob([audioBuffer], { type: mimeType });
 
                const whisperOutput = await global._whisperPipeline(audioBlob, {
                    language: audioLang === 'auto' ? null : audioLang,
                    return_timestamps: true,
                    chunk_length_s: 30,
                    stride_length_s: 5,
                });
 
                const transcript = whisperOutput.text?.trim() ?? '';
 
                // Estimate duration from the last timestamp chunk
                let duration = null;
                const chunks = whisperOutput.chunks;
                if (chunks && chunks.length > 0) {
                    const lastEnd = chunks[chunks.length - 1].timestamp?.[1];
                    if (lastEnd) {
                        const m = Math.floor(lastEnd / 60);
                        const s = Math.floor(lastEnd % 60);
                        duration = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
                    }
                }
 
                await pub('Transcript ready — extracting insights...', 65, `${transcript.split(/\s+/).length} words transcribed`);
 
                // ── Step 3: Gemini structured extraction ─────────────────────
                const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
                if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
 
                const wantActions   = options.actions   !== false;
                const wantDecisions = options.decisions  !== false;
                const wantQuestions = options.questions  !== false;
                const wantConf      = options.confidence !== false;
 
                const extractionPrompt = `
You are an expert meeting analyst. Analyze the following meeting transcript and return a JSON object.
 
CRITICAL: Return ONLY valid JSON, no markdown fences, no explanation.
 
JSON schema (all fields required):
{
  "summary": "2-4 sentence executive summary of the meeting",
  "actions": [
    { "text": "action item description", "confidence": 0.95 }
  ],
  "decisions": [
    { "text": "decision that was made", "confidence": 0.90 }
  ],
  "questions": [
    { "text": "open question or blocker that was raised", "confidence": 0.85 }
  ]
}
 
Rules:
- summary: in ${summaryLang === 'hu' ? 'Hungarian' : summaryLang === 'de' ? 'German' : 'English'}
- actions: concrete tasks someone agreed to do. Max 10. Empty array if none.
- decisions: things the group concluded or agreed on. Max 10. Empty array if none.
- questions: things left unresolved or explicitly asked but not answered. Max 8.
- confidence: float 0.0-1.0 reflecting how certain you are this item is genuine
- If the transcript is empty or unintelligible, return empty arrays and an appropriate summary.
 
TRANSCRIPT:
"""
${transcript.substring(0, 12000)}
"""
`.trim();
 
                await pub('Extracting insights with Gemini...', 75);
 
                const geminiRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: extractionPrompt }] }],
                            generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
                            safetySettings: [
                                { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
                                { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_NONE' },
                                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_NONE' },
                                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_NONE' },
                            ]
                        })
                    }
                );
 
                if (!geminiRes.ok) {
                    const errText = await geminiRes.text();
                    throw new Error(`Gemini HTTP ${geminiRes.status}: ${errText}`);
                }
 
                const geminiData = await geminiRes.json();
 
                if (!geminiData.candidates?.[0]?.content) {
                    throw new Error('Gemini returned no content (safety block?)');
                }
 
                let rawJson = geminiData.candidates[0].content.parts[0].text;
 
                // Strip markdown fences if Gemini ignored the instruction
                rawJson = rawJson.replace(/^```json\s*/im, '').replace(/```\s*$/im, '').trim();
 
                let extracted;
                try {
                    extracted = JSON.parse(rawJson);
                } catch (parseErr) {
                    // Fallback: return transcript with empty extraction rather than hard-fail
                    console.error('[WORKER-MEETING] Gemini JSON parse error:', parseErr.message, '\nRaw:', rawJson.substring(0, 300));
                    extracted = { summary: 'Extraction failed — see raw transcript.', actions: [], decisions: [], questions: [] };
                }
 
                // Strip confidence fields if the user didn't want them
                if (!wantConf) {
                    ['actions','decisions','questions'].forEach(key => {
                        if (Array.isArray(extracted[key])) {
                            extracted[key] = extracted[key].map(item =>
                                typeof item === 'object' ? item.text : item
                            );
                        }
                    });
                }
 
                await pub('Done!', 100);
 
                // ── Step 4: Publish result ───────────────────────────────────
                redisMaster.publish(`meeting_result_${jobId}`, JSON.stringify({
                    transcript,
                    duration,
                    summary:   extracted.summary   ?? '',
                    actions:   wantActions   ? (extracted.actions   ?? []) : [],
                    decisions: wantDecisions ? (extracted.decisions ?? []) : [],
                    questions: wantQuestions ? (extracted.questions ?? []) : [],
                    podName:   require('os').hostname(),
                }));
 
            } catch (err) {
                console.error('[WORKER-MEETING] Error:', err.message);
                redisMaster.publish(`meeting_result_${jobId}`, JSON.stringify({
                    transcript: '',
                    summary: 'Processing failed: ' + err.message,
                    actions: [], decisions: [], questions: [],
                    error: err.message
                }));
                // Also surface the error in the progress channel
                redisMaster.publish(`meeting_progress_${jobId}`, JSON.stringify({
                    stage: 'Error', pct: 0, detail: err.message
                }));
            }
        }
    } catch (err) {
        // Redis connection errors — log and keep going
        if (err.message && !err.message.includes('Connection')) {
            console.error('[WORKER-MEETING] Loop error:', err.message);
        }
    }
 
    // Small delay to avoid hammering Redis when the queue is empty
    setTimeout(meetingWorkerLoop, 500);
}   
    meetingWorkerLoop();
    aiWorkerLoop();
    translateWorkerLoop(); // A nyílt, publikus lokális fordító
    workerLoop();
    deeplWorkerLoop();     // VIP DeepL
    geminiWorkerLoop();
}