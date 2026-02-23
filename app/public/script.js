Chart.defaults.color = '#64748b';
Chart.defaults.borderColor = '#334155';

function formatBytesToMB(bytes) { return (bytes / (1024 * 1024)).toFixed(0); }

const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    elements: { point: { radius: 0 } },
    scales: {
        x: { display: false }, 
        y: {
            min: 0,
            max: 100,
            grid: { color: 'rgba(51, 65, 85, 0.5)', borderDash: [5, 5] },
            ticks: { callback: function(value) { return value + '%' } }
        }
    },
    plugins: {
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false, backgroundColor: '#1e293b', titleColor: '#f1f5f9', bodyColor: '#94a3b8', borderColor: '#334155', borderWidth: 1 }
    }
};

const cpuCtx = document.getElementById('cpuChart').getContext('2d');
const cpuGradient = cpuCtx.createLinearGradient(0, 0, 0, 400);
cpuGradient.addColorStop(0, 'rgba(239, 68, 68, 0.2)');
cpuGradient.addColorStop(1, 'rgba(239, 68, 68, 0)');
const cpuChart = new Chart(cpuCtx, {
    type: 'line',
    data: { labels: Array(30).fill(''), datasets: [{ data: Array(30).fill(0), borderColor: '#ef4444', backgroundColor: cpuGradient, borderWidth: 2, fill: true, tension: 0.4 }] },
    options: commonOptions
});

const memCtx = document.getElementById('memChart').getContext('2d');
const memGradient = memCtx.createLinearGradient(0, 0, 0, 400);
memGradient.addColorStop(0, 'rgba(59, 130, 246, 0.2)');
memGradient.addColorStop(1, 'rgba(59, 130, 246, 0)');
const memChart = new Chart(memCtx, {
    type: 'line',
    data: { labels: Array(30).fill(''), datasets: [{ data: Array(30).fill(0), borderColor: '#3b82f6', backgroundColor: memGradient, borderWidth: 2, fill: true, tension: 0.4 }] },
    options: commonOptions
});

const socket = io({
    path: '/socket.io/',
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 20
});

let isSystemOnline = false;

const statusLabel = document.getElementById('connectionStatus');
const statusDot = document.querySelector('.status-indicator');

socket.on('connect', () => {
    isSystemOnline = true; 
    statusLabel.textContent = "Live Connection";
    statusLabel.style.color = "#10b981";
    statusDot.style.backgroundColor = "#10b981";
    statusDot.style.boxShadow = "0 0 10px rgba(16, 185, 129, 0.4)";
});

socket.on('disconnect', () => {
    isSystemOnline = false; 
    statusLabel.textContent = "Offline (Reconnecting...)";
    statusLabel.style.color = "#ef4444";
    statusDot.style.backgroundColor = "#ef4444";
    statusDot.style.boxShadow = "none";
});

let myConnectedPodName = ""; 

socket.on('init info', (data) => {
    if(data && data.hostname) {
        myConnectedPodName = data.hostname; 
        updatePodInfo(data.hostname); // update pod name
    }
});

let currentAiPod = null;

socket.on('stats update', (stats) => {
    // 1. Meglévő Pod statisztikák frissítése
    updatePodList(stats); // Tegyük fel, hogy ez a függvényed kezeli a listát

    // 2. AI Specifikus frissítés
    const aiMonitor = document.getElementById('ai-active-pod');
    const progressBar = document.getElementById('ai-progress-bar');

    if (stats.aiStatus === 'working') {
        currentAiPod = stats.aiPod;
        aiMonitor.innerHTML = `Active: <span class="status-working">${stats.aiPod}</span>`;
        progressBar.style.width = '100%'; // Mivel az elemzés ideje változó, itt fixen jelezzük a munkát
    } else if (stats.aiStatus === 'idle') {
        currentAiPod = null;
        aiMonitor.innerHTML = `Status: <span class="status-idle">Waiting for task...</span>`;
        progressBar.style.width = '0%';
    }

    // 3. Eőforrás adatok hozzákötése az AI Podhoz
    // Ha a statisztika abból a Podból jött, amelyik éppen AI-t számol, 
    // vizuálisan is kiemeljük a listában.
    document.querySelectorAll('.pod-item').forEach(item => {
        const podName = item.dataset.hostname; // Feltételezve, hogy tárolod a nevet
        if (podName === currentAiPod) {
            item.classList.add('is-processing-ai');
            // Itt kiírhatod a specifikus CPU/RAM adatokat is az AI kártyára:
            if (stats.hostname === currentAiPod) {
                document.getElementById('ai-active-pod').innerHTML += 
                    `<br><small>CPU: ${stats.cpu}% | RAM: ${stats.mem}%</small>`;
            }
        } else {
            item.classList.remove('is-processing-ai');
        }
    });
});

function updatePodInfo(name) { document.getElementById('podName').textContent = name; } // update pod name

function updateChart(chart, value, valueElementId) {
    document.getElementById(valueElementId).innerHTML = `${value}<span class="unit">%</span>`;
    const data = chart.data.datasets[0].data;
    data.shift();
    data.push(value);
    chart.update();
}

function setMode(mode) {
    let password = null;
    if (mode === 'stress') {
        password = prompt("Enter admin password for stress test:");
        if (!password) return;
    }
    socket.emit('change mode', { mode, password });
}

socket.on('auth error', (msg) => alert("Authentication Failed: " + msg));

let podStats = {};  
let totalTiles = 0;
let completedTiles = 0;
let leaderboardTimeout = null;

let aiMemoryInterval = null;

function getBrowserHeapMB() {
    if (typeof performance !== 'undefined' && performance.memory && typeof performance.memory.usedJSHeapSize === 'number') {
        return (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
    }
    return null;
}

function setAiMemoryUI(state, valueMB) {
    const container = document.getElementById('aiMemory');
    const valueEl = document.getElementById('aiMemoryValue');
    const labelEl = document.getElementById('aiMemoryLabel');
    if (!container || !valueEl) return;
    const displayValue = valueMB != null ? valueMB + ' MB' : 'N/A';
    if (state === 'idle') {
        container.classList.remove('ai-memory-active');
        if (labelEl) labelEl.textContent = 'Memory';
        valueEl.textContent = displayValue;
    } else if (state === 'analyzing') {
        container.classList.add('ai-memory-active');
        if (labelEl) labelEl.textContent = 'Memory (analyzing)';
        valueEl.textContent = displayValue;
    }
}

function startAiMemorySampling() {
    const hasHeap = getBrowserHeapMB() !== null;
    setAiMemoryUI('analyzing', hasHeap ? parseFloat(getBrowserHeapMB()) : null);
    if (aiMemoryInterval) clearInterval(aiMemoryInterval);
    aiMemoryInterval = setInterval(() => {
        const valueEl = document.getElementById('aiMemoryValue');
        const mb = getBrowserHeapMB();
        if (valueEl) valueEl.textContent = (mb != null ? mb + ' MB' : 'N/A');
    }, 200);
}

function stopAiMemorySampling(peakMB) {
    if (aiMemoryInterval) {
        clearInterval(aiMemoryInterval);
        aiMemoryInterval = null;
    }
    setAiMemoryUI('idle', peakMB != null ? parseFloat(peakMB) : getBrowserHeapMB() !== null ? parseFloat(getBrowserHeapMB()) : null);
} 

async function startDistributedRender() {
    if (!isSystemOnline) { alert("ðŸš¨ Rendszer offline!"); return; }

    const fileInput = document.getElementById('imageInput');
    if (!fileInput.files || !fileInput.files[0]) { alert("Nincs kivÃ¡lasztva kÃ©p!"); return; }

    const TASK_MODE = document.getElementById('taskMode').value;
    const GRID_SIZE = parseInt(document.getElementById('gridSize').value);
    const MODE = document.getElementById('renderMode').value;
    
    totalTiles = GRID_SIZE * GRID_SIZE;
    completedTiles = 0;
    podStats = {};
    updateLeaderboard();

    const img = new Image();
    img.src = URL.createObjectURL(fileInput.files[0]);
    
    img.onload = async () => {
        const canvas = document.getElementById('hiddenCanvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        canvas.width = GRID_SIZE === 32 ? 320 : 240; 
        canvas.height = canvas.width;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const aiPanel = document.getElementById('aiPanel');
        const aiList = document.getElementById('aiList');
        const aiStatus = document.getElementById('aiStatus');
        
        let predictions = [];
        let scaledAiBoxes = [];

        if (TASK_MODE === 'both' || TASK_MODE === 'ai') {
            aiPanel.style.display = 'block';
            aiStatus.textContent = "Kérése elküldve a K8s Workernek...";
            aiList.innerHTML = '<li style="color: #ef4444;"><i class="fas fa-cloud-upload-alt"></i> Kép küldése az AI node-nak...</li>';
            
            const aiCanvas = document.createElement('canvas');
            const maxDim = 640;
            let scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
            aiCanvas.width = img.width * scale;
            aiCanvas.height = img.height * scale;
            aiCanvas.getContext('2d').drawImage(img, 0, 0, aiCanvas.width, aiCanvas.height);
            
            const imageDataBase64 = aiCanvas.toDataURL('image/jpeg', 0.8);

            try {
                aiList.innerHTML = '<li style="color: #ef4444;"><i class="fas fa-spinner fa-spin"></i> Worker node elemzi a képet...</li>';
                
                const rawPredictions = await new Promise((resolve, reject) => {
                    socket.emit('analyze image', { image: imageDataBase64 }, (response) => {
                        if (response.error) reject(new Error(response.error));
                        else resolve(response.predictions);
                    });
                    
                    // more timeout for ai
                    setTimeout(() => reject(new Error("AI Timeout (Túl sokáig tartott az elemzés)")), 90000);
                });

                predictions = rawPredictions;

                aiStatus.textContent = `${predictions.length} objektum találva`;
                aiList.innerHTML = '';
                predictions.forEach(p => {
                    let itemHTML = `<strong>${p.class.toUpperCase()}</strong> <span>${Math.round(p.score * 100)}%</span>`;
                    aiList.innerHTML += `<li style="margin-bottom: 8px; background: rgba(239, 68, 68, 0.1); padding: 5px; border-left: 3px solid #ef4444; display: flex; justify-content: space-between; align-items:center;">${itemHTML}</li>`;
                });

                const boxScaleX = canvas.width / aiCanvas.width;
                const boxScaleY = canvas.height / aiCanvas.height;
                scaledAiBoxes = predictions.map(p => ({
                    class: p.class,
                    score: p.score,
                    bbox: [p.bbox[0] * boxScaleX, p.bbox[1] * boxScaleY, p.bbox[2] * boxScaleX, p.bbox[3] * boxScaleY]
                }));

            } catch (err) {
                console.error("Hiba a backend AI során:", err);
                aiStatus.textContent = "Hiba";
                aiList.innerHTML = `<li style="color: #ef4444;">Failed: ${err.message}</li>`;
                return;
            }
        }

        const renderGrid = document.getElementById('renderGrid');

        // only ai
        if (TASK_MODE === 'ai') {
            renderGrid.style.display = 'flex'; 
            renderGrid.innerHTML = '';
            
            const finalCanvas = document.createElement('canvas');
            finalCanvas.width = img.width;
            finalCanvas.height = img.height;
            finalCanvas.style.maxWidth = '100%';
            finalCanvas.style.maxHeight = '100%';
            finalCanvas.style.objectFit = 'contain';
            
            const fctx = finalCanvas.getContext('2d');
            fctx.drawImage(img, 0, 0); 
            
            fctx.lineWidth = 4;
            fctx.font = 'bold 18px Inter, sans-serif';
            fctx.textBaseline = 'top';
            
            predictions.forEach(p => {
                fctx.strokeStyle = '#ef4444';
                fctx.strokeRect(p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]);
                
                const label = `${p.class.toUpperCase()} ${Math.round(p.score * 100)}%`;
                const textWidth = fctx.measureText(label).width;
                
                let bgY = p.bbox[1] - 28;
                let textY = p.bbox[1] - 22;
                
                if (bgY < 0) {
                    bgY = p.bbox[1]; 
                    textY = p.bbox[1] + 6;
                }
                
                fctx.fillStyle = '#ef4444';
                fctx.fillRect(p.bbox[0], bgY, textWidth + 10, 28);
                
                fctx.fillStyle = '#ffffff';
                fctx.fillText(label, p.bbox[0] + 5, textY);
            });
            
            renderGrid.appendChild(finalCanvas);
            
            document.getElementById('progressText').textContent = '100%';
            document.getElementById('podList').innerHTML = '<li style="color: #10b981;"><i class="fas fa-microchip"></i> Processed locally via Edge AI</li>';
            
            return; 
        }

        // ascii or ascii plus ai
        renderGrid.style.display = 'grid';
        renderGrid.style.gridTemplateColumns = `repeat(${GRID_SIZE}, 1fr)`;
        renderGrid.style.fontSize = GRID_SIZE === 32 ? '3px' : (GRID_SIZE === 16 ? '5px' : '8px');
        renderGrid.style.lineHeight = GRID_SIZE === 32 ? '3px' : (GRID_SIZE === 16 ? '4px' : '7px');
        renderGrid.style.letterSpacing = '1px';
        renderGrid.innerHTML = ''; 

        const fragment = document.createDocumentFragment();
        const tileW = Math.floor(canvas.width / GRID_SIZE);
        const tileH = Math.floor(canvas.height / GRID_SIZE);

        for (let row = 0; row < GRID_SIZE; row++) {
            for (let col = 0; col < GRID_SIZE; col++) {
                const tileDiv = document.createElement('div');
                tileDiv.id = `chunk_${row}_${col}`; 
                tileDiv.style.margin = '0';
                tileDiv.style.padding = '0';
                tileDiv.style.display = 'block'; 
                tileDiv.innerHTML = '<span style="color: #222;">...</span>';
                fragment.appendChild(tileDiv);
            }
        }
        renderGrid.appendChild(fragment); 

        for (let row = 0; row < GRID_SIZE; row++) {
            await new Promise(resolve => setTimeout(resolve, 10)); 
            
            const rowChunks = []; 
            
            for (let col = 0; col < GRID_SIZE; col++) {
                const globalX = col * tileW;
                const globalY = row * tileH;
                
                const imgData = ctx.getImageData(globalX, globalY, tileW, tileH);
                rowChunks.push({
                    chunkId: `chunk_${row}_${col}`,
                    width: tileW,
                    height: tileH,
                    globalX: globalX, 
                    globalY: globalY,
                    pixels: Array.from(imgData.data)
                });
            }
            socket.emit('start render row', { mode: MODE, aiBoxes: scaledAiBoxes, chunks: rowChunks });
        }
    };
}

socket.on('render result', (data) => {
    const tileDiv = document.getElementById(data.chunkId);
    if (tileDiv) {
        tileDiv.innerHTML = data.html;
        
        const pName = data.podName;
        if (!podStats[pName]) podStats[pName] = { count: 0, color: data.podColor };
        podStats[pName].count++;
        completedTiles++;
        
        if (!leaderboardTimeout) {
            leaderboardTimeout = setTimeout(() => {
                updateLeaderboard();
                leaderboardTimeout = null;
            }, 100);
        }
    }
});

function updateLeaderboard() {
    const list = document.getElementById('podList');
    const progress = document.getElementById('progressText');
    
    const percent = totalTiles > 0 ? Math.round((completedTiles / totalTiles) * 100) : 0;
    progress.textContent = `${percent}% (${completedTiles}/${totalTiles})`;

    if (completedTiles === totalTiles && leaderboardTimeout) {
        clearTimeout(leaderboardTimeout);
        leaderboardTimeout = null;
    }

    list.innerHTML = '';
    
    const pods = Object.keys(podStats);
    if(pods.length === 0 && totalTiles > 0) {
        list.innerHTML = '<li style="color: var(--text-muted);">Transmitting data...</li>';
        return;
    }

    pods.sort((a,b) => podStats[b].count - podStats[a].count).forEach(pod => {
        const li = document.createElement('li');
        li.style.marginBottom = '8px';
        li.style.display = 'flex';
        li.style.justifyContent = 'space-between';
        li.style.alignItems = 'center';
        li.style.background = 'rgba(255,255,255,0.03)';
        li.style.padding = '5px 10px';
        li.style.borderRadius = '4px';
        
        const data = podStats[pod];
        
        li.innerHTML = `
            <span style="display:flex; align-items:center; gap:8px;">
                <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background-color: ${data.color}; box-shadow: 0 0 5px ${data.color};"></span> 
                <span style="font-family: monospace;">${pod}</span>
            </span> 
            <strong>${data.count} blocks</strong>
        `;
        list.appendChild(li);
    });
}

function toggleTechModal(show) {
    const overlay = document.getElementById('techModalOverlay');
    const content = document.getElementById('techModalContent');
    
    if (show) {
        overlay.style.display = 'flex';
        setTimeout(() => {
            overlay.style.opacity = '1';
            content.style.transform = 'translateY(0)';
        }, 10);
    } else {
        overlay.style.opacity = '0';
        content.style.transform = 'translateY(20px)';
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 300);
    }
}