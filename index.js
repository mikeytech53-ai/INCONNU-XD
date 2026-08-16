const express = require('express');
const path = require('path');
const { startSession, getStatus, getStats, listSessions, sanitizeId, autoloadAllSessions, getSession } = require('./src/sessionManager');
const { CHANNEL_LINK, GROUP_LINK } = require('./src/config');
const { startGroupTimeScheduler } = require('./src/scheduler');

global.__BOT_START_TIME = Date.now();

const app = express();

// Allow requests from any origin (CORS wide open) — needed since the pairing
// site/API may be called from other domains/apps.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Request a pairing code for a phone number (e.g. "15551234567", no + or spaces)
app.post('/api/pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^\d{7,15}$/.test(phone.replace(/[^0-9]/g, ''))) {
      return res.status(400).json({ error: 'Enter a valid phone number with country code, digits only.' });
    }
    const result = await startSession(phone);
    res.json(result);
  } catch (err) {
    console.error('pair error:', err);
    if (err.message && err.message.startsWith('Session limit reached')) {
      return res.status(429).json({ error: err.message });
    }
    res.status(500).json({ error: 'Could not generate a pairing code. Try again in a moment.' });
  }
});

// Community links shown on the frontend (also used for the force-join gate).
app.get('/api/links', (_req, res) => {
  res.json({ channel: CHANNEL_LINK, group: GROUP_LINK });
});

// Poll connection status for a session
app.get('/api/status/:sessionId', (req, res) => {
  res.json(getStatus(req.params.sessionId));
});

// Public: total paired / currently-active counts shown on the landing page.
// Deliberately excludes phone numbers and session ids — see /api/sessions for that (admin-only).
app.get('/api/stats', (_req, res) => {
  res.json(getStats());
});

// Admin: list all active sessions
app.get('/api/sessions', (_req, res) => {
  res.json(listSessions());
});

app.listen(PORT, () => {
  console.log(`INCONNU XD V2 web server listening on port ${PORT}`);
  autoloadAllSessions().catch((e) => console.error('autoloadAllSessions error:', e.message));
  startGroupTimeScheduler(getSession);
});
