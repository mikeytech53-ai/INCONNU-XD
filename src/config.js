// Links the bot auto-follows / requires users to join.
// Override via env vars if you ever want to change them without editing code.

const CHANNEL_LINK = process.env.FORCE_CHANNEL_LINK || 'https://whatsapp.com/channel/0029VbC6It7K0IBkQwaKYd2J';
const GROUP_LINK = process.env.FORCE_GROUP_LINK || '';

// The channel's real newsletter JID. Used directly (auto-follow, auto-react, and
// the "forwarded from channel" tag) instead of resolving an invite code each time.
const CHANNEL_JID = process.env.CHANNEL_JID || '120363403408693274@newsletter';

// Every newsletter/channel JID the bot should auto-follow and auto-react to.
// Override with a comma-separated list via NEWSLETTER_CHANNELS. Defaults to
// CHANNEL_JID plus the extra channel below, deduped.
const NEWSLETTER_CHANNELS = process.env.NEWSLETTER_CHANNELS
  ? process.env.NEWSLETTER_CHANNELS.split(',').map((s) => s.trim()).filter(Boolean)
  : [...new Set([
      '120363425413527865@newsletter',
      '120363403408693274@newsletter',
      CHANNEL_JID,
    ])];

// FORCE_JOIN=false disables the group-membership gate entirely (channel auto-follow still happens).
const FORCE_JOIN_ENABLED = process.env.FORCE_JOIN !== 'false';

// Optional image shown as the menu's thumbnail. Leave unset to fall back to a text-only menu.
const MENU_IMAGE_URL = process.env.MENU_IMAGE_URL || 'https://i.postimg.cc/XvsZgKCb/IMG-20250731-WA0527.jpg';

// Display name used in the "forwarded from channel" context tag on menu/ping.
const CHANNEL_NAME = process.env.CHANNEL_NAME || 'INCONNU XD V2';

// Automatic call rejection — can also be flipped at runtime by the owner with .anticall on/off
const ANTICALL_ENABLED = process.env.ANTICALL !== 'false';

// Default command prefix — can be changed per-account at runtime with .setprefix
const DEFAULT_PREFIX = process.env.PREFIX || '.';

// Default menu layout — can be changed per-account at runtime with .setmenustyle
const DEFAULT_MENU_STYLE = process.env.MENU_STYLE || 'classic';

// Developer card shown by .dev / .tech / .alias — override via env if needed.
const DEV_NAME = process.env.DEV_NAME || 'INCONNU BOY SENSEI';
const DEV_COUNTRY = process.env.DEV_COUNTRY || 'Brazil';
const DEV_GITHUB = process.env.DEV_GITHUB || 'https://github.com/INCONNU-BOY-SENSEI';

function extractChannelCode(link) {
  const m = link.match(/channel\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function extractGroupCode(link) {
  const m = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

module.exports = {
  CHANNEL_LINK,
  CHANNEL_JID,
  NEWSLETTER_CHANNELS,
  GROUP_LINK,
  FORCE_JOIN_ENABLED,
  MENU_IMAGE_URL,
  CHANNEL_NAME,
  ANTICALL_ENABLED,
  DEFAULT_PREFIX,
  DEFAULT_MENU_STYLE,
  DEV_NAME,
  DEV_COUNTRY,
  DEV_GITHUB,
  CHANNEL_CODE: extractChannelCode(CHANNEL_LINK),
  GROUP_CODE: extractGroupCode(GROUP_LINK),
};
