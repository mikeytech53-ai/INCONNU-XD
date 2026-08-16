const {
  getGroupSettings,
  cacheMessage,
  getCachedMessage,
  getGlobalSetting,
  getMutedUser,
  bumpMutedCount,
  unmuteUser,
  isSudo,
  addWarn,
  removeWarn,
} = require('./store');
const { CHANNEL_JID, CHANNEL_NAME, NEWSLETTER_CHANNELS } = require('./config');

const REACT_EMOJIS = ['😀', '🔥', '👍', '💯', '😎', '✅', '⚡', '🎯', '😄', '👏', '🙌', '🚀'];

// Same "Forwarded many times from CHANNEL_NAME" branding used on owner/
// GROUP-ADMIN commands (see commands/index.js's channelContext()) — kept as
// its own tiny copy here instead of importing from ./commands, which would
// create a circular require (commands/index.js already requires this file).
function brandedContext() {
  if (!CHANNEL_JID) return {};
  return {
    contextInfo: {
      isForwarded: true,
      forwardingScore: 999,
      forwardedNewsletterMessageInfo: {
        newsletterJid: CHANNEL_JID,
        newsletterName: CHANNEL_NAME,
        serverMessageId: 143,
      },
    },
  };
}

// Tries the given JID's own profile picture first; if they don't have one
// (or it's private), falls back to the bot's own profile picture so the
// welcome/goodbye card always has an image instead of sometimes being
// text-only.
async function resolveWelcomeImage(sock, jid) {
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    if (url) return { url };
  } catch {
    // no photo / private — fall through to the bot's own picture
  }
  try {
    const botJid = sock.user?.id;
    if (botJid) {
      const url = await sock.profilePictureUrl(botJid, 'image');
      if (url) return { url };
    }
  } catch {
    // bot has no photo either — caller falls back to a text-only message
  }
  return null;
}

function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  );
}

function bareNumber(jid = '') {
  return jid.split('@')[0].split(':')[0];
}

async function isSenderAdmin(sock, jid, sender) {
  try {
    const meta = await sock.groupMetadata(jid);
    const p = meta.participants.find((x) => bareNumber(x.id) === bareNumber(sender));
    return !!p && (p.admin === 'admin' || p.admin === 'superadmin');
  } catch {
    return false;
  }
}

// Shared by every warn-issuing feature (antispam, antibot, antipromote,
// antidemote, ...). Adds one warning against `userJid` in `groupJid`; once
// their count reaches the group's .setwarn limit they're auto-kicked and
// their warnings reset, otherwise a warning notice is sent.
async function warnAndMaybeKick(sock, groupJid, userJid, reason) {
  const settings = getGroupSettings(groupJid);
  const limit = settings.warnLimit || 3;
  const count = addWarn(groupJid, userJid);

  if (count >= limit) {
    removeWarn(groupJid, userJid);
    try {
      await sock.groupParticipantsUpdate(groupJid, [userJid], 'remove');
      await sock.sendMessage(groupJid, {
        text: `👢 @${bareNumber(userJid)} was kicked — reached ${limit}/${limit} warning(s).\n_Reason: ${reason}_`,
        mentions: [userJid],
      });
    } catch (e) {
      console.error('warnAndMaybeKick auto-kick failed:', e.message);
    }
    return;
  }

  await sock.sendMessage(groupJid, {
    text: `⚠️ @${bareNumber(userJid)} warned (${count}/${limit}).\n_Reason: ${reason}_`,
    mentions: [userJid],
  }).catch(() => {});
}

// --- Antispam: in-memory sliding-window message counter, keyed by
// "groupJid:userJid". Not persisted — a burst of messages only matters while
// it's actually happening, and this resets naturally on a restart. ---
const SPAM_WINDOW_MS = 8000;
const SPAM_THRESHOLD = 6; // messages within the window before it counts as spam
const spamTracker = new Map();

function isSpamming(groupJid, userJid) {
  const key = `${groupJid}:${userJid}`;
  const now = Date.now();
  const recent = (spamTracker.get(key) || []).filter((t) => now - t < SPAM_WINDOW_MS);
  recent.push(now);
  spamTracker.set(key, recent);
  return recent.length > SPAM_THRESHOLD;
}

/**
 * Runs on every incoming message alongside the command handler. Unlike bot.js,
 * this does not require a command prefix — it watches all group traffic for
 * deletions, edits, stickers, mass-mentions, and (optionally) reacts to it.
 */
const LINK_RE = /(https?:\/\/|www\.)\S+|\b[A-Za-z0-9-]+\.(com|net|org|io|me|link|gg|xyz|co|app|dev|tv|to|gl|be|ly)\b\S*/i;

// Shared by both the group and DM code paths at the end of handleModeration:
// applies .ownerreact (fromMe) or the .autoreact dm/group/both scope to a
// regular chat message. Never throws — reactions are best-effort.
function applyAutoReactions(sock, msg, from, isGroup, sessionId) {
  if (msg.key.fromMe) {
    if (getGlobalSetting(sessionId, 'ownerreact')) {
      const emoji = REACT_EMOJIS[Math.floor(Math.random() * REACT_EMOJIS.length)];
      sock.sendMessage(from, { react: { text: emoji, key: msg.key } }).catch(() => {});
    }
    return;
  }

  const reactScope = getGlobalSetting(sessionId, 'autoreact'); // 'off' | 'dm' | 'group' | 'both'
  const reactApplies =
    reactScope === 'both' || (reactScope === 'dm' && !isGroup) || (reactScope === 'group' && isGroup);
  if (reactApplies) {
    const emoji = REACT_EMOJIS[Math.floor(Math.random() * REACT_EMOJIS.length)];
    sock.sendMessage(from, { react: { text: emoji, key: msg.key } }).catch(() => {});
  }
}

async function handleModeration(sock, m, sessionId) {
  try {
    const msg = m.messages?.[0];
    if (!msg || !msg.message) return;
    // Skip history-sync replay (m.type === 'append') — only act on live messages,
    // otherwise a fresh connect floods reactions/deletes across old chat history.
    if (m.type && m.type !== 'notify') return;

    const from = msg.key.remoteJid;

    // --- WhatsApp Status (stories) automation — handled separately from
    // normal chat traffic, then we're done with this message. ---
    if (from === 'status@broadcast') {
      if (!msg.key.fromMe) {
        if (getGlobalSetting(sessionId, 'autoviewstatus')) {
          sock.readMessages([msg.key]).catch(() => {});
        }
        if (getGlobalSetting(sessionId, 'autolikestatus')) {
          const participant = msg.key.participant || msg.participant;
          if (participant) {
            sock
              .sendMessage('status@broadcast', { react: { text: '❤️', key: msg.key } }, { statusJidList: [participant] })
              .catch(() => {});
          }
        }
      }
      return;
    }

    const isGroup = from.endsWith('@g.us');
    const sender = msg.key.fromMe ? sock.user?.id || from : msg.key.participant || from;
    const proto = msg.message.protocolMessage;

    // --- Auto-typing / auto-recording — simulated presence shown while the
    // bot "notices" any incoming message, before any reply is sent. Skipped
    // for the linked account's own messages (nothing to simulate there). ---
    if (!msg.key.fromMe) {
      if (getGlobalSetting(sessionId, 'autotyping')) {
        sock.sendPresenceUpdate('composing', from).catch(() => {});
      } else if (getGlobalSetting(sessionId, 'autorecording')) {
        sock.sendPresenceUpdate('recording', from).catch(() => {});
      }
    }

    if (isGroup) {
      const settings = getGroupSettings(from);

      // --- Deleted-for-everyone message (REVOKE) ---
      if (proto && proto.type === 0) {
        if (settings.antidelete) {
          const cached = getCachedMessage(proto.key.id);
          if (cached && cached.jid === from) {
            await sock.sendMessage(from, {
              text:
                `🗑️ *Antidelete*\n` +
                `👤 @${bareNumber(cached.sender)} deleted:\n\n` +
                `${cached.text || '[media message]'}`,
              mentions: [cached.sender],
            });
          }
        }
        return;
      }

      // --- Edited message ---
      if (proto && proto.type === 14 && proto.editedMessage) {
        if (settings.antiedit) {
          const cached = getCachedMessage(proto.key.id);
          const newText = extractText(proto.editedMessage) || '[media]';
          if (cached && cached.jid === from) {
            await sock.sendMessage(from, {
              text:
                `✏️ *Antiedit*\n` +
                `👤 @${bareNumber(cached.sender)} edited a message:\n\n` +
                `*Before:* ${cached.text || '[media]'}\n` +
                `*After:* ${newText}`,
              mentions: [cached.sender],
            });
            cacheMessage(proto.key.id, { ...cached, text: newText });
          }
        }
        return;
      }

      // Cache real (non-protocol) messages so a later delete/edit has something to show.
      const text = extractText(msg.message);
      if (text || msg.message.imageMessage || msg.message.videoMessage || msg.message.stickerMessage) {
        cacheMessage(msg.key.id, { jid: from, sender, text, timestamp: Date.now() });
      }

      // Never moderate the linked account's own messages — but still run the
      // owner-react check before returning.
      if (msg.key.fromMe) {
        applyAutoReactions(sock, msg, from, isGroup, sessionId);
        return;
      }

      // --- Antibot: warns/kicks anyone whose message carries a "forwarded
      // from channel" tag pointing to a DIFFERENT bot's channel — every reply
      // this bot itself sends is stamped with its own NEWSLETTER_CHANNELS, so
      // that tag pointing elsewhere is a strong signal another bot is active
      // in the group. Admins aren't exempted — a bot account being an admin
      // doesn't make it welcome. ---
      if (settings.antibot) {
        const ctx =
          msg.message.extendedTextMessage?.contextInfo ||
          msg.message.imageMessage?.contextInfo ||
          msg.message.videoMessage?.contextInfo ||
          msg.message.stickerMessage?.contextInfo;
        const fwdJid = ctx?.forwardedNewsletterMessageInfo?.newsletterJid;
        if (fwdJid && !NEWSLETTER_CHANNELS.includes(fwdJid)) {
          await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
          await warnAndMaybeKick(sock, from, sender, 'Antibot — another bot detected in the group');
          return;
        }
      }

      // --- Per-user mute (.mute <number> <limit>) ---
      // Every message from a muted user is deleted on sight; once their count
      // reaches the configured limit they're auto-kicked and the mute clears.
      const mutedEntry = getMutedUser(from, sender);
      if (mutedEntry) {
        await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
        const updated = bumpMutedCount(from, sender);
        if (updated && updated.count >= updated.limit) {
          unmuteUser(from, sender);
          try {
            await sock.groupParticipantsUpdate(from, [sender], 'remove');
            await sock.sendMessage(from, {
              text: `👢 @${bareNumber(sender)} was kicked — exceeded the muted message limit (${updated.limit}).`,
              mentions: [sender],
            });
          } catch (e) {
            console.error(`[moderation:${sessionId}] auto-kick failed:`, e.message);
          }
        }
        return;
      }

      // --- Antisticker ---
      if (settings.antisticker && msg.message.stickerMessage) {
        const admin = await isSenderAdmin(sock, from, sender);
        if (!admin) {
          await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
        }
        return;
      }

      // --- Antigif (GIF-playback videos, i.e. WhatsApp's "GIF" messages) ---
      if (settings.antigif && msg.message.videoMessage?.gifPlayback) {
        const admin = await isSenderAdmin(sock, from, sender);
        if (!admin) {
          await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
          await sock.sendMessage(from, {
            text: `🎬 @${bareNumber(sender)}'s GIF was removed.`,
            mentions: [sender],
            ...brandedContext(),
          });
          return;
        }
      }

      // --- Antigroupmention (mass @mention spam) ---
      if (settings.antigroupmention) {
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (mentioned.length >= 5) {
          const admin = await isSenderAdmin(sock, from, sender);
          if (!admin) {
            await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
            await sock.sendMessage(from, {
              text: `⚠️ @${bareNumber(sender)}'s mass-mention message was removed.`,
              mentions: [sender],
              ...brandedContext(),
            });
            return;
          }
        }
      }

      // --- Antilink (any URL, not just WhatsApp invite links) ---
      if (settings.antilink && LINK_RE.test(text)) {
        const admin = await isSenderAdmin(sock, from, sender);
        if (!admin) {
          await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
          await sock.sendMessage(from, {
            text: `🔗 @${bareNumber(sender)}'s message contained a link and was removed.`,
            mentions: [sender],
            ...brandedContext(),
          });
          return;
        }
      }

      // --- Antispam (flood protection) ---
      if (settings.antispam) {
        const admin = await isSenderAdmin(sock, from, sender);
        if (!admin && isSpamming(from, sender)) {
          await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
          await warnAndMaybeKick(sock, from, sender, 'Antispam — sending messages too fast');
          return;
        }
      }
    }

    // --- Auto-react (scoped to dm / group / both) / Owner-react (reacts to
    // the linked account's own outgoing messages too) — DM path. ---
    applyAutoReactions(sock, msg, from, isGroup, sessionId);
  } catch (err) {
    console.error(`[moderation:${sessionId}] error:`, err.message);
  }
}

/**
 * Auto-rejects incoming voice/video calls to the linked account.
 */
function registerAnticall(sock, sessionId) {
  sock.ev.on('call', async (calls) => {
    if (!getGlobalSetting(sessionId, 'anticall')) return;
    for (const call of calls) {
      if (call.status !== 'offer') continue;
      try {
        await sock.rejectCall(call.id, call.from);
        console.log(`[session:${sessionId}] rejected call from ${call.from}`);
      } catch (err) {
        console.error(`[session:${sessionId}] anticall error:`, err.message);
      }
    }
  });
}

/**
 * Fires on every join/leave/promote/demote in every group the linked account
 * is in. Sends the group's configured welcome/goodbye message (if that toggle
 * is on) for each member who joined or left. Supports @user and @group
 * placeholders in the custom message set via .setwelcome / .setgoodbye.
 * Also enforces .antipromote / .antidemote — reverting + warning whoever
 * performed the action if they aren't the bot owner or the group's real owner.
 */
async function handleGroupParticipantsUpdate(sock, update, sessionId) {
  try {
    const { id: groupJid, participants, action, author } = update;

    if (action === 'promote' || action === 'demote') {
      const settings = getGroupSettings(groupJid);
      const enabled = action === 'promote' ? settings.antipromote : settings.antidemote;
      if (!enabled || !author) return; // no actor info to verify against — skip rather than false-positive

      let groupOwner = null;
      try {
        const meta = await sock.groupMetadata(groupJid);
        groupOwner = meta.owner || meta.subjectOwner || null;
      } catch {
        // metadata unavailable — fall through, botOwner/sudo check below still applies
      }

      const botOwner = sock.user?.id;
      const actorAllowed =
        bareNumber(author) === bareNumber(botOwner || '') ||
        (groupOwner && bareNumber(author) === bareNumber(groupOwner)) ||
        isSudo(sessionId, bareNumber(author));

      if (actorAllowed) return;

      const targets = participants
        .map((p) => (typeof p === 'string' ? p : p?.id || p?.jid))
        .filter(Boolean);
      if (!targets.length) return;

      try {
        // Revert: a blocked promote gets demoted back, a blocked demote gets re-promoted.
        await sock.groupParticipantsUpdate(groupJid, targets, action === 'promote' ? 'demote' : 'promote');
      } catch (e) {
        console.error(`[moderation:${sessionId}] ${action} revert failed:`, e.message);
      }

      const label = action === 'promote' ? 'Antipromote' : 'Antidemote';
      await warnAndMaybeKick(
        sock,
        groupJid,
        author,
        `${label} — only the bot owner or the group owner may ${action} members`
      );
      return;
    }

    if (action !== 'add' && action !== 'remove') return; // ignore anything else

    const settings = getGroupSettings(groupJid);

    // --- Antinum: auto-kick anyone joining with a blocked calling code ---
    // (.antinum +55) — checked before the welcome message so a blocked
    // joiner never gets welcomed, just removed.
    let joiners = participants;
    if (action === 'add' && settings.antinumCodes && settings.antinumCodes.length) {
      const toKick = [];
      const kept = [];
      for (const participant of participants) {
        const jid = typeof participant === 'string' ? participant : participant?.id || participant?.jid;
        const num = bareNumber(jid || '');
        const blocked = settings.antinumCodes.some((code) => num.startsWith(code));
        if (blocked) toKick.push(jid);
        else kept.push(participant);
      }
      if (toKick.length) {
        try {
          await sock.groupParticipantsUpdate(groupJid, toKick, 'remove');
          await sock.sendMessage(groupJid, {
            text: `🚫 Antinum: auto-kicked ${toKick.length} joiner(s) with a blocked number code (@${toKick.map(bareNumber).join(', @')}).`,
            mentions: toKick,
          });
        } catch (e) {
          console.error(`[moderation:${sessionId}] antinum auto-kick failed:`, e.message);
        }
      }
      joiners = kept;
      if (!joiners.length) return; // nobody left to welcome
    }

    const enabled = action === 'add' ? settings.welcome : settings.goodbye;
    if (!enabled) return;

    let groupName = 'the group';
    let memberCount = null;
    let adminCount = null;
    try {
      const meta = await sock.groupMetadata(groupJid);
      groupName = meta.subject || groupName;
      memberCount = meta.participants.length;
      adminCount = meta.participants.filter((p) => p.admin === 'admin' || p.admin === 'superadmin').length;
    } catch {
      // fall back to the generic name above if metadata can't be fetched
    }

    const customTemplate = action === 'add' ? settings.welcomeMessage : settings.goodbyeMessage;
    const defaultTemplate =
      action === 'add'
        ? '╭───────────────⭓\n│ INCONNU XD V2\n╰───────────────⭓\n\n╭─ WELCOME\n│ • GROUP: @group\n│ • USER: @user\n│ • MEMBERS: @members\n│ • ADMIN: @admin\n│ • inconnuxdv2.vercel.app\n╰───────────────⭓'
        : '╭───────────────⭓\n│ INCONNU XD V2\n╰───────────────⭓\n\n╭─ GOODBYE\n│ • GROUP: @group\n│ • USER: @user\n│ • MEMBERS: @members\n│ • ADMIN: @admin\n│ • inconnuxdv2.vercel.app\n╰───────────────⭓';
    const template = customTemplate || defaultTemplate;

    for (const participant of joiners) {
      // participants can occasionally be objects (e.g. { id, lid }) rather than
      // a plain JID string depending on the Baileys version — normalize first,
      // otherwise @user/mentions silently resolve to nothing and the send below
      // throws, which used to be swallowed by an empty .catch(() => {}).
      const jid = typeof participant === 'string' ? participant : participant?.id || participant?.jid;
      if (!jid) continue;

      const text = template
        .replace(/@group/gi, groupName)
        .replace(/@members/gi, memberCount != null ? String(memberCount) : '—')
        .replace(/@admin/gi, adminCount != null ? String(adminCount) : '—')
        .replace(/@user/gi, `@${bareNumber(jid)}`);
      try {
        const image = await resolveWelcomeImage(sock, jid);
        if (image) {
          await sock.sendMessage(groupJid, {
            image,
            caption: text,
            mentions: [jid],
            ...brandedContext(),
          });
        } else {
          // Neither the member nor the bot has a usable profile picture —
          // fall back to a text-only card rather than failing the send.
          await sock.sendMessage(groupJid, { text, mentions: [jid], ...brandedContext() });
        }
      } catch (sendErr) {
        // Log instead of swallowing — a failed send here was previously silent,
        // making "welcome doesn't work" impossible to diagnose.
        console.error(`[moderation:${sessionId}] failed to send welcome/goodbye in ${groupJid}:`, sendErr.message);
      }
    }
  } catch (err) {
    console.error(`[moderation:${sessionId}] group-participants error:`, err.stack || err.message);
  }
}

module.exports = { handleModeration, registerAnticall, handleGroupParticipantsUpdate, isSenderAdmin };
