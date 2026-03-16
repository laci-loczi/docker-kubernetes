// ── Socket setup (mirrors your existing script.js pattern) ──────────────────
const socket = io({
    path: '/socket.io/',
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 20
});

const statusDot    = document.getElementById('statusDot');
const statusLabel  = document.getElementById('connectionStatus');

socket.on('connect', () => {
    statusLabel.textContent = 'Live Connection';
    statusLabel.style.color = '#10b981';
    statusDot.style.backgroundColor = '#10b981';
    statusDot.style.boxShadow = '0 0 10px rgba(16,185,129,0.4)';
});
socket.on('disconnect', () => {
    statusLabel.textContent = 'Offline (Reconnecting...)';
    statusLabel.style.color = '#ef4444';
    statusDot.style.backgroundColor = '#ef4444';
    statusDot.style.boxShadow = 'none';
});
socket.on('init info', (data) => {
    if (data?.hostname) document.getElementById('podName').textContent = data.hostname;
});

// ── State ───────────────────────────────────────────────────────────────────
let lastResult      = null;   // full JSON from server — used for export
let mediaRecorder   = null;
let recordedChunks  = [];
let recTimerInterval = null;
let recSeconds      = 0;
let isRunning       = false;

// ── File drop-zone ───────────────────────────────────────────────────────────
const dropZone       = document.getElementById('dropZone');
const audioFileInput = document.getElementById('audioFile');
const fileNameEl     = document.getElementById('selectedFileName');

audioFileInput.addEventListener('change', () => {
    const f = audioFileInput.files[0];
    if (f) { fileNameEl.textContent = f.name; fileNameEl.style.display = 'block'; }
});

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) {
        // Inject into the file input via DataTransfer
        const dt = new DataTransfer();
        dt.items.add(f);
        audioFileInput.files = dt.files;
        fileNameEl.textContent = f.name;
        fileNameEl.style.display = 'block';
    }
});

// ── Microphone recording ─────────────────────────────────────────────────────
const micBtn   = document.getElementById('micBtn');
const micIcon  = document.getElementById('micIcon');
const micLabel = document.getElementById('micLabel');
const recTimer = document.getElementById('recTimer');

micBtn.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        // Stop
        mediaRecorder.stop();
        clearInterval(recTimerInterval);
        recTimer.style.display = 'none';
        micBtn.classList.remove('recording');
        micIcon.className = 'fas fa-microphone';
        micLabel.textContent = 'Start Recording';
    } else {
        // Start
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            recordedChunks = [];
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) recordedChunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
                const blob = new Blob(recordedChunks, { type: 'audio/webm' });
                const file = new File([blob], 'recording.webm', { type: 'audio/webm' });
                const dt = new DataTransfer();
                dt.items.add(file);
                audioFileInput.files = dt.files;
                fileNameEl.textContent = `recording.webm (${formatTime(recSeconds)})`;
                fileNameEl.style.display = 'block';
                stream.getTracks().forEach(t => t.stop());
            };

            mediaRecorder.start(250);
            recSeconds = 0;
            recTimer.style.display = 'block';
            micBtn.classList.add('recording');
            micIcon.className = 'fas fa-stop';
            micLabel.textContent = 'Stop Recording';

            recTimerInterval = setInterval(() => {
                recSeconds++;
                recTimer.textContent = `⏺ ${formatTime(recSeconds)}`;
            }, 1000);
        } catch (err) {
            alert('Microphone access denied: ' + err.message);
        }
    }
});

function formatTime(s) {
    return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

// ── Main analysis trigger ────────────────────────────────────────────────────
async function startMeetingAnalysis() {
    if (isRunning) { alert('Analysis already in progress!'); return; }
    const file = audioFileInput.files[0];
    if (!file) { alert('Please select or record an audio file first.'); return; }

    if (file.size > 25 * 1024 * 1024) {
        alert('File too large (max 25 MB). Please trim or compress the audio.');
        return;
    }

    isRunning = true;
    resetUI();

    const runBtn = document.getElementById('runBtn');
    runBtn.disabled = true;

    // Read file as base64
    const base64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload  = (e) => res(e.target.result.split(',')[1]);
        reader.onerror = () => rej(new Error('File read failed'));
        reader.readAsDataURL(file);
    });

    setProgress('Uploading to worker...', 5);

    socket.emit('analyze meeting', {
        audioBase64: base64,
        mimeType:    file.type || 'audio/webm',
        fileName:    file.name,
        audioLang:   document.getElementById('audioLang').value,
        summaryLang: document.getElementById('summaryLang').value,
        options: {
            actions:    document.getElementById('toggleActions').classList.contains('on'),
            decisions:  document.getElementById('toggleDecisions').classList.contains('on'),
            questions:  document.getElementById('toggleQuestions').classList.contains('on'),
            confidence: document.getElementById('toggleConfidence').classList.contains('on'),
        }
    });
}

// ── Socket events from server ────────────────────────────────────────────────
socket.on('meeting progress', (data) => {
    // { stage: 'Transcribing...', pct: 40, detail: '...' }
    setProgress(data.stage, data.pct, data.detail);
});

socket.on('meeting transcript', (data) => {
    // { text: '...', wordCount: 420, duration: '12:34' }
    const box = document.getElementById('transcriptBox');
    document.getElementById('transcriptPlaceholder').style.display = 'none';
    box.classList.add('has-content');
    box.textContent = data.text;
    box.scrollTop = box.scrollHeight;

    document.getElementById('statWords').textContent    = data.wordCount ?? '—';
    document.getElementById('statDuration').textContent = data.duration  ?? '—';
    document.getElementById('statsRow').style.display   = 'flex';
    document.getElementById('copyTranscriptBtn').disabled = false;
});

socket.on('meeting result', (data) => {
    // Full structured result
    lastResult = data;
    isRunning  = false;

    document.getElementById('runBtn').disabled = false;
    document.getElementById('progressWrap').classList.remove('visible');
    document.getElementById('downloadBtn').disabled = false;

    // Summary
    if (data.summary) {
        const sb = document.getElementById('summaryBox');
        sb.classList.add('has-content');
        document.getElementById('summaryText').textContent = data.summary;
        document.getElementById('summaryText').style.fontStyle = 'normal';
        document.getElementById('summaryText').style.opacity = '1';
    }

    // Action items
    renderItems('actionsList', data.actions, 'action');

    // Decisions
    renderItems('decisionsList', data.decisions, 'decision');

    // Open questions
    renderItems('questionsList', data.questions, 'question');

    // Stats
    document.getElementById('statActions').textContent = (data.actions ?? []).length;
});

socket.on('meeting error', (err) => {
    isRunning = false;
    document.getElementById('runBtn').disabled = false;
    setProgress('Error: ' + err, 0, '');
    document.getElementById('progressWrap').classList.add('visible');
    document.getElementById('progressFill').style.background = '#ef4444';
    document.getElementById('progressStageName').style.color  = '#ef4444';
});

// ── Render helpers ───────────────────────────────────────────────────────────
function renderItems(containerId, items, type) {
    const container = document.getElementById(containerId);
    if (!items || items.length === 0) {
        container.innerHTML = '<div class="result-placeholder">None found</div>';
        return;
    }

    const showConf = document.getElementById('toggleConfidence').classList.contains('on');

    container.innerHTML = items.map(item => {
        const text = typeof item === 'string' ? item : item.text;
        const conf = typeof item === 'object' ? item.confidence : null;

        let badge = '';
        if (showConf && conf != null) {
            const cls = conf >= 0.75 ? 'conf-high' : conf >= 0.5 ? 'conf-med' : 'conf-low';
            badge = `<span class="confidence-badge ${cls}">${Math.round(conf * 100)}%</span>`;
        }

        return `
            <div class="result-item">
                <div class="result-item-dot"></div>
                <span>${escapeHTML(text)}</span>
                ${badge}
            </div>`;
    }).join('');
}

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function setProgress(stage, pct, detail = '') {
    const wrap = document.getElementById('progressWrap');
    wrap.classList.add('visible');
    document.getElementById('progressStageName').textContent = stage;
    document.getElementById('progressPct').textContent       = pct + '%';
    document.getElementById('progressFill').style.width      = pct + '%';
    document.getElementById('progressDetail').textContent    = detail;
}

function resetUI() {
    lastResult = null;

    // Transcript
    const box = document.getElementById('transcriptBox');
    box.textContent = '';
    box.classList.remove('has-content');
    document.getElementById('transcriptPlaceholder').style.display = 'flex';
    document.getElementById('copyTranscriptBtn').disabled = true;

    // Summary
    const sb = document.getElementById('summaryBox');
    sb.classList.remove('has-content');
    document.getElementById('summaryText').textContent  = 'Summary will appear here after analysis...';
    document.getElementById('summaryText').style.fontStyle = 'italic';
    document.getElementById('summaryText').style.opacity   = '0.5';

    // Result lists
    ['actionsList','decisionsList','questionsList'].forEach(id => {
        document.getElementById(id).innerHTML = '<div class="result-placeholder">Analyzing...</div>';
    });

    // Stats
    document.getElementById('statsRow').style.display = 'none';
    document.getElementById('downloadBtn').disabled = true;
    document.getElementById('progressFill').style.background = 'linear-gradient(90deg, #6366f1, #818cf8)';
    document.getElementById('progressStageName').style.color = '';
}

// ── Export ───────────────────────────────────────────────────────────────────
document.getElementById('downloadBtn').addEventListener('click', () => {
    if (!lastResult) return;
    const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `meeting_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

function copyTranscript() {
    const text = document.getElementById('transcriptBox').textContent;
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('copyTranscriptBtn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
    });
}
