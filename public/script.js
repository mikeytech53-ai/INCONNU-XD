const stepInput = document.getElementById('step-input');
const stepCode = document.getElementById('step-code');
const stepConnected = document.getElementById('step-connected');
const phoneInput = document.getElementById('phone');
const pairBtn = document.getElementById('pairBtn');
const errorEl = document.getElementById('error');
const codeEl = document.getElementById('code');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const connectedForEl = document.getElementById('connectedFor');
const channelLink = document.getElementById('channelLink');
const groupLink = document.getElementById('groupLink');
const statsText = document.getElementById('statsText');

let pollTimer = null;
let uptimeTimer = null;
let currentSessionId = null;
let connectedAt = null;

function showStep(step) {
  [stepInput, stepCode, stepConnected].forEach((s) => s.classList.add('hidden'));
  step.classList.remove('hidden');
}

// ---- Community links ----
async function loadCommunityLinks() {
  try {
    const res = await fetch('/api/links');
    const data = await res.json();
    if (data.channel) channelLink.href = data.channel;
    if (data.group) groupLink.href = data.group;
  } catch (err) {
    // Non-critical — just leave the buttons pointing nowhere if this fails.
    console.warn('Could not load community links:', err.message);
  }
}

// ---- Paired / active account count ----
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    statsText.textContent = `${data.active} active · ${data.total} paired`;
  } catch (err) {
    statsText.textContent = 'Stats unavailable';
  }
}

// ---- Ambient rising particles, purely decorative ----
function spawnParticles() {
  const container = document.getElementById('particles');
  if (!container) return;
  for (let i = 0; i < 24; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = 2 + Math.random() * 4;
    p.style.width = `${size}px`;
    p.style.height = `${size}px`;
    p.style.left = `${Math.random() * 100}%`;
    p.style.setProperty('--drift', `${(Math.random() - 0.5) * 80}px`);
    p.style.animationDuration = `${8 + Math.random() * 10}s`;
    p.style.animationDelay = `${Math.random() * 10}s`;
    container.appendChild(p);
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function startUptimeClock() {
  clearInterval(uptimeTimer);
  uptimeTimer = setInterval(() => {
    if (!connectedAt) return;
    connectedForEl.textContent = formatDuration(Date.now() - connectedAt);
  }, 1000);
}

async function requestPairing() {
  errorEl.textContent = '';
  const phone = phoneInput.value.replace(/[^0-9]/g, '');
  if (!phone) {
    errorEl.textContent = 'Enter your number with country code.';
    return;
  }

  pairBtn.disabled = true;
  pairBtn.textContent = 'Generating code…';

  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Something went wrong.';
      return;
    }

    currentSessionId = data.sessionId;

    if (data.alreadyLinked) {
      connectedAt = Date.now();
      showStep(stepConnected);
      startUptimeClock();
      return;
    }

    codeEl.textContent = data.pairingCode;
    showStep(stepCode);
    startPolling();
  } catch (err) {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    pairBtn.disabled = false;
    pairBtn.textContent = '🚀 Get Pairing Code';
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!currentSessionId) return;
    const res = await fetch(`/api/status/${currentSessionId}`);
    const data = await res.json();

    if (data.status === 'connected') {
      clearInterval(pollTimer);
      connectedAt = data.connectedAt || Date.now();
      showStep(stepConnected);
      startUptimeClock();
    } else if (data.status === 'disconnected') {
      statusText.textContent = 'Reconnecting…';
      statusDot.classList.remove('connected');
    } else {
      statusText.textContent = 'Waiting for link…';
    }
  }, 2500);
}

function reset() {
  clearInterval(pollTimer);
  clearInterval(uptimeTimer);
  currentSessionId = null;
  connectedAt = null;
  phoneInput.value = '';
  errorEl.textContent = '';
  showStep(stepInput);
}

pairBtn.addEventListener('click', requestPairing);
phoneInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') requestPairing(); });
document.getElementById('resetBtn').addEventListener('click', reset);
document.getElementById('resetBtn2').addEventListener('click', reset);

loadCommunityLinks();
loadStats();
setInterval(loadStats, 15000);
spawnParticles();
