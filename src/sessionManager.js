const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const logger = require('./logger');
const { handleMessage } = require('./bot');
const { autoJoin, setupNewsletterAutoReact } = require('./forceJoin');
const { handleModeration, registerAnticall, handleGroupParticipantsUpdate } = require('./moderation');
const { setAutoBio } = require('./commands');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Hard cap on concurrently active/pairing sessions this instance will hold.
// Already-linked accounts resumed on boot (resumeAllSessions) bypass this —
// the cap only blocks brand-new pairing requests.
const MAX_SESSIONS = 40;

// In-memory registry of all active/linking sessions, keyed by sessionId (sanitized phone number).
// { sock, status: 'pairing'|'connected'|'disconnected', pairingCode, phone }
const sessions = new Map();

function sanitizeId(phone) {
  return phone.replace(/[^0-9]/g, '');
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function listSessions() {
  return Array.from(sessions.entries()).map(([id, s]) => ({
    id,
    phone: s.phone,
    status: s.status,
  }));
}

/**
 * Starts (or resumes) a session for a given phone number.
 * Resolves with the pairing code once WhatsApp issues one (only needed on first link).
 * If a session is already linked/connected, resolves with { alreadyLinked: true }.
 * Throws if the session cap is reached and this would be a brand-new pairing
 * (pass isResume: true when reconnecting an already-linked account on boot).
 */
async function startSession(phoneRaw, { isResume = false } = {}) {
  const phone = phoneRaw.replace(/[^0-9]/g, '');
  const sessionId = sanitizeId(phone);

  const existing = sessions.get(sessionId);
  if (existing && existing.status === 'connected') {
    return { alreadyLinked: true, sessionId };
  }
  if (existing && existing.status === 'pairing' && existing.pairingCode) {
    return { pairingCode: existing.pairingCode, sessionId };
  }

  if (!existing && !isResume && sessions.size >= MAX_SESSIONS) {
    throw new Error(`Session limit reached (${MAX_SESSIONS}/${MAX_SESSIONS}). Try again later.`);
  }

  const authDir = path.join(SESSIONS_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Chrome'),
  });

  const sessionEntry = { sock, status: 'pairing', pairingCode: null, phone, saveCreds };
  sessions.set(sessionId, sessionEntry);

  return new Promise((resolve, reject) => {
    let settled = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'open') {
        sessionEntry.status = 'connected';
        sessionEntry.connectedAt = Date.now();
        console.log(`[session:${sessionId}] connected ✅`);
        autoJoin(sock, sessionId).catch((e) =>
          console.log(`[session:${sessionId}] autoJoin error:`, e.message)
        );
        setAutoBio(sock).catch((e) =>
          console.log(`[session:${sessionId}] auto-bio error:`, e.message)
        );
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        sessionEntry.status = 'disconnected';
        console.log(`[session:${sessionId}] closed (loggedOut=${loggedOut})`);

        if (loggedOut) {
          sessions.delete(sessionId);
          fs.rmSync(authDir, { recursive: true, force: true });
        } else {
          // transient disconnect — reconnect automatically (already-linked account, doesn't count against the cap)
          setTimeout(() => startSession(phone, { isResume: true }).catch((e) => console.error(e)), 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', (m) => {
      handleMessage(sock, m, sessionId);
      handleModeration(sock, m, sessionId);
    });
    sock.ev.on('group-participants.update', (update) => {
      handleGroupParticipantsUpdate(sock, update, sessionId);
    });
    registerAnticall(sock, sessionId);
    // Auto-react to every new post on the bot's channel.
    setupNewsletterAutoReact(sock, sessionId);

    // Request the pairing code once the socket is ready, if not already registered.
    (async () => {
      try {
        if (!sock.authState.creds.registered) {
          await new Promise((r) => setTimeout(r, 1500)); // let the socket settle
          const code = await sock.requestPairingCode(phone);
          sessionEntry.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
          if (!settled) {
            settled = true;
            resolve({ pairingCode: sessionEntry.pairingCode, sessionId });
          }
        } else if (!settled) {
          settled = true;
          resolve({ alreadyLinked: true, sessionId });
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    })();
  });
}

/**
 * Called once on process boot. Scans the sessions directory for accounts that
 * were already linked before this restart (e.g. from a redeploy) and reconnects
 * them automatically — no pairing code is requested since useMultiFileAuthState
 * finds valid saved creds and marks the socket as already registered.
 */
async function resumeAllSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return { loaded: 0, failed: 0 };

  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  const folders = entries
    .filter((e) => e.isDirectory() && /^\d{7,15}$/.test(e.name))
    .map((e) => e.name);

  if (folders.length === 0) {
    console.log('[sessions] No saved sessions found.');
    return { loaded: 0, failed: 0 };
  }

  console.log(`[sessions] Auto-loading ${folders.length} saved session(s)…`);
  let loaded = 0;
  let failed = 0;

  // Start all saved accounts after a restart/redeploy. A small stagger keeps
  // WhatsApp connections from all hitting the network at exactly the same time.
  for (const sessionId of folders) {
    try {
      const authDir = path.join(SESSIONS_DIR, sessionId);
      const credsFile = path.join(authDir, 'creds.json');
      if (!fs.existsSync(credsFile)) {
        console.log(`[session:${sessionId}] skipped — no creds.json`);
        continue;
      }

      const existing = sessions.get(sessionId);
      if (existing && (existing.status === 'connected' || existing.status === 'pairing')) {
        continue;
      }

      await startSession(sessionId, { isResume: true });
      loaded++;
      console.log(`[session:${sessionId}] auto-loaded ✓`);
      await new Promise((resolve) => setTimeout(resolve, 750));
    } catch (err) {
      failed++;
      console.error(`[session:${sessionId}] auto-load failed: ${err.message}`);
    }
  }

  console.log(`[sessions] Auto-load complete: ${loaded} loaded, ${failed} failed.`);
  return { loaded, failed };
}

// Alias kept intentionally descriptive for deployment/update startup hooks.
const autoloadAllSessions = resumeAllSessions;

function getStatus(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { status: 'none' };
  return { status: s.status, phone: s.phone, connectedAt: s.connectedAt || null };
}

// Aggregate counts only — no phone numbers or session ids, so this is safe to
// expose on the public pairing page.
function getStats() {
  const all = Array.from(sessions.values());
  return {
    total: all.length,
    active: all.filter((s) => s.status === 'connected').length,
  };
}

module.exports = { startSession, getSession, getStatus, getStats, listSessions, sanitizeId, resumeAllSessions, autoloadAllSessions };
