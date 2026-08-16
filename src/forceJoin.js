const {
  CHANNEL_LINK,
  GROUP_LINK,
  CHANNEL_JID,
  NEWSLETTER_CHANNELS,
  GROUP_CODE,
  FORCE_JOIN_ENABLED,
} = require('./config');

// Emoji pool for the newsletter auto-react feature — one is picked at random
// for every channel post.
const NEWSLETTER_REACT_EMOJIS = [
  '💜', '🔥', '💫', '👍', '🧧', '❤️', '🦋', '🧡', '💛', '💚', '💙',
  '✨', '🌟', '⭐', '⚡', '💥', '🎉', '🎊', '🎁', '🎈',
  '😎', '😂', '😍', '🥰', '😇', '🤩', '🥳',
  '👑', '💎', '🏆', '🥇',
  '🚀', '🌍', '🌈', '☀️', '🌙',
  '🎵', '🎶', '🫶', '🤝', '👏',
];

// The invite links point to one real channel/group, so once any session resolves the
// group's JID we cache it here and reuse it for membership checks across all sessions.
let resolvedGroupJid = null;

function normalizeNumber(jid = '') {
  // Strips @s.whatsapp.net / @g.us / @lid / device suffixes down to the bare digits,
  // so we can compare a chat sender against a group participant reliably.
  return jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

/**
 * Called once a session's socket connects. Makes that WhatsApp account
 * follow the channel and join the force-join group. Failures (e.g. "already
 * a member") are swallowed — this should never crash a session.
 */
async function autoJoin(sock, sessionId) {
  // Follow every configured channel — NEWSLETTER_CHANNELS holds the real
  // newsletter JIDs, so we follow them directly instead of resolving an
  // invite code every time.
  for (const jid of NEWSLETTER_CHANNELS) {
    try {
      await sock.newsletterFollow(jid);
      console.log(`[session:${sessionId}] following channel ${jid} ✅`);
    } catch (err) {
      console.log(`[session:${sessionId}] channel follow skipped for ${jid} (${err.message})`);
    }
  }

  // Join the group
  try {
    if (GROUP_CODE) {
      if (!resolvedGroupJid) {
        const info = await sock.groupGetInviteInfo(GROUP_CODE);
        resolvedGroupJid = info?.id || null;
      }
      try {
        await sock.groupAcceptInvite(GROUP_CODE);
        console.log(`[session:${sessionId}] joined group ✅`);
      } catch (joinErr) {
        // Most common case: already a participant — not a real error.
        console.log(`[session:${sessionId}] group join skipped (${joinErr.message})`);
      }
    }
  } catch (err) {
    console.log(`[session:${sessionId}] group resolve failed (${err.message})`);
  }
}

/**
 * Returns true if the message sender is allowed through, false if blocked.
 * When blocked, this also sends the "please join" prompt itself.
 */
async function checkForceJoin(sock, from, sender) {
  if (!FORCE_JOIN_ENABLED) return true;
  if (!resolvedGroupJid) return true; // fail-open if we haven't resolved the group yet

  try {
    const metadata = await sock.groupMetadata(resolvedGroupJid);
    const senderNum = normalizeNumber(sender);
    const isMember = metadata.participants.some((p) => normalizeNumber(p.id) === senderNum);

    if (isMember) return true;

    await sock.sendMessage(from, {
      text:
        `🔒 *Access restricted*\n\n` +
        `Join our group and channel to use this bot:\n\n` +
        `👥 Group: ${GROUP_LINK}\n` +
        `📢 Channel: ${CHANNEL_LINK}\n\n` +
        `Once you've joined the group, send your command again.`,
    });
    return false;
  } catch (err) {
    // If the membership check itself fails (e.g. bot got removed from the group),
    // don't lock everyone out — allow the command through.
    console.log('force-join check failed, allowing through:', err.message);
    return true;
  }
}

/**
 * Registers a listener that auto-reacts (with a random emoji) to every new
 * post on any of the bot's channels (NEWSLETTER_CHANNELS). Safe to call once
 * per socket — it just attaches a messages.upsert listener scoped to those
 * JIDs and ignores everything else.
 */
function setupNewsletterAutoReact(sock, sessionId) {
  if (!NEWSLETTER_CHANNELS.length) return;
  const channelSet = new Set(NEWSLETTER_CHANNELS);

  async function reactToOne(message) {
    try {
      if (!message?.key) return;

      const jid = message.key.remoteJid;
      if (!channelSet.has(jid)) return;

      const messageId = message.newsletterServerId;
      if (!messageId) return;

      const emoji = NEWSLETTER_REACT_EMOJIS[Math.floor(Math.random() * NEWSLETTER_REACT_EMOJIS.length)];

      let retries = 3;
      while (retries-- > 0) {
        try {
          await sock.newsletterReactMessage(jid, messageId.toString(), emoji);
          console.log(`[session:${sessionId}] newsletter reacted ${emoji}`);
          return;
        } catch (err) {
          console.log(`[session:${sessionId}] newsletter react retry: ${err.message}`);
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    } catch (err) {
      // Never let a reaction failure crash the session.
      console.log(`[session:${sessionId}] newsletter auto-react error: ${err.message}`);
    }
  }

  sock.ev.on('messages.upsert', ({ type, messages }) => {
    // Skip history-sync replay — only react to live channel posts, otherwise a
    // fresh connect floods reactions across old posts.
    if (type && type !== 'notify') return;
    if (!Array.isArray(messages) || !messages.length) return;

    // BUG FIX: this used to only look at messages[0]. When a channel post arrives
    // in the same upsert batch as another chat's message, the channel post could
    // land anywhere in the array — reacting only to index 0 silently dropped it.
    // React to every channel message in the batch instead.
    for (const message of messages) {
      reactToOne(message);
    }
  });
}

module.exports = { autoJoin, checkForceJoin, setupNewsletterAutoReact };
