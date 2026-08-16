// Drives the .opentime / .closetime auto-schedule set per group. Runs a
// single interval for every linked session, checking each group that has
// an openTime/closeTime configured against the current server time and
// firing groupSettingUpdate when a match is found.
const { getAllGroupSettings, setGroupSetting } = require('./store');

// In-memory de-dupe so a slow tick (or a tick landing a few seconds either
// side of the minute boundary) never fires the same action twice for the
// same group in the same minute.
const lastFired = new Map(); // jid -> "HH:MM" already handled this run

function currentTime() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

async function applyGroupState(sock, jid, announcement, label, emoji) {
  try {
    await sock.groupSettingUpdate(jid, announcement ? 'announcement' : 'not_announcement');
    await sock.sendMessage(jid, { text: `${emoji} Group auto-${label} (scheduled).` });
  } catch (err) {
    console.error(`[scheduler] could not auto-${label} ${jid}:`, err.message);
  }
}

/**
 * Starts the scheduler. getSession is sessionManager.getSession, injected
 * here (rather than required directly) to avoid a require cycle between
 * sessionManager and this module.
 */
function startGroupTimeScheduler(getSession) {
  setInterval(async () => {
    const time = currentTime();
    const all = getAllGroupSettings();

    for (const [jid, settings] of Object.entries(all)) {
      if (!settings || (!settings.openTime && !settings.closeTime)) continue;

      const match =
        settings.openTime === time ? 'open' : settings.closeTime === time ? 'close' : null;
      if (!match) continue;

      const fireKey = `${jid}:${match}`;
      if (lastFired.get(fireKey) === time) continue; // already handled this minute

      const session = settings.scheduleSessionId && getSession(settings.scheduleSessionId);
      if (!session || session.status !== 'connected' || !session.sock) continue;

      lastFired.set(fireKey, time);
      if (match === 'open') {
        await applyGroupState(session.sock, jid, false, 'opened', '🔓');
      } else {
        await applyGroupState(session.sock, jid, true, 'closed', '🔒');
      }
    }
  }, 30 * 1000);
}

module.exports = { startGroupTimeScheduler };
