const fs = require('fs');
const path = require('path');
const { ANTICALL_ENABLED, DEFAULT_PREFIX, DEFAULT_MENU_STYLE } = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const SETTINGS_FILE = path.join(DATA_DIR, 'group-settings.json');

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
} catch {
  settings = {};
}

let saveTimer = null;
function persist() {
  // Debounce writes so a burst of toggles doesn't hammer the disk.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), (err) => {
      if (err) console.error('settings save failed:', err.message);
    });
  }, 250);
}

const GROUP_DEFAULTS = {
  antidelete: true,
  antiedit: true,
  antisticker: false,
  antigroupmention: false,
  antilink: false,
  antigif: false,
  // On by default — group admins can turn them off with .welcome off / .goodbye off.
  welcome: true,
  goodbye: true,
  // Auto-kick codes for .antinum — array of bare calling codes (e.g. ["55", "509"]).
  antinumCodes: [],
  // Flood-message protection — warns/kicks a user sending too many messages too fast.
  antispam: false,
  // Warns/kicks anyone whose messages carry a "forwarded from channel" tag
  // pointing to a different bot's channel (a strong signal it's another bot).
  antibot: false,
  // Only the bot owner / sudo users / the group's real owner may promote or
  // demote members while these are on — anyone else gets reverted + warned.
  antipromote: false,
  antidemote: false,
  // How many warnings (from any warn-issuing feature: antispam, antibot,
  // antipromote, antidemote, mute, ...) before an auto-kick. Set with .setwarn.
  warnLimit: 3,
};

function getGroupSettings(jid) {
  if (!settings[jid]) {
    settings[jid] = { ...GROUP_DEFAULTS };
  } else {
    // Backfill keys added to GROUP_DEFAULTS after this group's settings were
    // first saved to disk, so older groups don't crash on a missing field.
    for (const key of Object.keys(GROUP_DEFAULTS)) {
      if (!(key in settings[jid])) settings[jid][key] = GROUP_DEFAULTS[key];
    }
  }
  return settings[jid];
}

function setGroupSetting(jid, key, value) {
  const s = getGroupSettings(jid);
  s[key] = value;
  persist();
}

// Wipes a group's settings back to GROUP_DEFAULTS — used by .resetsettings.
function resetGroupSettings(jid) {
  settings[jid] = { ...GROUP_DEFAULTS };
  persist();
  return settings[jid];
}

// Returns the raw jid -> settings map for every group that has ever had a
// setting touched. Used by the .opentime/.closetime scheduler to find every
// group with a schedule configured without needing a jid up front.
function getAllGroupSettings() {
  return settings;
}

// ---- Account-level (per-session) toggles, e.g. mode, anticall, autoreact ----
// Keyed by sessionId so each linked account has its own settings — this used
// to be a single flat object shared by every user, which broke multi-user use
// and also crashed `.mode` (called as getGlobalSetting(sessionId, key) against
// a function that only took one argument).
const ACCOUNT_SETTINGS_FILE = path.join(DATA_DIR, 'account-settings.json');
let accountSettings = {};
try {
  accountSettings = JSON.parse(fs.readFileSync(ACCOUNT_SETTINGS_FILE, 'utf8'));
} catch {
  accountSettings = {};
}

let accountSaveTimer = null;
function persistAccount() {
  clearTimeout(accountSaveTimer);
  accountSaveTimer = setTimeout(() => {
    fs.writeFile(ACCOUNT_SETTINGS_FILE, JSON.stringify(accountSettings, null, 2), (err) => {
      if (err) console.error('account settings save failed:', err.message);
    });
  }, 250);
}

const ACCOUNT_DEFAULTS = {
  mode: 'public',
  anticall: ANTICALL_ENABLED,
  // 'off' | 'dm' | 'group' | 'both' — which chats get random-emoji reactions.
  autoreact: 'off',
  // When true, the owner's own (fromMe) messages get reacted to as well.
  ownerreact: false,
  // Simulated "typing…" / "recording audio…" presence shown on incoming chats.
  autotyping: false,
  autorecording: false,
  // WhatsApp Status (stories) automation.
  autolikestatus: false,
  autoviewstatus: false,
  prefix: DEFAULT_PREFIX,
  menuStyle: DEFAULT_MENU_STYLE,
};

function getAccountSettings(sessionId) {
  if (!accountSettings[sessionId]) {
    accountSettings[sessionId] = { ...ACCOUNT_DEFAULTS };
  } else {
    for (const key of Object.keys(ACCOUNT_DEFAULTS)) {
      if (!(key in accountSettings[sessionId])) accountSettings[sessionId][key] = ACCOUNT_DEFAULTS[key];
    }
    // Migrate the old boolean autoreact (true/false) to the new dm/group/both/off scale.
    if (accountSettings[sessionId].autoreact === true) accountSettings[sessionId].autoreact = 'both';
    if (accountSettings[sessionId].autoreact === false) accountSettings[sessionId].autoreact = 'off';
  }
  return accountSettings[sessionId];
}

function getGlobalSetting(sessionId, key) {
  const s = getAccountSettings(sessionId);
  return key ? s[key] : s;
}

function setGlobalSetting(sessionId, key, value) {
  const s = getAccountSettings(sessionId);
  s[key] = value;
  persistAccount();
}

// ---- Short-lived cache of recent messages, keyed by message id ----
// Used only to show what a deleted/edited message said. Capped and cleared
// on a rolling basis so it never grows into a permanent message log.
const MAX_CACHE = 1500;
const messageCache = new Map();

function cacheMessage(id, data) {
  if (messageCache.size >= MAX_CACHE) {
    const oldestKey = messageCache.keys().next().value;
    messageCache.delete(oldestKey);
  }
  messageCache.set(id, data);
}

function getCachedMessage(id) {
  return messageCache.get(id);
}

// ---- Per-user group mutes (".mute <number> <limit>") ----
// Keyed by groupJid -> userJid -> { limit, count }. While a user is muted,
// moderation.js deletes every message they send and auto-kicks them once
// `count` reaches `limit`.
const MUTED_FILE = path.join(DATA_DIR, 'muted-users.json');
let mutedUsers = {};
try {
  mutedUsers = JSON.parse(fs.readFileSync(MUTED_FILE, 'utf8'));
} catch {
  mutedUsers = {};
}

let mutedSaveTimer = null;
function persistMuted() {
  clearTimeout(mutedSaveTimer);
  mutedSaveTimer = setTimeout(() => {
    fs.writeFile(MUTED_FILE, JSON.stringify(mutedUsers, null, 2), (err) => {
      if (err) console.error('muted-users save failed:', err.message);
    });
  }, 250);
}

function muteUser(groupJid, userJid, limit) {
  if (!mutedUsers[groupJid]) mutedUsers[groupJid] = {};
  mutedUsers[groupJid][userJid] = { limit: Math.max(1, limit | 0), count: 0 };
  persistMuted();
}

function unmuteUser(groupJid, userJid) {
  if (mutedUsers[groupJid]) {
    delete mutedUsers[groupJid][userJid];
    if (Object.keys(mutedUsers[groupJid]).length === 0) delete mutedUsers[groupJid];
  }
  persistMuted();
}

function unmuteAllUsers(groupJid) {
  delete mutedUsers[groupJid];
  persistMuted();
}

function getMutedUser(groupJid, userJid) {
  return mutedUsers[groupJid]?.[userJid] || null;
}

// Increments the muted user's message count and returns the updated entry
// (or null if they aren't currently muted in this group).
function bumpMutedCount(groupJid, userJid) {
  const entry = mutedUsers[groupJid]?.[userJid];
  if (!entry) return null;
  entry.count += 1;
  persistMuted();
  return entry;
}

// ---- Sudo users (".sudoadd <number>") ----
// Keyed by sessionId -> array of bare phone numbers. A sudo user is treated
// as a full owner (bypasses private mode, force-join, and every owner-only
// gate) for that session, without being the actual linked account.
const SUDO_FILE = path.join(DATA_DIR, 'sudo-users.json');
let sudoUsers = {};
try {
  sudoUsers = JSON.parse(fs.readFileSync(SUDO_FILE, 'utf8'));
} catch {
  sudoUsers = {};
}

let sudoSaveTimer = null;
function persistSudo() {
  clearTimeout(sudoSaveTimer);
  sudoSaveTimer = setTimeout(() => {
    fs.writeFile(SUDO_FILE, JSON.stringify(sudoUsers, null, 2), (err) => {
      if (err) console.error('sudo-users save failed:', err.message);
    });
  }, 250);
}

function addSudo(sessionId, number) {
  if (!sudoUsers[sessionId]) sudoUsers[sessionId] = [];
  if (!sudoUsers[sessionId].includes(number)) sudoUsers[sessionId].push(number);
  persistSudo();
}

function removeSudo(sessionId, number) {
  if (!sudoUsers[sessionId]) return;
  sudoUsers[sessionId] = sudoUsers[sessionId].filter((n) => n !== number);
  if (sudoUsers[sessionId].length === 0) delete sudoUsers[sessionId];
  persistSudo();
}

function isSudo(sessionId, number) {
  if (!number) return false;
  return !!(sudoUsers[sessionId] && sudoUsers[sessionId].includes(number));
}

function listSudoUsers(sessionId) {
  return sudoUsers[sessionId] || [];
}

// ---- Banned users (".ban <number>") ----
// Keyed by sessionId -> array of bare phone numbers. A banned user is
// ignored by the command handler entirely for that session.
const BAN_FILE = path.join(DATA_DIR, 'banned-users.json');
let bannedUsers = {};
try {
  bannedUsers = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
} catch {
  bannedUsers = {};
}

let banSaveTimer = null;
function persistBanned() {
  clearTimeout(banSaveTimer);
  banSaveTimer = setTimeout(() => {
    fs.writeFile(BAN_FILE, JSON.stringify(bannedUsers, null, 2), (err) => {
      if (err) console.error('banned-users save failed:', err.message);
    });
  }, 250);
}

function banUser(sessionId, number) {
  if (!bannedUsers[sessionId]) bannedUsers[sessionId] = [];
  if (!bannedUsers[sessionId].includes(number)) bannedUsers[sessionId].push(number);
  persistBanned();
}

function unbanUser(sessionId, number) {
  if (!bannedUsers[sessionId]) return;
  bannedUsers[sessionId] = bannedUsers[sessionId].filter((n) => n !== number);
  if (bannedUsers[sessionId].length === 0) delete bannedUsers[sessionId];
  persistBanned();
}

function isBanned(sessionId, number) {
  if (!number) return false;
  return !!(bannedUsers[sessionId] && bannedUsers[sessionId].includes(number));
}

function listBannedUsers(sessionId) {
  return bannedUsers[sessionId] || [];
}

// ---- Custom cases (".addcase <trigger>|<response>" / ".delcase <trigger>") ----
// Keyed by sessionId -> { trigger: response }. A "case" is a custom command:
// once added, sending "<prefix><trigger>" replies with the stored response,
// exactly like a built-in command — checked in bot.js after the built-in
// command map comes up empty.
const CASES_FILE = path.join(DATA_DIR, 'custom-cases.json');
let customCases = {};
try {
  customCases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
} catch {
  customCases = {};
}

let casesSaveTimer = null;
function persistCases() {
  clearTimeout(casesSaveTimer);
  casesSaveTimer = setTimeout(() => {
    fs.writeFile(CASES_FILE, JSON.stringify(customCases, null, 2), (err) => {
      if (err) console.error('custom-cases save failed:', err.message);
    });
  }, 250);
}

function addCase(sessionId, trigger, response) {
  if (!customCases[sessionId]) customCases[sessionId] = {};
  customCases[sessionId][trigger] = response;
  persistCases();
}

function removeCase(sessionId, trigger) {
  if (!customCases[sessionId]) return false;
  if (!(trigger in customCases[sessionId])) return false;
  delete customCases[sessionId][trigger];
  if (Object.keys(customCases[sessionId]).length === 0) delete customCases[sessionId];
  persistCases();
  return true;
}

function getCase(sessionId, trigger) {
  return customCases[sessionId]?.[trigger] ?? null;
}

function listCases(sessionId) {
  return customCases[sessionId] || {};
}

// ---- Warnings (".setwarn <n>", ".delwarn", ".delallwarn", ".listwarn") ----
// Keyed by groupJid -> userJid -> count. Shared by every warn-issuing feature
// (antispam, antibot, antipromote, antidemote, ...) so one warning pool and
// one .setwarn limit governs all of them per group.
const WARNINGS_FILE = path.join(DATA_DIR, 'warnings.json');
let warnings = {};
try {
  warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8'));
} catch {
  warnings = {};
}

let warnSaveTimer = null;
function persistWarnings() {
  clearTimeout(warnSaveTimer);
  warnSaveTimer = setTimeout(() => {
    fs.writeFile(WARNINGS_FILE, JSON.stringify(warnings, null, 2), (err) => {
      if (err) console.error('warnings save failed:', err.message);
    });
  }, 250);
}

// Increments a user's warning count in this group and returns the new total.
function addWarn(groupJid, userJid) {
  if (!warnings[groupJid]) warnings[groupJid] = {};
  warnings[groupJid][userJid] = (warnings[groupJid][userJid] || 0) + 1;
  persistWarnings();
  return warnings[groupJid][userJid];
}

function getWarnCount(groupJid, userJid) {
  return warnings[groupJid]?.[userJid] || 0;
}

// Clears one user's warnings in this group (".delwarn").
function removeWarn(groupJid, userJid) {
  if (!warnings[groupJid]) return false;
  if (!(userJid in warnings[groupJid])) return false;
  delete warnings[groupJid][userJid];
  if (Object.keys(warnings[groupJid]).length === 0) delete warnings[groupJid];
  persistWarnings();
  return true;
}

// Clears every warning in this group (".delallwarn").
function removeAllWarns(groupJid) {
  const had = !!warnings[groupJid];
  delete warnings[groupJid];
  persistWarnings();
  return had;
}

// Returns { userJid: count } for this group (".listwarn").
function listWarns(groupJid) {
  return warnings[groupJid] || {};
}

module.exports = {
  getGroupSettings,
  setGroupSetting,
  getAllGroupSettings,
  resetGroupSettings,
  getGlobalSetting,
  setGlobalSetting,
  cacheMessage,
  getCachedMessage,
  muteUser,
  unmuteUser,
  unmuteAllUsers,
  getMutedUser,
  bumpMutedCount,
  addSudo,
  removeSudo,
  isSudo,
  listSudoUsers,
  banUser,
  unbanUser,
  isBanned,
  listBannedUsers,
  addCase,
  removeCase,
  getCase,
  listCases,
  addWarn,
  getWarnCount,
  removeWarn,
  removeAllWarns,
  listWarns,
};
