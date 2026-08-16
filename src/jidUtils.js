// Small JID helpers shared across bot.js / moderation.js / commands/index.js.
// Kept in their own file (instead of living inside commands/index.js) so
// bot.js can use them too without creating a circular require.

function bareNumber(jid = '') {
  return (jid || '').split('@')[0].split(':')[0];
}

// Resolves the best-guess *real phone number* for whoever sent `msg`.
//
// WhatsApp's LID privacy feature means the "primary" id on a message key
// (msg.key.remoteJid in a DM, msg.key.participant in a group) can be an
// opaque @lid identifier instead of a real number, depending on the chat's
// addressingMode. When that happens, Baileys exposes the matching
// phone-number JID on the sibling *Alt field (remoteJidAlt / participantAlt).
// Blindly stripping the domain off whichever field happens to be primary
// (the old behavior) can silently return a LID's digits instead of a phone
// number — e.g. breaking ".pair" self-service checks for users whose chat
// is addressed by LID.
function resolveSenderPhoneNumber(msg) {
  const key = (msg && msg.key) || {};
  const candidates = key.participant
    ? [key.participant, key.participantAlt]
    : [key.remoteJid, key.remoteJidAlt];
  const pn = candidates.find((jid) => jid && jid.endsWith('@s.whatsapp.net'));
  return bareNumber(pn || candidates[0] || '');
}

module.exports = { bareNumber, resolveSenderPhoneNumber };
