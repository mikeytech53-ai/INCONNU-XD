const { commands, channelContext } = require('./commands');
const { checkForceJoin } = require('./forceJoin');
const { getGlobalSetting, isSudo, isBanned, getCase } = require('./store');
const { DEFAULT_PREFIX } = require('./config');
const { resolveSenderPhoneNumber } = require('./jidUtils');

// Wraps sock.sendMessage so every reply sent while running ANY command
// automatically carries the bot's branded contextInfo (the forwarded-from-
// channel tag), without having to touch every single sendMessage call site
// in commands/index.js individually.
function withBrandedContext(sock) {
  const brand = channelContext();
  if (!brand.contextInfo) return sock; // no channel configured — nothing to add

  return new Proxy(sock, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return async (jid, content, options) => {
          if (content && typeof content === 'object' && !('delete' in content)) {
            content = {
              ...content,
              contextInfo: { ...brand.contextInfo, ...(content.contextInfo || {}) },
            };
          }
          return target.sendMessage(jid, content, options);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function extractText(message) {
  if (!message) return '';

  // Native-flow replies (list rows / quick-reply buttons from an
  // interactiveMessage, e.g. the .richmenu command) come back as a JSON
  // string on nativeFlowResponseMessage.paramsJson, not as plain text.
  const nativeFlow = message.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nativeFlow?.paramsJson) {
    try {
      const params = JSON.parse(nativeFlow.paramsJson);
      if (params.id) return params.id;
    } catch {
      // fall through to the plain-text checks below
    }
  }

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    // Older-style list/button messages, for compatibility.
    message.listResponseMessage?.singleSelectReply?.selectedRowId ||
    message.buttonsResponseMessage?.selectedButtonId ||
    ''
  );
}

async function handleMessage(sock, m, sessionId) {
  // messages.upsert can carry more than one message in a single event
  // (e.g. catching up after a reconnect) — handle every one, not just the first.
  for (const msg of m.messages || []) {
    await handleSingleMessage(sock, msg, sessionId);
  }
}

async function handleSingleMessage(sock, msg, sessionId) {
  try {
    if (!msg || !msg.message) return;

    const from = msg.key.remoteJid;
    const sender = msg.key.fromMe
      ? sock.user?.id || from
      : msg.key.participant || from;
    const isGroup = from.endsWith('@g.us');

    // Each linked account can set its own prefix with .setprefix — falls back
    // to the global default until they do.
    const prefix = getGlobalSetting(sessionId, 'prefix') || DEFAULT_PREFIX;

    const text = extractText(msg.message).trim();
    if (!text.startsWith(prefix)) return;

    // We only reach here if the text starts with the command prefix — the bot's own
    // replies never do, so allowing fromMe through can't create a self-reply loop.
    // This is what makes ".ping" etc. work from "Message yourself".

    const [rawCmd, ...args] = text.slice(prefix.length).trim().split(/\s+/);
    const cmdName = rawCmd.toLowerCase();
    const command = commands.get(cmdName);
    // No built-in command? Check for a custom case added with .addcase —
    // same lookup, just backed by the per-session store instead of the map.
    const caseResponse = !command ? getCase(sessionId, cmdName) : null;
    if (!command && caseResponse === null) return;

    // Banned users are ignored entirely for this session (set with .ban,
    // lifted with .unban) — checked before anything else, including fromMe's
    // own bypass logic below, since a real ban should hold regardless.
    if (!msg.key.fromMe && isBanned(sessionId, resolveSenderPhoneNumber(msg))) return;

    // The linked account itself (you) is always treated as the owner — never
    // gated. A ".sudoadd"-ed number gets the same full-owner treatment for
    // this session, without being the actual linked account.
    const isOwner = msg.key.fromMe || isSudo(sessionId, resolveSenderPhoneNumber(msg));

    if (!isOwner) {
      // Private mode: only the owner can trigger commands at all.
      if (getGlobalSetting(sessionId, 'mode') === 'private') return;

      const allowed = await checkForceJoin(sock, from, sender);
      if (!allowed) return;
    }

    const quotedCtx = msg.message.extendedTextMessage?.contextInfo;
    const quoted = quotedCtx?.quotedMessage
      ? { message: quotedCtx.quotedMessage, key: { remoteJid: from, id: quotedCtx.stanzaId, participant: quotedCtx.participant } }
      : null;

    await sock.sendPresenceUpdate('composing', from);

    // Every command now gets the branded contextInfo tag on its replies,
    // not just GROUP-ADMIN/owner ones — withBrandedContext() is a no-op
    // Proxy when no channel is configured, so this is always safe.
    const execSock = withBrandedContext(sock);

    if (!command) {
      // Custom case (.addcase) — just send the stored response, with @user
      // resolving to a mention of whoever ran it, same as welcome/goodbye.
      await execSock.sendMessage(from, {
        text: caseResponse.replace(/@user/gi, `@${(sender || '').split('@')[0].split(':')[0]}`),
        mentions: [sender],
      });
      return;
    }

    await command.execute({
      sock: execSock,
      msg,
      from,
      sender,
      args,
      text,
      isGroup,
      sessionId,
      quoted,
      prefix,
      command: cmdName,
      isOwner,
    });
  } catch (err) {
    console.error(`[bot:${sessionId}] handler error:`, err.message);
  }
}

module.exports = { handleMessage };
