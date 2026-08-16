const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { MENU_IMAGE_URL, CHANNEL_JID, CHANNEL_NAME, CHANNEL_LINK, DEFAULT_PREFIX, DEFAULT_MENU_STYLE, NEXORACLE_API_KEY, DEV_COUNTRY, DEV_GITHUB } = require('../config');
const {
  getGroupSettings,
  setGroupSetting,
  resetGroupSettings,
  getGlobalSetting,
  setGlobalSetting,
  muteUser,
  unmuteUser,
  unmuteAllUsers,
  isSudo,
  addSudo,
  removeSudo,
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
} = require('../store');
const { isSenderAdmin } = require('../moderation');
const { resolveSenderPhoneNumber } = require('../jidUtils');
const {
  downloadContentFromMessage,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');





// ==========================================
//        PRINCE API HELPER & CONSTANTS
// ==========================================
const P_KEY = 'prince';
const P_BASE = 'https://api.princetechn.com/api';
/**
 * Helper to handle media downloads to reduce repetitive code
 */
const princeDownload = async (sock, from, url, path, type = 'video') => {
  try {
    await sock.sendMessage(from, { text: `📥 *Processing ${type}...* Please wait.` });
    const res = await fetch(`${P_BASE}/download/${path}?apikey=${P_KEY}&url=${encodeURIComponent(url)}`);
    const data = await res.json();
    const link = data.result?.url || data.result?.download_url || data.url || data.result;

    if (!link) return sock.sendMessage(from, { text: "❌ Failed to fetch download link." });

    if (type === 'video') {
      await sock.sendMessage(from, { video: { url: link }, caption: `✅ *${BOT_NAME} Download Success*`, mimetype: 'video/mp4' });
    } else {
      await sock.sendMessage(from, { audio: { url: link }, mimetype: 'audio/mpeg', fileName: 'audio.mp3' });
    }
  } catch (e) {
    sock.sendMessage(from, { text: "⚠️ Download Error: " + e.message });
  }
};


const BOT_NAME = 'INCONNU XD V2';
const DEV_NAME = 'INCONNU BOY SENSEI';
// Fallback shown in help text before a session sets its own prefix with .setprefix.
const PREFIX = DEFAULT_PREFIX;
const START_TIME = Date.now();

// Per-session bot name/image (".setbotname" / ".setbotimg") — each linked
// account can rebrand its own instance without touching the shared BOT_NAME/
// MENU_IMAGE_URL constants, which stay as the fallback until a session sets
// its own.
function getBotName(sessionId) {
  return (sessionId && getGlobalSetting(sessionId, 'botName')) || BOT_NAME;
}
function getBotImage(sessionId) {
  return (sessionId && getGlobalSetting(sessionId, 'botImage')) || MENU_IMAGE_URL;
}

// Category display order + icons for the menu.
const CATEGORY_STYLE = {
  MAIN: '🏠',
  INFO: 'ℹ️',
  TOOLS: '🛠️',
  AI: '🤖',
  DOWNLOADER: '📥',
  'GROUP-ADMIN': '👥',
  'GROUP-SECURITY': '🛡️',
  NSFW: '🔞',
  OWNER: '👑'
};

const CATEGORY_ORDER = [
  'MAIN', 
  'AI', 
  'DOWNLOADER', 
  'INFO', 
  'TOOLS', 
  'GROUP-ADMIN', 
  'GROUP-SECURITY', 
  'NSFW', 
  'OWNER'
];

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up? 🌙';
  if (h < 12) return 'Good morning ☀️';
  if (h < 18) return 'Good afternoon 🌤️';
  return 'Good evening 🌆';
}

/**
 * Each command: { name, aliases, category, description, execute(ctx) }
 * ctx = { sock, msg, from, sender, args, text, isGroup, sessionId, quoted }
 */
// ---- Upload helpers (used by the .upload command) ----
async function uploadToCatbox(buffer, filename) {
  const form = new FormData();
  form.append('file', buffer, { filename });
  form.append('reqtype', 'fileupload');

  const response = await axios.post('https://catbox.moe/user/api.php', form, {
    headers: { ...form.getHeaders() },
    timeout: 60000
  });

  const url = String(response.data).trim();
  if (!url.startsWith('https://')) throw new Error('Invalid response from Catbox');
  return url;
}

async function uploadTo0x0(buffer, filename) {
  const form = new FormData();
  form.append('file', buffer, { filename });

  const response = await axios.post('https://0x0.st', form, {
    headers: { ...form.getHeaders(), 'User-Agent': 'Mozilla/5.0' },
    timeout: 60000
  });

  const url = String(response.data).trim();
  if (!url.startsWith('http')) throw new Error('Invalid response from 0x0.st');
  return url;
}

// ---- NexOracle fallback (used by tiktok/instagram/facebook when the primary API fails) ----
async function fetchNexoracleFallback(endpoint, url) {
  const apiUrl = `https://api.nexoracle.com/downloader/${endpoint}?url=${encodeURIComponent(url)}${NEXORACLE_API_KEY ? `&apikey=${NEXORACLE_API_KEY}` : ''}`;
  const res = await axios.get(apiUrl, { timeout: 30000 });
  if (!res.data || res.data.status >= 400) throw new Error(`NexOracle returned ${res.data?.status || 'an error'}`);
  return res.data;
}

const commands = new Map();

function register(cmd) {
  commands.set(cmd.name, cmd);
  (cmd.aliases || []).forEach((a) => commands.set(a, cmd));
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

// Builds the contextInfo that makes a message display as "Forwarded many
// times" from the bot's channel — the little forwarded tag WhatsApp shows
// above a message, linking back to CHANNEL_NAME. Returns {} (no tag) if no
// channel is configured, so callers can always spread this in safely.
function channelContext() {
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

// MENU_IMAGE_URL may be either an http(s) URL or a local filesystem path.
// sessionId is optional — pass it to honor a per-session ".setbotimg", falls
// back to the shared MENU_IMAGE_URL constant when omitted or unset.
async function getMenuImage(sessionId) {
  const imgSrc = getBotImage(sessionId);
  if (!imgSrc) return null;
  if (/^https?:\/\//i.test(imgSrc)) return { url: imgSrc };
  try {
    if (fs.existsSync(imgSrc)) return await fs.promises.readFile(imgSrc);
  } catch (e) {
    console.error('Menu image read failed:', e.message);
  }
  return null;
}
// ==========================================
//          MEDIA CONVERSION COMMANDS
// ==========================================

// Helper function to get the owner JID for THIS session.
// Each session belongs to whoever paired their own WhatsApp number to it, so the
// owner is always that linked account itself — never a number baked into the code.
// OWNER_NUMBER is only used as a last-resort fallback if the socket isn't ready yet.
function getOwnerJid(sock) {
  const linkedId = sock?.user?.id;
  if (linkedId) {
    // Baileys ids can come as "1234567890:12@s.whatsapp.net" — strip the device suffix.
    const bare = linkedId.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    return `${bare}@s.whatsapp.net`;
  }
  const owner = process.env.OWNER_NUMBER || '';
  return owner ? `${owner.replace(/[^0-9]/g, '')}@s.whatsapp.net` : null;
}

// ==========================================
//          AUTO-BIO ON DEPLOY
// ==========================================

// Auto-bio function to run when the bot starts
async function setAutoBio(sock) {
  try {
    const now = new Date();
    const date = now.toLocaleDateString('en-US', { 
      weekday: 'long', 
      day: 'numeric', 
      month: 'long', 
      year: 'numeric' 
    });
    const time = now.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });
    
    // Get uptime
    const uptime = formatUptime(Date.now() - START_TIME);
    
    // Get RAM usage
    const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    
    // Get total commands count
    const totalCommands = new Set(commands.values()).size;
    
    // Build the bio message
    const bio = [
      `🤖 ${BOT_NAME} | Online ✅`,
      `📅 ${date}`,
      `⏱️ ${time}`,
      `⚡ ${uptime}`,
      `📦 ${totalCommands} commands`,
      `💾 ${mem}MB RAM`
    ].join(' • ');
    
    // Update the profile status (bio)
    await sock.updateProfileStatus(bio);
    
    console.log(`✅ Auto-bio set: ${bio}`);
    // Note: the "Bot Deployed Successfully" WhatsApp notification to the owner
    // was intentionally removed — the bio update above still happens silently.
  } catch (error) {
    console.error('Auto-bio error:', error);
  }
}



// deepai-llama.js - DeepAI Llama 3.1 8B Instant via David Cyril API
register({
  name: 'llama',
  aliases: ['llama3', 'llama31', 'llama8b', 'deepai-llama', 'meta-ai'],
  category: 'AI',
  description: 'Chat with Meta Llama 3.1 8B Instant model',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🦙 *Llama 3.1 8B Instant*\n\nUsage: ${prefix}${command} <your question>\nExample: ${prefix}${command} What is the meaning of life?\n\n*Aliases:* ${prefix}llama3, ${prefix}llama31, ${prefix}llama8b, ${prefix}deepai-llama` 
      });
    }

    const query = args.join(' ');
    await sock.sendMessage(from, { text: `🦙 Thinking with Llama 3.1 8B...` });

    try {
      // ─── API ENDPOINT ───
      const apiUrl = 'https://apis.davidcyril.name.ng/ai/deepai-llama-3.1-8b-instant';
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          query: query,
          // Optional parameters
          // temperature: 0.7,
          // max_tokens: 4096,
          // top_p: 0.9,
          // top_k: 50
        }),
        signal: AbortSignal.timeout(60000) // 60s timeout
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      // ─── EXTRACT RESPONSE ───
      let answer = '';
      let sources = [];
      let usage = '';
      let model = 'Llama 3.1 8B Instant';
      let finishReason = '';

      // Try different response structures
      if (data.result) {
        answer = data.result.response || data.result.answer || data.result.text || data.result.message || data.result.content || data.result.generated_text || data.result.output || data.result;
        sources = data.result.sources || data.result.references || [];
        usage = data.result.usage || data.result.token_usage || '';
        finishReason = data.result.finish_reason || data.result.stop_reason || '';
        model = data.result.model || data.result.model_name || 'Llama 3.1 8B Instant';
      } else if (data.response) {
        answer = data.response.answer || data.response.text || data.response.message || data.response.content || data.response.generated_text || data.response.output || data.response;
        sources = data.response.sources || [];
        usage = data.response.usage || '';
        finishReason = data.response.finish_reason || '';
        model = data.response.model || 'Llama 3.1 8B Instant';
      } else if (data.answer) {
        answer = data.answer;
      } else if (data.text) {
        answer = data.text;
      } else if (data.message) {
        answer = data.message;
      } else if (data.content) {
        answer = data.content;
      } else if (data.generated_text) {
        answer = data.generated_text;
      } else if (data.output) {
        answer = data.output;
      } else if (data.choices && data.choices[0]) {
        answer = data.choices[0].text || data.choices[0].message || data.choices[0].content || data.choices[0];
        finishReason = data.choices[0].finish_reason || '';
      } else if (data.generations && data.generations[0]) {
        answer = data.generations[0].text || data.generations[0].content || data.generations[0].message || data.generations[0];
      } else if (typeof data === 'string') {
        answer = data;
      } else {
        // Fallback: convert to string
        answer = JSON.stringify(data, null, 2);
      }

      // Clean up answer if it's an object
      if (typeof answer === 'object') {
        answer = JSON.stringify(answer, null, 2);
      }

      if (!answer || answer.length < 2) {
        throw new Error('Empty response from Llama API.');
      }

      // ─── FORMAT RESPONSE ───
      let reply = `🦙 *${model}*\n\n${answer}`;

      if (finishReason) {
        reply += `\n\n🏁 *Finish Reason:* ${finishReason}`;
      }

      if (usage) {
        if (typeof usage === 'object') {
          const tokens = usage.total_tokens || usage.total || (usage.prompt_tokens + usage.completion_tokens) || '';
          reply += `\n\n📊 *Tokens:* ${tokens}`;
        } else {
          reply += `\n\n📊 *Usage:* ${usage}`;
        }
      }

      if (sources && sources.length > 0) {
        reply += `\n\n📚 *Sources:*\n`;
        sources.slice(0, 5).forEach((src, i) => {
          reply += `${i + 1}. ${src.title || src.name || 'Link'}: ${src.url || src.link || 'N/A'}\n`;
        });
      }

      // ─── SEND REPLY ───
      if (reply.length > 4096) {
        const chunks = reply.match(/.{1,4000}/g) || [reply];
        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(from, { 
            text: i === 0 ? chunks[i] : `*(continued)*\n\n${chunks[i]}`
          });
        }
      } else {
        await sock.sendMessage(from, { text: reply });
      }

      console.log(`✅ Llama 3.1 response sent for: "${query}"`);

    } catch (error) {
      console.error('Llama 3.1 error:', error);

      // ─── FALLBACK: Try GET method ───
      try {
        const fallbackUrl = `https://apis.davidcyril.name.ng/ai/deepai-llama-3.1-8b-instant?q=${encodeURIComponent(query)}`;
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(30000)
        });

        if (fallbackRes.ok) {
          let fallbackData = await fallbackRes.text();
          try {
            const jsonData = JSON.parse(fallbackData);
            fallbackData = jsonData.result || jsonData.response || jsonData.answer || jsonData.message || jsonData.text || jsonData.content || jsonData.generated_text || jsonData.output || fallbackData;
            if (typeof fallbackData === 'object') {
              fallbackData = JSON.stringify(fallbackData, null, 2);
            }
          } catch (e) {}

          if (fallbackData && fallbackData.length > 2) {
            return await sock.sendMessage(from, { 
              text: `🦙 *Llama 3.1 (Fallback)*\n\n${fallbackData.slice(0, 4000)}` 
            });
          }
        }
      } catch (fallbackErr) {}

      // ─── ULTIMATE FALLBACK: Try alternative endpoint ───
      try {
        const altUrl = `https://apis.davidcyril.name.ng/ai/deepai-llama-3.1-8b-instant/chat`;
        const altRes = await fetch(altUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            message: query,
            prompt: query
          }),
          signal: AbortSignal.timeout(30000)
        });

        if (altRes.ok) {
          const altData = await altRes.json();
          const altAnswer = altData.result || altData.response || altData.answer || altData.message || altData.text || altData.content || JSON.stringify(altData);
          if (altAnswer && altAnswer.length > 2) {
            return await sock.sendMessage(from, { 
              text: `🦙 *Llama 3.1 (Alt)*\n\n${altAnswer.slice(0, 4000)}` 
            });
          }
        }
      } catch (altErr) {}

      await sock.sendMessage(from, { 
        text: `❌ *Llama 3.1 Error*\n\n${error.message || 'Failed to get response.'}\n\n💡 Tips:\n• Try a shorter question\n• Try again later\n• Use ${prefix}bb for Blackbox AI\n• Use ${prefix}gemini for Gemini 3 Pro\n• Use ${prefix}deepai for DeepAI Standard` 
      });
    }
  }
});

// deepai-models.js - List all DeepAI Models
register({
  name: 'deepaimodels',
  aliases: ['dmodels', 'daimodels', 'deepai-models', 'listai'],
  category: 'AI',
  description: 'List all available DeepAI models from David Cyril API',
  async execute({ sock, from, msg, args, prefix, command }) {
    await sock.sendMessage(from, { text: `📡 Fetching available DeepAI models...` });

    try {
      // ─── API ENDPOINT ───
      const apiUrl = 'https://apis.davidcyril.name.ng/ai/deepai-models';
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(15000) // 15s timeout
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      // ─── EXTRACT MODELS ───
      let models = [];
      let rawData = data;

      // Try different response structures
      if (data.result) {
        models = data.result.models || data.result.model_list || data.result.data || data.result;
        if (!Array.isArray(models) && typeof models === 'object') {
          models = Object.keys(models).map(key => ({ name: key, ...models[key] }));
        }
        rawData = data.result;
      } else if (data.models) {
        models = data.models;
      } else if (data.data) {
        models = data.data;
      } else if (data.list) {
        models = data.list;
      } else if (Array.isArray(data)) {
        models = data;
      } else if (typeof data === 'object') {
        // Try to extract model names from object keys
        models = Object.keys(data).filter(key => 
          key.toLowerCase().includes('model') || 
          key.toLowerCase().includes('llama') ||
          key.toLowerCase().includes('gemini') ||
          key.toLowerCase().includes('gpt') ||
          key.toLowerCase().includes('deepai') ||
          key.toLowerCase().includes('claude') ||
          key.toLowerCase().includes('mistral') ||
          key.toLowerCase().includes('falcon') ||
          key.toLowerCase().includes('bert')
        ).map(key => ({ name: key, ...data[key] }));
        
        if (models.length === 0) {
          models = Object.keys(data).map(key => ({ name: key, value: data[key] }));
        }
      }

      // Ensure models is an array
      if (!Array.isArray(models)) {
        if (typeof models === 'object') {
          models = Object.values(models);
        } else {
          models = [models];
        }
      }

      if (models.length === 0) {
        // Display raw data if no models extracted
        const jsonStr = JSON.stringify(data, null, 2);
        if (jsonStr.length < 4000) {
          return await sock.sendMessage(from, { 
            text: `📡 *DeepAI Models (Raw)*\n\n\`\`\`json\n${jsonStr}\n\`\`\`` 
          });
        } else {
          return await sock.sendMessage(from, { 
            text: `📡 *DeepAI Models*\n\nNo models found. Raw data length: ${jsonStr.length} characters.\n\nUse ${prefix}testmodels to see raw response.` 
          });
        }
      }

      // ─── FORMAT RESPONSE ───
      let reply = `🧠 *DeepAI Available Models*\n📡 Source: David Cyril API\n\n`;
      reply += `📊 *Total Models:* ${models.length}\n\n`;

      // Categorize models
      const categories = {
        'Llama': [],
        'Gemini': [],
        'GPT': [],
        'DeepAI': [],
        'Claude': [],
        'Mistral': [],
        'Falcon': [],
        'Bert': [],
        'Other': []
      };

      models.forEach(model => {
        const name = (model.name || model.id || model.model || model.title || model.label || JSON.stringify(model)).toLowerCase();
        let categorized = false;
        for (const [cat, keywords] of Object.entries({
          'Llama': ['llama', 'meta'],
          'Gemini': ['gemini', 'google'],
          'GPT': ['gpt', 'openai', 'chatgpt'],
          'DeepAI': ['deepai', 'deep ai'],
          'Claude': ['claude', 'anthropic'],
          'Mistral': ['mistral'],
          'Falcon': ['falcon'],
          'Bert': ['bert', 'bert-base']
        })) {
          if (keywords.some(k => name.includes(k))) {
            categories[cat].push(model);
            categorized = true;
            break;
          }
        }
        if (!categorized) {
          categories['Other'].push(model);
        }
      });

      // Build model list by category
      let hasModels = false;
      for (const [cat, catModels] of Object.entries(categories)) {
        if (catModels.length > 0) {
          hasModels = true;
          reply += `🔹 *${cat}* (${catModels.length})\n`;
          catModels.slice(0, 10).forEach((m, i) => {
            const name = m.name || m.id || m.model || m.title || m.label || `Model ${i+1}`;
            const version = m.version || m.variant || m.type || '';
            const status = m.status || m.available || m.active || '';
            reply += `   • ${name}${version ? ` v${version}` : ''}${status ? ` [${status}]` : ''}\n`;
          });
          if (catModels.length > 10) {
            reply += `   ... and ${catModels.length - 10} more\n`;
          }
          reply += '\n';
        }
      }

      if (!hasModels) {
        // Show raw model names
        models.slice(0, 20).forEach((m, i) => {
          const name = m.name || m.id || m.model || m.title || m.label || JSON.stringify(m);
          reply += `   ${i+1}. ${name}\n`;
        });
        if (models.length > 20) {
          reply += `\n   ... and ${models.length - 20} more`;
        }
      }

      // ─── SEND REPLY ───
      if (reply.length > 4096) {
        const chunks = reply.match(/.{1,4000}/g) || [reply];
        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(from, { 
            text: i === 0 ? chunks[i] : `*(continued)*\n\n${chunks[i]}`
          });
        }
      } else {
        await sock.sendMessage(from, { text: reply });
      }

      console.log(`✅ DeepAI models list sent (${models.length} models)`);

    } catch (error) {
      console.error('DeepAI Models error:', error);

      // ─── FALLBACK: Try alternative endpoint ───
      try {
        const altUrl = 'https://apis.davidcyril.name.ng/ai/deepai-models/list';
        const altRes = await fetch(altUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (altRes.ok) {
          const altData = await altRes.json();
          const jsonStr = JSON.stringify(altData, null, 2);
          if (jsonStr.length < 4000) {
            return await sock.sendMessage(from, { 
              text: `📡 *DeepAI Models (Alt)*\n\n\`\`\`json\n${jsonStr}\n\`\`\`` 
            });
          }
        }
      } catch (fallbackErr) {}

      await sock.sendMessage(from, { 
        text: `❌ *DeepAI Models Error*\n\n${error.message || 'Failed to fetch models.'}\n\n💡 Use ${prefix}testmodels to see raw API response.` 
      });
    }
  }
});


// Auto-bio command - manual trigger for updating bio
register({
  name: 'autobio',
  aliases: ['setbio', 'updatebio', 'bio'],
  category: 'MAIN',
  description: 'Set or update the bot\'s profile bio/status',
  async execute({ sock, from, args, prefix, command, isOwner }) {
    // Owner only command
    if (!isOwner) {
      return await sock.sendMessage(from, { 
        text: `❌ *Owner only command.*\n\nOnly the bot owner can update the bio.` 
      });
    }

    // Check if user provided custom bio
    if (args[0]) {
      const customBio = args.join(' ');
      
      try {
        await sock.updateProfileStatus(customBio);
        await sock.sendMessage(from, { 
          text: `✅ *Bio Updated*\n\n📝 ${customBio}` 
        });
        return;
      } catch (error) {
        await sock.sendMessage(from, { 
          text: `⚠️ Error updating bio: ${error.message}` 
        });
        return;
      }
    }

    // Auto-generate bio
    await sock.sendMessage(from, { text: `⏳ Generating and updating bio...` });

    try {
      const now = new Date();
      const date = now.toLocaleDateString('en-US', { 
        weekday: 'long', 
        day: 'numeric', 
        month: 'long', 
        year: 'numeric' 
      });
      const time = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      });
      
      const uptime = formatUptime(Date.now() - START_TIME);
      const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
      const totalCommands = new Set(commands.values()).size;
      
      const bio = [
        `🤖 ${BOT_NAME} | Online ✅`,
        `📅 ${date}`,
        `⏱️ ${time}`,
        `⚡ ${uptime}`,
        `📦 ${totalCommands} commands`,
        `💾 ${mem}MB RAM`
      ].join(' • ');
      
      await sock.updateProfileStatus(bio);
      
      await sock.sendMessage(from, { 
        text: `✅ *Bio Updated*\n\n📝 ${bio}` 
      });
      
    } catch (error) {
      console.error('Auto-bio command error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error updating bio: ${error.message || 'Unknown error'}` 
      });
    }
  }
});


// -------------------- TO IMAGE --------------------
// ==========================================
//          TO GIF - Convert Sticker/Video to GIF
// ==========================================
register({
  name: 'togif',
  aliases: ['gif', 'togifconvert', 'makegif'],
  category: 'TOOLS',
  description: 'Convert sticker/video to GIF and send',
  async execute({ sock, from, msg, args, prefix, command }) {
    // ─── FIX: Extract quoted message from contextInfo ───
    let quoted = null;
    
    if (msg?.quoted) {
      quoted = msg.quoted;
    }
    
    if (!quoted && msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
      const contextInfo = msg.message.extendedTextMessage.contextInfo;
      quoted = {
        message: contextInfo.quotedMessage,
        key: {
          id: contextInfo.stanzaId,
          fromMe: false,
          remoteJid: from,
          participant: contextInfo.participant || from
        }
      };
    }

    if (!quoted && msg?.message?.videoMessage) {
      quoted = { message: msg.message };
    }
    if (!quoted && msg?.message?.stickerMessage) {
      quoted = { message: msg.message };
    }

    if (!quoted || !quoted.message) {
      return await sock.sendMessage(from, { 
        text: `🎬 Reply to a video or sticker with: ${prefix || '.'}togif` 
      });
    }

    // ─── Check media type ───
    const isVideo = !!quoted.message.videoMessage;
    const isSticker = !!quoted.message.stickerMessage || 
                      quoted.message.imageMessage?.mimetype?.includes('webp') ||
                      quoted.mimetype?.includes('webp');

    if (!isVideo && !isSticker) {
      return await sock.sendMessage(from, { 
        text: `🎬 Reply to a *video* or *sticker* with: ${prefix || '.'}togif` 
      });
    }

    await sock.sendMessage(from, { text: '⏳ Converting to GIF...' });

    try {
      const { downloadMediaMessage } = require('@whiskeysockets/baileys');
      
      let mediaBuffer = null;
      
      try {
        mediaBuffer = await downloadMediaMessage(
          quoted,
          'buffer',
          {},
          { reuploadRequest: sock.updateMediaMessage }
        );
      } catch (dlErr) {
        try {
          mediaBuffer = await downloadMediaMessage(
            { key: quoted.key, message: quoted.message },
            'buffer',
            {},
            { reuploadRequest: sock.updateMediaMessage }
          );
        } catch (dlErr2) {
          mediaBuffer = await sock.downloadMediaMessage(quoted);
        }
      }

      if (!mediaBuffer || mediaBuffer.length < 100) {
        return await sock.sendMessage(from, { text: '❌ Failed to download media.' });
      }

      let finalBuffer = mediaBuffer;

      // ─── If sticker, convert to video ───
      if (isSticker) {
        try {
          const ffmpeg = require('ffmpeg-static');
          const { exec } = require('child_process');
          const fs = require('fs');
          const path = require('path');

          const tmpDir = path.join(process.cwd(), 'tmp');
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

          const inputPath = path.join(tmpDir, `sticker_${Date.now()}.webp`);
          const outputPath = path.join(tmpDir, `gif_${Date.now()}.mp4`);

          fs.writeFileSync(inputPath, mediaBuffer);
          await new Promise((resolve, reject) => {
            exec(`"${ffmpeg}" -i "${inputPath}" -vf "fps=15,scale=512:512:force_original_aspect_ratio=decrease" -c:v libx264 -pix_fmt yuv420p "${outputPath}"`, (error) => {
              if (error) reject(error);
              else resolve();
            });
          });

          finalBuffer = fs.readFileSync(outputPath);
          try { fs.unlinkSync(inputPath); } catch {}
          try { fs.unlinkSync(outputPath); } catch {}
        } catch (convErr) {
          return await sock.sendMessage(from, { text: '❌ Failed to convert sticker.' });
        }
      }

      if (!finalBuffer || finalBuffer.length < 100) {
        return await sock.sendMessage(from, { text: '❌ Failed to convert to GIF.' });
      }

      await sock.sendMessage(from, {
        video: finalBuffer,
        gifPlayback: true,
        caption: `🎬 *GIF Created*\n📦 Size: ${(finalBuffer.length / 1024).toFixed(1)} KB`
      });

    } catch (error) {
      console.error('To GIF error:', error);
      await sock.sendMessage(from, { text: `⚠️ Error: ${error.message || 'Could not convert to GIF.'}` });
    }
  }
});
// -------------------- UPLOAD --------------------
register({
  name: 'upload',
  aliases: ['tourl', 'url'],
  category: 'TOOLS',
  description: 'Upload replied/attached media and get a shareable URL',
  async execute({ sock, from, msg, prefix }) {
    let quoted = null;

    if (msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
      const contextInfo = msg.message.extendedTextMessage.contextInfo;
      quoted = {
        message: contextInfo.quotedMessage,
        key: {
          id: contextInfo.stanzaId,
          fromMe: false,
          remoteJid: from,
          participant: contextInfo.participant || from
        }
      };
    }
    if (!quoted && msg?.message) {
      const hasDirectMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']
        .some((k) => msg.message[k]);
      if (hasDirectMedia) quoted = { message: msg.message, key: msg.key };
    }

    if (!quoted || !quoted.message) {
      return sock.sendMessage(from, {
        text: `📤 Send or reply to media (image/video/audio/document/sticker) with: ${prefix || '.'}upload`
      });
    }

    await sock.sendMessage(from, { react: { text: '📤', key: msg.key } });

    try {
      const { downloadMediaMessage } = require('@whiskeysockets/baileys');

      let mediaBuffer = null;
      try {
        mediaBuffer = await downloadMediaMessage(quoted, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
      } catch (dlErr) {
        mediaBuffer = await sock.downloadMediaMessage(quoted);
      }

      if (!mediaBuffer || mediaBuffer.length < 1) {
        await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
        return sock.sendMessage(from, { text: '❌ Failed to download media.' });
      }

      const path = require('path');
      const mtype = Object.keys(quoted.message).find((k) => k.endsWith('Message')) || '';
      const rawFileName = quoted.message.documentMessage?.fileName;
      const ext = rawFileName ? (path.extname(rawFileName) || '.bin')
        : mtype.startsWith('image') ? '.jpg'
        : mtype.startsWith('video') ? '.mp4'
        : mtype.startsWith('audio') ? '.mp3'
        : mtype.startsWith('sticker') ? '.webp'
        : '.bin';

      const fileName = `upload_${Date.now()}${ext}`;
      let url, source;

      try {
        url = await uploadToCatbox(mediaBuffer, fileName);
        source = 'Catbox';
      } catch (err) {
        console.log('Catbox failed, trying 0x0.st:', err.message);
        url = await uploadTo0x0(mediaBuffer, fileName);
        source = '0x0.st';
      }

      await sock.sendMessage(from, { text: `✅ Uploaded via ${source}\n🔗 ${url}` });
      await sock.sendMessage(from, { react: { text: null, key: msg.key } });

    } catch (error) {
      console.error('Upload command error:', error?.message || error);
      await sock.sendMessage(from, { react: { text: '❌', key: msg.key } }).catch(() => {});
      await sock.sendMessage(from, { text: '❌ Failed to upload media.' });
    }
  }
});
// -------------------- VIEWONCE --------------------
register({
  name: 'viewonce',
  aliases: ['vo', 'once', 'viewonceimg', 'vv', 'vv2'],
  category: 'TOOLS',
  description: 'Download view-once media and send to owner',
  async execute({ sock, from, msg, quoted, prefix, command }) {
    const target = quoted || msg;
    const cmdPrefix = prefix || PREFIX;
    const cmdName = command || 'viewonce';

    const msgKeys = Object.keys(target.message || {});
    // Two shapes exist in the wild: an explicit wrapper (viewOnceMessage /
    // viewOnceMessageV2 / viewOnceMessageV2Extension), or — far more common on
    // recent WhatsApp clients — no wrapper at all, just a plain imageMessage/
    // videoMessage/audioMessage with a `viewOnce: true` flag set directly on it.
    // The old check only looked for the wrapper, so it missed that second case.
    const wrapped = msgKeys.some(k => k.toLowerCase().includes('viewonce'));
    const unwrapped = ['imageMessage', 'videoMessage', 'audioMessage'].some(
      (t) => target.message?.[t]?.viewOnce
    );
    const isViewOnce = wrapped || unwrapped;

    if (!isViewOnce) {
      return await sock.sendMessage(from, { 
        text: `❌ Reply to a view-once message with: ${cmdPrefix}${cmdName}\n\n*Note:* You must reply to a view-once image or video.` 
      });
    }

    try {
      let mediaMessage = target.message;
      
      if (mediaMessage.viewOnceMessageV2) {
        mediaMessage = mediaMessage.viewOnceMessageV2.message;
      } else if (mediaMessage.viewOnceMessageV2Extension) {
        mediaMessage = mediaMessage.viewOnceMessageV2Extension.message;
      } else if (mediaMessage.viewOnceMessage) {
        mediaMessage = mediaMessage.viewOnceMessage.message;
      }

      const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'];
      let mediaType = null;
      let mediaData = null;

      for (const type of mediaTypes) {
        if (mediaMessage[type]) {
          mediaType = type;
          mediaData = mediaMessage[type];
          break;
        }
      }

      if (!mediaData) {
        return await sock.sendMessage(from, { text: `❌ Could not extract media from view-once message.` });
      }

      // `downloadMediaMessage` is a standalone helper exported by Baileys — it is
      // NOT a method on the socket. Calling sock.downloadMediaMessage(...) throws
      // "not a function" every time, which is why this command was failing.
      const mediaBuffer = await downloadMediaMessage(
        { key: target.key, message: mediaMessage },
        'buffer',
        {},
        { reuploadRequest: sock.updateMediaMessage }
      );
      if (!mediaBuffer || mediaBuffer.length < 100) {
        return await sock.sendMessage(from, { text: `❌ Failed to download view-once media.` });
      }

      const ownerJid = getOwnerJid(sock);
      const fileSize = (mediaBuffer.length / 1024 / 1024).toFixed(2);
      const mediaTypeName = mediaType.replace('Message', '').toLowerCase();

      let caption = `👁️ *View-Once Media Saved*\n`;
      caption += `📱 *Type:* ${mediaTypeName}\n`;
      caption += `📦 *Size:* ${fileSize} MB\n`;
      caption += `📅 *Date:* ${new Date().toLocaleString()}\n`;
      caption += `👤 *From:* ${from.split('@')[0]}`;

      if (mediaType === 'imageMessage') {
        await sock.sendMessage(ownerJid, {
          image: mediaBuffer,
          caption: caption
        });
      } else if (mediaType === 'videoMessage') {
        await sock.sendMessage(ownerJid, {
          video: mediaBuffer,
          mimetype: 'video/mp4',
          caption: caption
        });
      } else if (mediaType === 'audioMessage') {
        await sock.sendMessage(ownerJid, {
          audio: mediaBuffer,
          mimetype: 'audio/mpeg',
          fileName: `viewonce_audio_${Date.now()}.mp3`,
          caption: caption
        });
      } else {
        await sock.sendMessage(ownerJid, {
          document: mediaBuffer,
          fileName: `viewonce_${Date.now()}`,
          caption: caption
        });
      }

      // No visible confirmation text in the chat — just react ✅ on the command
      // message so it's silent to anyone else watching that chat.
      await sock.sendMessage(from, {
        react: { text: '✅', key: msg.key }
      });

    } catch (error) {
      console.error('ViewOnce error:', error);
      await sock.sendMessage(from, { text: `⚠️ Error: ${error.message || 'Could not process view-once media.'}` });
    }
  }
});
// ---------- MAIN ----------

// Every "style" now renders the same single V2 box design — the style
// parameter is kept only so existing callers (setmenustyle, sendRichMenu)
// don't need to change.
const MENU_STYLES = ['classic', 'compact', 'minimal', 'neon', 'elegant'];

function buildMenu(style, { commandPrefix, name, isGroup, sessionId }) {
  const os = require('os');
  const byCategory = {};
  for (const cmd of new Set(commands.values())) {
    byCategory[cmd.category] = byCategory[cmd.category] || [];
    if (!byCategory[cmd.category].includes(cmd.name)) byCategory[cmd.category].push(cmd.name);
  }

  const totalCommands = new Set(commands.values()).size;
  const uptime = formatUptime(Date.now() - START_TIME);
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const usedGB = ((os.totalmem() - os.freemem()) / 1073741824).toFixed(2);
  const totGB = (os.totalmem() / 1073741824).toFixed(2);
  const ram = `${usedGB} / ${totGB} GB`;

  const orderedCats = [
    ...CATEGORY_ORDER.filter((c) => byCategory[c]),
    ...Object.keys(byCategory).filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  let menu = `╭───────────────⭓\n`;
  menu += `│ 👤 User : ${name}\n`;
  menu += `│ ⏱ Runtime : ${uptime}\n`;
  menu += `│ 🕒 Time : ${time}\n`;
  menu += `│ 💾 RAM : ${ram}\n`;
  menu += `│ ⚙️ Prefix : [ ${commandPrefix} ]\n`;
  menu += `│ 📦 Commands : ${totalCommands}\n`;
  menu += `│ 🌐 Mode : ${isGroup ? 'Group' : 'Private'}\n`;
  menu += `╰───────────────⭓\n`;

  for (const cat of orderedCats) {
    const names = byCategory[cat];
    const icon = CATEGORY_STYLE[cat] || '📁';
    menu += `\n╭─${icon} ${cat}\n`;
    names.forEach((n) => {
      menu += `│ • ${n}\n`;
    });
    menu += `╰───────────────⭓\n`;
  }

  menu += `\n✨ *${getBotName(sessionId)}* ✨`;
  return menu;
}

register({
  name: 'menu',
  aliases: ['help', 'commands'],
  category: 'MAIN',
  description: 'Show the command menu',
  async execute({ sock, from, sender, isGroup, sessionId, prefix, msg }) {
    const commandPrefix = prefix || getGlobalSetting(sessionId, 'prefix') || PREFIX;
    const style = getGlobalSetting(sessionId, 'menuStyle') || DEFAULT_MENU_STYLE;
    const name = msg?.pushName || sender.split('@')[0];

    const menu = buildMenu(MENU_STYLES.includes(style) ? style : 'classic', {
      commandPrefix,
      name,
      isGroup,
      sessionId,
    });

    const menuImage = await getMenuImage(sessionId);
    if (menuImage) {
      await sock.sendMessage(from, { image: menuImage, caption: menu, ...channelContext() });
    } else {
      await sock.sendMessage(from, { text: menu, ...channelContext() });
    }
  },
});

// ==========================================
//     INTERACTIVE (BUTTON/LIST) RICH MENU
// ==========================================

// Splits the category list into two roughly equal groups so the rich menu
// mirrors a classic two-column layout (Menu1 / Menu2 list buttons), the
// same shape as the reference "Rich Menu" screenshot.
function buildRichMenuSections(commandPrefix) {
  const byCategory = {};
  for (const cmd of new Set(commands.values())) {
    byCategory[cmd.category] = byCategory[cmd.category] || [];
    if (!byCategory[cmd.category].includes(cmd.name)) byCategory[cmd.category].push(cmd.name);
  }

  const orderedCats = [
    ...CATEGORY_ORDER.filter((c) => byCategory[c]),
    ...Object.keys(byCategory).filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  // WhatsApp list sections cap out at 10 rows — split oversized categories
  // into numbered sub-sections instead of silently dropping commands.
  const toSections = (cat) => {
    const names = byCategory[cat];
    const icon = CATEGORY_STYLE[cat] || '📁';
    const chunks = [];
    for (let i = 0; i < names.length; i += 10) chunks.push(names.slice(i, i + 10));
    return chunks.map((chunk, idx) => ({
      title: `${icon} ${cat}${chunks.length > 1 ? ` (${idx + 1}/${chunks.length})` : ''}`,
      rows: chunk.map((n) => ({
        title: `${commandPrefix}${n}`,
        description: (commands.get(n) && commands.get(n).description) || '',
        id: `${commandPrefix}${n}`,
      })),
    }));
  };

  const mid = Math.ceil(orderedCats.length / 2);
  return {
    left: orderedCats.slice(0, mid).flatMap(toSections),
    right: orderedCats.slice(mid).flatMap(toSections),
  };
}

// Builds and relays a native-flow interactive message: header image, body
// text, two list buttons (categories as sections, commands as rows), and
// an optional CTA URL button linking to the bot's channel.
async function sendRichMenu({ sock, from, sessionId, prefix, name, isGroup }) {
  const commandPrefix = prefix || getGlobalSetting(sessionId, 'prefix') || PREFIX;
  const style = getGlobalSetting(sessionId, 'menuStyle') || DEFAULT_MENU_STYLE;
  const menu = buildMenu(MENU_STYLES.includes(style) ? style : 'classic', {
    commandPrefix,
    name,
    isGroup: Boolean(isGroup),
    sessionId,
  });

  // Rich/interactive buttons were intentionally removed from the main menu.
  // Keep this command as a backwards-compatible text/image menu only.
  const menuImage = await getMenuImage(sessionId);
  if (menuImage) {
    await sock.sendMessage(from, {
      image: menuImage,
      caption: menu,
      ...channelContext(),
    });
  } else {
    await sock.sendMessage(from, { text: menu, ...channelContext() });
  }
}


register({
  name: 'setprefix',
  category: 'MAIN',
  description: "Change this account's command prefix (owner only)",
  async execute({ sock, from, args, msg, sessionId, prefix, isOwner }) {
    if (!isOwner) {
      return sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
    }
    const current = prefix || getGlobalSetting(sessionId, 'prefix') || PREFIX;
    const newPrefix = args[0];
    if (!newPrefix) {
      return sock.sendMessage(from, {
        text: `⚙️ Current prefix: [ ${current} ]\nUsage: ${current}setprefix <new prefix>\nExample: ${current}setprefix !`,
      });
    }
    if (/\s/.test(newPrefix) || newPrefix.length > 5) {
      return sock.sendMessage(from, { text: '❌ Prefix can\'t contain spaces and must be 5 characters or fewer.' });
    }
    setGlobalSetting(sessionId, 'prefix', newPrefix);
    await sock.sendMessage(from, {
      text: `✅ Prefix changed to [ ${newPrefix} ]\nAll commands now start with *${newPrefix}* — e.g. ${newPrefix}menu`,
    });
  },
});

register({
  name: 'setmenustyle',
  aliases: ['menustyle'],
  category: 'MAIN',
  description: 'Change the .menu layout — classic, compact, or minimal (owner only)',
  async execute({ sock, from, args, msg, sessionId, prefix, isOwner }) {
    if (!isOwner) {
      return sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
    }
    const commandPrefix = prefix || getGlobalSetting(sessionId, 'prefix') || PREFIX;
    const current = getGlobalSetting(sessionId, 'menuStyle') || DEFAULT_MENU_STYLE;
    const style = (args[0] || '').toLowerCase();

    if (!style || !MENU_STYLES.includes(style)) {
      return sock.sendMessage(from, {
        text:
          `🎨 Current menu style: *${current}*\n` +
          `Usage: ${commandPrefix}setmenustyle <style>\n\n` +
          `*Styles:*\n` +
          `• classic — boxed, full stats header (default)\n` +
          `• compact — numbered list per category\n` +
          `• minimal — one comma-separated line per category`,
      });
    }

    setGlobalSetting(sessionId, 'menuStyle', style);
    await sock.sendMessage(from, { text: `✅ Menu style set to *${style}*. Run ${commandPrefix}menu to see it.` });
  },
});
// ==========================================
//               AI COMMANDS
// ==========================================

register({
  name: 'riddle',
  aliases: ['puzzle', 'brainteaser', 'enigma'],
  category: 'GAMES',
  description: 'Get a random riddle to solve',
  async execute({ sock, from, args, prefix, command }) {
    const arg = (args[0] || '').toLowerCase();

    // Check if user wants the answer
    if (arg === 'answer' || arg === 'ans' || arg === 'reveal') {
      // Check if there's an active riddle
      if (!global.activeRiddle || global.activeRiddle.from !== from) {
        return await sock.sendMessage(from, { 
          text: `❌ No active riddle found. Use ${prefix}${command} to get a new riddle first.` 
        });
      }

      const answer = global.activeRiddle.answer;
      await sock.sendMessage(from, { 
        text: `🧩 *Riddle Answer*\n\n💡 *Answer:* ${answer}\n\n🤫 Don't tell everyone!` 
      });
      return;
    }

    // Show usage if no arguments
    if (args[0] && arg !== 'answer' && arg !== 'ans' && arg !== 'reveal') {
      return await sock.sendMessage(from, { 
        text: `🧩 *Riddle Game*\n\nUsage: ${prefix}${command} - Get a random riddle\n${prefix}${command} answer - Reveal the answer to the current riddle\n\n*Examples:*\n${prefix}${command}\n${prefix}${command} answer` 
      });
    }

    await sock.sendMessage(from, { text: `🧩 Fetching a riddle...` });

    try {
      // Primary: David Cyril API - Riddle Game
      const response = await fetch(
        `https://apis.davidcyril.name.ng/games/riddle`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract riddle data
      let question = data.result?.question || data.question || data.riddle || data.text;
      let answer = data.result?.answer || data.answer || data.solution;
      let category = data.result?.category || data.category || 'General';
      let difficulty = data.result?.difficulty || data.difficulty || 'Medium';
      let hint = data.result?.hint || data.hint || null;

      if (!question) {
        throw new Error("Could not extract riddle from API response.");
      }

      // Store active riddle for answer retrieval
      global.activeRiddle = {
        from: from,
        question: question,
        answer: answer || 'Hidden',
        category: category,
        difficulty: difficulty,
        timestamp: Date.now()
      };

      // Build the riddle message
      let msg = `🧩 *Riddle Time!*\n\n`;
      msg += `📝 *${question}*\n\n`;
      msg += `📌 *Category:* ${category}\n`;
      msg += `📊 *Difficulty:* ${difficulty}\n\n`;
      msg += `🤔 *Think hard!*\n\n`;
      msg += `💡 Use ${prefix}${command} answer to reveal the answer.`;

      await sock.sendMessage(from, { text: msg });

    } catch (error) {
      console.error('Riddle error:', error);

      // Fallback: Try alternative riddle API
      try {
        const altUrl = 'https://apis.davidcyril.name.ng/games/riddle-v2';
        const altRes = await fetch(altUrl);
        const altData = await altRes.json();

        let altQuestion = altData.result?.question || altData.question || altData.riddle;
        let altAnswer = altData.result?.answer || altData.answer;

        if (altQuestion) {
          global.activeRiddle = {
            from: from,
            question: altQuestion,
            answer: altAnswer || 'Hidden',
            category: altData.result?.category || altData.category || 'General',
            difficulty: altData.result?.difficulty || altData.difficulty || 'Medium',
            timestamp: Date.now()
          };

          let msg = `🧩 *Riddle Time! (fallback)*\n\n`;
          msg += `📝 *${altQuestion}*\n\n`;
          msg += `📌 *Category:* ${altData.result?.category || altData.category || 'General'}\n`;
          msg += `📊 *Difficulty:* ${altData.result?.difficulty || altData.difficulty || 'Medium'}\n\n`;
          msg += `🤔 *Think hard!*\n\n`;
          msg += `💡 Use ${prefix}${command} answer to reveal the answer.`;

          return await sock.sendMessage(from, { text: msg });
        }
      } catch (altErr) {}

      // Fallback: Use a local riddle
      const localRiddles = [
        {
          question: "I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?",
          answer: "An echo",
          category: "Logic",
          difficulty: "Easy"
        },
        {
          question: "The more you take, the more you leave behind. What am I?",
          answer: "Footsteps",
          category: "Classic",
          difficulty: "Easy"
        },
        {
          question: "What has keys but no locks, space but no room, and you can enter but not go in?",
          answer: "A keyboard",
          category: "Technology",
          difficulty: "Medium"
        }
      ];

      const random = localRiddles[Math.floor(Math.random() * localRiddles.length)];
      global.activeRiddle = {
        from: from,
        question: random.question,
        answer: random.answer,
        category: random.category,
        difficulty: random.difficulty,
        timestamp: Date.now()
      };

      let msg = `🧩 *Riddle Time! (local)*\n\n`;
      msg += `📝 *${random.question}*\n\n`;
      msg += `📌 *Category:* ${random.category}\n`;
      msg += `📊 *Difficulty:* ${random.difficulty}\n\n`;
      msg += `🤔 *Think hard!*\n\n`;
      msg += `💡 Use ${prefix}${command} answer to reveal the answer.`;

      await sock.sendMessage(from, { text: msg });
    }
  }
});
register({
  name: 'animequiz',
  aliases: ['aq', 'animeq', 'otakuquiz'],
  category: 'GAMES',
  description: 'Test your anime knowledge with a quiz',
  async execute({ sock, from, args, prefix, command }) {
    const arg = (args[0] || '').toLowerCase();

    // Check if user wants the answer
    if (arg === 'answer' || arg === 'ans' || arg === 'reveal') {
      if (!global.activeAnimeQuiz || global.activeAnimeQuiz.from !== from) {
        return await sock.sendMessage(from, { 
          text: `❌ No active anime quiz found. Use ${prefix}${command} to get a new question first.` 
        });
      }

      const answer = global.activeAnimeQuiz.answer;
      await sock.sendMessage(from, { 
        text: `🎌 *Anime Quiz Answer*\n\n💡 *Answer:* ${answer}\n\n📚 *Category:* ${global.activeAnimeQuiz.category}\n\n🤫 Don't tell everyone!` 
      });
      return;
    }

    // Show usage if no arguments
    if (args[0] && arg !== 'answer' && arg !== 'ans' && arg !== 'reveal') {
      return await sock.sendMessage(from, { 
        text: `🎌 *Anime Quiz Game*\n\nUsage: ${prefix}${command} - Get a random anime quiz\n${prefix}${command} answer - Reveal the answer to the current question\n\n*Examples:*\n${prefix}${command}\n${prefix}${command} answer` 
      });
    }

    await sock.sendMessage(from, { text: `🎌 Generating anime quiz...` });

    try {
      // Primary: David Cyril API - Anime Quiz
      const response = await fetch(
        `https://apis.davidcyril.name.ng/games/anime-quiz`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract quiz data
      let question = data.result?.question || data.question || data.text;
      let options = data.result?.options || data.options || [];
      let answer = data.result?.answer || data.answer || data.correct;
      let category = data.result?.category || data.category || 'Anime';
      let difficulty = data.result?.difficulty || data.difficulty || 'Medium';
      let image = data.result?.image || data.image || null;

      if (!question || options.length === 0) {
        throw new Error("Could not extract quiz from API response.");
      }

      // Store active quiz for answer retrieval
      global.activeAnimeQuiz = {
        from: from,
        question: question,
        options: options,
        answer: answer,
        category: category,
        difficulty: difficulty,
        timestamp: Date.now()
      };

      // Build the quiz message
      let msg = `🎌 *Anime Quiz Time!*\n\n`;
      msg += `📝 *${question}*\n\n`;
      msg += `*Options:*\n`;
      options.forEach((opt, i) => {
        msg += `${String.fromCharCode(65 + i)}. ${opt}\n`;
      });
      msg += `\n📌 *Category:* ${category}\n`;
      msg += `📊 *Difficulty:* ${difficulty}\n\n`;
      msg += `🤔 *Think you know?* Choose your answer!\n\n`;
      msg += `💡 Use ${prefix}${command} answer to reveal the correct answer.`;

      // Send with image if available
      if (image && image.startsWith('http')) {
        try {
          await sock.sendMessage(from, {
            image: { url: image },
            caption: msg
          });
        } catch (imgErr) {
          await sock.sendMessage(from, { text: msg });
        }
      } else {
        await sock.sendMessage(from, { text: msg });
      }

    } catch (error) {
      console.error('Anime quiz error:', error);

      // Fallback: Try alternative anime quiz API
      try {
        const altUrl = 'https://apis.davidcyril.name.ng/games/anime-quiz-v2';
        const altRes = await fetch(altUrl);
        const altData = await altRes.json();

        let altQuestion = altData.result?.question || altData.question;
        let altOptions = altData.result?.options || altData.options || [];
        let altAnswer = altData.result?.answer || altData.answer;

        if (altQuestion && altOptions.length > 0) {
          global.activeAnimeQuiz = {
            from: from,
            question: altQuestion,
            options: altOptions,
            answer: altAnswer,
            category: altData.result?.category || altData.category || 'Anime',
            difficulty: altData.result?.difficulty || altData.difficulty || 'Medium',
            timestamp: Date.now()
          };

          let msg = `🎌 *Anime Quiz Time! (fallback)*\n\n`;
          msg += `📝 *${altQuestion}*\n\n`;
          msg += `*Options:*\n`;
          altOptions.forEach((opt, i) => {
            msg += `${String.fromCharCode(65 + i)}. ${opt}\n`;
          });
          msg += `\n📌 *Category:* ${altData.result?.category || altData.category || 'Anime'}\n`;
          msg += `📊 *Difficulty:* ${altData.result?.difficulty || altData.difficulty || 'Medium'}\n\n`;
          msg += `💡 Use ${prefix}${command} answer to reveal the correct answer.`;

          return await sock.sendMessage(from, { text: msg });
        }
      } catch (altErr) {}

      // Fallback: Local anime quiz
      const localQuizzes = [
        {
          question: "Which anime features a character named Goku?",
          options: ["Naruto", "Dragon Ball", "One Piece", "Bleach"],
          answer: "Dragon Ball",
          category: "Shonen",
          difficulty: "Easy"
        },
        {
          question: "What is the name of Naruto's signature attack?",
          options: ["Kamehameha", "Gomu Gomu", "Rasengan", "Bankai"],
          answer: "Rasengan",
          category: "Shonen",
          difficulty: "Easy"
        },
        {
          question: "Which anime is about pirates searching for treasure?",
          options: ["Naruto", "One Piece", "Attack on Titan", "Death Note"],
          answer: "One Piece",
          category: "Adventure",
          difficulty: "Easy"
        },
        {
          question: "What is the name of the main protagonist in Attack on Titan?",
          options: ["Eren Yeager", "Mikasa Ackerman", "Armin Arlert", "Levi Ackerman"],
          answer: "Eren Yeager",
          category: "Action",
          difficulty: "Medium"
        }
      ];

      const random = localQuizzes[Math.floor(Math.random() * localQuizzes.length)];
      global.activeAnimeQuiz = {
        from: from,
        question: random.question,
        options: random.options,
        answer: random.answer,
        category: random.category,
        difficulty: random.difficulty,
        timestamp: Date.now()
      };

      let msg = `🎌 *Anime Quiz Time! (local)*\n\n`;
      msg += `📝 *${random.question}*\n\n`;
      msg += `*Options:*\n`;
      random.options.forEach((opt, i) => {
        msg += `${String.fromCharCode(65 + i)}. ${opt}\n`;
      });
      msg += `\n📌 *Category:* ${random.category}\n`;
      msg += `📊 *Difficulty:* ${random.difficulty}\n\n`;
      msg += `💡 Use ${prefix}${command} answer to reveal the correct answer.`;

      await sock.sendMessage(from, { text: msg });
    }
  }
});


// instagram.js - Instagram Downloader
// instagram.js - Instagram Downloader (David Cyril API)
register({
  name: 'instagram',
  aliases: ['ig', 'igdl', 'insta', 'instadl'],
  category: 'DOWNLOADER',
  description: 'Download Instagram Reels, Videos, and Images using David Cyril API',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `📥 *Instagram Downloader*\n\nUsage: ${prefix}${command} <url>\nExample: ${prefix}${command} https://www.instagram.com/p/xxxxx/\n\n*Supports:*\n• Posts (images/videos)\n• Reels\n• IGTV\n• Stories\n\n*Aliases:* ${prefix}ig, ${prefix}igdl, ${prefix}insta, ${prefix}instadl` 
      });
    }

    const url = args[0];

    if (!url.includes('instagram.com') && !url.includes('instagr.am')) {
      return await sock.sendMessage(from, { 
        text: `❌ Invalid URL. Please provide a valid Instagram link.` 
      });
    }

    await sock.sendMessage(from, { text: `⏳ Processing Instagram media...` });

    try {
      // ─── DAVID CYRIL API (GET METHOD) ───
      const apiUrl = `https://apis.davidcyril.name.ng/instagram?url=${encodeURIComponent(url)}`;
      
      let data;
      try {
        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
        data = await response.json();
      } catch (primaryErr) {
        console.log('[INSTAGRAM] David Cyril failed, trying NexOracle:', primaryErr.message);
        data = await fetchNexoracleFallback('instagram', url);
      }

      // ─── EXTRACT MEDIA DATA ───
      let videoUrl = null;
      let imageUrls = [];
      let thumbnail = null;
      let caption = 'Instagram Media';
      let username = 'Unknown';
      let mediaType = 'image';

      // Try different response structures
      if (data.result) {
        videoUrl = data.result.video || data.result.download_url || data.result.url || null;
        imageUrls = data.result.images || data.result.urls || data.result.media || [];
        thumbnail = data.result.thumbnail || data.result.thumb || null;
        caption = data.result.caption || data.result.title || 'Instagram Media';
        username = data.result.username || data.result.author || 'Unknown';
        mediaType = data.result.type || (videoUrl ? 'video' : 'image');
      } else if (data.video) {
        videoUrl = data.video;
        thumbnail = data.thumbnail || null;
        caption = data.caption || data.title || 'Instagram Media';
        username = data.username || data.author || 'Unknown';
        mediaType = 'video';
      } else if (data.images) {
        imageUrls = data.images;
        thumbnail = data.thumbnail || (imageUrls[0] || null);
        caption = data.caption || data.title || 'Instagram Media';
        username = data.username || data.author || 'Unknown';
        mediaType = 'image';
      } else if (data.image || data.url) {
        imageUrls = [data.image || data.url];
        thumbnail = data.thumbnail || imageUrls[0];
        caption = data.caption || data.title || 'Instagram Media';
        username = data.username || data.author || 'Unknown';
        mediaType = 'image';
      } else if (data.download_url) {
        // Could be video or image
        const dlUrl = data.download_url;
        if (dlUrl.match(/\.(mp4|mov)/i)) {
          videoUrl = dlUrl;
          mediaType = 'video';
        } else {
          imageUrls = [dlUrl];
          mediaType = 'image';
        }
        thumbnail = data.thumbnail || null;
        caption = data.caption || data.title || 'Instagram Media';
        username = data.username || data.author || 'Unknown';
      } else {
        // Try to find any URLs in the response
        const jsonString = JSON.stringify(data);
        const videoMatch = jsonString.match(/https?:\/\/[^\s"']+\.(mp4|mov)/i);
        const imageMatch = jsonString.match(/https?:\/\/[^\s"']+\.(jpg|jpeg|png|gif)/gi);
        
        if (videoMatch) {
          videoUrl = videoMatch[0];
          mediaType = 'video';
        } else if (imageMatch) {
          imageUrls = imageMatch;
          mediaType = 'image';
        }
      }

      // Handle single image case
      if (!videoUrl && !imageUrls.length) {
        const singleImage = data.image || data.url || data.result?.image || data.result?.url;
        if (singleImage) {
          imageUrls = [singleImage];
        }
      }

      if (!videoUrl && !imageUrls.length) {
        return await sock.sendMessage(from, { 
          text: `❌ *Download Failed*\n\nCould not extract media from API response.\n\nRaw response:\n${JSON.stringify(data, null, 2).slice(0, 500)}` 
        });
      }

      // ─── SEND PREVIEW ───
      if (thumbnail) {
        try {
          await sock.sendMessage(from, {
            image: { url: thumbnail },
            caption: `📸 *${caption.slice(0, 80)}${caption.length > 80 ? '...' : ''}*\n👤 *Author:* @${username}\n📊 *Type:* ${mediaType.toUpperCase()}\n\n⬇️ *Downloading media...*`
          });
        } catch (thumbErr) {
          await sock.sendMessage(from, { 
            text: `📸 *${caption.slice(0, 80)}${caption.length > 80 ? '...' : ''}*\n👤 *Author:* @${username}\n📊 *Type:* ${mediaType.toUpperCase()}\n\n⬇️ *Downloading media...*` 
          });
        }
      }

      let mediaSent = false;

      // ─── SEND VIDEO ───
      if (videoUrl) {
        try {
          const videoResponse = await fetch(videoUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'video/mp4,video/webm,*/*;q=0.9',
              'Range': 'bytes=0-'
            },
            signal: AbortSignal.timeout(120000)
          });

          if (videoResponse.ok) {
            const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
            
            if (videoBuffer.length > 5000) {
              const fileSize = (videoBuffer.length / 1024 / 1024).toFixed(1);
              const videoCaption = `📸 *${caption.slice(0, 80)}${caption.length > 80 ? '...' : ''}*\n👤 *Author:* @${username}\n📦 *Size:* ${fileSize} MB\n📡 *Source:* David Cyril API\n\n✅ *Instagram Video Download Success*`;

              if (videoBuffer.length > 16 * 1024 * 1024) {
                await sock.sendMessage(from, {
                  document: videoBuffer,
                  mimetype: 'video/mp4',
                  fileName: `instagram_${Date.now()}.mp4`,
                  caption: `📸 *${caption.slice(0, 80)}${caption.length > 80 ? '...' : ''}*\n👤 *Author:* @${username}\n📦 *Size:* ${fileSize} MB\n\n⚠️ *Sent as document (16MB limit)*`
                });
              } else {
                await sock.sendMessage(from, {
                  video: videoBuffer,
                  mimetype: 'video/mp4',
                  caption: videoCaption
                });
              }
              mediaSent = true;
            }
          }
        } catch (videoErr) {
          console.log('❌ Video download failed:', videoErr.message);
        }
      }

      // ─── SEND IMAGES ───
      if (imageUrls.length > 0 && !mediaSent) {
        const maxImages = Math.min(imageUrls.length, 10);
        let sentCount = 0;

        for (let i = 0; i < maxImages; i++) {
          try {
            const imgUrl = imageUrls[i];
            if (imgUrl && typeof imgUrl === 'string' && imgUrl.startsWith('http')) {
              // Skip video thumbnails
              if (imgUrl.includes('.mp4') || imgUrl.includes('.mov')) continue;

              const imgCaption = i === 0 
                ? `📸 *${caption.slice(0, 80)}${caption.length > 80 ? '...' : ''}*\n👤 *Author:* @${username}\n📡 *Source:* David Cyril API\n📷 Image ${i+1}/${Math.min(imageUrls.length, maxImages)}\n\n✅ *Instagram Image Download Success*`
                : `📷 Image ${i+1}/${Math.min(imageUrls.length, maxImages)}`;

              await sock.sendMessage(from, {
                image: { url: imgUrl },
                caption: imgCaption
              });
              sentCount++;
              await new Promise(r => setTimeout(r, 500));
            }
          } catch (imgErr) {
            console.log(`❌ Failed to send image ${i+1}:`, imgErr.message);
          }
        }

        if (sentCount > 0) mediaSent = true;
      }

      // ─── FALLBACK: Send as document ───
      if (!mediaSent && videoUrl) {
        try {
          const vRes = await fetch(videoUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          const vBuf = Buffer.from(await vRes.arrayBuffer());
          if (vBuf.length > 5000) {
            await sock.sendMessage(from, {
              document: vBuf,
              mimetype: 'video/mp4',
              fileName: `instagram_${Date.now()}.mp4`,
              caption: `📸 *${caption.slice(0, 80)}${caption.length > 80 ? '...' : ''}*\n👤 *Author:* @${username}\n\n✅ *Instagram Download (document)*`
            });
            mediaSent = true;
          }
        } catch (docErr) {}
      }

      if (!mediaSent) {
        throw new Error('Could not send any media.');
      }

      console.log(`✅ Instagram media sent: "${caption.slice(0, 30)}..."`);

    } catch (error) {
      console.error('Instagram download error:', error);

      // ─── FALLBACK: GiftedTech API ───
      try {
        const fallbackUrl = `https://api.giftedtech.co.ke/api/download/instagram?apikey=gifted&url=${encodeURIComponent(url)}`;
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(15000)
        });

        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          const video = fallbackData.result?.video || fallbackData.video;
          const images = fallbackData.result?.images || fallbackData.images || [];
          
          if (video) {
            const vRes = await fetch(video);
            const vBuf = Buffer.from(await vRes.arrayBuffer());
            if (vBuf.length > 5000) {
              return await sock.sendMessage(from, { 
                video: vBuf, 
                mimetype: 'video/mp4',
                caption: '✅ *Instagram Download (GiftedTech fallback)*' 
              });
            }
          }
          if (images.length) {
            for (const img of images.slice(0, 5)) {
              await sock.sendMessage(from, { image: { url: img } });
              await new Promise(r => setTimeout(r, 500));
            }
            return;
          }
        }
      } catch (fallbackErr) {}

      // ─── SECOND FALLBACK: OmegaTech API ───
      try {
        const omegaUrl = `https://omegatech-api.dixonomega.tech/api/download/instagram?url=${encodeURIComponent(url)}`;
        const omegaRes = await fetch(omegaUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(15000)
        });

        if (omegaRes.ok) {
          const omegaData = await omegaRes.json();
          const video = omegaData.result?.video || omegaData.video;
          const images = omegaData.result?.images || omegaData.images || [];
          
          if (video) {
            const vRes = await fetch(video);
            const vBuf = Buffer.from(await vRes.arrayBuffer());
            if (vBuf.length > 5000) {
              return await sock.sendMessage(from, { 
                video: vBuf, 
                mimetype: 'video/mp4',
                caption: '✅ *Instagram Download (OmegaTech fallback)*' 
              });
            }
          }
          if (images.length) {
            for (const img of images.slice(0, 5)) {
              await sock.sendMessage(from, { image: { url: img } });
              await new Promise(r => setTimeout(r, 500));
            }
            return;
          }
        }
      } catch (omegaErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ *Download Error*\n\n${error.message || 'Could not download media.'}\n\n💡 Tips:\n• Make sure the URL is valid\n• Post must be public\n• Try a different link\n• Use ${prefix}ig <url>` 
      });
    }
  }
});
// ==========================================
//          PAIRING COMMAND
// ==========================================

// Store active pairing sessions

register({
  name: 'pair',
  aliases: ['paircode', 'pairing', 'getpair'],
  category: 'MAIN',
  description: 'Generate a real WhatsApp pairing code. Anyone can pair their own number; only the owner can pair other numbers.',
  async execute({ sock, from, args, msg, prefix, command, isOwner }) {
    const phone = (args[0] || '').replace(/[^0-9]/g, '');
    if (!phone || phone.length < 7) {
      return await sock.sendMessage(from, {
        text: `❌ Please provide the number to pair, digits only with country code.\nUsage: ${prefix}${command} 15551234567\n\n_Tip: anyone can also self-serve this from the bot's web page instead of asking you._`
      });
    }

    // Non-owners can only request a pairing code for their own WhatsApp
    // number — never someone else's. This stops the command being used to
    // push unsolicited pairing codes at third parties (a real WhatsApp
    // account-hijacking technique: send someone a code, tell them it's a
    // "verification", and if they enter it their account links to the
    // attacker's session).
    //
    // The sender's own number is resolved via resolveSenderPhoneNumber()
    // rather than a plain bareNumber(sender) — with WhatsApp's LID privacy
    // feature, `sender`/`from` can be an opaque @lid id instead of a real
    // phone-number JID, which used to make this check reject a user's own
    // number as "fake".
    if (!isOwner) {
      const senderNumber = resolveSenderPhoneNumber(msg);
      if (phone !== senderNumber) {
        return await sock.sendMessage(from, {
          text: `❌ You can only generate a pairing code for your own number (*${senderNumber}*).\n\nOnly the bot owner can pair other numbers.`
        });
      }
    }

    try {
      // Delegates to the real session manager, which requests an actual
      // pairing code from WhatsApp for that number — the same flow the web
      // pairing page uses. A locally-invented code can never work here since
      // WhatsApp only accepts codes it issued itself.
      const { startSession } = require('../sessionManager');
      const result = await startSession(phone);

      if (result.alreadyLinked) {
        return await sock.sendMessage(from, { text: `✅ ${phone} is already linked and connected.` });
      }

      await sock.sendMessage(from, {
        text: `🔗 *WhatsApp Pairing Code*\n\n📌 *Code:* \`${result.pairingCode}\`\n\n📱 On the *${phone}* device: WhatsApp → Settings → Linked Devices → Link a Device → enter this code.\n\n⏱️ It expires quickly, so use it right away.`
      });
    } catch (error) {
      console.error('Pairing error:', error);
      await sock.sendMessage(from, {
        text: `⚠️ Error generating pairing code: ${error.message || 'Unknown error'}`
      });
    }
  }
});

// Command to check active/linked sessions
register({
  name: 'pairsessions',
  aliases: ['pairlist', 'sessions'],
  category: 'MAIN',
  description: 'List active bot sessions (owner only)',
  async execute({ sock, from, isOwner }) {
    if (!isOwner) {
      return await sock.sendMessage(from, { text: '❌ Owner only command.' });
    }

    const { listSessions } = require('../sessionManager');
    const all = listSessions();

    if (all.length === 0) {
      return await sock.sendMessage(from, { text: 'No sessions yet.' });
    }

    const lines = all.map((s) => `📌 ${s.phone} — ${s.status}`).join('\n');
    await sock.sendMessage(from, { text: `🔗 *Bot Sessions*\n\n${lines}` });
  }
});

// Command to log out / unlink a paired session
register({
  name: 'revokepair',
  aliases: ['revokecode', 'cancelpair', 'unlink'],
  category: 'MAIN',
  description: 'Log out a linked session by phone number (owner only)',
  async execute({ sock, from, args, prefix, command, isOwner }) {
    if (!isOwner) {
      return await sock.sendMessage(from, { text: '❌ Owner only command.' });
    }

    const phone = (args[0] || '').replace(/[^0-9]/g, '');
    if (!phone) {
      return await sock.sendMessage(from, {
        text: `❌ Please provide the phone number to unlink.\nUsage: ${prefix}${command} <phone>`
      });
    }

    const { getSession } = require('../sessionManager');
    const target = getSession(phone);
    if (!target) {
      return await sock.sendMessage(from, { text: `❌ No session found for \`${phone}\`.` });
    }

    try {
      await target.sock.logout();
      await sock.sendMessage(from, { text: `✅ \`${phone}\` has been logged out.` });
    } catch (error) {
      await sock.sendMessage(from, { text: `⚠️ Could not log out \`${phone}\`: ${error.message}` });
    }
  }
});








    




register({
  name: 'mediafire',
  category: 'DOWNLOADER',
  description: 'Download Mediafire files',
  async execute({ sock, from, args }) {
    if (!args[0]) return sock.sendMessage(from, { text: '❌ Provide a Mediafire link.' });
    await princeDownload(sock, from, args[0], 'mediafire', 'video');
  }
});

// ==========================================
//               SEARCH COMMANDS
// ==========================================

// google.js - Google Search (No API Key Required)
register({
  name: 'google',
  aliases: ['g', 'search', 'gsearch'],
  category: 'INFO',
  description: 'Search Google for information',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🔎 *Google Search*\n\nUsage: ${prefix}${command} <query>\nExample: ${prefix}${command} latest AI news\n\n*Aliases:* ${prefix}g, ${prefix}search` 
      });
    }

    const query = args.join(' ');
    await sock.sendMessage(from, { text: `🔍 Searching for "${query}"...` });

    try {
      // ─── OPTION 1: Using a public API (no key needed) ───
      let results = [];
      let error = null;

      // Try multiple public APIs
      const apis = [
        {
          name: 'DuckDuckGo',
          url: `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`,
          extract: (data) => {
            const results = [];
            if (data.AbstractText) {
              results.push({
                title: data.Heading || 'Result',
                snippet: data.AbstractText,
                link: data.AbstractURL || data.Answer || ''
              });
            }
            if (data.RelatedTopics) {
              data.RelatedTopics.forEach(topic => {
                if (topic.Text && topic.Text !== 'Related topics') {
                  results.push({
                    title: topic.Text.split(' - ')[0] || 'Related',
                    snippet: topic.Text,
                    link: topic.FirstURL || ''
                  });
                }
              });
            }
            return results;
          }
        },
        {
          name: 'Whatismyip',
          url: `https://api.whatismyip.com/google-search.php?q=${encodeURIComponent(query)}`,
          extract: (data) => {
            if (Array.isArray(data)) {
              return data.map(item => ({
                title: item.title || 'Result',
                snippet: item.snippet || '',
                link: item.link || ''
              }));
            }
            return [];
          }
        },
        {
          name: 'Custom Google Scraper',
          url: `https://www.googleapis.com/customsearch/v1?key=AIzaSyCkZxqN1wZ8nKzqQZxqN1wZ8nKzqQZxqN1wZ8&cx=017576662512468239146:omuauf_lfve&q=${encodeURIComponent(query)}`,
          extract: (data) => {
            if (data.items) {
              return data.items.map(item => ({
                title: item.title || 'Result',
                snippet: item.snippet || '',
                link: item.link || ''
              }));
            }
            return [];
          }
        }
      ];

      for (const api of apis) {
        try {
          const res = await fetch(api.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: AbortSignal.timeout(10000)
          });

          if (!res.ok) continue;
          
          const data = await res.json();
          const extracted = api.extract(data);
          if (extracted && extracted.length > 0) {
            results = extracted;
            break;
          }
        } catch (e) {
          console.log(`❌ ${api.name} failed:`, e.message);
        }
      }

      // ─── OPTION 2: Fallback - DuckDuckGo HTML scrape ───
      if (results.length === 0) {
        try {
          const htmlRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: AbortSignal.timeout(15000)
          });

          if (htmlRes.ok) {
            const html = await htmlRes.text();
            
            // Extract results from HTML
            const titleMatches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*>([^<]*)<\/a>/gi)];
            const snippetMatches = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([^<]*)<\/a>/gi)];
            const linkMatches = [...html.matchAll(/<a[^>]*class="result__url"[^>]*href="([^"]*)"[^>]*>/gi)];

            for (let i = 0; i < Math.min(titleMatches.length, 10); i++) {
              results.push({
                title: titleMatches[i] ? titleMatches[i][1].trim() : 'Result',
                snippet: snippetMatches[i] ? snippetMatches[i][1].trim() : '',
                link: linkMatches[i] ? linkMatches[i][1] : ''
              });
            }
          }
        } catch (e) {
          console.log('❌ HTML fallback failed:', e.message);
        }
      }

      // ─── OPTION 3: Ultimate Fallback - Wikipedia ───
      if (results.length === 0) {
        try {
          const wikiRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          if (wikiRes.ok) {
            const wikiData = await wikiRes.json();
            if (wikiData.extract) {
              results.push({
                title: wikiData.title || 'Wikipedia',
                snippet: wikiData.extract || '',
                link: `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiData.title || query)}`
              });
            }
          }
        } catch (e) {}
      }

      if (results.length === 0) {
        return await sock.sendMessage(from, { 
          text: `❌ No results found for "${query}".\n\n💡 Try:\n• Different keywords\n• Shorter query\n• Check spelling` 
        });
      }

      // ─── FORMAT RESULTS ───
      let msg = `🔎 *Google Search Results*\n📝 Query: "${query}"\n📊 Found: ${results.length} results\n\n`;

      results.slice(0, 10).forEach((result, i) => {
        const title = result.title || 'Untitled';
        const snippet = result.snippet || result.description || '';
        const link = result.link || result.url || result.href || '#';
        
        msg += `*${i + 1}. ${title}*\n`;
        if (snippet) {
          const shortSnippet = snippet.length > 300 ? snippet.slice(0, 300) + '...' : snippet;
          msg += `📝 ${shortSnippet}\n`;
        }
        msg += `🔗 ${link}\n\n`;
      });

      // ─── SEND RESPONSE ───
      if (msg.length > 4096) {
        const chunks = msg.match(/.{1,4000}/g) || [msg];
        for (const chunk of chunks) {
          await sock.sendMessage(from, { text: chunk });
        }
      } else {
        await sock.sendMessage(from, { text: msg });
      }

      console.log(`✅ Google search sent for: "${query}" (${results.length} results)`);

    } catch (error) {
      console.error('Google search error:', error);

      // ─── EMERGENCY FALLBACK: Direct Brave Search API ───
      try {
        const braveRes = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        if (braveRes.ok) {
          const braveData = await braveRes.json();
          if (braveData.web && braveData.web.results) {
            let msg = `🔎 *Brave Search Results*\n📝 Query: "${query}"\n\n`;
            braveData.web.results.slice(0, 5).forEach((r, i) => {
              msg += `*${i + 1}. ${r.title}*\n📝 ${r.description || ''}\n🔗 ${r.url}\n\n`;
            });
            return await sock.sendMessage(from, { text: msg });
          }
        }
      } catch (braveErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ *Search Error*\n\n${error.message || 'Could not complete search.'}\n\n💡 Tips:\n• Use specific keywords\n• Try ${prefix}google [query]\n• Check internet connection` 
      });
    }
  }
});

register({
  name: 'pinsearch',
  aliases: ['pinseek'],
  category: 'INFO',
  description: 'Find images on Pinterest by keyword',
  async execute({ sock, from, text }) {
    if (!text) return sock.sendMessage(from, { text: '❓ Search query?' });
    try {
      const res = await fetch(`${P_BASE}/search/pinterest?apikey=${P_KEY}&query=${encodeURIComponent(text)}`);
      const data = await res.json();
      const img = data.result && data.result[0];
      if (!img) return sock.sendMessage(from, { text: '❌ No results found.' });
      await sock.sendMessage(from, { image: { url: img }, caption: `📌 Result for: ${text}` });
    } catch (e) {
      await sock.sendMessage(from, { text: '⚠️ Search Error: ' + e.message });
    }
  }
});

// lyrics.js - Find Song Lyrics (No API Key Required)
register({
  name: 'lyrics',
  aliases: ['lyric', 'songlyrics', 'lirik', 'liriklagu'],
  category: 'INFO',
  description: 'Find lyrics for any song',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🎵 *Lyrics Finder*\n\nUsage: ${prefix}${command} <song title>\nExample: ${prefix}${command} Bohemian Rhapsody\n\n*Aliases:* ${prefix}lyric, ${prefix}songlyrics` 
      });
    }

    const query = args.join(' ');
    await sock.sendMessage(from, { text: `🎵 Searching lyrics for "${query}"...` });

    try {
      let lyricsData = null;

      // ─── OPTION 1: API 1 - Lyrics.ovh (Free, No Key) ───
      try {
        const res = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(query)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (res.ok) {
          const data = await res.json();
          if (data.lyrics) {
            lyricsData = {
              title: query,
              artist: 'Unknown',
              lyrics: data.lyrics
            };
          }
        }
      } catch (e) {
        console.log('❌ Lyrics.ovh failed:', e.message);
      }

      // ─── OPTION 2: API 2 - SongLyrics API ───
      if (!lyricsData) {
        try {
          const searchRes = await fetch(`https://www.songlyrics.com/index.php?section=search&searchTerm=${encodeURIComponent(query)}&searchType=all`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: AbortSignal.timeout(10000)
          });

          if (searchRes.ok) {
            const html = await searchRes.text();
            const linkMatch = html.match(/<a[^>]*href="([^"]*)"[^>]*class="title"[^>]*>([^<]*)<\/a>/);
            if (linkMatch) {
              const lyricUrl = linkMatch[1].startsWith('http') ? linkMatch[1] : `https://www.songlyrics.com${linkMatch[1]}`;
              const title = linkMatch[2].trim();

              const lyricRes = await fetch(lyricUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
              });

              if (lyricRes.ok) {
                const lyricHtml = await lyricRes.text();
                const lyricMatch = lyricHtml.match(/<p[^>]*id="songLyrics"[^>]*>([\s\S]*?)<\/p>/);
                if (lyricMatch) {
                  const rawLyrics = lyricMatch[1]
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<[^>]+>/g, '')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&amp;/g, '&')
                    .replace(/&quot;/g, '"')
                    .trim();

                  lyricsData = {
                    title: title,
                    artist: 'Unknown',
                    lyrics: rawLyrics
                  };
                }
              }
            }
          }
        } catch (e) {
          console.log('❌ SongLyrics failed:', e.message);
        }
      }

      // ─── OPTION 3: API 3 - Genius (Unofficial) ───
      if (!lyricsData) {
        try {
          const geniusRes = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Authorization': 'Bearer G9s5zI5VQV-G1eDuMreU4xE8TqpiPqIPn8yqkQHjVj_LqF5XyU5vZ2N2F2Vk3L' // Public Genius token
            }
          });

          if (geniusRes.ok) {
            const geniusData = await geniusRes.json();
            const hits = geniusData.response?.hits || [];
            if (hits.length > 0) {
              const song = hits[0].result;
              const artist = song.primary_artist?.name || 'Unknown';
              const title = song.title || query;

              // Get lyrics from Genius page
              const pageRes = await fetch(song.url, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
              });

              if (pageRes.ok) {
                const pageHtml = await pageRes.text();
                const lyricMatch = pageHtml.match(/<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/);
                if (lyricMatch) {
                  const rawLyrics = lyricMatch[1]
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<[^>]+>/g, '')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&amp;/g, '&')
                    .replace(/&quot;/g, '"')
                    .trim();

                  lyricsData = {
                    title: title,
                    artist: artist,
                    lyrics: rawLyrics
                  };
                }
              }
            }
          }
        } catch (e) {
          console.log('❌ Genius failed:', e.message);
        }
      }

      // ─── OPTION 4: Fallback - AZLyrics ───
      if (!lyricsData) {
        try {
          const searchQuery = query.toLowerCase().replace(/[^a-z0-9]/g, '');
          const url = `https://www.azlyrics.com/lyrics/${searchQuery.slice(0, 1)}/${searchQuery}.html`;
          
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: AbortSignal.timeout(10000)
          });

          if (res.ok) {
            const html = await res.text();
            const lyricMatch = html.match(/<div[^>]*class="lyricsh"[^>]*>([\s\S]*?)<\/div>/);
            if (lyricMatch) {
              const rawLyrics = lyricMatch[1]
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .trim();

              const titleMatch = html.match(/<title>([^<]*)<\/title>/);
              const title = titleMatch ? titleMatch[1].replace(' Lyrics', '').trim() : query;

              lyricsData = {
                title: title,
                artist: 'Unknown',
                lyrics: rawLyrics
              };
            }
          }
        } catch (e) {
          console.log('❌ AZLyrics failed:', e.message);
        }
      }

      if (!lyricsData || !lyricsData.lyrics) {
        return await sock.sendMessage(from, { 
          text: `❌ *Lyrics Not Found*\n\nCould not find lyrics for "${query}".\n\n💡 Tips:\n• Try a different song title\n• Use format: Artist - Song Name\n• Check spelling\n\nExample: ${prefix}${command} Queen - Bohemian Rhapsody` 
        });
      }

      // ─── FORMAT LYRIC ───
      const title = lyricsData.title || query;
      const artist = lyricsData.artist || 'Unknown';
      const lyrics = lyricsData.lyrics || '';

      // Clean lyrics (remove excessive newlines)
      const cleanLyrics = lyrics
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\r/g, '')
        .trim();

      // ─── SEND RESULT ───
      let msg = `🎵 *Lyrics*\n\n`;
      msg += `📌 *Title:* ${title}\n`;
      msg += `👤 *Artist:* ${artist}\n\n`;
      msg += `📝 *Lyrics:*\n\n${cleanLyrics}`;

      if (msg.length > 4096) {
        const chunks = msg.match(/.{1,4000}/g) || [msg];
        await sock.sendMessage(from, { text: `🎵 *Lyrics: ${title}*\n\n${chunks[0]}` });
        for (let i = 1; i < chunks.length; i++) {
          await sock.sendMessage(from, { text: `*(continued)*\n\n${chunks[i]}` });
        }
      } else {
        await sock.sendMessage(from, { text: msg });
      }

      console.log(`✅ Lyrics sent for: "${title}" by ${artist}`);

    } catch (error) {
      console.error('Lyrics error:', error);

      // ─── EMERGENCY FALLBACK: Simple text search ───
      try {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query + ' lyrics')}`;
        const fallbackRes = await fetch(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (fallbackRes.ok) {
          const html = await fallbackRes.text();
          const lyricMatch = html.match(/<span[^>]*>([^<]*)<\/span>[^<]*lyrics?/i);
          if (lyricMatch) {
            return await sock.sendMessage(from, { 
              text: `🎵 *Lyrics (Fallback)*\n\n${lyricMatch[1].slice(0, 4000)}` 
            });
          }
        }
      } catch (fallbackErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ *Lyrics Error*\n\n${error.message || 'Could not fetch lyrics.'}\n\n💡 Try:\n• Exact song title\n• Artist - Song Name\n• ${prefix}lyrics Bohemian Rhapsody` 
      });
    }
  }
});

// wikipedia.js - Wikipedia Search (No API Key Required)
register({
  name: 'wikipedia',
  aliases: ['wiki', 'wikipedia', 'enwiki'],
  category: 'INFO',
  description: 'Search Wikipedia for articles',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `📖 *Wikipedia*\n\nUsage: ${prefix}${command} <search query>\nExample: ${prefix}${command} Albert Einstein\n\n*Aliases:* ${prefix}wiki, ${prefix}enwiki` 
      });
    }

    const query = args.join(' ');
    await sock.sendMessage(from, { text: `📖 Searching Wikipedia for "${query}"...` });

    try {
      let article = null;
      let error = null;

      // ─── OPTION 1: Wikipedia REST API (Free, No Key) ───
      try {
        const searchRes = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (searchRes.ok) {
          const searchData = await searchRes.json();
          const results = searchData.query?.search || [];

          if (results.length > 0) {
            const title = results[0].title;

            // Get full article
            const articleRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            });

            if (articleRes.ok) {
              const articleData = await articleRes.json();
              article = {
                title: articleData.title || title,
                extract: articleData.extract || articleData.description || 'No description available.',
                url: articleData.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
                thumbnail: articleData.thumbnail?.source || null,
                pageId: articleData.pageid || null,
                categories: articleData.categories || []
              };
            }
          }
        }
      } catch (e) {
        console.log('❌ Wikipedia API failed:', e.message);
      }

      // ─── OPTION 2: Direct page fetch (if title is exact) ───
      if (!article) {
        try {
          const directRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          if (directRes.ok) {
            const data = await directRes.json();
            if (data.title && data.extract) {
              article = {
                title: data.title,
                extract: data.extract,
                url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(data.title)}`,
                thumbnail: data.thumbnail?.source || null,
                pageId: data.pageid || null
              };
            }
          }
        } catch (e) {
          console.log('❌ Direct Wikipedia failed:', e.message);
        }
      }

      // ─── OPTION 3: Mobile Wikipedia API ───
      if (!article) {
        try {
          const mobileRes = await fetch(`https://en.m.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(query)}&format=json`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: AbortSignal.timeout(10000)
          });

          if (mobileRes.ok) {
            const data = await mobileRes.json();
            const pages = data.query?.pages || {};
            const pageId = Object.keys(pages)[0];
            const page = pages[pageId];

            if (page && page.extract) {
              article = {
                title: page.title || query,
                extract: page.extract,
                url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title || query)}`,
                thumbnail: null,
                pageId: pageId
              };
            }
          }
        } catch (e) {
          console.log('❌ Mobile Wikipedia failed:', e.message);
        }
      }

      // ─── OPTION 4: Simple Wikipedia (Simplified English) ───
      if (!article) {
        try {
          const simpleRes = await fetch(`https://simple.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          if (simpleRes.ok) {
            const data = await simpleRes.json();
            if (data.title && data.extract) {
              article = {
                title: data.title,
                extract: data.extract + '\n\n📌 *Source: Simple Wikipedia*',
                url: `https://simple.wikipedia.org/wiki/${encodeURIComponent(data.title)}`,
                thumbnail: data.thumbnail?.source || null,
                pageId: data.pageid || null
              };
            }
          }
        } catch (e) {
          console.log('❌ Simple Wikipedia failed:', e.message);
        }
      }

      if (!article) {
        return await sock.sendMessage(from, { 
          text: `❌ *Article Not Found*\n\nNo Wikipedia article found for "${query}".\n\n💡 Tips:\n• Try a different topic\n• Use more specific keywords\n• Check spelling\n\nExample: ${prefix}${command} Quantum mechanics` 
        });
      }

      // ─── FORMAT RESPONSE ───
      let msg = `📖 *${article.title}*\n\n`;
      msg += `${article.extract}\n\n`;

      if (article.thumbnail) {
        try {
          await sock.sendMessage(from, {
            image: { url: article.thumbnail },
            caption: `📖 *${article.title}*\n\n${article.extract.slice(0, 900)}...\n\n🔗 ${article.url}`
          });
          return;
        } catch (imgErr) {
          // Fall through to text
        }
      }

      msg += `🔗 ${article.url}`;

      // ─── SEND RESPONSE ───
      if (msg.length > 4096) {
        // Split the article into chunks
        const intro = `📖 *${article.title}*\n\n`;
        const remaining = msg.slice(intro.length);
        const chunks = remaining.match(/.{1,4000}/g) || [remaining];
        
        await sock.sendMessage(from, { text: intro + chunks[0] });
        for (let i = 1; i < chunks.length; i++) {
          await sock.sendMessage(from, { text: `*(continued)*\n\n${chunks[i]}` });
        }
        await sock.sendMessage(from, { text: `🔗 ${article.url}` });
      } else {
        await sock.sendMessage(from, { text: msg });
      }

      console.log(`✅ Wikipedia article sent: "${article.title}"`);

    } catch (error) {
      console.error('Wikipedia error:', error);

      // ─── EMERGENCY FALLBACK: Simple text search ───
      try {
        const fallbackRes = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          const results = fallbackData.query?.search || [];
          if (results.length > 0) {
            const title = results[0].title;
            const snippet = results[0].snippet?.replace(/<[^>]+>/g, '') || '';
            
            return await sock.sendMessage(from, { 
              text: `📖 *${title}*\n\n${snippet}\n\n🔗 https://en.wikipedia.org/wiki/${encodeURIComponent(title)}` 
            });
          }
        }
      } catch (fallbackErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ *Wikipedia Error*\n\n${error.message || 'Could not fetch article.'}\n\n💡 Try:\n• Specific topic\n• ${prefix}wiki Quantum mechanics\n• Check internet connection` 
      });
    }
  }
});

register({
  name: 'weather',
  aliases: ['wthr', 'forecast', 'temp'],
  category: 'INFO',
  description: 'Get current weather for any city',
  async execute({ sock, from, text, prefix, command }) {
    if (!text) {
      return await sock.sendMessage(from, { 
        text: `🌤️ *Weather Forecast*\n\nUsage: ${prefix}${command} <city name>\nExample: ${prefix}${command} London\n\n*Examples:*\n${prefix}${command} New York\n${prefix}${command} Tokyo\n${prefix}${command} Lagos` 
      });
    }

    await sock.sendMessage(from, { text: `⏳ Fetching weather for *${text}*...` });

    try {
      // Primary: OmegaTech API
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const response = await fetch(`${baseUrl}/api/weather?city=${encodeURIComponent(text)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract weather data from various formats
      let weather = data.result || data.data || data;

      let city = weather.city || weather.name || weather.location || text;
      let country = weather.country || weather.region || '';
      let condition = weather.condition || weather.description || weather.weather || 'N/A';
      let temp = weather.temp || weather.temperature || weather.temp_c || 'N/A';
      let feelsLike = weather.feels_like || weather.feelslike || weather.feels || 'N/A';
      let humidity = weather.humidity || 'N/A';
      let wind = weather.wind || weather.wind_speed || weather.windspeed || 'N/A';
      let pressure = weather.pressure || 'N/A';
      let uv = weather.uv || weather.uv_index || 'N/A';
      let icon = weather.icon || weather.condition_icon || null;

      if (!city && !condition) {
        throw new Error("Could not extract weather data from API response.");
      }

      // Build the weather message
      let msg = `🌤️ *Weather in ${city}${country ? ', ' + country : ''}*\n\n`;
      msg += `☁️ *Condition:* ${condition}\n`;
      msg += `🌡️ *Temperature:* ${temp}°C\n`;
      msg += `🤔 *Feels like:* ${feelsLike}°C\n`;
      msg += `💧 *Humidity:* ${humidity}%\n`;
      msg += `💨 *Wind:* ${wind} km/h\n`;
      msg += `📊 *Pressure:* ${pressure} hPa\n`;
      msg += `☀️ *UV Index:* ${uv}\n\n`;
      msg += `🕐 *Last updated:* ${new Date().toLocaleString()}`;

      // Send with icon if available
      if (icon && icon.startsWith('http')) {
        try {
          await sock.sendMessage(from, {
            image: { url: icon },
            caption: msg
          });
        } catch (iconErr) {
          await sock.sendMessage(from, { text: msg });
        }
      } else {
        await sock.sendMessage(from, { text: msg });
      }

    } catch (error) {
      console.error('Weather error:', error);
      
      // Fallback: Prince API
      try {
        const princeUrl = 'https://api.princetechn.com/api/search/weather';
        const fallbackRes = await fetch(`${princeUrl}?apikey=prince&query=${encodeURIComponent(text)}`);
        const fallbackData = await fallbackRes.json();
        
        const w = fallbackData.result || fallbackData.data;
        if (w) {
          let msg = `🌤️ *Weather in ${w.city || w.name || text}*\n\n`;
          msg += `☁️ *Condition:* ${w.condition || w.weather || 'N/A'}\n`;
          msg += `🌡️ *Temperature:* ${w.temp || w.temperature || 'N/A'}°C\n`;
          msg += `💧 *Humidity:* ${w.humidity || 'N/A'}%\n`;
          msg += `💨 *Wind:* ${w.wind || w.windspeed || 'N/A'} km/h\n\n`;
          msg += `🕐 *Last updated:* ${new Date().toLocaleString()}`;
          return await sock.sendMessage(from, { text: msg });
        }
      } catch (fallbackErr) {
        // Silent fail
      }

      // Fallback: Free OpenWeatherMap-like API (wttr.in)
      try {
        const wttrRes = await fetch(`https://wttr.in/${encodeURIComponent(text)}?format=%l:+%c+%t+%h+%w+%p`, {
          headers: { 'User-Agent': 'curl' }
        });
        const wttrData = await wttrRes.text();
        if (wttrData && !wttrData.includes('Unknown location')) {
          return await sock.sendMessage(from, { 
            text: `🌤️ *Weather Report*\n\n${wttrData}\n\n🕐 ${new Date().toLocaleString()}` 
          });
        }
      } catch (wttrErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ Weather Error: Could not find weather for "${text}".\n\n💡 Try another city name or check your spelling.` 
      });
    }
  }
});

// facebook.js - Facebook Downloader (David Cyril API)
register({
  name: 'facebook',
  aliases: ['fb', 'fbdl', 'facebookdl', 'fbvideo'],
  category: 'DOWNLOADER',
  description: 'Download Facebook Videos using David Cyril API',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `📥 *Facebook Downloader*\n\nUsage: ${prefix}${command} <url>\nExample: ${prefix}${command} https://www.facebook.com/reel/402579285704851\n\n*Supports:*\n• Reels\n• Videos\n• Posts with video\n\n*Aliases:* ${prefix}fb, ${prefix}fbdl, ${prefix}facebookdl` 
      });
    }

    const url = args[0];

    if (!url.includes('facebook.com') && !url.includes('fb.watch')) {
      return await sock.sendMessage(from, { 
        text: `❌ Invalid URL. Please provide a valid Facebook link.` 
      });
    }

    await sock.sendMessage(from, { text: `⏳ Processing Facebook video...` });

    try {
      // ─── DAVID CYRIL API (GET METHOD) ───
      const apiUrl = `https://apis.davidcyril.name.ng/facebook?url=${encodeURIComponent(url)}`;
      
      let data;
      try {
        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
        data = await response.json();
      } catch (primaryErr) {
        console.log('[FACEBOOK] David Cyril failed, trying NexOracle:', primaryErr.message);
        data = await fetchNexoracleFallback('facebook', url);
      }

      // ─── EXTRACT VIDEO DATA ───
      let videoData = null;
      let thumbnail = null;
      let title = 'Facebook Video';
      let duration = 'N/A';
      let quality = 'SD';

      // Try different response structures
      if (data.result) {
        videoData = data.result.video || data.result.download_url || data.result.url || data.result;
        thumbnail = data.result.thumbnail || data.result.thumb || null;
        title = data.result.title || data.result.caption || 'Facebook Video';
        duration = data.result.duration || 'N/A';
        quality = data.result.quality || 'SD';
      } else if (data.video) {
        videoData = data.video;
        thumbnail = data.thumbnail || null;
        title = data.title || 'Facebook Video';
        duration = data.duration || 'N/A';
        quality = data.quality || 'SD';
      } else if (data.download_url) {
        videoData = data.download_url;
        thumbnail = data.thumbnail || null;
        title = data.title || 'Facebook Video';
        duration = data.duration || 'N/A';
      } else if (data.url) {
        videoData = data.url;
        thumbnail = data.thumbnail || null;
        title = data.title || 'Facebook Video';
        duration = data.duration || 'N/A';
      } else if (typeof data === 'string') {
        videoData = data;
      } else {
        // Try to find any URL in the response
        const jsonString = JSON.stringify(data);
        const urlMatch = jsonString.match(/https?:\/\/[^\s"']+\.(mp4|mov)/i);
        if (urlMatch) {
          videoData = urlMatch[0];
        }
      }

      if (!videoData) {
        return await sock.sendMessage(from, { 
          text: `❌ *Download Failed*\n\nCould not extract video URL from API response.\n\nRaw response:\n${JSON.stringify(data, null, 2).slice(0, 500)}` 
        });
      }

      // ─── SEND THUMBNAIL ───
      if (thumbnail) {
        try {
          await sock.sendMessage(from, {
            image: { url: thumbnail },
            caption: `🎬 *${title}*\n⏱️ *Duration:* ${duration}\n📊 *Quality:* ${quality}\n\n⬇️ *Downloading video...*`
          });
        } catch (thumbErr) {
          await sock.sendMessage(from, { 
            text: `🎬 *${title}*\n⏱️ *Duration:* ${duration}\n📊 *Quality:* ${quality}\n\n⬇️ *Downloading video...*` 
          });
        }
      }

      // ─── DOWNLOAD VIDEO ───
      const videoResponse = await fetch(videoData, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'video/mp4,video/webm,*/*;q=0.9',
          'Accept-Language': 'en-US,en;q=0.5',
          'Range': 'bytes=0-'
        },
        signal: AbortSignal.timeout(120000)
      });

      if (!videoResponse.ok) {
        throw new Error(`Video download failed: ${videoResponse.status}`);
      }

      let videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

      if (videoBuffer.length < 5000) {
        throw new Error("Downloaded file is too small.");
      }

      const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);

      // ─── SEND VIDEO ───
      const caption = `🎬 *${title}*\n📊 *Quality:* ${quality}\n📦 *Size:* ${fileSizeMB} MB\n📡 *Source:* David Cyril API\n\n✅ *Facebook Download Success*`;

      if (videoBuffer.length > 16 * 1024 * 1024) {
        await sock.sendMessage(from, {
          document: videoBuffer,
          mimetype: 'video/mp4',
          fileName: `facebook_${Date.now()}.mp4`,
          caption: `🎬 *${title}*\n📊 *Quality:* ${quality}\n📦 *Size:* ${fileSizeMB} MB\n\n⚠️ *Sent as document (16MB limit)*`
        });
      } else {
        try {
          await sock.sendMessage(from, {
            video: videoBuffer,
            mimetype: 'video/mp4',
            caption: caption
          });
        } catch (sendErr) {
          await sock.sendMessage(from, {
            document: videoBuffer,
            mimetype: 'video/mp4',
            fileName: `facebook_${Date.now()}.mp4`,
            caption: `🎬 *${title}*\n📊 *Quality:* ${quality}\n📦 *Size:* ${fileSizeMB} MB\n\n✅ *Facebook Download Success*`
          });
        }
      }

      console.log(`✅ Facebook video sent: "${title}" (${fileSizeMB}MB)`);

    } catch (error) {
      console.error('Facebook download error:', error);

      // ─── FALLBACK: Alternative Facebook API ───
      try {
        const fallbackUrl = `https://api.giftedtech.co.ke/api/download/facebook?apikey=gifted&url=${encodeURIComponent(url)}`;
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(15000)
        });

        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          const video = fallbackData.result?.hd_video || fallbackData.result?.sd_video || fallbackData.result?.video || fallbackData.video;
          
          if (video) {
            const vRes = await fetch(video);
            const vBuf = Buffer.from(await vRes.arrayBuffer());
            if (vBuf.length > 5000) {
              return await sock.sendMessage(from, { 
                video: vBuf, 
                mimetype: 'video/mp4',
                caption: '✅ *Facebook Download (GiftedTech fallback)*' 
              });
            }
          }
        }
      } catch (fallbackErr) {}

      // ─── SECOND FALLBACK: Prince API ───
      try {
        const princeUrl = `https://api.princetechn.com/api/download/facebook?apikey=prince&url=${encodeURIComponent(url)}`;
        const princeRes = await fetch(princeUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(15000)
        });

        if (princeRes.ok) {
          const princeData = await princeRes.json();
          const video = princeData.result?.video || princeData.result?.download_url || princeData.video || princeData.download_url || princeData.url;
          
          if (video) {
            const vRes = await fetch(video);
            const vBuf = Buffer.from(await vRes.arrayBuffer());
            if (vBuf.length > 5000) {
              return await sock.sendMessage(from, { 
                video: vBuf, 
                mimetype: 'video/mp4',
                caption: '✅ *Facebook Download (Prince fallback)*' 
              });
            }
          }
        }
      } catch (princeErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ *Download Error*\n\n${error.message || 'Could not download video.'}\n\n💡 Tips:\n• Make sure the URL is valid\n• Video must be public\n• Try a different link\n• Use ${prefix}fb <url>` 
      });
    }
  }
});
register({
  name: 'getid',
  aliases: ['getjid', 'getchannelid', 'getnewsletter', 'channelid'],
  category: 'INFO',
  description: 'Get the newsletter ID from a forwarded channel message',
  async execute({ sock, from, msg, quoted, args, prefix, command }) {
    const target = quoted || msg;

    const contextInfo = target?.message?.extendedTextMessage?.contextInfo ||
                        target?.message?.imageMessage?.contextInfo ||
                        target?.message?.videoMessage?.contextInfo ||
                        target?.message?.documentMessage?.contextInfo ||
                        target?.message?.audioMessage?.contextInfo ||
                        target?.message?.stickerMessage?.contextInfo;

    const newsletterJid = contextInfo?.newsletterJid || 
                          contextInfo?.forwardedNewsletterMessageInfo?.newsletterJid;

    if (newsletterJid) {
      await sock.sendMessage(from, { 
        text: newsletterJid 
      });
    } else {
      await sock.sendMessage(from, { 
        text: 'No newsletter ID found. Reply to a forwarded channel message.' 
      });
    }
  }
});
// -------------------- WELCOME / GOODBYE --------------------

register({
  name: 'welcome',
  category: 'GROUP-ADMIN',
  description: 'Toggle welcome messages (on/off) — shows the new member\'s profile picture (or the bot\'s, if they don\'t have one)',
  async execute({ sock, from, sender, args, isGroup, msg, isOwner }) {
    if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Group only!' });
    const isAdmin = await requireAdminOrOwner({ sock, from, sender, isGroup, msg, isOwner });
    if (!isAdmin) return;
    const state = args[0]?.toLowerCase();
    if (!state || !['on', 'off'].includes(state)) {
      return sock.sendMessage(from, { text: `📋 Usage: welcome on | off` });
    }
    setGroupSetting(from, 'welcome', state === 'on');
    await sock.sendMessage(from, { text: `✅ Welcome ${state === 'on' ? 'enabled' : 'disabled'}.` });
  }
});

register({
  name: 'goodbye',
  category: 'GROUP-ADMIN',
  description: 'Toggle goodbye messages (on/off) — shows the leaving member\'s profile picture (or the bot\'s, if they don\'t have one)',
  async execute({ sock, from, sender, args, isGroup, msg, isOwner }) {
    if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Group only!' });
    const isAdmin = await requireAdminOrOwner({ sock, from, sender, isGroup, msg, isOwner });
    if (!isAdmin) return;
    const state = args[0]?.toLowerCase();
    if (!state || !['on', 'off'].includes(state)) {
      return sock.sendMessage(from, { text: `📋 Usage: goodbye on | off` });
    }
    setGroupSetting(from, 'goodbye', state === 'on');
    await sock.sendMessage(from, { text: `✅ Goodbye ${state === 'on' ? 'enabled' : 'disabled'}.` });
  }
});

register({
  name: 'setwelcome',
  category: 'GROUP-ADMIN',
  description: 'Set custom welcome message (@user, @group, @members, @admin)',
  async execute({ sock, from, sender, args, isGroup, msg, isOwner }) {
    if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Group only!' });
    const isAdmin = await requireAdminOrOwner({ sock, from, sender, isGroup, msg, isOwner });
    if (!isAdmin) return;
    const msgText = args.join(' ');
    if (!msgText) return sock.sendMessage(from, { text: `📝 Usage: setwelcome <message> (use @user, @group, @members, @admin)` });
    setGroupSetting(from, 'welcomeMessage', msgText);
    await sock.sendMessage(from, { text: `✅ Welcome message set.` });
  }
});

register({
  name: 'setgoodbye',
  category: 'GROUP-ADMIN',
  description: 'Set custom goodbye message (@user, @group, @members, @admin)',
  async execute({ sock, from, sender, args, isGroup, msg, isOwner }) {
    if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Group only!' });
    const isAdmin = await requireAdminOrOwner({ sock, from, sender, isGroup, msg, isOwner });
    if (!isAdmin) return;
    const msgText = args.join(' ');
    if (!msgText) return sock.sendMessage(from, { text: `📝 Usage: setgoodbye <message> (use @user, @group, @members, @admin)` });
    setGroupSetting(from, 'goodbyeMessage', msgText);
    await sock.sendMessage(from, { text: `✅ Goodbye message set.` });
  }
});

// 13. Group info
register({
  name: 'groupinfo',
  aliases: ['gcinfo', 'group'],
  category: 'INFO',
  description: 'Show group information',
  async execute({ sock, from, isGroup }) {
    if (!isGroup) return sock.sendMessage(from, { text: '⚠️ Group only!' });
    const meta = await sock.groupMetadata(from);
    const admins = meta.participants.filter(p => p.admin);
    const total = meta.participants.length;
    let msg = `📊 *Group Info*\n\n`;
    msg += `📛 *Name:* ${meta.subject}\n`;
    msg += `👥 *Members:* ${total}\n`;
    msg += `👑 *Admins:* ${admins.length}\n`;
    msg += `🆔 *JID:* ${from}\n`;
    msg += `📅 *Created:* ${new Date(meta.creation * 1000).toLocaleDateString()}`;
    await sock.sendMessage(from, { text: msg });
  }
});
register({
  name: 'ytmp3',
  aliases: ['yt3', 'ytmusic', 'ytaudio'],
  category: 'DOWNLOADER',
  description: 'Download YouTube videos as MP3 audio with quality selection',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🎵 *YouTube MP3 Downloader*\n\nUsage: ${prefix}${command} <url> [quality]\nExample: ${prefix}${command} https://youtu.be/qF-JLqKtr2Q\n\n*Quality options:*\n• 320kbps (best)\n• 128kbps (default)\n\n*Examples:*\n${prefix}${command} https://youtu.be/xxxxx 320\n${prefix}${command} https://youtu.be/xxxxx 128\n\n*Note:* Download URL expires in 10 minutes.` 
      });
    }

    const url = args[0];
    let quality = '128'; // Default quality

    // Check if user specified quality
    const qualityArg = args[1] || '';
    if (qualityArg === '320' || qualityArg === '320kbps') {
      quality = '320';
    }

    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      return await sock.sendMessage(from, { 
        text: `❌ Invalid URL. Please provide a valid YouTube link.` 
      });
    }

    await sock.sendMessage(from, { text: `⏳ Processing YouTube audio...` });

    try {
      // Primary: GiftedTech API
      const response = await fetch(
        `https://api.giftedtech.co.ke/api/download/ytmp3?apikey=gifted&url=${encodeURIComponent(url)}&quality=${quality}kbps`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract data
      let title = data.result?.title || 'YouTube Audio';
      let thumbnail = data.result?.thumbnail || null;
      let downloadUrl = data.result?.download_url || null;
      let format = data.result?.format || 'mp3';
      let qualityReturned = data.result?.quality || `${quality}kbps`;
      let availableQualities = data.result?.availableQualities || [];
      let message = data.result?.message || '';

      if (!downloadUrl) {
        throw new Error("Could not extract download URL from API response.");
      }

      // Send thumbnail if available
      if (thumbnail) {
        try {
          await sock.sendMessage(from, {
            image: { url: thumbnail },
            caption: `🎵 *${title}*\n📊 *Quality:* ${qualityReturned}\n📦 *Format:* ${format}\n${message ? `\n${message}` : ''}\n\n⬇️ *Downloading audio...*`
          });
        } catch (thumbErr) {
          await sock.sendMessage(from, { 
            text: `🎵 *${title}*\n📊 *Quality:* ${qualityReturned}\n📦 *Format:* ${format}\n${message ? `\n${message}` : ''}\n\n⬇️ *Downloading audio...*` 
          });
        }
      }

      // Download the audio
      const audioResponse = await fetch(downloadUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!audioResponse.ok) {
        throw new Error(`Audio download failed: ${audioResponse.status}`);
      }

      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      if (audioBuffer.length < 5000) {
        throw new Error("Downloaded file is too small. The link may be invalid.");
      }

      const fileSizeMB = (audioBuffer.length / 1024 / 1024).toFixed(1);

      // Build available qualities message
      let qualityList = '';
      if (availableQualities.length > 0) {
        qualityList = availableQualities.map(q => `${q}kbps`).join(', ');
      }

      const caption = `🎵 *${title}*\n📊 *Quality:* ${qualityReturned}\n📦 *Format:* ${format}\n📦 *Size:* ${fileSizeMB} MB\n${qualityList ? `📥 *Available:* ${qualityList}` : ''}\n\n✅ *Download Success*\n${message ? `\n⚠️ ${message}` : ''}`;

      // Try to send as audio
      try {
        await sock.sendMessage(from, {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
          fileName: `${title.replace(/[^a-zA-Z0-9]/g, '_')}.${format}`,
          caption: caption,
          ptt: false
        });
      } catch (sendErr) {
        // Fallback: send as document
        await sock.sendMessage(from, {
          document: audioBuffer,
          mimetype: 'audio/mpeg',
          fileName: `${title.replace(/[^a-zA-Z0-9]/g, '_')}.${format}`,
          caption: caption
        });
      }

    } catch (error) {
      console.error('YouTube MP3 download error:', error);

      // Fallback: OmegaTech API
      try {
        const omegaUrl = 'https://omegatech-api.dixonomega.tech/api/download/play';
        const fallbackRes = await fetch(`${omegaUrl}?url=${encodeURIComponent(url)}`);
        const fallbackData = await fallbackRes.json();

        let fallbackAudio = fallbackData.download_url || fallbackData.download || fallbackData.url;
        let fallbackTitle = fallbackData.title || 'YouTube Audio';

        if (fallbackAudio) {
          const aRes = await fetch(fallbackAudio);
          const aBuf = Buffer.from(await aRes.arrayBuffer());
          if (aBuf.length > 5000) {
            return await sock.sendMessage(from, {
              audio: aBuf,
              mimetype: 'audio/mpeg',
              fileName: `${fallbackTitle}.mp3`,
              caption: `🎵 *${fallbackTitle}*\n\n✅ *YouTube MP3 Download (fallback)*`
            });
          }
        }
      } catch (fallbackErr) {}

      // Fallback: Prince API
      try {
        const princeUrl = 'https://api.princetechn.com/api/download/ytmp3';
        const princeRes = await fetch(`${princeUrl}?apikey=prince&url=${encodeURIComponent(url)}`);
        const princeData = await princeRes.json();

        let princeAudio = princeData.result?.download_url || princeData.result?.url || princeData.download_url || princeData.url;
        let princeTitle = princeData.result?.title || princeData.title || 'YouTube Audio';

        if (princeAudio) {
          const aRes = await fetch(princeAudio);
          const aBuf = Buffer.from(await aRes.arrayBuffer());
          if (aBuf.length > 5000) {
            return await sock.sendMessage(from, {
              audio: aBuf,
              mimetype: 'audio/mpeg',
              fileName: `${princeTitle}.mp3`,
              caption: `🎵 *${princeTitle}*\n\n✅ *YouTube MP3 Download (fallback)*`
            });
          }
        }
      } catch (princeErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ Download Error: ${error.message || 'Could not download audio.'}\n\n💡 Make sure the URL is valid and try again.` 
      });
    }
  }
});
register({
  name: 'tgsticker',
  aliases: ['tgstickers', 'tgs', 'teles'],
  category: 'TOOLS',
  description: 'Download stickers from Telegram sticker packs',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🖼️ *Telegram Sticker Downloader*\n\nUsage: ${prefix}${command} <url>\nExample: ${prefix}${command} https://t.me/addstickers/StickerPackName\n\n*Supports:*\n• t.me/addstickers/... (sticker packs)\n• t.me/sticker/... (individual stickers)\n\n*Note:* Sends up to 10 stickers from the pack.` 
      });
    }

    const url = args[0];

    // Check if it's a Telegram sticker link
    if (!url.includes('t.me/addstickers') && !url.includes('t.me/sticker')) {
      return await sock.sendMessage(from, { 
        text: `❌ Invalid URL. Please provide a Telegram sticker link.\nExample: https://t.me/addstickers/StickerPackName` 
      });
    }

    // ==========================================================
    // 🛑 REPLACE THIS WITH YOUR TELEGRAM BOT TOKEN
    // Get token from @BotFather on Telegram
    // ==========================================================
    const BOT_TOKEN = '8837997340:AAFotvN_C0AqVzHdMzrtyWDhTbGhbWolaGw';
    // ==========================================================

    if (BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
      return await sock.sendMessage(from, { 
        text: `❌ Bot token not configured. Please set your token in the command.` 
      });
    }

    // Extract pack name from URL
    let packName = '';
    if (url.includes('t.me/addstickers/')) {
      packName = url.split('t.me/addstickers/')[1].split('?')[0].split('#')[0];
    } else if (url.includes('t.me/sticker')) {
      const match = url.match(/t\.me\/sticker\/([^\s?]+)/);
      if (match) packName = match[1];
    }

    if (!packName) {
      return await sock.sendMessage(from, { 
        text: `❌ Could not extract sticker pack name from URL.` 
      });
    }

    await sock.sendMessage(from, { text: `⏳ Fetching sticker pack: *${packName}*...` });

    try {
      // Use Telegram Bot API to get sticker set
      const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getStickerSet?name=${encodeURIComponent(packName)}`;
      const response = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.description || 'Sticker pack not found.');
      }

      const stickerSet = data.result;
      const stickers = stickerSet.stickers || [];
      const packTitle = stickerSet.title || packName;

      if (stickers.length === 0) {
        return await sock.sendMessage(from, { 
          text: `❌ No stickers found in this pack.` 
        });
      }

      const maxStickers = Math.min(stickers.length, 10);

      await sock.sendMessage(from, { 
        text: `🖼️ *${packTitle}*\n📊 *Total:* ${stickers.length} stickers\n📤 *Sending:* ${maxStickers} stickers\n\n⬇️ Downloading...` 
      });

      let sentCount = 0;

      for (let i = 0; i < maxStickers; i++) {
        try {
          const sticker = stickers[i];
          const fileId = sticker.file_id;

          // Get file path from Telegram
          const fileRes = await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            }
          );

          if (!fileRes.ok) continue;

          const fileData = await fileRes.json();

          if (!fileData.ok) continue;

          const filePath = fileData.result?.file_path;
          if (!filePath) continue;

          // Download the sticker file
          const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
          const stickerRes = await fetch(fileUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          if (!stickerRes.ok) continue;

          const stickerBuffer = Buffer.from(await stickerRes.arrayBuffer());

          if (stickerBuffer.length < 100) continue;

          // Determine if it's a sticker (webp) or image
          const isWebp = filePath.endsWith('.webp');

          if (isWebp) {
            await sock.sendMessage(from, {
              sticker: stickerBuffer,
              caption: `🖼️ ${i+1}/${maxStickers}`
            });
          } else {
            await sock.sendMessage(from, {
              image: stickerBuffer,
              caption: `🖼️ ${i+1}/${maxStickers}`
            });
          }

          sentCount++;
          await new Promise(r => setTimeout(r, 300));

        } catch (stickerErr) {
          console.warn(`Sticker ${i+1} error:`, stickerErr.message);
        }
      }

      if (sentCount === 0) {
        await sock.sendMessage(from, { 
          text: `❌ Failed to download any stickers.\n\n💡 The sticker pack may be private or unavailable.` 
        });
      } else {
        await sock.sendMessage(from, { 
          text: `✅ Downloaded and sent *${sentCount}*/${maxStickers} stickers from *${packTitle}*` 
        });
      }

    } catch (error) {
      console.error('Telegram sticker error:', error);

      // Fallback: Try alternative method
      try {
        const fallbackUrl = `https://t.me/addstickers/${packName}`;
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        if (fallbackRes.ok) {
          const html = await fallbackRes.text();
          const urlMatches = html.match(/https?:\/\/[^\s"']+\.(webp|png|jpg)/gi) || [];
          const uniqueImages = [...new Set(urlMatches)];

          if (uniqueImages.length > 0) {
            const maxFallback = Math.min(uniqueImages.length, 5);
            let fallbackCount = 0;
            for (let i = 0; i < maxFallback; i++) {
              try {
                const imgUrl = uniqueImages[i];
                const imgRes = await fetch(imgUrl);
                if (imgRes.ok) {
                  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
                  if (imgBuf.length > 1000) {
                    await sock.sendMessage(from, {
                      image: imgBuf,
                      caption: `🖼️ ${i+1}/${maxFallback} (fallback)`
                    });
                    fallbackCount++;
                    await new Promise(r => setTimeout(r, 400));
                  }
                }
              } catch (imgErr) {}
            }
            if (fallbackCount > 0) {
              return await sock.sendMessage(from, { 
                text: `✅ Downloaded *${fallbackCount}* images (fallback method).` 
              });
            }
          }
        }
      } catch (fallbackErr) {
        console.warn('Fallback failed:', fallbackErr.message);
      }

      await sock.sendMessage(from, { 
        text: `⚠️ Download Error: ${error.message || 'Could not fetch stickers.'}\n\n💡 Make sure the sticker pack exists and is public.` 
      });
    }
  }
});
register({
  name: 'ytmp4',
  aliases: ['ytv', 'youtube', 'ytdl', 'youtubedl'],
  category: 'DOWNLOADER',
  description: 'Download YouTube videos with quality selection',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🎬 *YouTube MP4 Downloader*\n\nUsage: ${prefix}${command} <url> [quality]\nExample: ${prefix}${command} https://youtu.be/wdJrTQJh1ZQ\n\n*Quality options:*\n• 1080p (best)\n• 720p (default)\n• 480p\n• 360p\n• 240p\n• 144p\n\n*Examples:*\n${prefix}${command} https://youtu.be/xxxxx 1080p\n${prefix}${command} https://youtu.be/xxxxx 720p\n\n*Note:* Download URL expires in 10 minutes.` 
      });
    }

    const url = args[0];
    let quality = '720p'; // Default quality

    // Check if user specified quality
    const qualityArg = (args[1] || '').toLowerCase();
    const validQualities = ['1080p', '720p', '480p', '360p', '240p', '144p'];
    if (validQualities.includes(qualityArg)) {
      quality = qualityArg;
    }

    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      return await sock.sendMessage(from, { 
        text: `❌ Invalid URL. Please provide a valid YouTube link.` 
      });
    }

    await sock.sendMessage(from, { text: `⏳ Processing YouTube video... (${quality})` });

    try {
      // Primary: GiftedTech API
      const response = await fetch(
        `https://api.giftedtech.co.ke/api/download/ytmp4?apikey=gifted&url=${encodeURIComponent(url)}&quality=${quality}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract data
      let title = data.result?.title || 'YouTube Video';
      let thumbnail = data.result?.thumbnail || null;
      let downloadUrl = data.result?.download_url || null;
      let format = data.result?.format || 'mp4';
      let qualityReturned = data.result?.quality || quality;
      let availableQualities = data.result?.availableQualities || [];
      let message = data.result?.message || '';

      if (!downloadUrl) {
        throw new Error("Could not extract download URL from API response.");
      }

      // Send thumbnail if available
      if (thumbnail) {
        try {
          await sock.sendMessage(from, {
            image: { url: thumbnail },
            caption: `🎬 *${title}*\n📊 *Quality:* ${qualityReturned}\n📦 *Format:* ${format}\n${message ? `\n${message}` : ''}\n\n⬇️ *Downloading video...*`
          });
        } catch (thumbErr) {
          await sock.sendMessage(from, { 
            text: `🎬 *${title}*\n📊 *Quality:* ${qualityReturned}\n📦 *Format:* ${format}\n${message ? `\n${message}` : ''}\n\n⬇️ *Downloading video...*` 
          });
        }
      }

      // Download the video
      const videoResponse = await fetch(downloadUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!videoResponse.ok) {
        throw new Error(`Video download failed: ${videoResponse.status}`);
      }

      const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

      if (videoBuffer.length < 5000) {
        throw new Error("Downloaded file is too small. The link may be invalid.");
      }

      const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);

      // Build available qualities message
      let qualityList = '';
      if (availableQualities.length > 0) {
        qualityList = availableQualities.map(q => `${q}p`).join(', ');
      }

      const caption = `🎬 *${title}*\n📊 *Quality:* ${qualityReturned}\n📦 *Format:* ${format}\n📦 *Size:* ${fileSizeMB} MB\n${qualityList ? `📥 *Available:* ${qualityList}` : ''}\n\n✅ *Download Success*\n${message ? `\n⚠️ ${message}` : ''}`;

      // Try to send as video
      try {
        await sock.sendMessage(from, {
          video: videoBuffer,
          mimetype: 'video/mp4',
          caption: caption
        });
      } catch (sendErr) {
        // Fallback: send as document
        await sock.sendMessage(from, {
          document: videoBuffer,
          mimetype: 'video/mp4',
          fileName: `${title.replace(/[^a-zA-Z0-9]/g, '_')}.${format}`,
          caption: caption
        });
      }

    } catch (error) {
      console.error('YouTube MP4 download error:', error);

      // Fallback: OmegaTech API
      try {
        const omegaUrl = 'https://omegatech-api.dixonomega.tech/api/download/ytmp4';
        const fallbackRes = await fetch(`${omegaUrl}?url=${encodeURIComponent(url)}&quality=${quality}`);
        const fallbackData = await fallbackRes.json();

        let fallbackVideo = fallbackData.download_url || fallbackData.url || fallbackData.video;
        let fallbackTitle = fallbackData.title || 'YouTube Video';

        if (fallbackVideo) {
          const vRes = await fetch(fallbackVideo);
          const vBuf = Buffer.from(await vRes.arrayBuffer());
          if (vBuf.length > 5000) {
            return await sock.sendMessage(from, {
              video: vBuf,
              mimetype: 'video/mp4',
              caption: `🎬 *${fallbackTitle}*\n\n✅ *YouTube Download (fallback)*`
            });
          }
        }
      } catch (fallbackErr) {}

      // Fallback: Prince API
      try {
        const princeUrl = 'https://api.princetechn.com/api/download/ytmp4';
        const princeRes = await fetch(`${princeUrl}?apikey=prince&url=${encodeURIComponent(url)}&quality=${quality}`);
        const princeData = await princeRes.json();

        let princeVideo = princeData.result?.download_url || princeData.result?.url || princeData.download_url || princeData.url;
        let princeTitle = princeData.result?.title || princeData.title || 'YouTube Video';

        if (princeVideo) {
          const vRes = await fetch(princeVideo);
          const vBuf = Buffer.from(await vRes.arrayBuffer());
          if (vBuf.length > 5000) {
            return await sock.sendMessage(from, {
              video: vBuf,
              mimetype: 'video/mp4',
              caption: `🎬 *${princeTitle}*\n\n✅ *YouTube Download (fallback)*`
            });
          }
        }
      } catch (princeErr) {}

      // Fallback: Try yt-search with GiftedTech
      try {
        const yts = require('yt-search');
        const searchResults = await yts(url);
        if (searchResults && searchResults.videos && searchResults.videos.length > 0) {
          const target = searchResults.videos[0];
          const ytUrl = target.url;

          const giftedRes = await fetch(
            `https://api.giftedtech.co.ke/api/download/ytmp4?apikey=gifted&url=${encodeURIComponent(ytUrl)}&quality=${quality}`
          );
          const giftedData = await giftedRes.json();

          let giftedVideo = giftedData.result?.download_url || giftedData.download_url || giftedData.url;
          if (giftedVideo) {
            const vRes = await fetch(giftedVideo);
            const vBuf = Buffer.from(await vRes.arrayBuffer());
            if (vBuf.length > 5000) {
              return await sock.sendMessage(from, {
                video: vBuf,
                mimetype: 'video/mp4',
                caption: `🎬 *${target.title}*\n\n✅ *YouTube Download (search fallback)*`
              });
            }
          }
        }
      } catch (ytErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ Download Error: ${error.message || 'Could not download video.'}\n\n💡 Make sure the URL is valid and try again.` 
      });
    }
  }
});

// twitter.js - Twitter/X Video Downloader
register({
  name: 'twitter',
  aliases: ['x', 'xdl', 'twitterdl', 'tweet', 'twitdl'],
  category: 'DOWNLOADER',
  description: 'Download Twitter/X Videos with quality selection',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🐦 *Twitter/X Downloader*\n\nUsage: ${prefix}${command} <url> [quality]\nExample: ${prefix}${command} https://twitter.com/elonmusk/status/1822355008559489216\n\n*Quality options:*\n• 720p (best)\n• 360p (default)\n• 270p (smallest)\n\n*Examples:*\n${prefix}${command} https://twitter.com/user/status/xxxxx 720p\n${prefix}${command} https://x.com/user/status/xxxxx 360p\n\n*Aliases:* ${prefix}x, ${prefix}xdl, ${prefix}twitterdl, ${prefix}tweet\n\n*Note:* Supports Twitter/X video posts.` 
      });
    }

    const url = args[0];
    let preferredQuality = '360p';

    // Check if user specified quality
    if (args[1]) {
      const qualityArg = args[1].toLowerCase();
      const validQualities = ['720p', '360p', '270p', '1080p', '480p'];
      if (validQualities.includes(qualityArg)) {
        preferredQuality = qualityArg;
      }
    }

    // Check URL format
    if (!url.includes('twitter.com') && !url.includes('x.com')) {
      return await sock.sendMessage(from, { 
        text: `❌ Invalid URL. Please provide a valid Twitter/X link.` 
      });
    }

    await sock.sendMessage(from, { text: `⏳ Processing Twitter/X media...` });

    try {
      let videoData = null;

      // ─── API 1: GiftedTech API ───
      try {
        const response = await fetch(
          `https://api.giftedtech.co.ke/api/download/twitter?apikey=gifted&url=${encodeURIComponent(url)}`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
          }
        );

        if (response.ok) {
          const data = await response.json();
          const videoUrls = data.result?.videoUrls || [];
          const images = data.result?.images || [];
          const thumbnail = data.result?.thumbnail || null;

          if (videoUrls.length > 0) {
            // Quality order
            const qualityOrder = ['720p', '480p', '360p', '270p'];
            
            // Find preferred quality
            let selectedVideo = null;
            let selectedQuality = '';

            // Try to match user's preferred quality
            for (const video of videoUrls) {
              if (video.quality === preferredQuality) {
                selectedVideo = video;
                selectedQuality = video.quality;
                break;
              }
            }

            // If not found, use best available
            if (!selectedVideo) {
              for (const q of qualityOrder) {
                for (const video of videoUrls) {
                  if (video.quality === q) {
                    selectedVideo = video;
                    selectedQuality = video.quality;
                    break;
                  }
                }
                if (selectedVideo) break;
              }
            }

            // If still no match, use first one
            if (!selectedVideo && videoUrls.length > 0) {
              selectedVideo = videoUrls[0];
              selectedQuality = selectedVideo.quality || 'Unknown';
            }

            if (selectedVideo) {
              videoData = {
                title: data.result?.title || 'Twitter/X Video',
                thumbnail: thumbnail || (images.length > 0 ? images[0] : null),
                selectedLink: selectedVideo,
                selectedQuality: selectedQuality,
                videoUrls: videoUrls,
                images: images,
                source: 'GiftedTech'
              };
            }
          } else if (images.length > 0) {
            // Image post
            videoData = {
              title: data.result?.title || 'Twitter/X Images',
              thumbnail: images[0] || null,
              images: images,
              isImage: true,
              source: 'GiftedTech'
            };
          }
        }
      } catch (e) {
        console.log('❌ GiftedTech failed:', e.message);
      }

      // ─── API 2: Prince API ───
      if (!videoData) {
        try {
          const response = await fetch(
            `https://api.princetechn.com/api/download/twitter?apikey=prince&url=${encodeURIComponent(url)}`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              signal: AbortSignal.timeout(15000)
            }
          );

          if (response.ok) {
            const data = await response.json();
            const videoUrl = data.result?.video || data.result?.download_url || data.video || data.download_url || data.url;
            const images = data.result?.images || data.images || [];
            const thumbnail = data.result?.thumbnail || data.thumbnail || null;

            if (videoUrl) {
              videoData = {
                title: data.result?.title || data.title || 'Twitter/X Video',
                thumbnail: thumbnail || (images.length > 0 ? images[0] : null),
                selectedLink: { url: videoUrl, quality: 'HD' },
                selectedQuality: 'HD',
                videoUrls: [{ url: videoUrl, quality: 'HD' }],
                images: images,
                source: 'Prince API'
              };
            } else if (images.length > 0) {
              videoData = {
                title: data.result?.title || data.title || 'Twitter/X Images',
                thumbnail: images[0] || null,
                images: images,
                isImage: true,
                source: 'Prince API'
              };
            }
          }
        } catch (e) {
          console.log('❌ Prince API failed:', e.message);
        }
      }

      // ─── API 3: David Cyril API ───
      if (!videoData) {
        try {
          const response = await fetch(
            `https://apis.davidcyril.name.ng/download/twitterx?url=${encodeURIComponent(url)}`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              signal: AbortSignal.timeout(15000)
            }
          );

          if (response.ok) {
            const data = await response.json();
            const videoUrl = data.result?.video || data.video || data.download_url || data.url;
            const images = data.result?.images || data.images || [];

            if (videoUrl) {
              videoData = {
                title: data.result?.title || data.title || 'Twitter/X Video',
                thumbnail: data.result?.thumbnail || data.thumbnail || null,
                selectedLink: { url: videoUrl, quality: 'SD' },
                selectedQuality: 'SD',
                videoUrls: [{ url: videoUrl, quality: 'SD' }],
                images: images,
                source: 'David Cyril'
              };
            } else if (images.length > 0) {
              videoData = {
                title: data.result?.title || data.title || 'Twitter/X Images',
                thumbnail: images[0] || null,
                images: images,
                isImage: true,
                source: 'David Cyril'
              };
            }
          }
        } catch (e) {
          console.log('❌ David Cyril failed:', e.message);
        }
      }

      // ─── API 4: Fallback - Media Downloader ───
      if (!videoData) {
        try {
          const response = await fetch(
            `https://api.media-downloader.xyz/api/twitter?url=${encodeURIComponent(url)}`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              signal: AbortSignal.timeout(10000)
            }
          );

          if (response.ok) {
            const data = await response.json();
            const videoUrl = data.result?.download_url || data.download_url || data.url || data.video;

            if (videoUrl) {
              videoData = {
                title: data.result?.title || data.title || 'Twitter/X Video',
                thumbnail: data.result?.thumbnail || data.thumbnail || null,
                selectedLink: { url: videoUrl, quality: 'SD' },
                selectedQuality: 'SD',
                videoUrls: [{ url: videoUrl, quality: 'SD' }],
                images: [],
                source: 'Media Downloader'
              };
            }
          }
        } catch (e) {
          console.log('❌ Media Downloader failed:', e.message);
        }
      }

      if (!videoData) {
        return await sock.sendMessage(from, { 
          text: `❌ *Download Failed*\n\nCould not fetch media from Twitter/X.\n\n💡 Tips:\n• Make sure the post is public\n• Try a different link\n• URL format: https://twitter.com/user/status/xxxxx or https://x.com/user/status/xxxxx` 
        });
      }

      // ─── HANDLE IMAGE POST ───
      if (videoData.isImage && videoData.images && videoData.images.length > 0) {
        let imageMsg = `🖼️ *${videoData.title}*\n📡 *Source:* ${videoData.source}\n📊 *Images:* ${videoData.images.length}\n\n📥 *Downloading images...*`;

        await sock.sendMessage(from, { text: imageMsg });

        for (let i = 0; i < Math.min(videoData.images.length, 10); i++) {
          const img = videoData.images[i];
          if (img && img.startsWith('http')) {
            try {
              await sock.sendMessage(from, { 
                image: { url: img },
                caption: `🖼️ *${videoData.title}*\n📊 Image ${i + 1}/${videoData.images.length}`
              });
              await new Promise(r => setTimeout(r, 300));
            } catch (imgErr) {
              console.log(`❌ Failed to send image ${i + 1}:`, imgErr.message);
            }
          }
        }
        return;
      }

      // ─── HANDLE VIDEO POST ───
      const videoUrl = videoData.selectedLink.url;
      const quality = videoData.selectedQuality;
      const title = videoData.title || 'Twitter/X Video';
      const thumbnail = videoData.thumbnail || null;

      // ─── SEND THUMBNAIL ───
      if (thumbnail) {
        try {
          await sock.sendMessage(from, {
            image: { url: thumbnail },
            caption: `🐦 *${title}*\n📊 *Quality:* ${quality}\n📡 *Source:* ${videoData.source}\n\n⬇️ *Downloading video...*`
          });
        } catch (thumbErr) {
          await sock.sendMessage(from, { 
            text: `🐦 *${title}*\n📊 *Quality:* ${quality}\n📡 *Source:* ${videoData.source}\n\n⬇️ *Downloading video...*` 
          });
        }
      }

      // ─── DOWNLOAD VIDEO ───
      const videoResponse = await fetch(videoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'video/mp4,video/webm,*/*;q=0.9',
          'Accept-Language': 'en-US,en;q=0.5',
          'Range': 'bytes=0-'
        },
        signal: AbortSignal.timeout(120000)
      });

      if (!videoResponse.ok) {
        throw new Error(`Video download failed: ${videoResponse.status}`);
      }

      let videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

      if (videoBuffer.length < 5000) {
        // Try alternative URL if available
        let altUrl = null;
        if (videoData.videoUrls && videoData.videoUrls.length > 1) {
          for (const v of videoData.videoUrls) {
            if (v.url !== videoUrl) {
              altUrl = v.url;
              break;
            }
          }
        }

        if (altUrl) {
          const altResponse = await fetch(altUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: AbortSignal.timeout(60000)
          });

          if (altResponse.ok) {
            videoBuffer = Buffer.from(await altResponse.arrayBuffer());
          }
        }

        if (videoBuffer.length < 5000) {
          throw new Error("Downloaded file is too small. The link may be invalid.");
        }
      }

      const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);

      // ─── BUILD QUALITY LIST ───
      let qualityList = '';
      if (videoData.videoUrls) {
        const uniqueQualities = [...new Set(videoData.videoUrls.map(v => v.quality || 'Unknown'))];
        uniqueQualities.forEach(q => {
          const check = q === quality ? '✅' : '•';
          qualityList += `${check} ${q}\n`;
        });
      }

      const caption = `🐦 *${title}*\n📊 *Quality:* ${quality}\n📦 *Size:* ${fileSizeMB} MB\n📡 *Source:* ${videoData.source}\n\n${qualityList ? `📥 *Available Qualities:*\n${qualityList}\n` : ''}✅ *Twitter/X Download Success*\n\n💡 Use ${prefix}${command} <url> <quality> to select quality.`;

      // ─── SEND VIDEO ───
      if (videoBuffer.length > 16 * 1024 * 1024) {
        await sock.sendMessage(from, {
          document: videoBuffer,
          mimetype: 'video/mp4',
          fileName: `twitter_${Date.now()}.mp4`,
          caption: `🐦 *${title}*\n📊 *Quality:* ${quality}\n📦 *Size:* ${fileSizeMB} MB\n\n⚠️ *Sent as document (16MB limit)*`
        });
      } else {
        try {
          await sock.sendMessage(from, {
            video: videoBuffer,
            mimetype: 'video/mp4',
            caption: caption
          });
        } catch (sendErr) {
          await sock.sendMessage(from, {
            document: videoBuffer,
            mimetype: 'video/mp4',
            fileName: `twitter_${Date.now()}.mp4`,
            caption: `🐦 *${title}*\n📊 *Quality:* ${quality}\n📦 *Size:* ${fileSizeMB} MB\n\n✅ *Twitter/X Download Success*`
          });
        }
      }

      console.log(`✅ Twitter/X video sent: "${title}" (${fileSizeMB}MB, ${quality})`);

    } catch (error) {
      console.error('Twitter/X download error:', error);

      // ─── EMERGENCY FALLBACK: fxtwitter ───
      try {
        const fxUrl = url.replace('twitter.com', 'fxtwitter.com').replace('x.com', 'fxtwitter.com');
        const fxRes = await fetch(fxUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (fxRes.ok) {
          const html = await fxRes.text();
          const videoMatch = html.match(/<video[^>]*src="([^"]*)"[^>]*>/);
          if (videoMatch) {
            const vUrl = videoMatch[1];
            const vRes = await fetch(vUrl);
            const vBuf = Buffer.from(await vRes.arrayBuffer());
            if (vBuf.length > 5000) {
              return await sock.sendMessage(from, { 
                video: vBuf, 
                mimetype: 'video/mp4',
                caption: '✅ *Twitter/X Download (fxTwitter fallback)*' 
              });
            }
          }
        }
      } catch (fxErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ *Download Error*\n\n${error.message || 'Could not download media.'}\n\n💡 Tips:\n• Make sure the URL is valid\n• Post must be public\n• Try a different quality\n• Use ${prefix}x <url> 720p for best quality` 
      });
    }
  }
});

register({
  name: 'pinterest',
  aliases: ['pin', 'pins', 'pinvideo', 'pinterestdl'],
  category: 'DOWNLOADER',
  description: 'Search and download Pinterest videos',
  async execute({ sock, from, args, prefix, command }) {
    // ==========================================================
    // Check if user provided a search query
    // ==========================================================
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `📌 *Pinterest Video Search & Download*\n\nUsage: ${prefix}${command} <query>\nExample: ${prefix}${command} Naruto\n\n*Examples:*\n${prefix}${command} Anime\n${prefix}${command} Nature wallpaper\n${prefix}${command} Aesthetic\n${prefix}${command} Funny cats\n\n*Note:* Returns up to 10 video results with download links.` 
      });
    }

    const query = args.join(" ");

    await sock.sendMessage(from, { 
      text: `📌 *Searching Pinterest for:* ${query}` 
    });

    try {
      // ==========================================================
      // Call Pinterest Search API
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/download/Pinterest`);
      apiUrl.searchParams.append('action', 'search');
      apiUrl.searchParams.append('query', query);

      const response = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Check if search was successful
      // ==========================================================
      if (!data.success) {
        return await sock.sendMessage(from, { 
          text: `❌ Search failed: ${data.message || 'Unknown error'}` 
        });
      }

      const videos = data.data?.videos || [];
      
      if (!videos.length) {
        return await sock.sendMessage(from, { 
          text: `❌ No videos found for "${query}".` 
        });
      }

      // ==========================================================
      // Send results (max 10)
      // ==========================================================
      const maxResults = Math.min(videos.length, 10);
      
      await sock.sendMessage(from, { 
        text: `📌 *Found ${videos.length} videos for "${query}"*\n📤 *Sending ${maxResults} results...*` 
      });

      for (let i = 0; i < maxResults; i++) {
        const video = videos[i];
        
        const title = video.title || 'Untitled';
        const description = video.description || 'No description';
        const videoUrl = video.video || '';
        const thumbnail = video.thumbnail || '';
        const link = video.link || '';
        const pinner = video.pinner || 'Unknown';
        const username = video.username || '';
        const likes = video.likes || 0;

        if (!videoUrl) continue;

        let msg = `📌 *${title}*\n`;
        msg += `👤 *Pinner:* ${pinner}${username ? ` (@${username})` : ''}\n`;
        msg += `❤️ *Likes:* ${likes.toLocaleString()}\n`;
        msg += `📝 *Description:* ${description.slice(0, 100)}${description.length > 100 ? '...' : ''}\n`;
        msg += `🔗 *Link:* ${link}\n\n`;
        msg += `⬇️ *Downloading video...*`;

        // Send thumbnail with info
        if (thumbnail) {
          try {
            await sock.sendMessage(from, {
              image: { url: thumbnail },
              caption: msg
            });
          } catch (thumbErr) {
            await sock.sendMessage(from, { text: msg });
          }
        } else {
          await sock.sendMessage(from, { text: msg });
        }

        // ==========================================================
        // Download and send the video
        // ==========================================================
        try {
          const videoResponse = await fetch(videoUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://www.pinterest.com/'
            }
          });

          if (videoResponse.ok) {
            const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
            
            if (videoBuffer.length > 5000) {
              const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
              
              // If video is too large, send as document
              if (videoBuffer.length > 16 * 1024 * 1024) {
                await sock.sendMessage(from, {
                  document: videoBuffer,
                  mimetype: 'video/mp4',
                  fileName: `pinterest_${Date.now()}.mp4`,
                  caption: `📌 *${title}*\n📦 *Size:* ${fileSizeMB} MB\n\n⚠️ *Sent as document due to 16MB limit.*`
                });
              } else {
                try {
                  await sock.sendMessage(from, {
                    video: videoBuffer,
                    mimetype: 'video/mp4',
                    caption: `📌 *${title}*\n❤️ ${likes} likes\n📦 *Size:* ${fileSizeMB} MB\n\n✅ *Pinterest Download Success*`
                  });
                } catch (sendErr) {
                  // Fallback: send as document
                  await sock.sendMessage(from, {
                    document: videoBuffer,
                    mimetype: 'video/mp4',
                    fileName: `pinterest_${Date.now()}.mp4`,
                    caption: `📌 *${title}*\n📦 *Size:* ${fileSizeMB} MB`
                  });
                }
              }
            }
          }
        } catch (dlErr) {
          console.warn(`Failed to download video ${i+1}:`, dlErr.message);
          await sock.sendMessage(from, { 
            text: `⚠️ Failed to download video ${i+1}. Skipping...` 
          });
        }

        // Small delay between videos
        await new Promise(r => setTimeout(r, 1000));
      }

      await sock.sendMessage(from, { 
        text: `✅ *Sent ${maxResults} videos from Pinterest.*\n💡 Use ${prefix}${command} <query> to search more.` 
      });

    } catch (error) {
      console.error('Pinterest error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not search Pinterest.'}\n\n💡 Try:\n• ${prefix}${command} Naruto\n• ${prefix}${command} Anime\n• ${prefix}${command} Nature\n\n💡 Or try again later.` 
      });
    }
  }
});



register({
  name: 'livescore',
  aliases: ['score', 'football', 'scores', 'livefootball'],
  category: 'INFO',
  description: 'Get live football scores and match updates',
  async execute({ sock, from, args, prefix, command }) {
    // Check if user wants to filter by league
    let filter = '';
    if (args[0]) {
      filter = args.join(' ').toLowerCase();
    }

    await sock.sendMessage(from, { text: `⏳ Fetching live scores...` });

    try {
      // Primary: GiftedTech API
      const response = await fetch(
        `https://api.giftedtech.co.ke/api/football/livescore2?apikey=gifted`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract matches
      let matches = data.result?.matches || [];
      let totalMatches = data.result?.totalMatches || 0;

      if (!matches || matches.length === 0) {
        return await sock.sendMessage(from, { 
          text: `⚠️ No matches found right now.` 
        });
      }

      // Filter by league if specified
      if (filter) {
        matches = matches.filter(m => 
          m.league?.toLowerCase().includes(filter) ||
          m.homeTeam?.toLowerCase().includes(filter) ||
          m.awayTeam?.toLowerCase().includes(filter)
        );
      }

      if (matches.length === 0) {
        return await sock.sendMessage(from, { 
          text: `❌ No matches found for "${filter}".\n\n💡 Try a different filter or remove it.` 
        });
      }

      // Limit to 20 matches to avoid message overflow
      const maxMatches = Math.min(matches.length, 20);

      // Build the response
      let msg = `⚽ *LIVE SCORES*\n`;
      if (filter) msg += `📌 *Filter:* ${filter}\n`;
      msg += `📊 *Showing:* ${maxMatches}/${matches.length} matches\n\n`;

      matches.slice(0, maxMatches).forEach((match) => {
        const home = match.homeTeam || 'Unknown';
        const away = match.awayTeam || 'Unknown';
        const homeScore = match.homeScore || '0';
        const awayScore = match.awayScore || '0';
        const league = match.league || 'Unknown League';
        const status = match.status || 'Unknown';
        const startTime = match.startTime ? new Date(match.startTime).toLocaleString() : 'N/A';

        // Status emoji
        let statusEmoji = '⏳';
        if (status.toLowerCase().includes('full time') || status.toLowerCase().includes('ft')) {
          statusEmoji = '✅ FT';
        } else if (status.toLowerCase().includes('live') || status.toLowerCase().includes('in progress')) {
          statusEmoji = '🟢 LIVE';
        } else if (status.toLowerCase().includes('half time')) {
          statusEmoji = '⏸️ HT';
        } else if (status.toLowerCase().includes('scheduled')) {
          statusEmoji = '📅';
        }

        msg += `${statusEmoji} *${league}*\n`;
        msg += `🏠 ${home} ${homeScore} - ${awayScore} ${away}\n`;
        msg += `📅 ${startTime}\n\n`;
      });

      if (matches.length > 20) {
        msg += `\n*Showing 20 of ${matches.length} matches.*\n`;
        msg += `💡 Use ${prefix}${command} <league> to filter results.`;
      }

      // Send as text
      await sock.sendMessage(from, { text: msg });

    } catch (error) {
      console.error('Livescore error:', error);

      // Fallback: Try alternative endpoint
      try {
        const fallbackUrl = 'https://api.giftedtech.co.ke/api/football/livescore';
        const fallbackRes = await fetch(`${fallbackUrl}?apikey=gifted`);
        const fallbackData = await fallbackRes.json();

        let fallbackMatches = fallbackData.result?.matches || [];

        if (fallbackMatches.length > 0) {
          let msg = `⚽ *Live Scores (fallback)*\n\n`;
          fallbackMatches.slice(0, 15).forEach((match) => {
            const home = match.homeTeam || 'Unknown';
            const away = match.awayTeam || 'Unknown';
            const score = match.score || `${match.homeScore || 0} - ${match.awayScore || 0}`;
            const league = match.league || 'Unknown League';
            msg += `*${league}*\n${home} ${score} ${away}\n\n`;
          });
          return await sock.sendMessage(from, { text: msg });
        }
      } catch (fallbackErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ Livescore Error: ${error.message || 'Could not fetch scores.'}\n\n💡 Try again later.` 
      });
    }
  }
});
register({
  name: 'neko',
  aliases: ['nekogirl', 'animecat', 'nekoai'],
  category: 'TOOLS',
  description: 'Get a random Neko anime girl image',
  async execute({ sock, from, prefix, command }) {
    await sock.sendMessage(from, { text: `⏳ Fetching a neko image...` });

    try {
      // Primary: GiftedTech API
      const response = await fetch(
        `https://api.giftedtech.co.ke/api/anime/neko?apikey=gifted`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract image URL
      let imageUrl = data.result || data.url || data.image || data.data?.url || data.data?.result;

      if (!imageUrl) {
        const jsonString = JSON.stringify(data);
        const urlMatch = jsonString.match(/https?:\/\/[^\s"']+\.(png|jpg|jpeg|gif|webp)/i);
        if (urlMatch) imageUrl = urlMatch[0];
      }

      if (!imageUrl) {
        throw new Error("Could not extract image URL from API response.");
      }

      // Send the image
      await sock.sendMessage(from, {
        image: { url: imageUrl },
        caption: `🐱 *Neko Girl*\n\n✨ _Powered by INCONNU XD V2_`
      });

    } catch (error) {
      console.error('Neko error:', error);

      // Fallback: Waifu API (sfw/neko)
      try {
        const fallbackRes = await fetch('https://api.waifu.pics/sfw/neko');
        const fallbackData = await fallbackRes.json();

        if (fallbackData && fallbackData.url) {
          return await sock.sendMessage(from, {
            image: { url: fallbackData.url },
            caption: `🐱 *Neko Girl (fallback)*\n\n✨ _Powered by INCONNU XD V2_`
          });
        }
      } catch (fallbackErr) {}

      // Fallback: Another anime API
      try {
        const anotherRes = await fetch('https://nekos.life/api/v2/img/neko');
        const anotherData = await anotherRes.json();

        if (anotherData && anotherData.url) {
          return await sock.sendMessage(from, {
            image: { url: anotherData.url },
            caption: `🐱 *Neko Girl (fallback)*\n\n✨ _Powered by INCONNU XD V2_`
          });
        }
      } catch (anotherErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ Neko Error: ${error.message || 'Could not fetch image.'}\n\n💡 Try again later.` 
      });
    }
  }
});
register({
  name: 'scores',
  aliases: ['livescore', 'football', 'matches', 'livefootball'],
  category: 'INFO',
  description: 'Fetch live football matches and scores',
  async execute({ sock, from, args, prefix, command }) {
    // Check if user wants to filter by league or team
    let filter = '';
    if (args[0]) {
      filter = args.join(' ').toLowerCase();
    }

    await sock.sendMessage(from, { text: `⏳ Fetching live football scores...` });

    try {
      // ==========================================================
      // Primary: OmegaTech API - /api/tools/scores
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const response = await fetch(`${baseUrl}/api/tools/scores`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Extract matches from response
      // ==========================================================
      let matches = data.result?.matches || data.matches || data.data || [];
      let totalMatches = matches.length || data.total || data.count || 0;

      // Handle case where data might be an object with matches inside
      if (data.result && !Array.isArray(data.result)) {
        matches = data.result.matches || data.result.fixtures || data.result.data || [];
      }

      if (!matches || !Array.isArray(matches) || matches.length === 0) {
        return await sock.sendMessage(from, { 
          text: `⚽ No live matches found right now.\n\n💡 Check back later or try:\n${prefix}${command} premier league\n${prefix}${command} la liga\n${prefix}${command} champions league` 
        });
      }

      // ==========================================================
      // Apply filter if specified
      // ==========================================================
      if (filter) {
        const filtered = matches.filter(m => {
          const league = (m.league || m.competition || m.tournament || '').toLowerCase();
          const home = (m.homeTeam || m.home || m.team1 || '').toLowerCase();
          const away = (m.awayTeam || m.away || m.team2 || '').toLowerCase();
          return league.includes(filter) || home.includes(filter) || away.includes(filter);
        });
        
        if (filtered.length === 0) {
          return await sock.sendMessage(from, { 
            text: `❌ No matches found for "${filter}".\n\n💡 Try a different filter or remove it.\n\n*Examples:*\n${prefix}${command} premier league\n${prefix}${command} manchester\n${prefix}${command} champions` 
          });
        }
        matches = filtered;
        totalMatches = matches.length;
      }

      // ==========================================================
      // Limit to 20 matches to avoid message overflow
      // ==========================================================
      const maxMatches = Math.min(matches.length, 25);

      // ==========================================================
      // Build the response
      // ==========================================================
      let msg = `⚽ *LIVE FOOTBALL SCORES*\n`;
      if (filter) msg += `📌 *Filter:* ${filter}\n`;
      msg += `📊 *Showing:* ${maxMatches}/${matches.length} matches\n`;
      msg += `🕐 *Updated:* ${new Date().toLocaleString()}\n\n`;

      let matchCount = 0;
      for (const match of matches) {
        if (matchCount >= maxMatches) break;
        
        // Extract match data with fallbacks
        const home = match.homeTeam || match.home || match.team1 || 'Unknown';
        const away = match.awayTeam || match.away || match.team2 || 'Unknown';
        const homeScore = match.homeScore !== undefined ? match.homeScore : (match.score?.home || match.score1 || '?');
        const awayScore = match.awayScore !== undefined ? match.awayScore : (match.score?.away || match.score2 || '?');
        const league = match.league || match.competition || match.tournament || 'Unknown League';
        const status = match.status || match.matchStatus || match.time || 'Unknown';
        const startTime = match.startTime || match.kickoff || match.datetime || '';

        // Format time
        let timeDisplay = '';
        if (startTime) {
          try {
            const date = new Date(startTime);
            if (!isNaN(date)) {
              timeDisplay = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            }
          } catch (e) {}
        }

        // Status emoji
        let statusEmoji = '⏳';
        const statusLower = (status || '').toLowerCase();
        if (statusLower.includes('full time') || statusLower.includes('ft') || statusLower.includes('finished')) {
          statusEmoji = '✅ FT';
        } else if (statusLower.includes('live') || statusLower.includes('in progress') || statusLower.includes('playing')) {
          statusEmoji = '🟢 LIVE';
        } else if (statusLower.includes('half time') || statusLower.includes('ht')) {
          statusEmoji = '⏸️ HT';
        } else if (statusLower.includes('scheduled') || statusLower.includes('upcoming')) {
          statusEmoji = '📅';
        } else if (statusLower.includes('penalty') || statusLower.includes('pen')) {
          statusEmoji = '⚽ PEN';
        }

        // Format score display
        let scoreDisplay = `${homeScore} - ${awayScore}`;
        if (homeScore === '?' || awayScore === '?') {
          scoreDisplay = 'vs';
        }

        msg += `${statusEmoji} *${league}*\n`;
        msg += `🏠 ${home} ${scoreDisplay} ${away}\n`;
        if (timeDisplay) msg += `🕐 ${timeDisplay}`;
        if (status && !statusLower.includes('live')) msg += ` | ${status}`;
        msg += `\n\n`;

        matchCount++;
      }

      if (matches.length > 25) {
        msg += `\n*Showing 25 of ${matches.length} matches.*\n`;
        msg += `💡 Use ${prefix}${command} <league/team> to filter results.`;
      }

      // ==========================================================
      // Send the message
      // ==========================================================
      await sock.sendMessage(from, { text: msg });

    } catch (error) {
      console.error('Scores error:', error);

      // ==========================================================
      // Fallback: Try alternative endpoints
      // ==========================================================
      const fallbacks = [
        'https://api.giftedtech.co.ke/api/football/livescore2?apikey=gifted',
        'https://api.princetechn.com/api/tools/scores?apikey=prince',
        'https://apis.davidcyril.name.ng/sports/football'
      ];

      for (const fallbackUrl of fallbacks) {
        try {
          const fallbackRes = await fetch(fallbackUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });

          if (fallbackRes.ok) {
            const fallbackData = await fallbackRes.json();
            let fallbackMatches = fallbackData.result?.matches || 
                                 fallbackData.matches || 
                                 fallbackData.data || 
                                 fallbackData.fixtures || [];

            if (fallbackMatches && fallbackMatches.length > 0) {
              let msg = `⚽ *Live Scores (fallback)*\n\n`;
              const filtered = filter ? fallbackMatches.filter(m => {
                const league = (m.league || m.competition || '').toLowerCase();
                const home = (m.homeTeam || m.home || '').toLowerCase();
                const away = (m.awayTeam || m.away || '').toLowerCase();
                return league.includes(filter) || home.includes(filter) || away.includes(filter);
              }) : fallbackMatches;

              const display = (filter && filtered.length > 0) ? filtered : fallbackMatches;
              const limit = Math.min(display.length, 15);

              for (let i = 0; i < limit; i++) {
                const m = display[i];
                const home = m.homeTeam || m.home || 'Unknown';
                const away = m.awayTeam || m.away || 'Unknown';
                const score = m.score || `${m.homeScore || 0} - ${m.awayScore || 0}`;
                const league = m.league || m.competition || 'Unknown League';
                msg += `*${league}*\n${home} ${score} ${away}\n\n`;
              }

              if (filter && filtered.length === 0) {
                msg = `❌ No matches found for "${filter}". Try a different filter.`;
              }

              return await sock.sendMessage(from, { text: msg });
            }
          }
        } catch (fallbackErr) {
          console.warn(`Fallback ${fallbackUrl} failed:`, fallbackErr.message);
        }
      }

      // ==========================================================
      // All fallbacks failed
      // ==========================================================
      await sock.sendMessage(from, { 
        text: `⚠️ Could not fetch live scores: ${error.message || 'Unknown error'}\n\n💡 Try:\n• ${prefix}${command} premier league\n• ${prefix}${command} la liga\n• ${prefix}${command} manchester united\n\n💡 Or try again in a few minutes.` 
      });
    }
  }
});
register({
  name: 'nanobanana',
  aliases: ['nano', 'bananaimg', 'nanobanana2', 'nbanana', 'txt2img'],
  category: 'AI',
  description: 'Generate AI images from text prompts using NanoBanana 2',
  async execute({ sock, from, args, prefix, command }) {
    // ==========================================================
    // Check if user provided a prompt
    // ==========================================================
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🍌 *NanoBanana 2 - AI Image Generator*\n\nUsage: ${prefix}${command} <prompt>\nExample: ${prefix}${command} A cow in city\n\n*Examples:*\n${prefix}${command} A beautiful sunset over mountains\n${prefix}${command} A cyberpunk city at night\n${prefix}${command} A cat wearing a wizard hat\n${prefix}${command} A floating island in space\n\n*Note:* Generates high-quality images using NanoBanana Pro.` 
      });
    }

    const prompt = args.join(" ");

    await sock.sendMessage(from, { 
      text: `🍌 *Generating image...*\n📝 *Prompt:* ${prompt}\n⏳ This may take 10-20 seconds...` 
    });

    try {
      // ==========================================================
      // Call NanoBanana Pro API
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/ai/nano-banana-pro`);
      apiUrl.searchParams.append('prompt', prompt);

      const response = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Check if generation was successful
      // ==========================================================
      if (!data.success) {
        return await sock.sendMessage(from, { 
          text: `❌ Image generation failed: ${data.message || 'Unknown error'}` 
        });
      }

      // ==========================================================
      // Extract image URL
      // ==========================================================
      const imageUrl = data.image || data.result?.image || data.result?.url || data.url;

      if (!imageUrl) {
        return await sock.sendMessage(from, { 
          text: `❌ No image URL returned from the API.` 
        });
      }

      // ==========================================================
      // Download the image
      // ==========================================================
      const imageResponse = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!imageResponse.ok) {
        throw new Error(`Failed to download image: ${imageResponse.status}`);
      }

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

      if (imageBuffer.length < 1000) {
        return await sock.sendMessage(from, { 
          text: `❌ Generated image is too small. Please try again.` 
        });
      }

      const fileSize = (imageBuffer.length / 1024).toFixed(1);

      // ==========================================================
      // Send the image
      // ==========================================================
      const model = data.model || 'NanoBanana 2';
      const timestamp = data.timestamp ? new Date(data.timestamp).toLocaleString() : 'Just now';

      await sock.sendMessage(from, {
        image: imageBuffer,
        caption: `🍌 *${model}*\n\n📝 *Prompt:* ${prompt}\n📦 *Size:* ${fileSize} KB\n🕐 *Generated:* ${timestamp}\n\n✅ *Image Generated Successfully*\n\n✨ _Powered by OmegaTech_`
      });

    } catch (error) {
      console.error('NanoBanana error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not generate image.'}\n\n💡 Try:\n• A different prompt\n• A shorter prompt\n• ${prefix}${command} a cat sitting on a chair\n• ${prefix}${command} beautiful landscape\n\n💡 Or try again later.` 
      });
    }
  }
});

// gifreact.js - GIF Reaction Finder
register({
  name: 'gifreact',
  aliases: ['gr', 'reaction', 'reactgif', 'gif'],
  category: 'TOOLS',
  description: 'Send a random GIF reaction based on keyword',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🎬 *GIF Reaction*\n\nUsage: ${prefix || '.'}gifreact <keyword>\nExample: ${prefix || '.'}gifreact happy\n\n*Popular keywords:*\nhappy, sad, angry, laugh, cry, love, hug, kiss, dance, wave, hello, bye, yes, no, sorry, thank you, welcome, good morning, good night, fire, cool, wow, omg, lol, bruh, shocked, confused, thinking, sleepy, hungry, eat, party, celebrate, workout, running, singing, dancing, gaming, reading, sleeping, crying, laughing, smiling, waving, hugging, kissing, fighting, running, jumping, swimming, flying, driving, cooking, eating, drinking, working, studying, playing, shopping, traveling` 
      });
    }

    const keyword = args.join(' ').toLowerCase();
    await sock.sendMessage(from, { text: `⏳ Finding reaction for: *${keyword}*...` });

    try {
      let gifUrl = null;
      let usedApi = '';
      let gifTitle = '';

      // ─── API 1: Tenor ───
      try {
        const res = await fetch(
          `https://api.tenor.com/v1/search?q=${encodeURIComponent(keyword)}&key=LIVDSRZULELA&limit=30`,
          {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(10000)
          }
        );

        if (res.ok) {
          const data = await res.json();
          const results = data.results || [];
          const valid = results.filter(r => r.media && r.media.length > 0);
          
          if (valid.length > 0) {
            const random = valid[Math.floor(Math.random() * valid.length)];
            gifUrl = random.media[0]?.gif?.url || random.media[0]?.tinygif?.url || random.media[0]?.mediumgif?.url;
            gifTitle = random.title || keyword;
            usedApi = 'Tenor';
          }
        }
      } catch (e) {
        console.log('❌ Tenor failed:', e.message);
      }

      // ─── API 2: Giphy ───
      if (!gifUrl) {
        try {
          const res = await fetch(
            `https://api.giphy.com/v1/gifs/search?api_key=dc6zaTOxFJmzC&q=${encodeURIComponent(keyword)}&limit=25&rating=g`,
            {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
              signal: AbortSignal.timeout(10000)
            }
          );

          if (res.ok) {
            const data = await res.json();
            const results = data.data || [];
            const valid = results.filter(r => r.images && r.images.original);
            
            if (valid.length > 0) {
              const random = valid[Math.floor(Math.random() * valid.length)];
              gifUrl = random.images?.original?.url || random.images?.downsized?.url || random.images?.fixed_height?.url;
              gifTitle = random.title || keyword;
              usedApi = 'Giphy';
            }
          }
        } catch (e) {
          console.log('❌ Giphy failed:', e.message);
        }
      }

      // ─── API 3: Giphy Trending (fallback) ───
      if (!gifUrl) {
        try {
          const res = await fetch(
            `https://api.giphy.com/v1/gifs/trending?api_key=dc6zaTOxFJmzC&limit=20&rating=g`,
            {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
              signal: AbortSignal.timeout(10000)
            }
          );

          if (res.ok) {
            const data = await res.json();
            const results = data.data || [];
            const valid = results.filter(r => r.images && r.images.original);
            
            if (valid.length > 0) {
              const random = valid[Math.floor(Math.random() * valid.length)];
              gifUrl = random.images?.original?.url || random.images?.downsized?.url;
              gifTitle = random.title || 'Trending GIF';
              usedApi = 'Giphy (Trending)';
            }
          }
        } catch (e) {
          console.log('❌ Giphy Trending failed:', e.message);
        }
      }

      // ─── API 4: Tenor Trending (fallback) ───
      if (!gifUrl) {
        try {
          const res = await fetch(
            `https://api.tenor.com/v1/trending?key=LIVDSRZULELA&limit=20`,
            {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
              signal: AbortSignal.timeout(10000)
            }
          );

          if (res.ok) {
            const data = await res.json();
            const results = data.results || [];
            const valid = results.filter(r => r.media && r.media.length > 0);
            
            if (valid.length > 0) {
              const random = valid[Math.floor(Math.random() * valid.length)];
              gifUrl = random.media[0]?.gif?.url || random.media[0]?.tinygif?.url;
              gifTitle = random.title || 'Trending GIF';
              usedApi = 'Tenor (Trending)';
            }
          }
        } catch (e) {
          console.log('❌ Tenor Trending failed:', e.message);
        }
      }

      if (!gifUrl) {
        return await sock.sendMessage(from, { 
          text: `❌ No GIF found for "${keyword}". Try a different keyword.\n\n💡 Popular: happy, sad, angry, laugh, cry, love, hug, kiss, dance, wave, hello, bye, yes, no, sorry, thank you, welcome` 
        });
      }

      // ─── SEND THE GIF ───
      try {
        await sock.sendMessage(from, {
          image: { url: gifUrl },
          caption: `🎬 *${(gifTitle || keyword).toUpperCase()}*\n📌 Source: ${usedApi}\n\n✨ _Powered by INCONNU XD V2_`
        });
      } catch (sendErr) {
        // If image send fails, try sending as document
        const gifRes = await fetch(gifUrl);
        const gifBuf = Buffer.from(await gifRes.arrayBuffer());
        await sock.sendMessage(from, {
          document: gifBuf,
          mimetype: 'image/gif',
          fileName: `${keyword}_${Date.now()}.gif`,
          caption: `🎬 *${(gifTitle || keyword).toUpperCase()}*\n📌 Source: ${usedApi}`
        });
      }

    } catch (error) {
      console.error('GIF reaction error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not fetch GIF.'}\n\n💡 Try again later or use a different keyword.` 
      });
    }
  }
});
register({
  name: 'spotify',
  aliases: ['sp', 'spsearch', 'spotifydl', 'spotifysearch'],
  category: 'DOWNLOADER',
  description: 'Search Spotify tracks and get preview audio',
  async execute({ sock, from, args, prefix, command }) {
    // ==========================================================
    // Check if user provided a search query
    // ==========================================================
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🎵 *Spotify Search & Preview*\n\nUsage: ${prefix}${command} <song/artist>\nExample: ${prefix}${command} Alone\n\n*Examples:*\n${prefix}${command} Shape of You\n${prefix}${command} Drake\n${prefix}${command} Bohemian Rhapsody\n${prefix}${command} Blinding Lights\n\n*Note:* Returns top 5 results with 30-second previews.` 
      });
    }

    const query = args.join(" ");

    await sock.sendMessage(from, { 
      text: `🎵 *Searching Spotify for:* ${query}` 
    });

    try {
      // ==========================================================
      // Call Spotify Search API
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/Search/Spotify`);
      apiUrl.searchParams.append('query', query);
      apiUrl.searchParams.append('type', 'tracks');
      apiUrl.searchParams.append('preview', 'true');

      const response = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Check if search was successful
      // ==========================================================
      if (!data.success) {
        return await sock.sendMessage(from, { 
          text: `❌ Search failed: ${data.message || 'Unknown error'}` 
        });
      }

      const tracks = data.tracks || [];
      
      if (!tracks.length) {
        return await sock.sendMessage(from, { 
          text: `❌ No results found for "${query}".` 
        });
      }

      // ==========================================================
      // Build and send results
      // ==========================================================
      const maxResults = Math.min(tracks.length, 5);
      
      for (let i = 0; i < maxResults; i++) {
        const track = tracks[i];
        
        const title = track.title || 'Unknown';
        const artist = track.artist || 'Unknown';
        const album = track.album || 'Unknown';
        const duration = track.duration || '0:00';
        const explicit = track.explicit ? '🔞' : '✅';
        const thumb = track.thumb || '';
        const url = track.url || '';
        const previewUrl = track.previewUrl || '';

        let msg = `🎵 *${title}*\n`;
        msg += `👤 *Artist:* ${artist}\n`;
        msg += `💿 *Album:* ${album}\n`;
        msg += `⏱️ *Duration:* ${duration}\n`;
        msg += `📌 *Explicit:* ${explicit}\n`;
        msg += `🔗 *Spotify:* ${url}\n\n`;

        if (previewUrl) {
          msg += `🎧 *Preview:* ${previewUrl}`;
        } else {
          msg += `❌ *No preview available*`;
        }

        // Send with thumbnail if available
        if (thumb) {
          try {
            await sock.sendMessage(from, {
              image: { url: thumb },
              caption: msg
            });
          } catch (thumbErr) {
            await sock.sendMessage(from, { text: msg });
          }
        } else {
          await sock.sendMessage(from, { text: msg });
        }

        // Small delay between results
        await new Promise(r => setTimeout(r, 500));
      }

    } catch (error) {
      console.error('Spotify error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not search Spotify.'}\n\n💡 Try:\n• ${prefix}${command} Alone\n• ${prefix}${command} Shape of You\n• ${prefix}${command} Drake\n\n💡 Or try again later.` 
      });
    }
  }
});
register({
  name: 'bible',
  aliases: ['verse', 'scripture', 'bibleverse'],
  category: 'TOOLS',
  description: 'Get Bible verses with translation options',
  async execute({ sock, from, args, prefix, command }) {
    const query = args.join(' ');

    // ─── CHECK FOR TRANSLATION FLAG ───
    let translation = 'kjv'; // Default
    let cleanQuery = query;

    const translationMatch = query.match(/--(kjv|asv|web|bbe|akjv|ylt|dby|nkjv|niv|esv|nasb|nlt|msg|amp)/i);
    if (translationMatch) {
      translation = translationMatch[1].toLowerCase();
      cleanQuery = query.replace(/--\w+/i, '').trim();
    }

    // ─── PARSE VERSE REFERENCE ───
    const verseMatch = cleanQuery.match(/^(\d?\s?\w+)\s+(\d+):(\d+)(?:-(\d+))?$/);
    const isSearch = cleanQuery.length > 0 && !verseMatch;

    // ─── BUILD TRANSLATION TEXT ───
    const transMap = {
      'kjv': 'King James Version',
      'asv': 'American Standard Version',
      'web': 'World English Bible',
      'bbe': 'Bible in Basic English',
      'akjv': 'Authorized King James Version',
      'ylt': 'Young\'s Literal Translation',
      'dby': 'Darby Bible',
      'nkjv': 'New King James Version',
      'niv': 'New International Version',
      'esv': 'English Standard Version',
      'nasb': 'New American Standard Bible',
      'nlt': 'New Living Translation',
      'msg': 'The Message',
      'amp': 'Amplified Bible'
    };
    const transName = transMap[translation] || 'KJV';

    try {
      let url = '';
      let label = '';

      // ─── DETERMINE QUERY TYPE ───
      if (verseMatch) {
        // ─── SPECIFIC VERSE ───
        const book = verseMatch[1].trim();
        const chapter = parseInt(verseMatch[2]);
        const startVerse = parseInt(verseMatch[3]);
        const endVerse = verseMatch[4] ? parseInt(verseMatch[4]) : startVerse;
        
        url = `https://bible-api.com/${encodeURIComponent(book)} ${chapter}:${startVerse}${endVerse !== startVerse ? '-' + endVerse : ''}?translation=${translation}`;
        label = `${book} ${chapter}:${startVerse}${endVerse !== startVerse ? '-' + endVerse : ''}`;
        
        await sock.sendMessage(from, { text: `📖 *Searching for ${label} (${transName})...*` });
      } else if (isSearch) {
        // ─── SEARCH ───
        url = `https://bible-api.com/${encodeURIComponent(cleanQuery)}?translation=${translation}`;
        label = `"${cleanQuery}"`;
        await sock.sendMessage(from, { text: `📖 *Searching for ${label} (${transName})...*` });
      } else {
        // ─── RANDOM VERSE ───
        url = `https://bible-api.com/?random=1&translation=${translation}`;
        label = 'Random Verse';
        await sock.sendMessage(from, { text: `📖 *Fetching a random verse (${transName})...*` });
      }

      // ─── FETCH ───
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      if (data.error || !data.text) {
        return await sock.sendMessage(from, { 
          text: `❌ No verses found.\n\n💡 Try: ${prefix || '.'}bible John 3:16\n${prefix || '.'}bible love --kjv\n${prefix || '.'}bible --niv` 
        });
      }

      const text = data.text.replace(/\n/g, ' ');
      const reference = data.reference || 'Unknown';
      const translationDisplay = data.translation_name || transName;

      const msg = `📖 *${reference} (${translationDisplay})*\n\n"${text}"\n\n📌 *Available Translations:*\n--kjv, --asv, --web, --bbe, --nkjv, --niv, --esv, --nasb, --nlt, --msg, --amp\n\n💡 ${prefix || '.'}bible John 3:16 --niv`;

      await sock.sendMessage(from, { text: msg });

    } catch (error) {
      console.error('Bible error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not fetch Bible verse.'}\n\n💡 Try: ${prefix || '.'}bible John 3:16` 
      });
    }
  }
});

register({
  name: 'txt2video',
  aliases: ['t2v', 'textvideo', 'aivideo', 'text2video'],
  category: 'AI',
  description: 'Generate AI videos from text prompts',
  async execute({ sock, from, args, prefix, command }) {
    // ==========================================================
    // Check if user provided a prompt
    // ==========================================================
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🎬 *Text to Video AI*\n\nUsage: ${prefix}${command} <prompt> [ratio] [sound]\n\n*Examples:*\n${prefix}${command} A cow in city\n${prefix}${command} A beautiful sunset over mountains 16:9\n${prefix}${command} A cyberpunk city at night 9:16\n${prefix}${command} A cat running through a field 1:1\n\n*Options:*\n• ratio: auto, 16:9, 9:16, 1:1, 4:3, 3:4 (default: auto)\n• sound: true, false (default: true)\n\n*Full example:*\n${prefix}${command} A cow in city 16:9 true` 
      });
    }

    // ==========================================================
    // Parse prompt, ratio, and sound
    // ==========================================================
    let prompt = args[0];
    let ratio = 'auto';
    let sound = true;

    // Check if user provided ratio (second argument)
    if (args[1]) {
      const validRatios = ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'];
      if (validRatios.includes(args[1])) {
        ratio = args[1];
        // Check if user provided sound (third argument)
        if (args[2]) {
          sound = args[2].toLowerCase() === 'true';
        }
        prompt = args[0];
      } else {
        // If second arg is not a ratio, treat it as part of the prompt
        prompt = args.join(" ");
        ratio = 'auto';
        sound = true;
      }
    }

    await sock.sendMessage(from, { 
      text: `🎬 *Generating video...*\n📝 *Prompt:* ${prompt}\n📐 *Ratio:* ${ratio}\n🔊 *Sound:* ${sound ? 'On' : 'Off'}\n⏳ This may take 30-60 seconds...` 
    });

    try {
      // ==========================================================
      // Call Txt2video API
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/ai/Txt2video`);
      apiUrl.searchParams.append('action', 'generate');
      apiUrl.searchParams.append('prompt', prompt);
      apiUrl.searchParams.append('ratio', ratio);
      apiUrl.searchParams.append('sound', String(sound));

      const response = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Check if generation was successful
      // ==========================================================
      if (!data.success) {
        return await sock.sendMessage(from, { 
          text: `❌ Video generation failed: ${data.message || 'Unknown error'}` 
        });
      }

      // ==========================================================
      // Extract video URL
      // ==========================================================
      const videoUrl = data.data?.videoUrl || data.result?.videoUrl || data.videoUrl || data.url;

      if (!videoUrl) {
        return await sock.sendMessage(from, { 
          text: `❌ No video URL returned from the API.` 
        });
      }

      // ==========================================================
      // Download the video
      // ==========================================================
      const videoResponse = await fetch(videoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!videoResponse.ok) {
        throw new Error(`Failed to download video: ${videoResponse.status}`);
      }

      const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

      if (videoBuffer.length < 5000) {
        return await sock.sendMessage(from, { 
          text: `❌ Generated video is too small. Please try again.` 
        });
      }

      const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(2);

      // ==========================================================
      // Send the video
      // ==========================================================
      const timestamp = data.timestamp ? new Date(data.timestamp).toLocaleString() : 'Just now';

      const caption = `🎬 *AI Generated Video*\n\n📝 *Prompt:* ${prompt}\n📐 *Ratio:* ${ratio}\n🔊 *Sound:* ${sound ? 'On ✅' : 'Off ❌'}\n📦 *Size:* ${fileSizeMB} MB\n🕐 *Generated:* ${timestamp}\n\n✅ *Video Generated Successfully*\n\n✨ _Powered by OmegaTech_`;

      // If video is too large (WhatsApp 16MB limit), send as document
      if (videoBuffer.length > 16 * 1024 * 1024) {
        await sock.sendMessage(from, {
          document: videoBuffer,
          mimetype: 'video/mp4',
          fileName: `txt2video_${Date.now()}.mp4`,
          caption: caption + '\n\n⚠️ *Sent as document due to 16MB limit.*'
        });
      } else {
        try {
          await sock.sendMessage(from, {
            video: videoBuffer,
            mimetype: 'video/mp4',
            caption: caption,
            gifPlayback: false
          });
        } catch (sendErr) {
          // Fallback: send as document
          await sock.sendMessage(from, {
            document: videoBuffer,
            mimetype: 'video/mp4',
            fileName: `txt2video_${Date.now()}.mp4`,
            caption: caption
          });
        }
      }

    } catch (error) {
      console.error('Text-to-video error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not generate video.'}\n\n💡 Try:\n• A shorter prompt\n• A different ratio\n• ${prefix}${command} A cow in city 16:9\n• ${prefix}${command} A sunset over mountains\n\n💡 Or try again later.` 
      });
    }
  }
});
register({
  name: 'nanoblend',
  aliases: ['blend', 'mergeimage', 'nano3', 'teamimage'],
  category: 'AI',
  description: 'Blend/merge up to 4 images into one using NanoBanana Pro V3',
  async execute({ sock, from, msg, quoted, args, prefix, command }) {
    // ==========================================================
    // Check if user provided a prompt
    // ==========================================================
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🍌 *NanoBanana Pro V3 - Image Blender*\n\nUsage: Reply to images with: ${prefix}${command} <prompt>\n\n*Reply to up to 4 images at once:*\n${prefix}${command} Blind and make a nice team image\n\n*Examples:*\n${prefix}${command} Merge these into one cool photo\n${prefix}${command} Combine and make a group picture\n${prefix}${command} Blend these into a team image\n\n*Note:* Reply to 2-4 images in one message. The AI will blend them according to your prompt.` 
      });
    }

    const prompt = args.join(" ");
    const target = quoted || msg;

    // ==========================================================
    // Check for multiple images in the quoted message
    // ==========================================================
    let imageUrls = [];
    let imageIndex = 1;

    // Check for single image
    if (target.message?.imageMessage) {
      const url = target.message.imageMessage.url || target.message.imageMessage.caption;
      if (url) imageUrls.push(url);
    }

    // Check for multiple images in the quoted message (quoted message with multiple images)
    // Note: WhatsApp doesn't support multiple images in a single quote,
    // so users need to reply to a message that already has multiple images,
    // or we collect them from the message context

    // Alternative: Check if the message has multiple image messages in the protocol
    // This handles the case where the user has forwarded a message with multiple images
    if (target.message?.imageMessage && !imageUrls.length) {
      // Try to get more images from the message context
      const ctxInfo = target.message?.imageMessage?.contextInfo;
      if (ctxInfo?.quotedMessage?.imageMessage) {
        const url2 = ctxInfo.quotedMessage.imageMessage.url || ctxInfo.quotedMessage.imageMessage.caption;
        if (url2) imageUrls.push(url2);
      }
    }

    // Check for document messages that are images
    if (target.message?.documentMessage?.mimetype?.includes('image')) {
      const url = target.message.documentMessage.url;
      if (url) imageUrls.push(url);
    }

    // Check for sticker
    if (target.message?.stickerMessage) {
      const url = target.message.stickerMessage.url;
      if (url) imageUrls.push(url);
    }

    // ==========================================================
    // If no images found, try to get from the message context
    // ==========================================================
    if (!imageUrls.length && target.message?.extendedTextMessage?.contextInfo) {
      const ctx = target.message.extendedTextMessage.contextInfo;
      // Check for quoted message images
      if (ctx?.quotedMessage?.imageMessage) {
        const url = ctx.quotedMessage.imageMessage.url || ctx.quotedMessage.imageMessage.caption;
        if (url) imageUrls.push(url);
      }
      // Check for multiple quoted messages (not supported in WhatsApp)
    }

    // ==========================================================
    // Manual check: try to get images from the message chain
    // ==========================================================
    // If the user replied to a message with images, we need to find them
    // WhatsApp only allows quoting one message, so users need to send
    // a message with multiple images (like a media message with multiple attachments)
    // or we need to accept image URLs as arguments instead

    // Alternative: Accept image URLs as arguments
    // Check if any arguments are URLs
    const urlArgs = args.filter(arg => arg.startsWith('http') && (arg.includes('.jpg') || arg.includes('.jpeg') || arg.includes('.png') || arg.includes('.gif') || arg.includes('.webp')));
    if (urlArgs.length) {
      imageUrls = urlArgs;
      // Remove URLs from prompt
      const cleanPrompt = args.filter(arg => !arg.startsWith('http')).join(' ');
      if (cleanPrompt) {
        // Use the cleaned prompt
        // But we already have the prompt from args[0], so we need to rebuild it
        const promptParts = args.filter(arg => !arg.startsWith('http'));
        const newPrompt = promptParts.join(' ');
        // We'll use the original prompt but note that URLs were provided
      }
    }

    // ==========================================================
    // If still no images, ask the user
    // ==========================================================
    if (!imageUrls.length) {
      return await sock.sendMessage(from, { 
        text: `❌ *No images found.*\n\nPlease reply to a message with images, or provide image URLs:\n\n*Usage (with URLs):*\n${prefix}${command} <prompt> <image_url1> <image_url2> ...\n\n*Example:*\n${prefix}${command} Make a team image https://example.com/img1.jpg https://example.com/img2.jpg\n\n*Or reply to:*\n• A message with 2-4 images\n• A single image message\n• A document image` 
      });
    }

    // Limit to 4 images
    if (imageUrls.length > 4) {
      imageUrls = imageUrls.slice(0, 4);
    }

    if (imageUrls.length < 2) {
      return await sock.sendMessage(from, { 
        text: `❌ *Need at least 2 images.*\n\nFound only ${imageUrls.length} image(s).\n\nPlease provide 2-4 images to blend.\n\n${prefix}${command} <prompt> <url1> <url2>\nExample: ${prefix}${command} Make a team image https://example.com/1.jpg https://example.com/2.jpg` 
      });
    }

    await sock.sendMessage(from, { 
      text: `🍌 *Blending images...*\n📝 *Prompt:* ${prompt}\n📊 *Images:* ${imageUrls.length}\n⏳ This may take 20-40 seconds...` 
    });

    try {
      // ==========================================================
      // Call NanoBanana Pro V3 API
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/ai/nanobana-pro-v3`);
      
      // Add images to the request
      imageUrls.forEach((url, index) => {
        apiUrl.searchParams.append(`image${index + 1}`, url);
      });
      
      apiUrl.searchParams.append('prompt', prompt);

      const response = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Check if blending was successful
      // ==========================================================
      if (!data.success) {
        return await sock.sendMessage(from, { 
          text: `❌ Image blending failed: ${data.message || 'Unknown error'}` 
        });
      }

      // ==========================================================
      // Extract task ID and wait for completion
      // ==========================================================
      const taskId = data.task_id || data.taskId || data.id;

      if (!taskId) {
        return await sock.sendMessage(from, { 
          text: `❌ No task ID returned from the API.` 
        });
      }

      await sock.sendMessage(from, { 
        text: `⏳ *Processing...* (Task ID: ${taskId.slice(0, 8)})\nThis may take up to 60 seconds...` 
      });

      let blendedImage = null;
      let attempts = 0;
      const maxAttempts = 12;

      while (attempts < maxAttempts) {
        attempts++;
        await new Promise(r => setTimeout(r, 5000));

        try {
          const statusUrl = new URL(`${baseUrl}/api/ai/nanobana-pro-v3/status`);
          statusUrl.searchParams.append('task_id', taskId);

          const statusRes = await fetch(statusUrl.toString(), {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });

          if (statusRes.ok) {
            const statusData = await statusRes.json();
            
            if (statusData.status === 'completed' || statusData.success) {
              blendedImage = statusData.result?.image || statusData.result?.url || statusData.image || statusData.url;
              break;
            } else if (statusData.status === 'failed' || statusData.status === 'error') {
              throw new Error(statusData.message || 'Blending failed');
            }
          }
        } catch (e) {
          // Continue retrying
        }

        if (attempts < maxAttempts) {
          await sock.sendMessage(from, { 
            text: `⏳ *Still processing...* (${attempts}/${maxAttempts})` 
          });
        }
      }

      // ==========================================================
      // If we didn't get an image, try to get it from the initial response
      // ==========================================================
      if (!blendedImage) {
        blendedImage = data.result?.image || data.result?.url || data.image || data.url;
      }

      if (!blendedImage) {
        return await sock.sendMessage(from, { 
          text: `❌ Could not retrieve the blended image.\n\nTask ID: ${taskId}\n💡 Try again or check the status later.` 
        });
      }

      // ==========================================================
      // Download the blended image
      // ==========================================================
      const imageResponse = await fetch(blendedImage, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!imageResponse.ok) {
        throw new Error(`Failed to download blended image: ${imageResponse.status}`);
      }

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

      if (imageBuffer.length < 1000) {
        return await sock.sendMessage(from, { 
          text: `❌ Blended image is too small. Please try again.` 
        });
      }

      const fileSize = (imageBuffer.length / 1024).toFixed(1);

      // ==========================================================
      // Send the blended image
      // ==========================================================
      const timestamp = data.timestamp ? new Date(data.timestamp).toLocaleString() : 'Just now';

      await sock.sendMessage(from, {
        image: imageBuffer,
        caption: `🍌 *NanoBanana Pro V3 - Image Blend*\n\n📝 *Prompt:* ${prompt}\n📊 *Images used:* ${data.images_used || imageUrls.length}\n📦 *Size:* ${fileSize} KB\n🕐 *Generated:* ${timestamp}\n🆔 *Task ID:* ${taskId.slice(0, 12)}...\n\n✅ *Images Blended Successfully*\n\n✨ _Powered by OmegaTech_`
      });

    } catch (error) {
      console.error('NanoBlend error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not blend images.'}\n\n💡 Try:\n• A different prompt\n• Different images\n• ${prefix}${command} Merge these into one cool photo <url1> <url2>\n• ${prefix}${command} Blend these into a team image <url1> <url2>\n\n💡 Or try again later.` 
      });
    }
  }
});
register({
  name: 'chatbot',
  aliases: ['claude', 'omegaai', 'chat', 'ai'],
  category: 'AI',
  description: 'Chat with Claude AI (OmegaTech) - supports multi-turn conversations',
  async execute({ sock, from, msg, args, prefix, command, sessionId }) {
    // ==========================================================
    // Check if user provided a message
    // ==========================================================
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🤖 *OmegaTech AI Chatbot*\n\nUsage: ${prefix}${command} <message>\nExample: ${prefix}${command} What is the capital of France?\n\n*Features:*\n• Powered by Claude AI\n• Multi-turn conversations (remembers context)\n• Web search optional\n\n*Commands:*\n${prefix}${command} reset - Clear conversation history\n${prefix}${command} <message> - Chat with AI\n${prefix}${command} <message> --search - Enable web search` 
      });
    }

    const userMessage = args.join(" ");
    const isReset = userMessage.toLowerCase() === 'reset';
    const isSearch = userMessage.includes('--search');

    // Clean message for API (remove --search flag)
    const cleanMessage = userMessage.replace(/\s*--search\s*/, '').trim();

    // ==========================================================
    // Handle reset command
    // ==========================================================
    if (isReset) {
      // Clear session for this user
      const sessionKey = `chatbot_${sessionId || from}`;
      // Using global store or memory - adjust based on your store setup
      if (global.chatSessions) {
        delete global.chatSessions[sessionKey];
      }
      return await sock.sendMessage(from, { 
        text: `🧹 *Chat history cleared.*\nStart a fresh conversation with: ${prefix}${command} Hello` 
      });
    }

    // ==========================================================
    // Generate a session ID for this user
    // ==========================================================
    const userSessionId = sessionId || from.split('@')[0];

    await sock.sendMessage(from, { text: `🤖 *Thinking...*${isSearch ? ' (with web search)' : ''}` });

    try {
      // ==========================================================
      // Call OmegaTech Chatbot API
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/ai/Chatbot`);
      
      // Add parameters
      apiUrl.searchParams.append('chat', cleanMessage);
      apiUrl.searchParams.append('sessionId', userSessionId);
      if (isSearch) {
        apiUrl.searchParams.append('web', 'true');
      }

      const response = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Extract response
      // ==========================================================
      let reply = data.result || data.response || data.reply || data.message || data.text;

      if (!reply) {
        // Try to find any text in the response
        const jsonString = JSON.stringify(data);
        const textMatch = jsonString.match(/"result":"([^"]+)"/) || 
                          jsonString.match(/"response":"([^"]+)"/) ||
                          jsonString.match(/"reply":"([^"]+)"/) ||
                          jsonString.match(/"message":"([^"]+)"/);
        if (textMatch) reply = textMatch[1];
      }

      if (!reply) {
        return await sock.sendMessage(from, { 
          text: `❌ No response from AI. Please try again.` 
        });
      }

      // ==========================================================
      // Clean up the response
      // ==========================================================
      reply = reply.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '  ');

      // Truncate if too long (WhatsApp limit ~65k)
      if (reply.length > 65000) {
        reply = reply.slice(0, 65000) + '\n\n... (truncated)';
      }

      // ==========================================================
      // Split into chunks if needed (WhatsApp message limit)
      // ==========================================================
      if (reply.length > 1000) {
        // Try to split by paragraphs or sentences
        const chunks = reply.match(/[^\n]{1,1000}(?:\n|$)/g) || [reply];
        
        for (let i = 0; i < Math.min(chunks.length, 5); i++) {
          const chunk = chunks[i].trim();
          if (!chunk) continue;
          
          const prefix = i === 0 ? `🤖 *Claude AI:*\n\n` : `\n*...continued*\n\n`;
          await sock.sendMessage(from, { text: prefix + chunk });
          // Small delay between messages
          await new Promise(r => setTimeout(r, 300));
        }
      } else {
        await sock.sendMessage(from, { 
          text: `🤖 *Claude AI:*\n\n${reply}` 
        });
      }

    } catch (error) {
      console.error('Chatbot error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not reach AI service.'}\n\n💡 Try:\n• ${prefix}${command} reset (clear history)\n• ${prefix}${command} Hello (start fresh)\n• ${prefix}${command} What is AI? --search (with web search)` 
      });
    }
  }
});
register({
  name: 'veo3',
  aliases: ['veo', 'aivideo', 'genvideo', 'veo2'],
  category: 'AI',
  description: 'Generate AI videos from text prompts (Veo3/Veo2)',
  async execute({ sock, from, args, prefix, command }) {
    // ==========================================================
    // Check if user provided a prompt
    // ==========================================================
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🎬 *Veo3 AI Video Generator*\n\nUsage: ${prefix}${command} <prompt>\nExample: ${prefix}${command} a cute cat eating bread\n\n*Examples:*\n${prefix}${command} sunset over ocean waves, cinematic slow motion\n${prefix}${command} futuristic city at night with neon lights\n${prefix}${command} a robot dancing in a cyberpunk alley\n${prefix}${command} a dog running through a flower field, slow motion\n\n*Note:* Generation takes 30-60 seconds. You will get a short MP4 video.` 
      });
    }

    const prompt = args.join(" ");

    await sock.sendMessage(from, { 
      text: `🎬 *Generating video...*\n⏳ Prompt: *${prompt}*\n\nThis may take 30-60 seconds...` 
    });

    try {
      // ==========================================================
      // Call Veo3 API (primary endpoint)
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const response = await fetch(`${baseUrl}/api/ai/veo3`, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          prompt: prompt
        })
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Extract video URL
      // ==========================================================
      let videoUrl = data.result?.url || data.result?.video_url || data.result?.video || 
                     data.url || data.video_url || data.video || data.download_url;

      if (!videoUrl) {
        // Try to find a URL in the response
        const jsonString = JSON.stringify(data);
        const urlMatch = jsonString.match(/https?:\/\/[^\s"']+\.(mp4|mov|webm|mkv)/i);
        if (urlMatch) videoUrl = urlMatch[0];
      }

      if (!videoUrl) {
        return await sock.sendMessage(from, { 
          text: `❌ No video URL returned from the API.\n\n💡 Try a different prompt or try again later.` 
        });
      }

      // ==========================================================
      // Download the video
      // ==========================================================
      const videoResponse = await fetch(videoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!videoResponse.ok) {
        throw new Error(`Failed to download video: ${videoResponse.status}`);
      }

      const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

      if (videoBuffer.length < 5000) {
        return await sock.sendMessage(from, { 
          text: `❌ Generated video is too small (${videoBuffer.length} bytes). The generation may have failed.` 
        });
      }

      const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(2);

      // ==========================================================
      // Send the video
      // ==========================================================
      const caption = `🎬 *Veo3 AI Video*\n\n📝 *Prompt:* ${prompt}\n📦 *Size:* ${fileSizeMB} MB\n\n✅ *Generated Successfully*\n\n✨ _Powered by OmegaTech Veo3_`;

      // If video is too large (WhatsApp 16MB limit), send as document
      if (videoBuffer.length > 16 * 1024 * 1024) {
        await sock.sendMessage(from, {
          document: videoBuffer,
          mimetype: 'video/mp4',
          fileName: `veo3_${Date.now()}.mp4`,
          caption: caption + '\n\n⚠️ *Sent as document due to 16MB limit.*'
        });
      } else {
        try {
          await sock.sendMessage(from, {
            video: videoBuffer,
            mimetype: 'video/mp4',
            caption: caption,
            gifPlayback: false
          });
        } catch (sendErr) {
          // Fallback: send as document if video sending fails
          await sock.sendMessage(from, {
            document: videoBuffer,
            mimetype: 'video/mp4',
            fileName: `veo3_${Date.now()}.mp4`,
            caption: caption
          });
        }
      }

    } catch (error) {
      console.error('Veo3 error:', error);
      
      // ==========================================================
      // Try alternative endpoint (Veo3-v3)
      // ==========================================================
      try {
        await sock.sendMessage(from, { text: `⏳ Trying alternative endpoint...` });
        
        const altResponse = await fetch(`${baseUrl}/api/ai/Veo3-v3`, {
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            prompt: prompt
          })
        });

        if (altResponse.ok) {
          const altData = await altResponse.json();
          
          let videoUrl = altData.result?.url || altData.result?.video_url || altData.result?.video || 
                         altData.url || altData.video_url || altData.video;

          if (videoUrl) {
            const videoRes = await fetch(videoUrl);
            const videoBuf = Buffer.from(await videoRes.arrayBuffer());
            
            if (videoBuf.length > 5000) {
              const sizeMB = (videoBuf.length / 1024 / 1024).toFixed(2);
              
              if (videoBuf.length > 16 * 1024 * 1024) {
                await sock.sendMessage(from, {
                  document: videoBuf,
                  mimetype: 'video/mp4',
                  fileName: `veo3_${Date.now()}.mp4`,
                  caption: `🎬 *Veo3 AI Video*\n📝 ${prompt}\n📦 ${sizeMB} MB\n\n✅ Generated (alt endpoint)`
                });
              } else {
                await sock.sendMessage(from, {
                  video: videoBuf,
                  mimetype: 'video/mp4',
                  caption: `🎬 *Veo3 AI Video*\n📝 ${prompt}\n📦 ${sizeMB} MB\n\n✅ Generated (alt endpoint)`
                });
              }
              return;
            }
          }
        }
      } catch (altError) {
        console.warn('Alternative Veo3 endpoint failed:', altError.message);
      }

      // ==========================================================
      // All attempts failed
      // ==========================================================
      await sock.sendMessage(from, { 
        text: `⚠️ Video Generation Error: ${error.message || 'Could not generate video.'}\n\n💡 Try:\n• A shorter prompt\n• A simpler scene description\n• ${prefix}${command} sunset over ocean\n• ${prefix}${command} a cat sleeping\n\n💡 Or try again later.` 
      });
    }
  }
});
// blackbox.js - AI Chat via David Cyril API
register({
  name: 'blackbox',
  aliases: ['bb', 'blackboxai', 'askai', 'ai'],
  category: 'AI',
  description: 'Chat with Blackbox AI through David Cyril API',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🤖 *Blackbox AI*\n\nUsage: ${prefix}${command} <your question>\nExample: ${prefix}${command} What is the capital of France?\n\n*Aliases:* ${prefix}bb, ${prefix}askai` 
      });
    }

    const query = args.join(' ');
    await sock.sendMessage(from, { text: `⏳ Thinking... 🤔` });

    try {
      const apiUrl = `https://apis.davidcyril.name.ng/blackbox`;
      
      const response = await fetch(apiUrl, {
        method: 'POST', // or GET depending on API
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: JSON.stringify({
          query: query,
          // Add any required params based on API spec
        }),
        signal: AbortSignal.timeout(60000) // 60s timeout
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();
      
      // ─── EXTRACT RESPONSE ───
      let answer = '';
      let sources = [];
      let images = [];

      // Try different response structures
      if (data.result) {
        answer = data.result.response || data.result.answer || data.result.text || data.result.message || data.result;
        sources = data.result.sources || data.result.references || [];
        images = data.result.images || data.result.image || [];
      } else if (data.response) {
        answer = data.response.answer || data.response.text || data.response.message || data.response;
        sources = data.response.sources || [];
      } else if (data.message) {
        answer = data.message;
      } else if (data.answer) {
        answer = data.answer;
      } else if (data.text) {
        answer = data.text;
      } else if (typeof data === 'string') {
        answer = data;
      } else {
        // Fallback: convert to string
        answer = JSON.stringify(data, null, 2);
      }

      if (!answer || answer.length < 2) {
        throw new Error('Empty response from API.');
      }

      // ─── FORMAT RESPONSE ───
      let reply = `🤖 *Blackbox AI*\n\n${answer}`;

      if (sources.length > 0) {
        reply += `\n\n📚 *Sources:*\n`;
        sources.forEach((src, i) => {
          reply += `${i + 1}. ${src.title || src.name || 'Link'}: ${src.url || src.link || 'N/A'}\n`;
        });
      }

      if (images.length > 0) {
        // Send image if available
        try {
          const imgUrl = images[0];
          await sock.sendMessage(from, {
            image: { url: imgUrl },
            caption: reply.slice(0, 1024) // Caption limit
          });
          return;
        } catch (imgErr) {}
      }

      // ─── SEND REPLY ───
      if (reply.length > 4096) {
        // Split long replies
        const chunks = reply.match(/.{1,4000}/g) || [reply];
        for (const chunk of chunks) {
          await sock.sendMessage(from, { text: chunk });
        }
      } else {
        await sock.sendMessage(from, { text: reply });
      }

      console.log(`✅ Blackbox response sent for: "${query}"`);

    } catch (error) {
      console.error('Blackbox API error:', error);

      // ─── FALLBACK: Try GET method if POST fails ───
      try {
        const fallbackUrl = `https://apis.davidcyril.name.ng/blackbox?q=${encodeURIComponent(query)}`;
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(30000)
        });

        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.text();
          let fallbackAnswer = fallbackData;
          
          try {
            const jsonData = JSON.parse(fallbackData);
            fallbackAnswer = jsonData.result || jsonData.response || jsonData.answer || jsonData.message || jsonData.text || fallbackData;
          } catch (e) {}

          if (fallbackAnswer && fallbackAnswer.length > 2) {
            return await sock.sendMessage(from, { 
              text: `🤖 *Blackbox AI (Fallback)*\n\n${fallbackAnswer.slice(0, 4000)}` 
            });
          }
        }
      } catch (fallbackErr) {}

      await sock.sendMessage(from, { 
        text: `❌ Error: ${error.message || 'Failed to get response from Blackbox AI.'}\n\n💡 Try again later or use a different command.` 
      });
    }
  }
});
// gemini.js - Gemini 3 Pro via David Cyril API
register({
  name: 'gemini',
  aliases: ['g3', 'gemini3', 'geminipro', 'ai3'],
  category: 'AI',
  description: 'Chat with Google Gemini 3 Pro AI',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🧠 *Gemini 3 Pro AI*\n\nUsage: ${prefix}${command} <your question>\nExample: ${prefix}${command} Write a poem about space\n\n*Aliases:* ${prefix}g3, ${prefix}gemini3, ${prefix}geminipro` 
      });
    }

    const query = args.join(' ');
    await sock.sendMessage(from, { text: `🧠 Processing with Gemini 3 Pro...` });

    try {
      // ─── API ENDPOINT ───
      const apiUrl = 'https://apis.davidcyril.name.ng/ai/gemini-3-pro';
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          query: query,
          // Optional parameters if supported
          // temperature: 0.7,
          // max_tokens: 4096
        }),
        signal: AbortSignal.timeout(90000) // 90s for Gemini
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      // ─── EXTRACT RESPONSE ───
      let answer = '';
      let sources = [];
      let images = [];
      let usage = '';

      // Try different response structures
      if (data.result) {
        answer = data.result.response || data.result.answer || data.result.text || data.result.message || data.result.content || data.result;
        sources = data.result.sources || data.result.references || [];
        images = data.result.images || data.result.image || [];
        usage = data.result.usage || data.result.token_usage || '';
      } else if (data.response) {
        answer = data.response.answer || data.response.text || data.response.message || data.response.content || data.response;
        sources = data.response.sources || [];
        usage = data.response.usage || '';
      } else if (data.answer) {
        answer = data.answer;
      } else if (data.text) {
        answer = data.text;
      } else if (data.message) {
        answer = data.message;
      } else if (data.content) {
        answer = data.content;
      } else if (data.candidates && data.candidates[0]) {
        answer = data.candidates[0].content || data.candidates[0].text || data.candidates[0].message || data.candidates[0];
      } else if (typeof data === 'string') {
        answer = data;
      } else {
        // Fallback: convert to string
        answer = JSON.stringify(data, null, 2);
      }

      // Clean up answer if it's an object
      if (typeof answer === 'object') {
        answer = JSON.stringify(answer, null, 2);
      }

      if (!answer || answer.length < 2) {
        throw new Error('Empty response from Gemini API.');
      }

      // ─── FORMAT RESPONSE ───
      let reply = `🧠 *Gemini 3 Pro*\n\n${answer}`;

      if (usage) {
        reply += `\n\n📊 *Usage:* ${usage}`;
      }

      if (sources && sources.length > 0) {
        reply += `\n\n📚 *Sources:*\n`;
        sources.slice(0, 5).forEach((src, i) => {
          reply += `${i + 1}. ${src.title || src.name || 'Link'}: ${src.url || src.link || 'N/A'}\n`;
        });
      }

      // ─── SEND IMAGES IF AVAILABLE ───
      if (images && images.length > 0) {
        try {
          const imgUrl = images[0];
          await sock.sendMessage(from, {
            image: { url: imgUrl },
            caption: reply.slice(0, 1024)
          });
          return;
        } catch (imgErr) {
          // Fall through to text
        }
      }

      // ─── SEND REPLY ───
      if (reply.length > 4096) {
        const chunks = reply.match(/.{1,4000}/g) || [reply];
        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(from, { 
            text: i === 0 ? chunks[i] : `*(continued)*\n\n${chunks[i]}`
          });
        }
      } else {
        await sock.sendMessage(from, { text: reply });
      }

      console.log(`✅ Gemini 3 Pro response sent for: "${query}"`);

    } catch (error) {
      console.error('Gemini 3 Pro error:', error);

      // ─── FALLBACK: Try GET method ───
      try {
        const fallbackUrl = `https://apis.davidcyril.name.ng/ai/gemini-3-pro?q=${encodeURIComponent(query)}`;
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(45000)
        });

        if (fallbackRes.ok) {
          let fallbackData = await fallbackRes.text();
          try {
            const jsonData = JSON.parse(fallbackData);
            fallbackData = jsonData.result || jsonData.response || jsonData.answer || jsonData.message || jsonData.text || jsonData.content || fallbackData;
            if (typeof fallbackData === 'object') {
              fallbackData = JSON.stringify(fallbackData, null, 2);
            }
          } catch (e) {}

          if (fallbackData && fallbackData.length > 2) {
            return await sock.sendMessage(from, { 
              text: `🧠 *Gemini 3 Pro (Fallback)*\n\n${fallbackData.slice(0, 4000)}` 
            });
          }
        }
      } catch (fallbackErr) {}

      await sock.sendMessage(from, { 
        text: `❌ *Gemini 3 Pro Error*\n\n${error.message || 'Failed to get response.'}\n\n💡 Tips:\n• Try a shorter question\n• Try again later\n• Use ${prefix}bb for Blackbox AI` 
      });
    }
  }
});
// deepai.js - DeepAI Standard via David Cyril API
register({
  name: 'deepai',
  aliases: ['deep', 'deepai', 'dai', 'aideep'],
  category: 'AI',
  description: 'Chat with DeepAI Standard model',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🧠 *DeepAI Standard*\n\nUsage: ${prefix}${command} <your question>\nExample: ${prefix}${command} What is artificial intelligence?\n\n*Aliases:* ${prefix}deep, ${prefix}dai, ${prefix}deepai` 
      });
    }

    const query = args.join(' ');
    await sock.sendMessage(from, { text: `🧠 Processing with DeepAI Standard...` });

    try {
      // ─── API ENDPOINT ───
      const apiUrl = 'https://apis.davidcyril.name.ng/ai/deepai-standard';
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          query: query,
          // Optional parameters
          // temperature: 0.7,
          // max_tokens: 4096,
          // top_p: 0.9
        }),
        signal: AbortSignal.timeout(60000) // 60s timeout
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      // ─── EXTRACT RESPONSE ───
      let answer = '';
      let sources = [];
      let images = [];
      let confidence = '';
      let model = 'DeepAI Standard';

      // Try different response structures
      if (data.result) {
        answer = data.result.response || data.result.answer || data.result.text || data.result.message || data.result.content || data.result.generated_text || data.result;
        sources = data.result.sources || data.result.references || [];
        images = data.result.images || data.result.image || [];
        confidence = data.result.confidence || data.result.score || '';
        model = data.result.model || data.result.model_name || 'DeepAI Standard';
      } else if (data.response) {
        answer = data.response.answer || data.response.text || data.response.message || data.response.content || data.response.generated_text || data.response;
        sources = data.response.sources || [];
        confidence = data.response.confidence || '';
        model = data.response.model || 'DeepAI Standard';
      } else if (data.answer) {
        answer = data.answer;
      } else if (data.text) {
        answer = data.text;
      } else if (data.message) {
        answer = data.message;
      } else if (data.content) {
        answer = data.content;
      } else if (data.generated_text) {
        answer = data.generated_text;
      } else if (data.output) {
        answer = data.output;
      } else if (data.generations && data.generations[0]) {
        answer = data.generations[0].text || data.generations[0].content || data.generations[0].message || data.generations[0];
      } else if (data.choices && data.choices[0]) {
        answer = data.choices[0].text || data.choices[0].message || data.choices[0].content || data.choices[0];
      } else if (typeof data === 'string') {
        answer = data;
      } else {
        // Fallback: convert to string
        answer = JSON.stringify(data, null, 2);
      }

      // Clean up answer if it's an object
      if (typeof answer === 'object') {
        answer = JSON.stringify(answer, null, 2);
      }

      if (!answer || answer.length < 2) {
        throw new Error('Empty response from DeepAI API.');
      }

      // ─── FORMAT RESPONSE ───
      let reply = `🧠 *${model}*\n\n${answer}`;

      if (confidence) {
        reply += `\n\n📊 *Confidence:* ${confidence}`;
      }

      if (sources && sources.length > 0) {
        reply += `\n\n📚 *Sources:*\n`;
        sources.slice(0, 5).forEach((src, i) => {
          reply += `${i + 1}. ${src.title || src.name || 'Link'}: ${src.url || src.link || 'N/A'}\n`;
        });
      }

      // ─── SEND IMAGES IF AVAILABLE ───
      if (images && images.length > 0) {
        try {
          const imgUrl = images[0];
          await sock.sendMessage(from, {
            image: { url: imgUrl },
            caption: reply.slice(0, 1024)
          });
          return;
        } catch (imgErr) {
          // Fall through to text
        }
      }

      // ─── SEND REPLY ───
      if (reply.length > 4096) {
        const chunks = reply.match(/.{1,4000}/g) || [reply];
        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(from, { 
            text: i === 0 ? chunks[i] : `*(continued)*\n\n${chunks[i]}`
          });
        }
      } else {
        await sock.sendMessage(from, { text: reply });
      }

      console.log(`✅ DeepAI response sent for: "${query}"`);

    } catch (error) {
      console.error('DeepAI Standard error:', error);

      // ─── FALLBACK: Try GET method ───
      try {
        const fallbackUrl = `https://apis.davidcyril.name.ng/ai/deepai-standard?q=${encodeURIComponent(query)}`;
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(30000)
        });

        if (fallbackRes.ok) {
          let fallbackData = await fallbackRes.text();
          try {
            const jsonData = JSON.parse(fallbackData);
            fallbackData = jsonData.result || jsonData.response || jsonData.answer || jsonData.message || jsonData.text || jsonData.content || jsonData.generated_text || fallbackData;
            if (typeof fallbackData === 'object') {
              fallbackData = JSON.stringify(fallbackData, null, 2);
            }
          } catch (e) {}

          if (fallbackData && fallbackData.length > 2) {
            return await sock.sendMessage(from, { 
              text: `🧠 *DeepAI Standard (Fallback)*\n\n${fallbackData.slice(0, 4000)}` 
            });
          }
        }
      } catch (fallbackErr) {}

      // ─── ULTIMATE FALLBACK: Try alternative endpoint ───
      try {
        const altUrl = `https://apis.davidcyril.name.ng/ai/deepai-standard/chat`;
        const altRes = await fetch(altUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: query }),
          signal: AbortSignal.timeout(30000)
        });

        if (altRes.ok) {
          const altData = await altRes.json();
          const altAnswer = altData.result || altData.response || altData.answer || altData.message || altData.text || JSON.stringify(altData);
          if (altAnswer && altAnswer.length > 2) {
            return await sock.sendMessage(from, { 
              text: `🧠 *DeepAI Standard (Alt)*\n\n${altAnswer.slice(0, 4000)}` 
            });
          }
        }
      } catch (altErr) {}

      await sock.sendMessage(from, { 
        text: `❌ *DeepAI Standard Error*\n\n${error.message || 'Failed to get response.'}\n\n💡 Tips:\n• Try a shorter question\n• Try again later\n• Use ${prefix}bb for Blackbox AI\n• Use ${prefix}gemini for Gemini 3 Pro` 
      });
    }
  }
});
register({
  name: 'claudepro',
  aliases: ['claudep', 'deepai', 'claudeai', 'cp'],
  category: 'AI',
  description: 'Full DeepAI — 15+ models, vision, image generation, and editing',
  async execute({ sock, from, msg, quoted, args, prefix, command, sessionId }) {
    // ==========================================================
    // Check if user provided a message or action
    // ==========================================================
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🧠 *Claude Pro (DeepAI)*\n\n*Chat:*\n${prefix}${command} <message>\n${prefix}${command} What is AI? --model llama-4-scout\n\n*Vision (reply to image):*\n${prefix}${command} What's in this image? --vision\n\n*Generate Image:*\n${prefix}${command} generate a beautiful sunset --generate\n${prefix}${command} anime girl --generate --size landscape\n\n*Edit Image (reply to image):*\n${prefix}${command} make it black and white --edit\n\n*Models:* ${prefix}${command} models\n*Clear session:* ${prefix}${command} clear` 
      });
    }

    const userMessage = args.join(" ");
    const isModels = userMessage.toLowerCase().trim() === 'models';
    const isClear = userMessage.toLowerCase().trim() === 'clear';

    // ==========================================================
    // Handle "models" action
    // ==========================================================
    if (isModels) {
      await sock.sendMessage(from, { text: `⏳ Fetching available models...` });
      
      try {
        const baseUrl = 'https://omegatech-api.dixonomega.tech';
        const response = await fetch(`${baseUrl}/api/ai/Claude-pro?action=models`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          }
        });

        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const data = await response.json();

        let models = data.result || data.models || data.data || [];
        
        if (!models.length) {
          return await sock.sendMessage(from, { 
            text: `❌ Could not fetch model list.` 
          });
        }

        let msg = `🧠 *Claude Pro Models (${models.length}+)*\n\n`;
        const maxDisplay = Math.min(models.length, 25);
        
        for (let i = 0; i < maxDisplay; i++) {
          const m = models[i];
          const name = m.name || m.id || m.model || 'Unknown';
          msg += `• *${name}*\n`;
        }
        
        if (models.length > 25) {
          msg += `\n*...and ${models.length - 25} more.*`;
        }
        
        msg += `\n\n💡 Use: ${prefix}${command} <message> --model <model_id>`;
        await sock.sendMessage(from, { text: msg });
        
      } catch (error) {
        await sock.sendMessage(from, { text: `⚠️ Error: ${error.message}` });
      }
      return;
    }

    // ==========================================================
    // Handle "clear" action - reset session
    // ==========================================================
    if (isClear) {
      const sessionKey = `claudepro_${sessionId || from}`;
      if (global.claudeProSessions) {
        delete global.claudeProSessions[sessionKey];
      }
      return await sock.sendMessage(from, { 
        text: `🧹 *Claude Pro session cleared.*\nStart fresh with: ${prefix}${command} Hello` 
      });
    }

    // ==========================================================
    // Parse user message and options
    // ==========================================================
    let cleanMessage = userMessage;
    let model = 'llama-4-scout'; // default
    let persona = 'chat';
    let tools = 'all';
    let action = 'chat'; // chat | generate | edit
    let size = 'portrait';
    let version = 'hd';
    let imageUrl = null;
    let imageUuid = null;
    let isVision = false;

    // Check for actions
    if (userMessage.includes('--generate')) {
      action = 'generate';
      cleanMessage = cleanMessage.replace(/--generate/g, '').trim();
    } else if (userMessage.includes('--edit')) {
      action = 'edit';
      cleanMessage = cleanMessage.replace(/--edit/g, '').trim();
    } else if (userMessage.includes('--vision')) {
      isVision = true;
      cleanMessage = cleanMessage.replace(/--vision/g, '').trim();
    }

    // Extract --model flag
    const modelMatch = userMessage.match(/--model\s+([^\s]+)/);
    if (modelMatch) {
      model = modelMatch[1];
      cleanMessage = cleanMessage.replace(/--model\s+[^\s]+/, '').trim();
    }

    // Extract --persona flag
    const personaMatch = userMessage.match(/--persona\s+([^\s]+)/);
    if (personaMatch) {
      persona = personaMatch[1];
      cleanMessage = cleanMessage.replace(/--persona\s+[^\s]+/, '').trim();
    }

    // Extract --tools flag
    const toolsMatch = userMessage.match(/--tools\s+([^\s]+)/);
    if (toolsMatch) {
      tools = toolsMatch[1];
      cleanMessage = cleanMessage.replace(/--tools\s+[^\s]+/, '').trim();
    }

    // Extract --size flag (for generate)
    const sizeMatch = userMessage.match(/--size\s+(portrait|landscape|square)/);
    if (sizeMatch) {
      size = sizeMatch[1];
      cleanMessage = cleanMessage.replace(/--size\s+[^\s]+/, '').trim();
    }

    // Extract --version flag (for generate/edit)
    const versionMatch = userMessage.match(/--version\s+(sd|hd|ultra)/);
    if (versionMatch) {
      version = versionMatch[1];
      cleanMessage = cleanMessage.replace(/--version\s+[^\s]+/, '').trim();
    }

    if (!cleanMessage && action !== 'vision') {
      return await sock.sendMessage(from, { 
        text: `❌ Please provide a message or prompt.\n\nExample: ${prefix}${command} Hello --model llama-4-scout` 
      });
    }

    // ==========================================================
    // Check for image in quoted message (vision/edit)
    // ==========================================================
    const target = quoted || msg;
    if (isVision || action === 'edit') {
      if (target.message?.imageMessage) {
        imageUrl = target.message.imageMessage.url || target.message.imageMessage.caption;
      } else if (target.message?.documentMessage?.mimetype?.includes('image')) {
        imageUrl = target.message.documentMessage.url;
      } else if (target.message?.stickerMessage) {
        imageUrl = target.message.stickerMessage.url;
      }

      if (!imageUrl) {
        return await sock.sendMessage(from, { 
          text: `❌ Please reply to an image for vision/edit.\n\n${isVision ? 'Example: reply to a photo with:\n' : ''}${prefix}${command} What's in this image? --vision` 
        });
      }
    }

    // ==========================================================
    // Generate session ID
    // ==========================================================
    const userSessionId = sessionId || from.split('@')[0];

    // ==========================================================
    // Send status message
    // ==========================================================
    let statusMsg = `🧠 *Claude Pro processing...*\n`;
    if (action === 'generate') statusMsg += `🎨 Generating image: *${cleanMessage}*\n`;
    else if (action === 'edit') statusMsg += `✏️ Editing image: *${cleanMessage}*\n`;
    else if (isVision) statusMsg += `👁️ Analyzing image...\n`;
    else statusMsg += `💬 Model: ${model}\n`;
    statusMsg += `⏳ Please wait...`;
    
    await sock.sendMessage(from, { text: statusMsg });

    try {
      // ==========================================================
      // Call Claude Pro API
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/ai/Claude-pro`);
      
      // Set the primary action
      if (action === 'generate') {
        apiUrl.searchParams.append('generate', cleanMessage);
        apiUrl.searchParams.append('size', size);
        apiUrl.searchParams.append('version', version);
      } else if (action === 'edit' && imageUrl) {
        apiUrl.searchParams.append('edit', cleanMessage);
        apiUrl.searchParams.append('image', imageUrl);
        apiUrl.searchParams.append('version', version);
      } else if (isVision && imageUrl) {
        // For vision, we need to upload first then chat
        // Option 1: Direct vision via upload action
        apiUrl.searchParams.append('upload', imageUrl);
        // Then we'll need a second request with the UUID
        // But the API might support direct vision via chat + image param
        apiUrl.searchParams.append('chat', cleanMessage);
        apiUrl.searchParams.append('model', model);
        apiUrl.searchParams.append('persona', persona);
        apiUrl.searchParams.append('tools', tools);
        apiUrl.searchParams.append('sessionId', userSessionId);
        // Try to pass image directly
        apiUrl.searchParams.append('image_url', imageUrl);
      } else {
        // Default: chat
        apiUrl.searchParams.append('chat', cleanMessage);
        apiUrl.searchParams.append('model', model);
        apiUrl.searchParams.append('persona', persona);
        apiUrl.searchParams.append('tools', tools);
        apiUrl.searchParams.append('sessionId', userSessionId);
        apiUrl.searchParams.append('clear', 'false');
      }

      const response = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Extract response
      // ==========================================================
      let reply = data.result || data.response || data.reply || data.message || data.text;
      let mediaUrl = data.url || data.image || data.video || data.generated;

      // ==========================================================
      // Handle image generation/edit response
      // ==========================================================
      if ((action === 'generate' || action === 'edit') && mediaUrl) {
        const imgRes = await fetch(mediaUrl);
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        
        if (imgBuf.length > 1000) {
          const caption = action === 'generate' ? 
            `🎨 *Generated Image*\n📝 ${cleanMessage}\n📐 ${size}\n\n✅ Success` :
            `✏️ *Edited Image*\n📝 ${cleanMessage}\n\n✅ Success`;
          
          await sock.sendMessage(from, {
            image: imgBuf,
            caption: caption
          });
          return;
        }
      }

      // ==========================================================
      // Handle chat/vision response
      // ==========================================================
      if (!reply) {
        const jsonString = JSON.stringify(data);
        const textMatch = jsonString.match(/"result":"([^"]+)"/) || 
                          jsonString.match(/"response":"([^"]+)"/) ||
                          jsonString.match(/"reply":"([^"]+)"/) ||
                          jsonString.match(/"message":"([^"]+)"/);
        if (textMatch) reply = textMatch[1];
      }

      if (!reply) {
        return await sock.sendMessage(from, { 
          text: `❌ No response from Claude Pro. Please try again.` 
        });
      }

      // Clean up
      reply = reply.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '  ');
      if (reply.length > 65000) reply = reply.slice(0, 65000) + '\n\n... (truncated)';

      // ==========================================================
      // Send response (split if needed)
      // ==========================================================
      const modelDisplay = model ? ` (${model})` : '';
      
      if (reply.length > 1000) {
        const chunks = reply.match(/[^\n]{1,1000}(?:\n|$)/g) || [reply];
        for (let i = 0; i < Math.min(chunks.length, 5); i++) {
          const chunk = chunks[i].trim();
          if (!chunk) continue;
          const prefix = i === 0 ? `🧠 *Claude Pro${modelDisplay}:*\n\n` : `\n*...continued*\n\n`;
          await sock.sendMessage(from, { text: prefix + chunk });
          await new Promise(r => setTimeout(r, 300));
        }
      } else {
        await sock.sendMessage(from, { 
          text: `🧠 *Claude Pro${modelDisplay}:*\n\n${reply}` 
        });
      }

    } catch (error) {
      console.error('Claude Pro error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not reach Claude Pro.'}\n\n💡 Try:\n• ${prefix}${command} clear (reset session)\n• ${prefix}${command} Hello\n• ${prefix}${command} models\n• Check your syntax` 
      });
    }
  }
});

// catbox.js - Catbox File Uploader
register({
  name: 'catbox',
  aliases: ['upload', 'uploadcatbox', 'catboxupload'],
  category: 'TOOLS',
  description: 'Upload files/images to Catbox (via David Cyril API)',
  async execute({ sock, from, msg, quoted, args, prefix, command }) {
    // ─── CHECK IF REPLYING TO A FILE ───
    const target = quoted || msg;
    
    let fileBuffer = null;
    let fileType = '';
    let fileName = 'file';
    let mimetype = '';

    // ─── EXTRACT FILE FROM MESSAGE ───
    // Check for image
    if (target.message?.imageMessage) {
      try {
        const media = await sock.downloadMediaMessage(target);
        if (media) {
          fileBuffer = media;
          fileType = 'image';
          mimetype = target.message.imageMessage.mimetype || 'image/jpeg';
          fileName = target.message.imageMessage.fileName || 'image.jpg';
        }
      } catch (e) {}
    }
    
    // Check for document
    if (!fileBuffer && target.message?.documentMessage) {
      try {
        const media = await sock.downloadMediaMessage(target);
        if (media) {
          fileBuffer = media;
          fileType = 'document';
          mimetype = target.message.documentMessage.mimetype || 'application/octet-stream';
          fileName = target.message.documentMessage.fileName || 'document.pdf';
        }
      } catch (e) {}
    }
    
    // Check for sticker
    if (!fileBuffer && target.message?.stickerMessage) {
      try {
        const media = await sock.downloadMediaMessage(target);
        if (media) {
          fileBuffer = media;
          fileType = 'sticker';
          mimetype = target.message.stickerMessage.mimetype || 'image/webp';
          fileName = 'sticker.webp';
        }
      } catch (e) {}
    }
    
    // Check for video
    if (!fileBuffer && target.message?.videoMessage) {
      try {
        const media = await sock.downloadMediaMessage(target);
        if (media) {
          fileBuffer = media;
          fileType = 'video';
          mimetype = target.message.videoMessage.mimetype || 'video/mp4';
          fileName = target.message.videoMessage.fileName || 'video.mp4';
        }
      } catch (e) {}
    }

    // Check for audio
    if (!fileBuffer && target.message?.audioMessage) {
      try {
        const media = await sock.downloadMediaMessage(target);
        if (media) {
          fileBuffer = media;
          fileType = 'audio';
          mimetype = target.message.audioMessage.mimetype || 'audio/mpeg';
          fileName = target.message.audioMessage.fileName || 'audio.mp3';
        }
      } catch (e) {}
    }

    // ─── CHECK IF USER PROVIDED A FILE NAME ───
    if (args[0]) {
      fileName = args[0];
    }

    if (!fileBuffer) {
      return await sock.sendMessage(from, { 
        text: `📤 *Catbox Uploader*\n\nUsage: Reply to an image/document/sticker/video with:\n${prefix}${command} <filename>\n\n*Examples:*\n${prefix}${command} myimage.jpg (reply to image)\n${prefix}${command} document.pdf (reply to PDF)\n\n*Supports:*\n• Images (jpg, png, gif)\n• Documents (pdf, txt, etc.)\n• Stickers (webp)\n• Videos (mp4)\n• Audio (mp3)\n\n*Aliases:* ${prefix}upload, ${prefix}uploadcatbox` 
      });
    }

    // ─── CHECK FILE SIZE (max 200MB for Catbox) ───
    const fileSizeMB = (fileBuffer.length / 1024 / 1024).toFixed(1);
    if (parseFloat(fileSizeMB) > 200) {
      return await sock.sendMessage(from, { 
        text: `❌ File too large! (${fileSizeMB}MB)\nMax size: 200MB` 
      });
    }

    await sock.sendMessage(from, { 
      text: `📤 *Uploading to Catbox...*\n📁 File: ${fileName}\n📦 Size: ${fileSizeMB}MB\n⏳ Please wait...` 
    });

    try {
      // ─── DAVID CYRIL API (POST) ───
      const apiUrl = 'https://apis.davidcyril.name.ng/uploader/catbox';
      
      // Create FormData
      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer], { type: mimetype }), fileName);
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: formData,
        signal: AbortSignal.timeout(120000) // 2 minute timeout
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      // ─── EXTRACT UPLOAD URL ───
      let uploadUrl = null;
      let message = '';

      if (data.result) {
        uploadUrl = data.result.url || data.result.link || data.result || null;
        message = data.result.message || data.message || '';
      } else if (data.url) {
        uploadUrl = data.url;
      } else if (data.link) {
        uploadUrl = data.link;
      } else if (data.data) {
        uploadUrl = data.data;
      } else if (typeof data === 'string') {
        uploadUrl = data;
      }

      // If no URL, try to find one in the response
      if (!uploadUrl) {
        const jsonString = JSON.stringify(data);
        const urlMatch = jsonString.match(/https?:\/\/[^\s"']+\.(jpg|png|gif|webp|mp4|pdf|txt|zip|rar|7z|mp3|wav)/i);
        if (urlMatch) {
          uploadUrl = urlMatch[0];
        }
      }

      if (!uploadUrl || !uploadUrl.startsWith('http')) {
        return await sock.sendMessage(from, { 
          text: `❌ *Upload Failed*\n\nCould not get upload URL.\n\nResponse:\n${JSON.stringify(data, null, 2).slice(0, 500)}` 
        });
      }

      // ─── SEND SUCCESS MESSAGE ───
      const finalSize = (fileBuffer.length / 1024 / 1024).toFixed(1);
      const fileExtension = fileName.split('.').pop() || 'file';
      const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExtension.toLowerCase());
      const isVideo = ['mp4', 'mov', 'avi', 'mkv'].includes(fileExtension.toLowerCase());

      let successMsg = `📤 *Catbox Upload Success*\n\n`;
      successMsg += `📁 *File:* ${fileName}\n`;
      successMsg += `📦 *Size:* ${finalSize} MB\n`;
      successMsg += `🔗 *Link:* ${uploadUrl}\n`;
      if (message) successMsg += `📝 *Message:* ${message}\n`;
      successMsg += `\n✅ *Upload Complete!*`;

      // ─── SEND PREVIEW IF IMAGE ───
      if (isImage) {
        try {
          await sock.sendMessage(from, {
            image: { url: uploadUrl },
            caption: successMsg
          });
          return;
        } catch (imgErr) {}
      }

      // ─── SEND PREVIEW IF VIDEO ───
      if (isVideo) {
        try {
          await sock.sendMessage(from, {
            video: { url: uploadUrl },
            caption: successMsg
          });
          return;
        } catch (videoErr) {}
      }

      // ─── SEND TEXT RESPONSE ───
      await sock.sendMessage(from, { text: successMsg });

      console.log(`✅ Catbox upload: ${fileName} -> ${uploadUrl}`);

    } catch (error) {
      console.error('Catbox upload error:', error);

      // ─── FALLBACK: Direct Catbox Upload ───
      try {
        const directFormData = new FormData();
        directFormData.append('reqtype', 'fileupload');
        directFormData.append('fileToUpload', new Blob([fileBuffer], { type: mimetype }), fileName);

        const directRes = await fetch('https://catbox.moe/user/api.php', {
          method: 'POST',
          body: directFormData,
          signal: AbortSignal.timeout(60000)
        });

        if (directRes.ok) {
          const directUrl = await directRes.text();
          if (directUrl && directUrl.startsWith('http')) {
            const finalSize = (fileBuffer.length / 1024 / 1024).toFixed(1);
            return await sock.sendMessage(from, { 
              text: `📤 *Catbox Upload Success (Direct)*\n\n📁 *File:* ${fileName}\n📦 *Size:* ${finalSize} MB\n🔗 *Link:* ${directUrl}\n\n✅ *Upload Complete!*` 
            });
          }
        }
      } catch (directErr) {
        console.log('❌ Direct Catbox upload failed:', directErr.message);
      }

      await sock.sendMessage(from, { 
        text: `⚠️ *Upload Error*\n\n${error.message || 'Could not upload file.'}\n\n💡 Tips:\n• File must be under 200MB\n• Try a different file\n• Try again later` 
      });
    }
  }
});

// uguu.js - Uguu File Uploader
register({
  name: 'uguu',
  aliases: ['uploaduguu', 'uguuupload', 'uguuup'],
  category: 'TOOLS',
  description: 'Upload files/images to Uguu (via David Cyril API)',
  async execute({ sock, from, msg, quoted, args, prefix, command }) {
    // ─── CHECK IF REPLYING TO A FILE ───
    const target = quoted || msg;
    
    let fileBuffer = null;
    let fileType = '';
    let fileName = 'file';
    let mimetype = '';

    // ─── EXTRACT FILE FROM MESSAGE ───
    // Check for image
    if (target.message?.imageMessage) {
      try {
        const media = await sock.downloadMediaMessage(target);
        if (media) {
          fileBuffer = media;
          fileType = 'image';
          mimetype = target.message.imageMessage.mimetype || 'image/jpeg';
          fileName = target.message.imageMessage.fileName || 'image.jpg';
        }
      } catch (e) {}
    }
    
    // Check for document
    if (!fileBuffer && target.message?.documentMessage) {
      try {
        const media = await sock.downloadMediaMessage(target);
        if (media) {
          fileBuffer = media;
          fileType = 'document';
          mimetype = target.message.documentMessage.mimetype || 'application/octet-stream';
          fileName = target.message.documentMessage.fileName || 'document.pdf';
        }
      } catch (e) {}
    }
    
    // Check for sticker
    if (!fileBuffer && target.message?.stickerMessage) {
      try {
        const media = await sock.downloadMediaMessage(target);
        if (media) {
          fileBuffer = media;
          fileType = 'sticker';
          mimetype = target.message.stickerMessage.mimetype || 'image/webp';
          fileName = 'sticker.webp';
        }
      } catch (e) {}
    }
    
    // Check for video
    if (!fileBuffer && target.message?.videoMessage) {
      try {
        const media = await sock.downloadMediaMessage(target);
        if (media) {
          fileBuffer = media;
          fileType = 'video';
          mimetype = target.message.videoMessage.mimetype || 'video/mp4';
          fileName = target.message.videoMessage.fileName || 'video.mp4';
        }
      } catch (e) {}
    }

    // Check for audio
    if (!fileBuffer && target.message?.audioMessage) {
      try {
        const media = await sock.downloadMediaMessage(target);
        if (media) {
          fileBuffer = media;
          fileType = 'audio';
          mimetype = target.message.audioMessage.mimetype || 'audio/mpeg';
          fileName = target.message.audioMessage.fileName || 'audio.mp3';
        }
      } catch (e) {}
    }

    // ─── CHECK IF USER PROVIDED A FILE NAME ───
    if (args[0]) {
      fileName = args[0];
    }

    if (!fileBuffer) {
      return await sock.sendMessage(from, { 
        text: `📤 *Uguu Uploader*\n\nUsage: Reply to an image/document/sticker/video with:\n${prefix}${command} <filename>\n\n*Examples:*\n${prefix}${command} myimage.jpg (reply to image)\n${prefix}${command} document.pdf (reply to PDF)\n\n*Supports:*\n• Images (jpg, png, gif)\n• Documents (pdf, txt, etc.)\n• Stickers (webp)\n• Videos (mp4)\n• Audio (mp3)\n\n*Aliases:* ${prefix}uploaduguu, ${prefix}uguuupload, ${prefix}uguuup` 
      });
    }

    // ─── CHECK FILE SIZE (max 512MB for Uguu) ───
    const fileSizeMB = (fileBuffer.length / 1024 / 1024).toFixed(1);
    if (parseFloat(fileSizeMB) > 512) {
      return await sock.sendMessage(from, { 
        text: `❌ File too large! (${fileSizeMB}MB)\nMax size: 512MB` 
      });
    }

    await sock.sendMessage(from, { 
      text: `📤 *Uploading to Uguu...*\n📁 File: ${fileName}\n📦 Size: ${fileSizeMB}MB\n⏳ Please wait...` 
    });

    try {
      // ─── DAVID CYRIL API (POST) ───
      const apiUrl = 'https://apis.davidcyril.name.ng/uploader/uguu';
      
      // Create FormData
      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer], { type: mimetype }), fileName);
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: formData,
        signal: AbortSignal.timeout(120000) // 2 minute timeout
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      // ─── EXTRACT UPLOAD URL ───
      let uploadUrl = null;
      let message = '';

      if (data.result) {
        uploadUrl = data.result.url || data.result.link || data.result || null;
        message = data.result.message || data.message || '';
      } else if (data.url) {
        uploadUrl = data.url;
      } else if (data.link) {
        uploadUrl = data.link;
      } else if (data.data) {
        uploadUrl = data.data;
      } else if (typeof data === 'string') {
        uploadUrl = data;
      }

      // If no URL, try to find one in the response
      if (!uploadUrl) {
        const jsonString = JSON.stringify(data);
        const urlMatch = jsonString.match(/https?:\/\/[^\s"']+\.(jpg|png|gif|webp|mp4|pdf|txt|zip|rar|7z|mp3|wav)/i);
        if (urlMatch) {
          uploadUrl = urlMatch[0];
        }
      }

      if (!uploadUrl || !uploadUrl.startsWith('http')) {
        return await sock.sendMessage(from, { 
          text: `❌ *Upload Failed*\n\nCould not get upload URL.\n\nResponse:\n${JSON.stringify(data, null, 2).slice(0, 500)}` 
        });
      }

      // ─── SEND SUCCESS MESSAGE ───
      const finalSize = (fileBuffer.length / 1024 / 1024).toFixed(1);
      const fileExtension = fileName.split('.').pop() || 'file';
      const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExtension.toLowerCase());
      const isVideo = ['mp4', 'mov', 'avi', 'mkv'].includes(fileExtension.toLowerCase());

      let successMsg = `📤 *Uguu Upload Success*\n\n`;
      successMsg += `📁 *File:* ${fileName}\n`;
      successMsg += `📦 *Size:* ${finalSize} MB\n`;
      successMsg += `🔗 *Link:* ${uploadUrl}\n`;
      if (message) successMsg += `📝 *Message:* ${message}\n`;
      successMsg += `\n✅ *Upload Complete!*`;

      // ─── SEND PREVIEW IF IMAGE ───
      if (isImage) {
        try {
          await sock.sendMessage(from, {
            image: { url: uploadUrl },
            caption: successMsg
          });
          return;
        } catch (imgErr) {}
      }

      // ─── SEND PREVIEW IF VIDEO ───
      if (isVideo) {
        try {
          await sock.sendMessage(from, {
            video: { url: uploadUrl },
            caption: successMsg
          });
          return;
        } catch (videoErr) {}
      }

      // ─── SEND TEXT RESPONSE ───
      await sock.sendMessage(from, { text: successMsg });

      console.log(`✅ Uguu upload: ${fileName} -> ${uploadUrl}`);

    } catch (error) {
      console.error('Uguu upload error:', error);

      // ─── FALLBACK: Direct Uguu Upload ───
      try {
        const directFormData = new FormData();
        directFormData.append('file', new Blob([fileBuffer], { type: mimetype }), fileName);

        const directRes = await fetch('https://uguu.se/api.php?d=upload-tool', {
          method: 'POST',
          body: directFormData,
          signal: AbortSignal.timeout(60000)
        });

        if (directRes.ok) {
          const directData = await directRes.json();
          const directUrl = directData.url || directData.link || directData;
          if (directUrl && directUrl.startsWith('http')) {
            const finalSize = (fileBuffer.length / 1024 / 1024).toFixed(1);
            return await sock.sendMessage(from, { 
              text: `📤 *Uguu Upload Success (Direct)*\n\n📁 *File:* ${fileName}\n📦 *Size:* ${finalSize} MB\n🔗 *Link:* ${directUrl}\n\n✅ *Upload Complete!*` 
            });
          }
        }
      } catch (directErr) {
        console.log('❌ Direct Uguu upload failed:', directErr.message);
      }

      // ─── SECOND FALLBACK: Alternative Uguu API ───
      try {
        const altFormData = new FormData();
        altFormData.append('file', new Blob([fileBuffer], { type: mimetype }), fileName);

        const altRes = await fetch('https://uguu.se/upload', {
          method: 'POST',
          body: altFormData,
          signal: AbortSignal.timeout(60000)
        });

        if (altRes.ok) {
          const altData = await altRes.json();
          const altUrl = altData.url || altData.link || altData;
          if (altUrl && altUrl.startsWith('http')) {
            const finalSize = (fileBuffer.length / 1024 / 1024).toFixed(1);
            return await sock.sendMessage(from, { 
              text: `📤 *Uguu Upload Success (Alt)*\n\n📁 *File:* ${fileName}\n📦 *Size:* ${finalSize} MB\n🔗 *Link:* ${altUrl}\n\n✅ *Upload Complete!*` 
            });
          }
        }
      } catch (altErr) {
        console.log('❌ Alt Uguu upload failed:', altErr.message);
      }

      await sock.sendMessage(from, { 
        text: `⚠️ *Upload Error*\n\n${error.message || 'Could not upload file.'}\n\n💡 Tips:\n• File must be under 512MB\n• Try a different file\n• Try again later\n• Use ${prefix}catbox for alternative upload` 
      });
    }
  }
});
register({
  name: 'tocartoon',
  aliases: ['cartoon', 'cartoonify', 'toon', 'animeify'],
  category: 'TOOLS',
  description: 'Convert a normal image into a realistic cartoon-style artwork',
  async execute({ sock, from, msg, quoted, args, prefix, command }) {
    // ==========================================================
    // Check if user provided a URL or replied to an image
    // ==========================================================
    let imageUrl = null;
    const target = quoted || msg;

    // Check if user provided a URL as argument
    if (args[0] && args[0].startsWith('http')) {
      imageUrl = args[0];
    }
    // Check if replying to an image
    else if (target.message?.imageMessage) {
      imageUrl = target.message.imageMessage.url || target.message.imageMessage.caption;
    }
    // Check if replying to a document (image)
    else if (target.message?.documentMessage?.mimetype?.includes('image')) {
      imageUrl = target.message.documentMessage.url;
    }
    // Check if replying to a sticker
    else if (target.message?.stickerMessage) {
      imageUrl = target.message.stickerMessage.url;
    }

    if (!imageUrl) {
      return await sock.sendMessage(from, { 
        text: `🎨 *Cartoonify Image*\n\nUsage: ${prefix}${command} <image_url>\nOr reply to an image with: ${prefix}${command}\n\n*Examples:*\n${prefix}${command} https://example.com/photo.jpg\nReply to a photo with ${prefix}${command}\n\n*Supports:*\n• Images (jpg, png, jpeg)\n• Stickers (webp)\n• Any image URL` 
      });
    }

    await sock.sendMessage(from, { text: `🎨 *Converting image to cartoon...*\n⏳ This may take 5-10 seconds...` });

    try {
      // ==========================================================
      // Call OmegaTech ToCartoon API
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/tools/tocartoon`);
      apiUrl.searchParams.append('image', imageUrl);

      const response = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Extract cartoon image URL
      // ==========================================================
      let cartoonUrl = data.result?.url || data.result?.image || data.result?.cartoon || 
                       data.url || data.image || data.cartoon || data.data;

      if (!cartoonUrl) {
        const jsonString = JSON.stringify(data);
        const urlMatch = jsonString.match(/https?:\/\/[^\s"']+\.(png|jpg|jpeg|gif|webp)/i);
        if (urlMatch) cartoonUrl = urlMatch[0];
      }

      if (!cartoonUrl) {
        return await sock.sendMessage(from, { 
          text: `❌ Could not convert image to cartoon. Please try a different image.` 
        });
      }

      // ==========================================================
      // Download and send the cartoon image
      // ==========================================================
      const imageResponse = await fetch(cartoonUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!imageResponse.ok) {
        throw new Error(`Failed to download cartoon: ${imageResponse.status}`);
      }

      const cartoonBuffer = Buffer.from(await imageResponse.arrayBuffer());

      if (cartoonBuffer.length < 1000) {
        return await sock.sendMessage(from, { 
          text: `❌ Generated cartoon image is too small. Please try again.` 
        });
      }

      const fileSize = (cartoonBuffer.length / 1024).toFixed(1);

      // ==========================================================
      // Send the cartoon image
      // ==========================================================
      await sock.sendMessage(from, {
        image: cartoonBuffer,
        caption: `🎨 *Cartoonified Image*\n\n📦 *Size:* ${fileSize} KB\n\n✅ *Successfully converted to cartoon style*\n\n✨ _Powered by OmegaTech_`
      });

    } catch (error) {
      console.error('Cartoonify error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not convert image.'}\n\n💡 Try:\n• A different image\n• A clearer photo\n• A URL instead of a file\n• ${prefix}${command} https://example.com/photo.jpg` 
      });
    }
  }
});
register({
  name: 'meta',
  aliases: ['metabots', 'aichat', 'coze', 'character'],
  category: 'AI',
  description: 'Chat with AI characters/bots from Meta (Coze/Anime/Diverse categories)',
  async execute({ sock, from, args, prefix, command, sessionId }) {
    // ==========================================================
    // Check if user provided an action
    // ==========================================================
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🧠 *Meta AI Characters*\n\n*Actions:*\n• ${prefix}${command} categories - List all bot categories\n• ${prefix}${command} bots <category_id> - List bots in a category\n• ${prefix}${command} chat <bot_id> <message> - Chat with a bot\n• ${prefix}${command} search <query> - Search for a character\n\n*Quick examples:*\n${prefix}${command} categories\n${prefix}${command} bots 17\n${prefix}${command} chat 2 Hello Gojo!\n${prefix}${command} search anime` 
      });
    }

    const action = args[0].toLowerCase();
    const query = args.slice(1).join(" ");

    try {
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/ai/Meta`);

      // ==========================================================
      // Action: categories - List all categories
      // ==========================================================
      if (action === 'categories') {
        apiUrl.searchParams.append('action', 'categories');
        
        const response = await fetch(apiUrl.toString(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const data = await response.json();

        let categories = data.data || data.result || [];
        if (!categories.length) {
          return await sock.sendMessage(from, { text: '❌ No categories found.' });
        }

        let msg = `📂 *Meta Bot Categories (${categories.length})*\n\n`;
        for (const cat of categories) {
          const id = cat.id || cat.cid || '?';
          const name = cat.cname || cat.name || cat.category || 'Unknown';
          const count = cat.bots?.length || cat.count || 0;
          msg += `• *${name}* (ID: ${id}) — ${count} bots\n`;
        }
        msg += `\n💡 Use: ${prefix}${command} bots <category_id> to see bots`;
        await sock.sendMessage(from, { text: msg });
        return;
      }

      // ==========================================================
      // Action: bots - List bots in a category
      // ==========================================================
      if (action === 'bots') {
        if (!query) {
          return await sock.sendMessage(from, { 
            text: `❌ Please provide a category ID.\n\nUsage: ${prefix}${command} bots <category_id>\nExample: ${prefix}${command} bots 17\n\n💡 Use ${prefix}${command} categories to see all IDs.` 
          });
        }

        apiUrl.searchParams.append('action', 'categories');
        apiUrl.searchParams.append('cateid', query);

        const response = await fetch(apiUrl.toString(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const data = await response.json();

        let bots = data.data || data.result || [];
        if (!bots.length) {
          return await sock.sendMessage(from, { text: `❌ No bots found in category ${query}.` });
        }

        let msg = `🤖 *Bots in Category ${query} (${bots.length})*\n\n`;
        for (const bot of bots) {
          const id = bot.id || bot.bot_id || '?';
          const name = bot.bot_name || bot.name || 'Unknown';
          const desc = bot.description || bot.desc || '';
          const vip = bot.is_vip ? '⭐' : '';
          msg += `• *${name}* ${vip} (ID: ${id})\n`;
          if (desc) msg += `  ${desc.slice(0, 60)}${desc.length > 60 ? '...' : ''}\n`;
          msg += `\n`;
        }
        msg += `💡 Use: ${prefix}${command} chat <bot_id> <message> to chat\n`;
        msg += `Example: ${prefix}${command} chat 2 Hello Gojo!`;
        await sock.sendMessage(from, { text: msg });
        return;
      }

      // ==========================================================
      // Action: chat - Chat with a specific bot
      // ==========================================================
      if (action === 'chat') {
        const parts = query.split(' ');
        if (parts.length < 2) {
          return await sock.sendMessage(from, { 
            text: `❌ Usage: ${prefix}${command} chat <bot_id> <message>\n\nExample: ${prefix}${command} chat 2 Hello Gojo!\n\n💡 Use ${prefix}${command} bots 17 to see bot IDs.` 
          });
        }

        const botId = parts[0];
        const message = parts.slice(1).join(' ');

        // Generate session ID for this user and bot
        const userSessionId = sessionId || from.split('@')[0];
        const sessionKey = `meta_${userSessionId}_${botId}`;

        apiUrl.searchParams.append('action', 'chat');
        apiUrl.searchParams.append('bot_id', botId);
        apiUrl.searchParams.append('prompt', message);
        apiUrl.searchParams.append('sessionId', sessionKey);

        await sock.sendMessage(from, { text: `🧠 *Meta AI thinking...*` });

        const response = await fetch(apiUrl.toString(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const data = await response.json();

        let reply = data.result || data.response || data.reply || data.message || data.text;

        if (!reply) {
          const jsonString = JSON.stringify(data);
          const textMatch = jsonString.match(/"result":"([^"]+)"/) || 
                            jsonString.match(/"response":"([^"]+)"/) ||
                            jsonString.match(/"reply":"([^"]+)"/) ||
                            jsonString.match(/"message":"([^"]+)"/);
          if (textMatch) reply = textMatch[1];
        }

        if (!reply) {
          return await sock.sendMessage(from, { text: `❌ No response from the bot.` });
        }

        reply = reply.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '  ');
        if (reply.length > 65000) reply = reply.slice(0, 65000) + '\n\n... (truncated)';

        if (reply.length > 1000) {
          const chunks = reply.match(/[^\n]{1,1000}(?:\n|$)/g) || [reply];
          for (let i = 0; i < Math.min(chunks.length, 5); i++) {
            const chunk = chunks[i].trim();
            if (!chunk) continue;
            const prefix = i === 0 ? `🧠 *Meta AI (${botId}):*\n\n` : `\n*...continued*\n\n`;
            await sock.sendMessage(from, { text: prefix + chunk });
            await new Promise(r => setTimeout(r, 300));
          }
        } else {
          await sock.sendMessage(from, { 
            text: `🧠 *Meta AI (${botId}):*\n\n${reply}` 
          });
        }
        return;
      }

      // ==========================================================
      // Action: search - Search for bots by keyword
      // ==========================================================
      if (action === 'search') {
        if (!query) {
          return await sock.sendMessage(from, { 
            text: `❌ Please provide a search query.\n\nUsage: ${prefix}${command} search <keyword>\nExample: ${prefix}${command} search anime` 
          });
        }

        apiUrl.searchParams.append('action', 'search');
        apiUrl.searchParams.append('query', query);

        const response = await fetch(apiUrl.toString(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const data = await response.json();

        let results = data.data || data.result || [];
        if (!results.length) {
          return await sock.sendMessage(from, { text: `❌ No bots found for "${query}".` });
        }

        let msg = `🔍 *Search Results for "${query}" (${results.length})*\n\n`;
        for (const bot of results.slice(0, 15)) {
          const id = bot.id || bot.bot_id || '?';
          const name = bot.bot_name || bot.name || 'Unknown';
          const desc = bot.description || bot.desc || '';
          msg += `• *${name}* (ID: ${id})\n`;
          if (desc) msg += `  ${desc.slice(0, 60)}${desc.length > 60 ? '...' : ''}\n\n`;
        }
        if (results.length > 15) {
          msg += `\n*...and ${results.length - 15} more.*`;
        }
        msg += `\n💡 Use: ${prefix}${command} chat <bot_id> <message> to chat`;
        await sock.sendMessage(from, { text: msg });
        return;
      }

      // ==========================================================
      // Invalid action
      // ==========================================================
      await sock.sendMessage(from, { 
        text: `❌ Invalid action. Use: categories, bots, chat, search\n\n💡 ${prefix}${command} categories to start.` 
      });

    } catch (error) {
      console.error('Meta error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not reach Meta API.'}\n\n💡 Try:\n• ${prefix}${command} categories\n• ${prefix}${command} bots 17\n• ${prefix}${command} chat 2 Hello` 
      });
    }
  }
});
register({
  name: 'toimage',
  aliases: ['img', 'toimg', 'convertimg'],
  category: 'TOOLS',
  description: 'Convert sticker to image and send',
  async execute({ sock, from, msg, args, prefix, command }) {
    // ─── FIX: Extract quoted message from contextInfo ───
    let quoted = null;
    
    // Method 1: Check msg.quoted (if your bot sets it)
    if (msg?.quoted) {
      quoted = msg.quoted;
    }
    
    // Method 2: Extract from contextInfo (most reliable for your bot)
    if (!quoted && msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
      const contextInfo = msg.message.extendedTextMessage.contextInfo;
      quoted = {
        message: contextInfo.quotedMessage,
        key: {
          id: contextInfo.stanzaId,
          fromMe: false,
          remoteJid: from,
          participant: contextInfo.participant || from
        }
      };
    }

    // Method 3: Check if the message itself is a sticker (if no command text)
    if (!quoted && msg?.message?.stickerMessage) {
      quoted = { message: msg.message };
    }

    if (!quoted || !quoted.message) {
      return await sock.sendMessage(from, { 
        text: `🖼️ Reply to a *sticker* with: ${prefix || '.'}toimage\n\nNo sticker found in reply.` 
      });
    }

    // ─── Check if it's a sticker ───
    const stickerMsg = quoted.message.stickerMessage || 
                       quoted.message.imageMessage?.mimetype?.includes('webp') ||
                       quoted.mimetype?.includes('webp');

    if (!stickerMsg) {
      const msgKeys = Object.keys(quoted.message).join(', ');
      return await sock.sendMessage(from, { 
        text: `🖼️ Reply to a *sticker* with: ${prefix || '.'}toimage\n\nFound: ${msgKeys || 'unknown'}` 
      });
    }

    await sock.sendMessage(from, { text: '⏳ Converting sticker to image...' });

    try {
      const { downloadMediaMessage } = require('@whiskeysockets/baileys');
      
      let mediaBuffer = null;
      
      try {
        mediaBuffer = await downloadMediaMessage(
          quoted,
          'buffer',
          {},
          { reuploadRequest: sock.updateMediaMessage }
        );
      } catch (dlErr) {
        try {
          mediaBuffer = await downloadMediaMessage(
            { key: quoted.key, message: quoted.message },
            'buffer',
            {},
            { reuploadRequest: sock.updateMediaMessage }
          );
        } catch (dlErr2) {
          mediaBuffer = await sock.downloadMediaMessage(quoted);
        }
      }

      if (!mediaBuffer || mediaBuffer.length < 100) {
        return await sock.sendMessage(from, { text: '❌ Failed to download sticker.' });
      }

      // ─── CONVERT WEBP TO IMAGE ───
      let imageBuffer = null;
      
      try {
        const sharp = require('sharp');
        imageBuffer = await sharp(mediaBuffer).toFormat('jpeg').toBuffer();
      } catch (sharpErr) {
        try {
          const ffmpeg = require('ffmpeg-static');
          const { exec } = require('child_process');
          const fs = require('fs');
          const path = require('path');

          const tmpDir = path.join(process.cwd(), 'tmp');
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

          const inputPath = path.join(tmpDir, `sticker_${Date.now()}.webp`);
          const outputPath = path.join(tmpDir, `image_${Date.now()}.jpg`);

          fs.writeFileSync(inputPath, mediaBuffer);
          await new Promise((resolve, reject) => {
            exec(`"${ffmpeg}" -i "${inputPath}" "${outputPath}"`, (error) => {
              if (error) reject(error);
              else resolve();
            });
          });
          imageBuffer = fs.readFileSync(outputPath);
          try { fs.unlinkSync(inputPath); } catch {}
          try { fs.unlinkSync(outputPath); } catch {}
        } catch (ffmpegErr) {
          return await sock.sendMessage(from, { text: '❌ Failed to convert sticker.' });
        }
      }

      if (!imageBuffer || imageBuffer.length < 100) {
        return await sock.sendMessage(from, { text: '❌ Failed to convert sticker.' });
      }

      await sock.sendMessage(from, {
        image: imageBuffer,
        caption: `🖼️ *Sticker to Image*\n📦 Size: ${(imageBuffer.length / 1024).toFixed(1)} KB`
      });

    } catch (error) {
      console.error('To image error:', error);
      await sock.sendMessage(from, { text: `⚠️ Error: ${error.message || 'Could not convert sticker.'}` });
    }
  }
});
register({
  name: 'alightgen',
  aliases: ['alight', 'amprem', 'alightprem', 'amgen'],
  category: 'TOOLS',
  description: 'Generate Alight Motion premium account credentials',
  async execute({ sock, from, args, prefix, command }) {
    await sock.sendMessage(from, { text: `⏳ Generating Alight Motion premium account...` });

    try {
      // ==========================================================
      // Call OmegaTech Alight Motion Generator API
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/tools/Alightmotion-Prem-gen`);
      apiUrl.searchParams.append('action', 'generate');

      const response = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Check if generation was successful
      // ==========================================================
      if (!data.success) {
        return await sock.sendMessage(from, { 
          text: `❌ Account generation failed.\n\n💡 Try again later.` 
        });
      }

      const accounts = data.data?.accounts || [];
      
      if (!accounts.length) {
        return await sock.sendMessage(from, { 
          text: `❌ No accounts generated. Please try again.` 
        });
      }

      const account = accounts[0];
      
      // ==========================================================
      // Extract account details
      // ==========================================================
      const email = account.email || 'N/A';
      const link = account.link || 'N/A';
      const status = account.status ? '✅ Valid' : '❌ Invalid';
      
      const idToken = account.data?.idToken || 'N/A';
      const userId = account.data?.user?.localId || 'N/A';
      const emailVerified = account.data?.user?.emailVerified ? '✅ Yes' : '❌ No';

      // Premium details
      const premium = account.data?.premium?.data?.result || {};
      const isPremium = premium.valid ? '✅ Active' : '❌ Inactive';
      const autoRenew = premium.autoRenewing ? 'Yes' : 'No';
      
      let expiry = 'N/A';
      if (premium.expiryTimeMillis) {
        const expiryDate = new Date(parseInt(premium.expiryTimeMillis));
        expiry = expiryDate.toLocaleString();
      }

      // ==========================================================
      // Build response message
      // ==========================================================
      const msg = `🎬 *Alight Motion Premium Account*\n\n` +
        `📧 *Email:* ${email}\n` +
        `🔗 *Link:* ${link}\n\n` +
        `📊 *Account Status:* ${status}\n` +
        `🆔 *User ID:* ${userId}\n` +
        `📧 *Email Verified:* ${emailVerified}\n\n` +
        `✨ *Premium Status:* ${isPremium}\n` +
        `🔄 *Auto-Renew:* ${autoRenew}\n` +
        `⏰ *Expires:* ${expiry}\n\n` +
        `🔑 *ID Token:*\n\`${idToken.slice(0, 60)}...\`\n\n` +
        `📌 *Instructions:*\n` +
        `1. Open the link in your browser\n` +
        `2. You'll be automatically signed in\n` +
        `3. Open Alight Motion and enjoy premium features\n\n` +
        `⚠️ *Note:* Accounts may expire. Generate a new one if this stops working.\n` +
        `✨ _Powered by OmegaTech_`;

      // ==========================================================
      // Send the account details
      // ==========================================================
      await sock.sendMessage(from, { text: msg });

    } catch (error) {
      console.error('Alight Motion generator error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not generate account.'}\n\n💡 Try:\n• ${prefix}${command} (retry)\n• Wait a few minutes and try again\n• The generator may be rate-limited` 
      });
    }
  }
});
register({
  name: 'llamacoder',
  aliases: ['llama', 'coder', 'aicoder', 'llamacode'],
  category: 'AI',
  description: 'Generate code/projects with Llamacoder AI (web apps, portfolios, etc.)',
  async execute({ sock, from, args, prefix, command }) {
    // ==========================================================
    // Check if user provided a prompt
    // ==========================================================
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🤖 *Llamacoder AI - Code Generator*\n\nUsage: ${prefix}${command} <prompt> [quality]\n\n*Quality options:*\n• low (fast, basic)\n• medium (balanced)\n• high (detailed, full project)\n\n*Examples:*\n${prefix}${command} A simple portfolio\n${prefix}${command} A to-do app with React low\n${prefix}${command} A weather dashboard high\n${prefix}${command} A landing page for a coffee shop medium\n\n*Note:* Generates full project files (React, Next.js, etc.)` 
      });
    }

    // ==========================================================
    // Parse prompt and quality
    // ==========================================================
    let prompt = args.join(" ");
    let quality = 'low'; // default

    // Check if last word is a quality option
    const lastWord = args[args.length - 1].toLowerCase();
    if (['low', 'medium', 'high'].includes(lastWord)) {
      quality = lastWord;
      prompt = args.slice(0, -1).join(" ");
    }

    await sock.sendMessage(from, { 
      text: `🤖 *Llamacoder generating...*\n📝 Prompt: *${prompt}*\n📊 Quality: *${quality}*\n⏳ This may take 10-30 seconds...` 
    });

    try {
      // ==========================================================
      // Call Llamacoder API
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/ai/llamacoder`);
      apiUrl.searchParams.append('action', 'create');
      apiUrl.searchParams.append('prompt', prompt);
      apiUrl.searchParams.append('quality', quality);

      const response = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Check if generation was successful
      // ==========================================================
      if (!data.success) {
        return await sock.sendMessage(from, { 
          text: `❌ Generation failed: ${data.message || 'Unknown error'}` 
        });
      }

      // ==========================================================
      // Extract data
      // ==========================================================
      const sessionId = data.sessionId || 'N/A';
      const chatId = data.chatId || 'N/A';
      const filesCount = data.filesCount || 0;
      const files = data.files || [];

      // ==========================================================
      // Build response message
      // ==========================================================
      let msg = `🤖 *Llamacoder Generation Complete*\n\n`;
      msg += `📝 *Prompt:* ${prompt}\n`;
      msg += `📊 *Quality:* ${quality}\n`;
      msg += `📁 *Files Generated:* ${filesCount}\n`;
      msg += `🆔 *Session ID:* ${sessionId}\n`;
      msg += `💬 *Chat ID:* ${chatId}\n\n`;

      if (files.length) {
        msg += `📂 *Files Created:*\n`;
        for (const file of files) {
          const path = file.path || 'unknown';
          const content = file.content || '';
          const preview = content.slice(0, 100).replace(/\n/g, ' ').trim();
          msg += `• *${path}*\n  \`${preview}${content.length > 100 ? '...' : ''}\`\n\n`;
        }
      }

      // ==========================================================
      // Ask if user wants full code
      // ==========================================================
      msg += `\n💡 *To get the full code:*\n`;
      msg += `${prefix}${command} get ${sessionId}\n\n`;
      msg += `✨ _Powered by OmegaTech Llamacoder_`;

      await sock.sendMessage(from, { text: msg });

    } catch (error) {
      console.error('Llamacoder error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not generate code.'}\n\n💡 Try:\n• A shorter prompt\n• ${prefix}${command} simple to-do app low\n• ${prefix}${command} portfolio medium\n• Check your internet connection` 
      });
    }
  }
});

// ==========================================================
// Sub-command: Get full code from a session
// ==========================================================
register({
  name: 'llamacoder get',
  aliases: ['llamaget', 'codepull', 'llamafiles'],
  category: 'AI',
  description: 'Get full code files from a Llamacoder session',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `📂 *Get Llamacoder Files*\n\nUsage: ${prefix}${command} get <session_id>\nExample: ${prefix}${command} get be7ca71b-f32b-4cc4-b87f-32add052b94e` 
      });
    }

    const sessionId = args[0];

    await sock.sendMessage(from, { text: `⏳ Fetching files for session ${sessionId}...` });

    try {
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/ai/llamacoder`);
      apiUrl.searchParams.append('action', 'get');
      apiUrl.searchParams.append('sessionId', sessionId);

      const response = await fetch(apiUrl.toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });

      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const data = await response.json();

      if (!data.success) {
        return await sock.sendMessage(from, { text: `❌ ${data.message || 'Session not found.'}` });
      }

      const files = data.files || [];
      if (!files.length) {
        return await sock.sendMessage(from, { text: `❌ No files found for session ${sessionId}.` });
      }

      // ==========================================================
      // Send each file as a document or text
      // ==========================================================
      let sentCount = 0;
      for (const file of files) {
        const path = file.path || 'file';
        const content = file.content || '';

        if (!content) continue;

        const buffer = Buffer.from(content, 'utf-8');
        const ext = path.split('.').pop() || 'txt';
        const fileName = path.replace(/\//g, '_');

        try {
          await sock.sendMessage(from, {
            document: buffer,
            mimetype: 'text/plain',
            fileName: fileName,
            caption: `📁 *${path}*\n📦 ${(buffer.length / 1024).toFixed(1)} KB`
          });
          sentCount++;
          await new Promise(r => setTimeout(r, 500));
        } catch (sendErr) {
          // Try sending as text if document fails
          const preview = content.slice(0, 1000);
          await sock.sendMessage(from, { 
            text: `📁 *${path}*\n\n\`\`\`${ext}\n${preview}${content.length > 1000 ? '\n\n... (truncated)' : ''}\n\`\`\`` 
          });
          sentCount++;
        }
      }

      if (sentCount === 0) {
        await sock.sendMessage(from, { text: `❌ Could not send any files.` });
      } else {
        await sock.sendMessage(from, { 
          text: `✅ Sent *${sentCount}* file${sentCount > 1 ? 's' : ''} from session ${sessionId}.` 
        });
      }

    } catch (error) {
      console.error('Llamacoder get error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not fetch files.'}` 
      });
    }
  }
});
register({
  name: 'tiktokboost',
  aliases: ['ttboost', 'boost', 'ttviews', 'tiktokviews'],
  category: 'TOOLS',
  description: 'Boost TikTok video views and engagement',
  async execute({ sock, from, args, prefix, command }) {
    // ==========================================================
    // Check if user provided a TikTok URL
    // ==========================================================
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🚀 *TikTok Video Booster*\n\nUsage: ${prefix}${command} <tiktok_url>\nExample: ${prefix}${command} https://www.tiktok.com/@username/video/xxxxx\n\n*Note:* Likes and views take time to register.\n\n*Supports:*\n• TikTok video URLs\n• Short links (vm.tiktok.com)\n• Profile video links` 
      });
    }

    const url = args[0];

    // ==========================================================
    // Validate TikTok URL
    // ==========================================================
    if (!url.includes('tiktok.com') && !url.includes('vm.tiktok.com')) {
      return await sock.sendMessage(from, { 
        text: `❌ Invalid URL. Please provide a valid TikTok video link.\n\nExample: https://www.tiktok.com/@username/video/xxxxx` 
      });
    }

    await sock.sendMessage(from, { 
      text: `🚀 *Processing boost...*\n⏳ This may take a few seconds.\n\n📱 URL: ${url.slice(0, 50)}...` 
    });

    try {
      // ==========================================================
      // Call OmegaTech TikTok Booster API
      // ==========================================================
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const apiUrl = new URL(`${baseUrl}/api/Fun/Tiktok-booster`);
      apiUrl.searchParams.append('action', 'boost');
      apiUrl.searchParams.append('url', url);

      const response = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // ==========================================================
      // Check if the request was successful
      // ==========================================================
      if (!data.success) {
        const errorMsg = data.message || data.error || 'Unknown error';
        return await sock.sendMessage(from, { 
          text: `❌ Boost failed: ${errorMsg}\n\n💡 Try again later or check the URL.` 
        });
      }

      // ==========================================================
      // Extract and display the boost result
      // ==========================================================
      const result = data.data || {};
      const title = result.title || 'TikTok Video';
      const author = result.author || result.username || 'Unknown';
      const username = result.username || author;
      const status = result.status || 'completed';

      const statusEmoji = status === 'completed' ? '✅' : '⏳';

      const boostMessage = `🚀 *TikTok Boost Successful!*\n\n` +
        `${statusEmoji} *Status:* ${status}\n` +
        `📱 *Video:* ${title.slice(0, 60)}${title.length > 60 ? '...' : ''}\n` +
        `👤 *Author:* ${author} (@${username})\n` +
        `🔗 *URL:* ${url.slice(0, 40)}...\n\n` +
        `📊 *Boost Started*\n` +
        `⏱️ *Timestamp:* ${data.timestamp ? new Date(data.timestamp).toLocaleString() : 'Just now'}\n\n` +
        `*⚠️ Note:* Likes and views take time to register.\n` +
        `✨ _Powered by INCONNU XD V2`;

      await sock.sendMessage(from, { 
        text: boostMessage 
      });

    } catch (error) {
      console.error('TikTok boost error:', error);
      await sock.sendMessage(from, { 
        text: `⚠️ Error: ${error.message || 'Could not boost video.'}\n\n💡 Try:\n• Check the URL is valid\n• Try again later\n• Use a different TikTok video` 
      });
    }
  }
});
register({
  name: 'waifu',
  aliases: ['animegirl', 'waifuai', 'waifuimg'],
  category: 'TOOLS',
  description: 'Get a random anime waifu image',
  async execute({ sock, from, prefix, command }) {
    await sock.sendMessage(from, { text: `⏳ Fetching a waifu image...` });

    try {
      // Primary: GiftedTech API
      const response = await fetch(
        `https://api.giftedtech.co.ke/api/anime/waifu?apikey=gifted`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract image URL
      let imageUrl = data.result || data.url || data.image || data.data?.url || data.data?.result;

      if (!imageUrl) {
        const jsonString = JSON.stringify(data);
        const urlMatch = jsonString.match(/https?:\/\/[^\s"']+\.(png|jpg|jpeg|gif|webp)/i);
        if (urlMatch) imageUrl = urlMatch[0];
      }

      if (!imageUrl) {
        throw new Error("Could not extract image URL from API response.");
      }

      // Send the image
      await sock.sendMessage(from, {
        image: { url: imageUrl },
        caption: `💕 *Waifu*\n\n✨ _Powered by INCONNU XD V2_`
      });

    } catch (error) {
      console.error('Waifu error:', error);

      // Fallback: Waifu API (sfw/waifu)
      try {
        const fallbackRes = await fetch('https://api.waifu.pics/sfw/waifu');
        const fallbackData = await fallbackRes.json();

        if (fallbackData && fallbackData.url) {
          return await sock.sendMessage(from, {
            image: { url: fallbackData.url },
            caption: `💕 *Waifu (fallback)*\n\n✨ _Powered by INCONNU XD V2_`
          });
        }
      } catch (fallbackErr) {}

      // Fallback: Another anime API
      try {
        const anotherRes = await fetch('https://nekos.life/api/v2/img/waifu');
        const anotherData = await anotherRes.json();

        if (anotherData && anotherData.url) {
          return await sock.sendMessage(from, {
            image: { url: anotherData.url },
            caption: `💕 *Waifu (fallback)*\n\n✨ _Powered by INCONNU XD V2_`
          });
        }
      } catch (anotherErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ Waifu Error: ${error.message || 'Could not fetch image.'}\n\n💡 Try again later.` 
      });
    }
  }
});
register({
  name: 'github',
  category: 'INFO',
  description: 'Search GitHub user profiles',
  async execute({ sock, from, text }) {
    if (!text) return sock.sendMessage(from, { text: '❓ GitHub username?' });
    try {
      const res = await fetch(`${P_BASE}/search/github?apikey=${P_KEY}&query=${encodeURIComponent(text)}`);
      const data = await res.json();
      const v = data.result;
      if (!v) return sock.sendMessage(from, { text: '❌ User not found.' });
      const info = `👤 *User:* ${v.login}\n📂 *Repos:* ${v.public_repos}\n👥 *Followers:* ${v.followers}\n🔗 *Link:* ${v.html_url}`;
      await sock.sendMessage(from, { image: { url: v.avatar_url }, caption: info });
    } catch (e) {
      await sock.sendMessage(from, { text: '⚠️ GitHub Error: ' + e.message });
    }
  }
});

// ==========================================
//                TOOL COMMANDS
// ==========================================

register({
  name: 'ssweb',
  category: 'TOOLS',
  description: 'Screenshot of a website',
  async execute({ sock, from, args }) {
    if (!args[0]) return sock.sendMessage(from, { text: '❓ Provide URL.' });
    await sock.sendMessage(from, { image: { url: `${P_BASE}/tools/ssweb?apikey=${P_KEY}&url=${args[0]}` }, caption: '📸 Screenshot' });
  }
});

register({
  name: 'shorturl',
  category: 'TOOLS',
  description: 'Shorten a long URL',
  async execute({ sock, from, args }) {
    if (!args[0]) return sock.sendMessage(from, { text: '❓ Provide URL.' });
    try {
      const res = await fetch(`${P_BASE}/tools/tinyurl?apikey=${P_KEY}&url=${args[0]}`);
      const data = await res.json();
      if (!data.result) return sock.sendMessage(from, { text: '❌ Could not shorten that URL.' });
      await sock.sendMessage(from, { text: `🔗 *Shortened:* ${data.result}` });
    } catch (e) {
      await sock.sendMessage(from, { text: '⚠️ Shorten Error: ' + e.message });
    }
  }
});

register({
  name: 'translate',
  category: 'TOOLS',
  description: 'Translate text to English',
  async execute({ sock, from, text }) {
    if (!text) return sock.sendMessage(from, { text: '❓ Text to translate?' });
    try {
      const res = await fetch(`${P_BASE}/tools/translate?apikey=${P_KEY}&query=${encodeURIComponent(text)}&lang=en`);
      const data = await res.json();
      if (!data.result) return sock.sendMessage(from, { text: '❌ Could not translate that text.' });
      await sock.sendMessage(from, { text: `🌍 *Translation:* ${data.result}` });
    } catch (e) {
      await sock.sendMessage(from, { text: '⚠️ Translate Error: ' + e.message });
    }
  }
});

register({
  name: 'meme',
  aliases: ['memes', 'dank', 'funny'],
  category: 'TOOLS',
  description: 'Get a random meme from the internet',
  async execute({ sock, from, prefix, command }) {
    await sock.sendMessage(from, { text: `⏳ Fetching a meme...` });

    try {
      // Primary: OmegaTech API
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const response = await fetch(`${baseUrl}/api/meme`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract meme data from various formats
      let imageUrl = data.result?.url || data.result?.image || data.result?.img || 
                     data.url || data.image || data.img;
      let title = data.result?.title || data.title || '😂 Meme';
      let subreddit = data.result?.subreddit || data.subreddit || 'unknown';
      let upvotes = data.result?.upvotes || data.upvotes || '?';

      if (!imageUrl) {
        // Fallback: try to find any URL in the response
        const jsonString = JSON.stringify(data);
        const urlMatch = jsonString.match(/https?:\/\/[^\s"']+\.(png|jpg|jpeg|gif|webp)/i);
        if (urlMatch) imageUrl = urlMatch[0];
      }

      if (!imageUrl) {
        throw new Error("Could not extract meme image from API response.");
      }

      const caption = `😂 *${title}*\n\n📌 r/${subreddit}\n⬆️ ${upvotes} upvotes\n\n✨ _Powered by INCONNU XD V2_`;

      await sock.sendMessage(from, {
        image: { url: imageUrl },
        caption: caption
      });

    } catch (error) {
      console.error('Meme error:', error);

      // Fallback: Prince API
      try {
        const princeUrl = 'https://api.princetechn.com/api/tools/meme';
        const fallbackRes = await fetch(`${princeUrl}?apikey=prince`);
        const fallbackData = await fallbackRes.json();

        let fallbackImage = fallbackData.result?.url || fallbackData.result || fallbackData.url || fallbackData.image;

        if (fallbackImage) {
          return await sock.sendMessage(from, {
            image: { url: fallbackImage },
            caption: '😂 *Random Meme*\n\n✨ _Powered by INCONNU XD V2_'
          });
        }
      } catch (fallbackErr) {
        // Silent fail
      }

      // Fallback: Reddit API directly
      try {
        const redditRes = await fetch('https://meme-api.com/gimme');
        const redditData = await redditRes.json();

        if (redditData && redditData.url) {
          const caption = `😂 *${redditData.title || 'Meme'}*\n\n📌 r/${redditData.subreddit || 'memes'}\n⬆️ ${redditData.ups || '?'} upvotes\n\n✨ _Powered by INCONNU XD V2_`;

          return await sock.sendMessage(from, {
            image: { url: redditData.url },
            caption: caption
          });
        }
      } catch (redditErr) {
        // Silent fail
      }

      await sock.sendMessage(from, {
        text: `⚠️ Meme Error: ${error.message || 'Could not fetch meme.'}\n\n💡 Try again later.`
      });
    }
  }
});

register({
  name: 'waifu2',
  category: 'TOOLS',
  description: 'Random Waifu Anime Image',
  async execute({ sock, from }) {
    await sock.sendMessage(from, { image: { url: `${P_BASE}/anime/waifu?apikey=${P_KEY}` }, caption: '❤️' });
  }
});

register({
  name: 'fact',
  aliases: ['facts', 'didyouknow', 'trivia'],
  category: 'TOOLS',
  description: 'Get a random interesting fact',
  async execute({ sock, from, prefix, command }) {
    await sock.sendMessage(from, { text: `⏳ Fetching a fact...` });

    try {
      // Primary: OmegaTech API
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const response = await fetch(`${baseUrl}/api/fact`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract fact from various formats
      let fact = data.result || data.fact || data.text || data.message || data.data;

      if (!fact) {
        const jsonString = JSON.stringify(data);
        const textMatch = jsonString.match(/"fact":"([^"]+)"/) || 
                          jsonString.match(/"text":"([^"]+)"/) ||
                          jsonString.match(/"result":"([^"]+)"/);
        if (textMatch) fact = textMatch[1];
      }

      if (!fact) {
        throw new Error("Could not extract fact from API response.");
      }

      // Clean up the fact
      fact = fact.replace(/\\n/g, '\n').replace(/\\"/g, '"');

      // Split long facts into chunks if needed
      if (fact.length > 1000) {
        const chunks = fact.match(/.{1,1000}/g) || [fact];
        for (const chunk of chunks) {
          await sock.sendMessage(from, { text: `💡 *Did you know?*\n\n${chunk}` });
        }
      } else {
        await sock.sendMessage(from, { 
          text: `💡 *Did you know?*\n\n${fact}` 
        });
      }

    } catch (error) {
      console.error('Fact error:', error);

      // Fallback: Prince API
      try {
        const princeUrl = 'https://api.princetechn.com/api/tools/fact';
        const fallbackRes = await fetch(`${princeUrl}?apikey=prince`);
        const fallbackData = await fallbackRes.json();

        let fallbackFact = fallbackData.result || fallbackData.fact || fallbackData.text;

        if (fallbackFact) {
          return await sock.sendMessage(from, { 
            text: `💡 *Did you know?*\n\n${fallbackFact}` 
          });
        }
      } catch (fallbackErr) {
        // Silent fail
      }

      // Fallback: Free API (Useless Facts)
      try {
        const uselessRes = await fetch('https://uselessfacts.jsph.pl/random.json?language=en');
        const uselessData = await uselessRes.json();

        if (uselessData && uselessData.text) {
          return await sock.sendMessage(from, { 
            text: `💡 *Did you know?*\n\n${uselessData.text}` 
          });
        }
      } catch (uselessErr) {
        // Silent fail
      }

      // Fallback: Another free API
      try {
        const anotherRes = await fetch('https://api.api-ninjas.com/v1/facts?limit=1', {
          headers: { 'X-Api-Key': 'your-key-here' } // Note: requires API key
        });
        // This one needs an API key, so skip if not configured
      } catch (anotherErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ Fact Error: ${error.message || 'Could not fetch a fact.'}\n\n💡 Try again later.` 
      });
    }
  }
});
register({
  name: 'gpt',
  aliases: ['ai', 'chatgpt', 'ask'],
  category: 'AI',
  description: 'Chat with ChatGPT AI assistant',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🤖 *GPT Assistant*\n\nUsage: ${prefix}${command} <your question>\nExample: ${prefix}${command} What is the capital of France?\n\n*Examples:*\n${prefix}${command} Write a poem about AI\n${prefix}${command} Explain quantum computing in simple terms\n${prefix}${command} Create a JavaScript function to reverse a string` 
      });
    }

    const query = args.join(" ");

    await sock.sendMessage(from, { text: `⏳ Thinking...` });

    try {
      // Primary: EliteProTech API
      const response = await fetch(
        `https://eliteprotech-apis.zone.id/chatgpt?prompt=${encodeURIComponent(query)}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract response
      let reply = data.response || data.result || data.reply || data.message;

      if (!reply) {
        // Fallback: try to find any text in the response
        const jsonString = JSON.stringify(data);
        const textMatch = jsonString.match(/"response":"([^"]+)"/) || 
                          jsonString.match(/"result":"([^"]+)"/) ||
                          jsonString.match(/"reply":"([^"]+)"/) ||
                          jsonString.match(/"message":"([^"]+)"/);
        if (textMatch) reply = textMatch[1];
      }

      if (!reply) {
        throw new Error("Could not extract response from AI.");
      }

      // Clean up
      reply = reply.replace(/\\n/g, '\n').replace(/\\"/g, '"');

      // Truncate if too long
      if (reply.length > 65000) {
        reply = reply.slice(0, 65000) + '\n\n... (truncated)';
      }

      // Send the response
      await sock.sendMessage(from, { 
        text: `🤖 *GPT:*\n\n${reply}` 
      });

    } catch (error) {
      console.error('GPT error:', error);

      // Fallback: OmegaTech API
      try {
        const omegaUrl = 'https://omegatech-api.dixonomega.tech/api/ai/gpt';
        const fallbackRes = await fetch(`${omegaUrl}?q=${encodeURIComponent(query)}`);
        const fallbackData = await fallbackRes.json();
        const fallbackReply = fallbackData.result || fallbackData.reply || fallbackData.message;

        if (fallbackReply) {
          return await sock.sendMessage(from, { 
            text: `🤖 *GPT (fallback):*\n\n${fallbackReply}` 
          });
        }
      } catch (fallbackErr) {}

      // Fallback: Prince API
      try {
        const princeUrl = 'https://api.princetechn.com/api/ai/gpt';
        const princeRes = await fetch(`${princeUrl}?apikey=prince&query=${encodeURIComponent(query)}`);
        const princeData = await princeRes.json();
        const princeReply = princeData.result || princeData.reply || princeData.message;

        if (princeReply) {
          return await sock.sendMessage(from, { 
            text: `🤖 *GPT (fallback):*\n\n${princeReply}` 
          });
        }
      } catch (princeErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ GPT Error: ${error.message || 'Unknown error'}\n\n💡 Try again later.` 
      });
    }
  }
});
// tiktok.js - TikTok Downloader (David Cyril API)
register({
  name: 'tiktok',
  aliases: ['tt', 'tiktokdl', 'ttdl', 'tiktokvideo'],
  category: 'DOWNLOADER',
  description: 'Download TikTok videos using David Cyril API',
  async execute({ sock, from, msg, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🎵 *TikTok Downloader*\n\nUsage: ${prefix}${command} <url>\nExample: ${prefix}${command} https://www.tiktok.com/@username/video/xxxxx\n\n*Supports:*\n• TikTok videos (with/without watermark)\n• TikTok photo/slideshows\n\n*Aliases:* ${prefix}tt, ${prefix}tiktokdl, ${prefix}ttdl` 
      });
    }

    const url = args[0];

    if (!url.includes('tiktok.com')) {
      return await sock.sendMessage(from, { 
        text: `❌ Invalid URL. Please provide a valid TikTok link.` 
      });
    }

    await sock.sendMessage(from, { text: `🎵 Processing TikTok video...` });

    try {
      // ─── DAVID CYRIL API (GET METHOD) ───
      const apiUrl = `https://apis.davidcyril.name.ng/download/tiktok?url=${encodeURIComponent(url)}`;
      
      let data;
      try {
        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
        data = await response.json();
      } catch (primaryErr) {
        console.log('[TIKTOK] David Cyril failed, trying NexOracle:', primaryErr.message);
        data = await fetchNexoracleFallback('tiktok-nowm', url);
      }

      // ─── EXTRACT VIDEO DATA ───
      let videoUrl = null;
      let watermarkVideo = null;
      let noWatermarkVideo = null;
      let thumbnail = null;
      let title = 'TikTok Video';
      let author = 'Unknown';
      let duration = 'N/A';
      let likes = 'N/A';
      let comments = 'N/A';
      let shares = 'N/A';

      // Try different response structures
      if (data.result) {
        videoUrl = data.result.video || data.result.download_url || data.result.url || data.result;
        watermarkVideo = data.result.watermark_video || data.result.wm_video || null;
        noWatermarkVideo = data.result.no_watermark_video || data.result.nowm_video || data.result.nowatermark || null;
        thumbnail = data.result.thumbnail || data.result.thumb || null;
        title = data.result.title || data.result.desc || data.result.description || 'TikTok Video';
        author = data.result.author || data.result.username || data.result.nickname || 'Unknown';
        duration = data.result.duration || 'N/A';
        likes = data.result.likes || data.result.digg_count || 'N/A';
        comments = data.result.comments || data.result.comment_count || 'N/A';
        shares = data.result.shares || data.result.share_count || 'N/A';
      } else if (data.video) {
        videoUrl = data.video;
        watermarkVideo = data.watermark_video || null;
        noWatermarkVideo = data.nowatermark || data.no_watermark || null;
        thumbnail = data.thumbnail || null;
        title = data.title || data.desc || 'TikTok Video';
        author = data.author || data.username || 'Unknown';
        duration = data.duration || 'N/A';
        likes = data.likes || 'N/A';
        comments = data.comments || 'N/A';
        shares = data.shares || 'N/A';
      } else if (data.download_url) {
        videoUrl = data.download_url;
        thumbnail = data.thumbnail || null;
        title = data.title || data.desc || 'TikTok Video';
        author = data.author || data.username || 'Unknown';
        duration = data.duration || 'N/A';
        likes = data.likes || 'N/A';
        comments = data.comments || 'N/A';
        shares = data.shares || 'N/A';
      } else if (typeof data === 'string') {
        videoUrl = data;
      } else {
        // Try to find any URL in the response
        const jsonString = JSON.stringify(data);
        const urlMatch = jsonString.match(/https?:\/\/[^\s"']+\.(mp4|mov)/i);
        if (urlMatch) {
          videoUrl = urlMatch[0];
        }
      }

      // Prefer no-watermark video
      const finalVideo = noWatermarkVideo || watermarkVideo || videoUrl;

      if (!finalVideo) {
        return await sock.sendMessage(from, { 
          text: `❌ *Download Failed*\n\nCould not extract video URL from API response.\n\nRaw response:\n${JSON.stringify(data, null, 2).slice(0, 500)}` 
        });
      }

      // ─── FORMAT STATS ───
      const likesFormatted = likes !== 'N/A' ? new Intl.NumberFormat().format(parseInt(likes) || 0) : 'N/A';
      const commentsFormatted = comments !== 'N/A' ? new Intl.NumberFormat().format(parseInt(comments) || 0) : 'N/A';
      const sharesFormatted = shares !== 'N/A' ? new Intl.NumberFormat().format(parseInt(shares) || 0) : 'N/A';

      // ─── SEND THUMBNAIL ───
      if (thumbnail) {
        try {
          await sock.sendMessage(from, {
            image: { url: thumbnail },
            caption: `🎵 *${title.slice(0, 80)}${title.length > 80 ? '...' : ''}*\n👤 *Author:* @${author}\n⏱️ *Duration:* ${duration}\n❤️ *Likes:* ${likesFormatted}\n💬 *Comments:* ${commentsFormatted}\n🔗 *Shares:* ${sharesFormatted}\n📊 *Type:* ${noWatermarkVideo ? 'No Watermark' : 'Watermark'}\n\n⬇️ *Downloading video...*`
          });
        } catch (thumbErr) {
          await sock.sendMessage(from, { 
            text: `🎵 *${title.slice(0, 80)}${title.length > 80 ? '...' : ''}*\n👤 *Author:* @${author}\n⏱️ *Duration:* ${duration}\n❤️ *Likes:* ${likesFormatted}\n💬 *Comments:* ${commentsFormatted}\n🔗 *Shares:* ${sharesFormatted}\n📊 *Type:* ${noWatermarkVideo ? 'No Watermark' : 'Watermark'}\n\n⬇️ *Downloading video...*` 
          });
        }
      }

      // ─── DOWNLOAD VIDEO ───
      const videoResponse = await fetch(finalVideo, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'video/mp4,video/webm,*/*;q=0.9',
          'Accept-Language': 'en-US,en;q=0.5',
          'Range': 'bytes=0-'
        },
        signal: AbortSignal.timeout(120000)
      });

      if (!videoResponse.ok) {
        throw new Error(`Video download failed: ${videoResponse.status}`);
      }

      let videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

      if (videoBuffer.length < 5000) {
        throw new Error("Downloaded file is too small.");
      }

      const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);

      // ─── SEND VIDEO ───
      const videoCaption = `🎵 *${title.slice(0, 80)}${title.length > 80 ? '...' : ''}*\n👤 *Author:* @${author}\n📦 *Size:* ${fileSizeMB} MB\n📊 *Type:* ${noWatermarkVideo ? 'No Watermark ✅' : 'Watermark'}\n📡 *Source:* David Cyril API\n\n✅ *TikTok Download Success*`;

      if (videoBuffer.length > 16 * 1024 * 1024) {
        await sock.sendMessage(from, {
          document: videoBuffer,
          mimetype: 'video/mp4',
          fileName: `tiktok_${Date.now()}.mp4`,
          caption: `🎵 *${title.slice(0, 80)}${title.length > 80 ? '...' : ''}*\n👤 *Author:* @${author}\n📦 *Size:* ${fileSizeMB} MB\n\n⚠️ *Sent as document (16MB limit)*`
        });
      } else {
        try {
          await sock.sendMessage(from, {
            video: videoBuffer,
            mimetype: 'video/mp4',
            caption: videoCaption
          });
        } catch (sendErr) {
          await sock.sendMessage(from, {
            document: videoBuffer,
            mimetype: 'video/mp4',
            fileName: `tiktok_${Date.now()}.mp4`,
            caption: `🎵 *${title.slice(0, 80)}${title.length > 80 ? '...' : ''}*\n👤 *Author:* @${author}\n📦 *Size:* ${fileSizeMB} MB\n\n✅ *TikTok Download Success*`
          });
        }
      }

      console.log(`✅ TikTok video sent: "${title.slice(0, 30)}..." (${fileSizeMB}MB)`);

    } catch (error) {
      console.error('TikTok download error:', error);

      // ─── FALLBACK: Alternative TikTok API ───
      try {
        const fallbackUrl = `https://api.giftedtech.co.ke/api/download/tiktok?apikey=gifted&url=${encodeURIComponent(url)}`;
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(15000)
        });

        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          const video = fallbackData.result?.video || fallbackData.result?.download || fallbackData.video || fallbackData.download;
          
          if (video) {
            const vRes = await fetch(video);
            const vBuf = Buffer.from(await vRes.arrayBuffer());
            if (vBuf.length > 5000) {
              return await sock.sendMessage(from, { 
                video: vBuf, 
                mimetype: 'video/mp4',
                caption: '✅ *TikTok Download (GiftedTech fallback)*' 
              });
            }
          }
        }
      } catch (fallbackErr) {}

      // ─── SECOND FALLBACK: OmegaTech API ───
      try {
        const omegaUrl = `https://omegatech-api.dixonomega.tech/api/download/tiktok?url=${encodeURIComponent(url)}`;
        const omegaRes = await fetch(omegaUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(15000)
        });

        if (omegaRes.ok) {
          const omegaData = await omegaRes.json();
          const video = omegaData.result?.video || omegaData.result?.download || omegaData.video || omegaData.download;
          
          if (video) {
            const vRes = await fetch(video);
            const vBuf = Buffer.from(await vRes.arrayBuffer());
            if (vBuf.length > 5000) {
              return await sock.sendMessage(from, { 
                video: vBuf, 
                mimetype: 'video/mp4',
                caption: '✅ *TikTok Download (OmegaTech fallback)*' 
              });
            }
          }
        }
      } catch (omegaErr) {}

      // ─── THIRD FALLBACK: Prince API ───
      try {
        const princeUrl = `https://api.princetechn.com/api/download/tiktok?apikey=prince&url=${encodeURIComponent(url)}`;
        const princeRes = await fetch(princeUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(15000)
        });

        if (princeRes.ok) {
          const princeData = await princeRes.json();
          const video = princeData.result?.video || princeData.result?.download || princeData.video || princeData.download;
          
          if (video) {
            const vRes = await fetch(video);
            const vBuf = Buffer.from(await vRes.arrayBuffer());
            if (vBuf.length > 5000) {
              return await sock.sendMessage(from, { 
                video: vBuf, 
                mimetype: 'video/mp4',
                caption: '✅ *TikTok Download (Prince fallback)*' 
              });
            }
          }
        }
      } catch (princeErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ *Download Error*\n\n${error.message || 'Could not download video.'}\n\n💡 Tips:\n• Make sure the URL is valid\n• Video must be public\n• Try a different link\n• Use ${prefix}tt <url>` 
      });
    }
  }
});
register({
  name: 'letmegpt',
  aliases: ['giftedai', 'gptai'],
  category: 'AI',
  description: 'Chat with LetMeGPT AI from GiftedTech',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🤖 *LetMeGPT AI Assistant*\n\nUsage: ${prefix}${command} <your question>\nExample: ${prefix}${command} What is the capital of France?` 
      });
    }

    const query = args.join(" ");
    const apiKey = 'gifted'; // Public test key

    await sock.sendMessage(from, { text: `⏳ Thinking...` });

    try {
      // Primary: GiftedTech API
      const response = await fetch(
        `https://api.giftedtech.co.ke/api/ai/letmegpt?apikey=${apiKey}&q=${encodeURIComponent(query)}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract response
      let reply = data.result || data.response || data.reply || data.message;

      if (!reply) {
        const jsonString = JSON.stringify(data);
        const textMatch = jsonString.match(/"result":"([^"]+)"/) || 
                          jsonString.match(/"response":"([^"]+)"/) ||
                          jsonString.match(/"reply":"([^"]+)"/) ||
                          jsonString.match(/"message":"([^"]+)"/);
        if (textMatch) reply = textMatch[1];
      }

      // Handle null result
      if (!reply) {
        // Try alternative parameter name
        const altRes = await fetch(
          `https://api.giftedtech.co.ke/api/ai/letmegpt?apikey=${apiKey}&prompt=${encodeURIComponent(query)}`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          }
        );

        if (altRes.ok) {
          const altData = await altRes.json();
          reply = altData.result || altData.response || altData.reply || altData.message;
        }
      }

      if (!reply) {
        throw new Error("Could not extract response from LetMeGPT AI.");
      }

      reply = reply.replace(/\\n/g, '\n').replace(/\\"/g, '"');

      if (reply.length > 65000) {
        reply = reply.slice(0, 65000) + '\n\n... (truncated)';
      }

      await sock.sendMessage(from, { 
        text: `🤖 *LetMeGPT:*\n\n${reply}` 
      });

    } catch (error) {
      console.error('LetMeGPT error:', error);

      // Fallback: EliteProTech ChatGPT API
      try {
        const eliteUrl = 'https://eliteprotech-apis.zone.id/chatgpt';
        const fallbackRes = await fetch(`${eliteUrl}?prompt=${encodeURIComponent(query)}`);
        const fallbackData = await fallbackRes.json();
        const fallbackReply = fallbackData.response || fallbackData.result || fallbackData.reply;

        if (fallbackReply) {
          return await sock.sendMessage(from, { 
            text: `🤖 *GPT (fallback):*\n\n${fallbackReply}` 
          });
        }
      } catch (fallbackErr) {}

      // Fallback: OmegaTech GPT
      try {
        const omegaUrl = 'https://omegatech-api.dixonomega.tech/api/ai/gpt';
        const omegaRes = await fetch(`${omegaUrl}?q=${encodeURIComponent(query)}`);
        const omegaData = await omegaRes.json();
        const omegaReply = omegaData.result || omegaData.reply || omegaData.message;

        if (omegaReply) {
          return await sock.sendMessage(from, { 
            text: `🤖 *GPT (fallback):*\n\n${omegaReply}` 
          });
        }
      } catch (omegaErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ LetMeGPT Error: ${error.message || 'Unknown error'}\n\n💡 Try again later.` 
      });
    }
  }
});
register({
  name: 'flux',
  aliases: ['gf', 'giftedimg', 'fluxai'],
  category: 'AI',
  description: 'Generate AI images using GiftedTech Flux AI',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🎨 *GiftedTech Flux AI Image Generator*\n\nUsage: ${prefix}${command} <description> [ratio]\nExample: ${prefix}${command} A futuristic city with neon lights\n\n*With ratio:*\n${prefix}${command} A beautiful landscape 16:9\n${prefix}${command} A portrait of a woman 9:16\n\n*Available ratios:*\n• 1:1 (square - default)\n• 16:9 (wide)\n• 9:16 (vertical)\n• 4:3 (standard)\n• 3:4 (portrait)\n\n*Tips for better results:*\n• Be descriptive\n• Include style (realistic, cartoon, anime, etc.)\n• Mention colors, lighting, mood` 
      });
    }

    let prompt = args[0];
    let ratio = '1:1';

    // Check if the last argument is a ratio
    const possibleRatios = ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'];
    if (args.length > 1 && possibleRatios.includes(args[args.length - 1])) {
      ratio = args[args.length - 1];
      prompt = args.slice(0, -1).join(' ');
    }

    const apiKey = 'gifted';

    await sock.sendMessage(from, { text: `🎨 *Generating image with Flux AI...*\n⏳ This may take 15-30 seconds...\n\n📝 *Prompt:* ${prompt}\n📐 *Ratio:* ${ratio}` });

    try {
      // Primary: GiftedTech API
      const response = await fetch(
        `https://api.giftedtech.co.ke/api/ai/fluximg?apikey=${apiKey}&prompt=${encodeURIComponent(prompt)}&ratio=${encodeURIComponent(ratio)}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract image URL
      let imageUrl = data.result?.url || data.url || data.image || data.result?.image;

      if (!imageUrl) {
        const jsonString = JSON.stringify(data);
        const urlMatch = jsonString.match(/https?:\/\/[^\s"']+\.(png|jpg|jpeg|gif|webp)/i);
        if (urlMatch) imageUrl = urlMatch[0];
      }

      if (!imageUrl) {
        throw new Error("Could not extract image URL from API response.");
      }

      // Send the generated image
      await sock.sendMessage(from, {
        image: { url: imageUrl },
        caption: `🎨 *Flux AI Generated Image*\n\n📝 *Prompt:* ${prompt}\n📐 *Ratio:* ${ratio}\n\n✨ _Generated by GiftedTech Flux AI_`
      });

    } catch (error) {
      console.error('GiftedTech Flux error:', error);

      // Fallback: Try alternative GiftedTech endpoint
      try {
        const altUrl = 'https://api.giftedtech.co.ke/api/ai/flux';
        const altRes = await fetch(`${altUrl}?apikey=${apiKey}&prompt=${encodeURIComponent(prompt)}&ratio=${encodeURIComponent(ratio)}`);
        const altData = await altRes.json();

        let altImage = altData.result?.url || altData.url || altData.image;

        if (altImage) {
          return await sock.sendMessage(from, {
            image: { url: altImage },
            caption: `🎨 *Flux AI Generated Image (fallback)*\n\n📝 *Prompt:* ${prompt}\n📐 *Ratio:* ${ratio}`
          });
        }
      } catch (altErr) {}

      // Fallback: Try David Cyril Writecream
      try {
        const davidUrl = 'https://apis.davidcyril.name.ng/imagegen/writecream';
        const davidRes = await fetch(`${davidUrl}?prompt=${encodeURIComponent(prompt)}`);
        const davidData = await davidRes.json();

        let davidImage = davidData.result || davidData.url || davidData.image;

        if (davidImage) {
          return await sock.sendMessage(from, {
            image: { url: davidImage },
            caption: `🎨 *Writecream Generated Image (fallback)*\n\n📝 *Prompt:* ${prompt}`
          });
        }
      } catch (davidErr) {}

      // Fallback: Try Prince API Flux
      try {
        const princeUrl = 'https://api.princetechn.com/api/ai/flux';
        const princeRes = await fetch(`${princeUrl}?apikey=prince&prompt=${encodeURIComponent(prompt)}`);
        const princeData = await princeRes.json();

        let princeImage = princeData.result || princeData.url || princeData.image;

        if (princeImage) {
          return await sock.sendMessage(from, {
            image: { url: princeImage },
            caption: `🎨 *Flux AI Generated Image (fallback)*\n\n📝 *Prompt:* ${prompt}`
          });
        }
      } catch (princeErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ Image Generation Error: ${error.message || 'Could not generate image.'}\n\n💡 Try a different prompt or try again later.` 
      });
    }
  }
});
register({
  name: 'unlimitedai',
  aliases: ['uai', 'unlimited'],
  category: 'AI',
  description: 'Chat with Unlimited AI from GiftedTech',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return await sock.sendMessage(from, { 
        text: `🤖 *Unlimited AI Assistant*\n\nUsage: ${prefix}${command} <your question>\nExample: ${prefix}${command} What is the capital of France?\n\n*Examples:*\n${prefix}${command} Write a poem about AI\n${prefix}${command} Explain quantum computing\n${prefix}${command} Create a JavaScript function\n\n*Features:*\n• Powered by GPT-4\n• No usage limits\n• Fast responses` 
      });
    }

    const query = args.join(" ");
    const apiKey = 'gifted';

    await sock.sendMessage(from, { text: `⏳ Thinking...` });

    try {
      // Primary: GiftedTech API
      const response = await fetch(
        `https://api.giftedtech.co.ke/api/ai/unlimitedai?apikey=${apiKey}&q=${encodeURIComponent(query)}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract response
      let reply = data.result || data.response || data.reply || data.message;

      if (!reply) {
        const jsonString = JSON.stringify(data);
        const textMatch = jsonString.match(/"result":"([^"]+)"/) || 
                          jsonString.match(/"response":"([^"]+)"/) ||
                          jsonString.match(/"reply":"([^"]+)"/) ||
                          jsonString.match(/"message":"([^"]+)"/);
        if (textMatch) reply = textMatch[1];
      }

      if (!reply) {
        // Try alternative parameter name
        const altRes = await fetch(
          `https://api.giftedtech.co.ke/api/ai/unlimitedai?apikey=${apiKey}&prompt=${encodeURIComponent(query)}`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          }
        );

        if (altRes.ok) {
          const altData = await altRes.json();
          reply = altData.result || altData.response || altData.reply || altData.message;
        }
      }

      if (!reply) {
        throw new Error("Could not extract response from Unlimited AI.");
      }

      reply = reply.replace(/\\n/g, '\n').replace(/\\"/g, '"');

      if (reply.length > 65000) {
        reply = reply.slice(0, 65000) + '\n\n... (truncated)';
      }

      // Split into chunks if needed
      if (reply.length > 1000) {
        const chunks = reply.match(/.{1,1000}/g) || [reply];
        for (let i = 0; i < Math.min(chunks.length, 5); i++) {
          const chunk = chunks[i];
          const prefix = i === 0 ? `🤖 *Unlimited AI:*\n\n` : `\n\n*Continued...*\n\n`;
          await sock.sendMessage(from, { text: prefix + chunk });
        }
      } else {
        await sock.sendMessage(from, { 
          text: `🤖 *Unlimited AI:*\n\n${reply}` 
        });
      }

    } catch (error) {
      console.error('Unlimited AI error:', error);

      // Fallback: EliteProTech ChatGPT API
      try {
        const eliteUrl = 'https://eliteprotech-apis.zone.id/chatgpt';
        const fallbackRes = await fetch(`${eliteUrl}?prompt=${encodeURIComponent(query)}`);
        const fallbackData = await fallbackRes.json();
        const fallbackReply = fallbackData.response || fallbackData.result || fallbackData.reply;

        if (fallbackReply) {
          return await sock.sendMessage(from, { 
            text: `🤖 *GPT (fallback):*\n\n${fallbackReply}` 
          });
        }
      } catch (fallbackErr) {}

      // Fallback: OmegaTech GPT
      try {
        const omegaUrl = 'https://omegatech-api.dixonomega.tech/api/ai/gpt';
        const omegaRes = await fetch(`${omegaUrl}?q=${encodeURIComponent(query)}`);
        const omegaData = await omegaRes.json();
        const omegaReply = omegaData.result || omegaData.reply || omegaData.message;

        if (omegaReply) {
          return await sock.sendMessage(from, { 
            text: `🤖 *GPT (fallback):*\n\n${omegaReply}` 
          });
        }
      } catch (omegaErr) {}

      // Fallback: Prince API GPT
      try {
        const princeUrl = 'https://api.princetechn.com/api/ai/gpt';
        const princeRes = await fetch(`${princeUrl}?apikey=prince&query=${encodeURIComponent(query)}`);
        const princeData = await princeRes.json();
        const princeReply = princeData.result || princeData.reply || princeData.message;

        if (princeReply) {
          return await sock.sendMessage(from, { 
            text: `🤖 *GPT (fallback):*\n\n${princeReply}` 
          });
        }
      } catch (princeErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ Unlimited AI Error: ${error.message || 'Unknown error'}\n\n💡 Try again later.` 
      });
    }
  }
});
register({
  name: 'quote',
  aliases: ['quotes', 'inspire', 'motivation'],
  category: 'TOOLS',
  description: 'Get a random inspirational quote',
  async execute({ sock, from, prefix, command }) {
    await sock.sendMessage(from, { text: `⏳ Fetching a quote...` });

    try {
      // Primary: OmegaTech API
      const baseUrl = 'https://omegatech-api.dixonomega.tech';
      const response = await fetch(`${baseUrl}/api/quote`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();

      // Extract quote from various formats
      let quote = data.result?.quote || data.quote || data.text || data.message || data.data;
      let author = data.result?.author || data.author || data.by || 'Unknown';

      if (!quote) {
        const jsonString = JSON.stringify(data);
        const quoteMatch = jsonString.match(/"quote":"([^"]+)"/) || 
                           jsonString.match(/"text":"([^"]+)"/) ||
                           jsonString.match(/"message":"([^"]+)"/);
        if (quoteMatch) quote = quoteMatch[1];
        
        const authorMatch = jsonString.match(/"author":"([^"]+)"/) || 
                            jsonString.match(/"by":"([^"]+)"/);
        if (authorMatch) author = authorMatch[1];
      }

      if (!quote) {
        throw new Error("Could not extract quote from API response.");
      }

      // Clean up the quote
      quote = quote.replace(/\\n/g, '\n').replace(/\\"/g, '"');

      // Send the quote
      await sock.sendMessage(from, { 
        text: `💬 *"${quote}"*\n\n— *${author}*`
      });

    } catch (error) {
      console.error('Quote error:', error);

      // Fallback: Prince API
      try {
        const princeUrl = 'https://api.princetechn.com/api/tools/quote';
        const fallbackRes = await fetch(`${princeUrl}?apikey=prince`);
        const fallbackData = await fallbackRes.json();

        let fallbackQuote = fallbackData.result?.quote || fallbackData.quote || fallbackData.text;
        let fallbackAuthor = fallbackData.result?.author || fallbackData.author || 'Unknown';

        if (fallbackQuote) {
          return await sock.sendMessage(from, { 
            text: `💬 *"${fallbackQuote}"*\n\n— *${fallbackAuthor}*`
          });
        }
      } catch (fallbackErr) {
        // Silent fail
      }

      // Fallback: ZenQuotes API (free, no key required)
      try {
        const zenRes = await fetch('https://zenquotes.io/api/random');
        const zenData = await zenRes.json();

        if (zenData && zenData[0]) {
          const q = zenData[0].q || zenData[0].quote;
          const a = zenData[0].a || zenData[0].author || 'Unknown';
          if (q) {
            return await sock.sendMessage(from, { 
              text: `💬 *"${q}"*\n\n— *${a}*`
            });
          }
        }
      } catch (zenErr) {
        // Silent fail
      }

      // Fallback: Another free API
      try {
        const anotherRes = await fetch('https://api.quotable.io/random');
        const anotherData = await anotherRes.json();

        if (anotherData && anotherData.content) {
          const q = anotherData.content;
          const a = anotherData.author || 'Unknown';
          return await sock.sendMessage(from, { 
            text: `💬 *"${q}"*\n\n— *${a}*`
          });
        }
      } catch (anotherErr) {
        // Silent fail
      }

      await sock.sendMessage(from, { 
        text: `⚠️ Quote Error: ${error.message || 'Could not fetch a quote.'}\n\n💡 Try again later.`
      });
    }
  }
});

register({
  name: 'define',
  category: 'INFO',
  description: 'Dictionary definition',
  async execute({ sock, from, text }) {
    if (!text) return sock.sendMessage(from, { text: '❓ Word to define?' });
    try {
      const res = await fetch(`${P_BASE}/search/dictionary?apikey=${P_KEY}&query=${encodeURIComponent(text)}`);
      const data = await res.json();
      if (!data.result) return sock.sendMessage(from, { text: '❌ No definition found.' });
      await sock.sendMessage(from, { text: `📖 *Definition:* ${text}\n\n${data.result}` });
    } catch (e) {
      await sock.sendMessage(from, { text: '⚠️ Define Error: ' + e.message });
    }
  }
});
register({
  name: 'ping',
  aliases: ['p'],
  category: 'MAIN',
  description: 'Check bot speed and system status',
  async execute({ sock, from, sessionId }) {
    const os = require('os');
    const start = Date.now();
    
    // Initial message to calculate round-trip time
    const sent = await sock.sendMessage(from, { text: `⚡ *${getBotName(sessionId)}: MEASURING...*`, ...channelContext() });
    
    const end = Date.now();
    const latency = end - start;

    // Calculate RAM usage
    const totalRam = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
    const freeRam = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
    const usedRam = (totalRam - freeRam).toFixed(2);

    // Determine speed grade
    let grade = 'Excellent 🟢';
    if (latency > 300) grade = 'Good 🟡';
    if (latency > 700) grade = 'Poor 🔴';

    const uptime = formatUptime(Date.now() - START_TIME);

    let status = `╭───────────────⭓\n`;
    status += `│ ⚡ *${getBotName(sessionId)}* STATUS\n`;
    status += `│ 🛰 Latency : ${latency}ms\n`;
    status += `│ 📊 Grade : ${grade}\n`;
    status += `│ ⏱ Uptime : ${uptime}\n`;
    status += `│ 💾 RAM : ${usedRam}GB / ${totalRam}GB\n`;
    status += `│ 📡 Platform : ${os.platform()}\n`;
    status += `╰───────────────⭓\n`;
    status += `✨ _System running at optimal capacity_`;

    // Send the detailed status as an edit; fall back to a new message if
    // editing isn't supported/fails, so the command never goes silent.
    try {
      await sock.sendMessage(from, {
        text: status,
        edit: sent.key,
      });
    } catch (e) {
      await sock.sendMessage(from, { text: status, ...channelContext() });
    }
  },
});
register({
  name: 'alive',
  category: 'MAIN',
  description: 'Check if the bot is online',
  async execute({ sock, from, sessionId }) {
    const uptime = formatUptime(Date.now() - START_TIME);
    let text = `╭───────────────⭓\n`;
    text += `│ ${getBotName(sessionId)}\n`;
    text += `╰───────────────⭓\n\n`;
    text += `✅ *${getBotName(sessionId)} is alive!*\n`;
    text += `⏱️ Uptime: ${uptime}\n`;
    text += `🌐 inconnuxdv2.vercel.app`;
    await sock.sendMessage(from, { text, ...channelContext() });
  },
});
register({
  name: 'play',
  aliases: ['song', 'music', 'ytplay', 'ytaudio'],
  category: 'DOWNLOADER',
  description: 'Search and download YouTube audio as MP3',
  async execute({ sock, from, msg, args, prefix, command }) {
    // ─── BUILD TEXT FROM ARGS ───
    const text = args.join(' ');
    
    if (!text) {
      return await sock.sendMessage(from, { 
        text: `🎵 Usage: ${prefix || '.'}play <song name or URL>\nExample: ${prefix || '.'}play Alone` 
      });
    }

    await sock.sendMessage(from, { text: `🔍 Searching for: ${text}` });

    try {
      // ─── GET VIDEO INFO ───
      let videoUrl = text;
      let videoTitle = 'YouTube Audio';
      let thumbnail = '';

      if (text.includes('youtube.com') || text.includes('youtu.be')) {
        const videoId = text.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];
        if (videoId) {
          try {
            const yts = require('yt-search');
            const search = await yts({ videoId });
            if (search) {
              videoTitle = search.title || 'YouTube Audio';
              thumbnail = search.thumbnail || '';
            }
          } catch (e) {}
        }
        videoUrl = text;
      } else {
        const yts = require('yt-search');
        const search = await yts(text);
        if (!search?.videos?.length) {
          return await sock.sendMessage(from, { text: '❌ No results found.' });
        }
        const video = search.videos[0];
        videoUrl = video.url;
        videoTitle = video.title || 'YouTube Audio';
        thumbnail = video.thumbnail || '';
      }

      // ─── SEND THUMBNAIL ───
      if (thumbnail) {
        try {
          await sock.sendMessage(from, {
            image: { url: thumbnail },
            caption: `🎵 *${videoTitle}*\n⏳ Downloading...`
          });
        } catch (e) {}
      }

      // ─── DOWNLOAD AUDIO ───
      let audioData = null;
      const apis = [
        { name: 'David Cyril', url: `https://apis.davidcyril.name.ng/download/ytmp3v2?url=${encodeURIComponent(videoUrl)}` },
        { name: 'OmegaTech', url: `https://api.omegatech.app/api/download/play?search=${encodeURIComponent(videoUrl)}` },
        { name: 'Prince', url: `https://api.princetechn.com/api/download/ytmp3?apikey=prince&url=${encodeURIComponent(videoUrl)}` },
        { name: 'EliteProTech', url: `https://eliteprotech-apis.zone.id/ytmp3?url=${encodeURIComponent(videoUrl)}` },
        { name: 'NexOracle', url: `https://api.nexoracle.com/download/ytmp3?url=${encodeURIComponent(videoUrl)}` }
      ];

      for (const api of apis) {
        try {
          const res = await fetch(api.url, { 
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          if (!res.ok) continue;
          const data = await res.json();
          const download = data?.result?.url || data?.result?.download_url || data?.download_url || data?.url || data?.download;
          if (download) {
            audioData = { download, title: data?.result?.title || data?.title || videoTitle };
            break;
          }
        } catch (e) {
          console.log(`❌ ${api.name} failed:`, e.message);
        }
      }

      if (!audioData) {
        return await sock.sendMessage(from, { text: '❌ All download sources failed. Try again.' });
      }

      // ─── FETCH AUDIO BUFFER ───
      const audioRes = await fetch(audioData.download, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });

      if (!audioRes.ok) {
        return await sock.sendMessage(from, { text: '❌ Failed to download audio file.' });
      }

      let audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      if (audioBuffer.length < 1000) {
        return await sock.sendMessage(from, { text: '❌ Downloaded file is too small.' });
      }

      // ─── SEND AUDIO ───
      const safeTitle = (audioData.title || 'audio').replace(/[^\w\s-]/g, '').trim();

      try {
        await sock.sendMessage(from, {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
          fileName: `${safeTitle}.mp3`,
          ptt: false
        });
      } catch (sendErr) {
        await sock.sendMessage(from, {
          document: audioBuffer,
          mimetype: 'audio/mpeg',
          fileName: `${safeTitle}.mp3`,
          caption: `🎵 ${safeTitle}`
        });
      }

    } catch (err) {
      console.error('Play error:', err);
      await sock.sendMessage(from, { text: `❌ Error: ${err.message || 'Unknown error'}` });
    }
  }
});

// -------------------- GCSTATUS --------------------
register({
  name: 'gcstatus',
  category: 'GROUP-ADMIN',
  description: 'Post a group message/media as a WhatsApp Status update',
  async execute({ sock, from, sender, msg, args }) {
    const { isSenderAdmin } = require('../moderation');
    const { downloadContentFromMessage, generateWAMessageFromContent } = require('@whiskeysockets/baileys');

    let isReacting = false;

    try {
      // ---- Resolve target group + caption from args ----
      let targetGroup = from;
      let caption = '';

      if (args && args.length > 0) {
        if (args[0].endsWith('@g.us')) {
          targetGroup = args[0];
          caption = args.slice(1).join(' ') || '';
        } else {
          caption = args.join(' ') || '';
        }
      }

      if (!targetGroup.endsWith('@g.us')) {
        return sock.sendMessage(from, { text: '❌ This command is used inside a group, or pass a group JID as the first argument.' });
      }

      // ---- Permission checks ----
      if (!msg.key.fromMe) {
        const isGroupAdmin = await isSenderAdmin(sock, targetGroup, sender);
        if (!isGroupAdmin) {
          return sock.sendMessage(from, { text: '❌ You must be a group admin to use this command.' });
        }
      }

      let isBotAdmin = false;
      try {
        const meta = await sock.groupMetadata(targetGroup);
        const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];
        const botP = meta.participants.find((p) => p.id.split('@')[0].split(':')[0] === botNumber);
        isBotAdmin = !!botP && (botP.admin === 'admin' || botP.admin === 'superadmin');
      } catch {}

      if (!isBotAdmin) {
        return sock.sendMessage(from, { text: '❌ Bot must be an admin in that group to post status updates.' });
      }

      // ---- Pull quoted media, if any ----
      const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
      let mediaBuffer = null;
      let mediaType = null;

      if (quotedMessage) {
        const map = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio' };
        for (const [key, type] of Object.entries(map)) {
          if (quotedMessage[key]) {
            mediaType = type;
            try {
              const stream = await downloadContentFromMessage(quotedMessage[key], type);
              const chunks = [];
              for await (const chunk of stream) chunks.push(chunk);
              mediaBuffer = Buffer.concat(chunks);
            } catch (e) {
              console.error('[GCSTATUS] Download failed:', e.message);
            }
            break;
          }
        }
      }

      if (!mediaType && !caption.trim()) {
        return sock.sendMessage(from, {
          text: `📱 *Group Status*\n\n*Usage:*\n• .gcstatus <message>\n• .gcstatus <group-jid> <message>\n• .gcstatus (reply to media)\n• .gcstatus <group-jid> (reply to media)`
        });
      }

      let groupName = targetGroup;
      try {
        const metadata = await sock.groupMetadata(targetGroup);
        groupName = metadata.subject;
      } catch {}

      await sock.sendMessage(from, { react: { text: '📱', key: msg.key } });
      isReacting = true;

      if (mediaBuffer && mediaType) {
        let statusMessage = {};
        if (mediaType === 'image') statusMessage = { image: mediaBuffer, caption: caption || `📸 Update from ${groupName}` };
        else if (mediaType === 'video') statusMessage = { video: mediaBuffer, caption: caption || `🎬 Update from ${groupName}` };
        else if (mediaType === 'audio') statusMessage = { audio: mediaBuffer, mimetype: 'audio/mpeg', ptt: false, caption: caption || `🎵 Update from ${groupName}` };

        await sock.sendMessage('status@broadcast', statusMessage);
      } else {
        const randomColor = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
        const statusPayload = {
          groupStatusMessageV2: {
            message: {
              extendedTextMessage: {
                text: caption,
                backgroundArgb: 0xff000000 + parseInt(randomColor, 16),
                font: 2,
                textArgb: 0xffffffff
              }
            }
          }
        };

        const generatedMessage = generateWAMessageFromContent(targetGroup, statusPayload, { participant: sock.user.id });
        await sock.relayMessage(targetGroup, generatedMessage.message, { messageId: generatedMessage.key.id });
      }

      await sock.sendMessage(from, { text: `✅ Status update posted to *${groupName}*${mediaType ? ` (${mediaType})` : ''}` });
      await sock.sendMessage(from, { react: { text: null, key: msg.key } });
      isReacting = false;

    } catch (error) {
      console.error('[GCSTATUS] Error:', error);
      if (isReacting) {
        await sock.sendMessage(from, { react: { text: null, key: msg.key } }).catch(() => {});
      }
      await sock.sendMessage(from, { react: { text: '❌', key: msg.key } }).catch(() => {});
      await sock.sendMessage(from, { text: `❌ Failed to post status: ${error.message}` });
    }
  }
});

// -------------------- THREADS --------------------
register({
  name: 'threads',
  aliases: ['threadsdl'],
  category: 'DOWNLOADER',
  description: 'Download Threads posts (photo/video) via NexOracle',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return sock.sendMessage(from, {
        text: `🧵 *Threads Downloader*\n\nUsage: ${prefix}${command} <url>\nExample: ${prefix}${command} https://www.threads.net/@user/post/xxxxx`
      });
    }
    const url = args[0];
    if (!url.includes('threads.net') && !url.includes('threads.com')) {
      return sock.sendMessage(from, { text: '❌ Invalid URL. Please provide a valid Threads link.' });
    }

    await sock.sendMessage(from, { text: '🧵 Processing Threads post...' });

    try {
      const data = await fetchNexoracleFallback('threads', url);
      const result = data.result || data;

      const mediaUrl = result.video || result.video_url || result.download_url
        || (Array.isArray(result.images) && result.images[0])
        || result.image || result.url;

      if (!mediaUrl) {
        return sock.sendMessage(from, { text: `❌ Could not extract media from response:\n${JSON.stringify(data, null, 2).slice(0, 400)}` });
      }

      const isVideo = /\.(mp4|mov)(\?|$)/i.test(mediaUrl) || !!result.video;
      const caption = `🧵 *${(result.caption || result.title || 'Threads Post').slice(0, 150)}*`;

      if (isVideo) {
        await sock.sendMessage(from, { video: { url: mediaUrl }, caption });
      } else {
        await sock.sendMessage(from, { image: { url: mediaUrl }, caption });
      }
    } catch (error) {
      console.error('[THREADS] Error:', error.message);
      await sock.sendMessage(from, { text: `❌ Failed to download: ${error.message}` });
    }
  }
});

// -------------------- SOUNDCLOUD --------------------
register({
  name: 'soundcloud',
  aliases: ['sc', 'scdl'],
  category: 'DOWNLOADER',
  description: 'Download SoundCloud tracks via NexOracle',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return sock.sendMessage(from, {
        text: `🎧 *SoundCloud Downloader*\n\nUsage: ${prefix}${command} <url>\nExample: ${prefix}${command} https://soundcloud.com/artist/track`
      });
    }
    const url = args[0];
    if (!url.includes('soundcloud.com')) {
      return sock.sendMessage(from, { text: '❌ Invalid URL. Please provide a valid SoundCloud link.' });
    }

    await sock.sendMessage(from, { text: '🎧 Processing SoundCloud track...' });

    try {
      const data = await fetchNexoracleFallback('sound-cloud', url);
      const result = data.result || data;

      const audioUrl = result.audio || result.download_url || result.url;
      const title = result.title || 'SoundCloud Track';

      if (!audioUrl) {
        return sock.sendMessage(from, { text: `❌ Could not extract audio from response:\n${JSON.stringify(data, null, 2).slice(0, 400)}` });
      }

      await sock.sendMessage(from, {
        audio: { url: audioUrl },
        mimetype: 'audio/mpeg',
        fileName: `${title}.mp3`,
        caption: `🎧 *${title}*`
      });
    } catch (error) {
      console.error('[SOUNDCLOUD] Error:', error.message);
      await sock.sendMessage(from, { text: `❌ Failed to download: ${error.message}` });
    }
  }
});

// -------------------- MEDIAFIRE (NexOracle) --------------------
register({
  name: 'mfdl',
  aliases: ['mfile', 'mediafiredl'],
  category: 'DOWNLOADER',
  description: 'Download MediaFire files via NexOracle (sent as a proper document, any file type)',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return sock.sendMessage(from, {
        text: `📁 *MediaFire Downloader*\n\nUsage: ${prefix}${command} <url>\nExample: ${prefix}${command} https://www.mediafire.com/file/xxxxx/file.zip`
      });
    }

    const url = args[0];
    if (!url.includes('mediafire.com')) {
      return sock.sendMessage(from, { text: '❌ Invalid URL. Please provide a valid MediaFire link.' });
    }

    await sock.sendMessage(from, { text: '📁 Processing MediaFire link...' });

    try {
      const data = await fetchNexoracleFallback('media-fire', url);
      const result = data.result || data;

      const downloadUrl = result.download_url || result.url || result.link;
      const fileName = result.filename || result.file_name || result.name || 'mediafire_file';
      const fileSize = result.size || result.filesize || null;

      if (!downloadUrl) {
        return sock.sendMessage(from, { text: `❌ Could not extract a download link from response:\n${JSON.stringify(data, null, 2).slice(0, 400)}` });
      }

      await sock.sendMessage(from, {
        document: { url: downloadUrl },
        fileName,
        mimetype: 'application/octet-stream',
        caption: `📁 *${fileName}*${fileSize ? `\n📦 ${fileSize}` : ''}`
      });
    } catch (error) {
      console.error('[MFDL] Error:', error.message);
      await sock.sendMessage(from, { text: `❌ Failed to download: ${error.message}` });
    }
  }
});

// -------------------- AIO (All-In-One Downloader) --------------------
register({
  name: 'aio',
  aliases: ['alldl', 'universaldl'],
  category: 'DOWNLOADER',
  description: 'Universal downloader (TikTok, IG, FB, Twitter, YouTube, etc.) via NexOracle aio1/2/3',
  async execute({ sock, from, args, prefix, command }) {
    if (!args[0]) {
      return sock.sendMessage(from, {
        text: `🌐 *All-In-One Downloader*\n\nUsage: ${prefix}${command} <url>\nWorks with most major platforms (TikTok, Instagram, Facebook, Twitter/X, YouTube, and more).`
      });
    }

    const url = args[0];
    await sock.sendMessage(from, { text: '🌐 Processing link...' });

    const endpoints = ['aio1', 'aio2', 'aio3'];
    let data = null;
    let lastErr = null;

    for (const ep of endpoints) {
      try {
        data = await fetchNexoracleFallback(ep, url);
        if (data) break;
      } catch (err) {
        lastErr = err;
        console.log(`[AIO] ${ep} failed:`, err.message);
      }
    }

    if (!data) {
      return sock.sendMessage(from, { text: `❌ All sources failed: ${lastErr?.message || 'unknown error'}` });
    }

    try {
      const result = data.result || data;

      const videoUrl = result.video || result.video_url || result.download_url
        || (Array.isArray(result.videos) && result.videos[0]?.url);
      const imageUrls = Array.isArray(result.images) ? result.images
        : Array.isArray(result.photos) ? result.photos
        : (result.image ? [result.image] : []);
      const audioUrl = result.audio || result.audio_url;
      const title = (result.title || result.caption || 'Downloaded Media').toString().slice(0, 150);

      if (videoUrl) {
        await sock.sendMessage(from, { video: { url: videoUrl }, caption: `🌐 *${title}*` });
      } else if (imageUrls.length) {
        for (const img of imageUrls.slice(0, 10)) {
          await sock.sendMessage(from, { image: { url: img }, caption: `🌐 *${title}*` });
        }
      } else if (audioUrl) {
        await sock.sendMessage(from, { audio: { url: audioUrl }, mimetype: 'audio/mpeg', fileName: `${title}.mp3` });
      } else {
        await sock.sendMessage(from, { text: `❌ Could not extract media from response:\n${JSON.stringify(data, null, 2).slice(0, 400)}` });
      }
    } catch (error) {
      console.error('[AIO] Error:', error.message);
      await sock.sendMessage(from, { text: `❌ Failed to process: ${error.message}` });
    }
  }
});

register({
  name: 'listpair',
  category: 'INFO',
  description: 'List paired WhatsApp sessions (owner only)',
  async execute({ sock, from, msg, isOwner }) {
    if (!isOwner) return sock.sendMessage(from, { text: '⛔ Owner only.' });
    const { listSessions } = require('../sessionManager');
    const sessions = listSessions();
    if (!sessions.length) return sock.sendMessage(from, { text: '📋 No paired sessions.' });
    const lines = sessions.map((x, i) => `${i + 1}. ${x.phone || x.id} — ${x.status}`);
    await sock.sendMessage(from, { text: `📋 *Paired sessions:*\n\n${lines.join('\n')}` });
  },
});

register({
  name: 'adminid',
  aliases: ['admin'],
  category: 'INFO',
  description: 'Show the owner/admin WhatsApp JID',
  async execute({ sock, from }) {
    const ownerJid = getOwnerJid(sock);
    await sock.sendMessage(from, { text: `👑 *Admin ID:* \`${ownerJid || 'unknown'}\`` });
  },
});

register({
  name: 'runtime',
  category: 'MAIN',
  description: 'Show bot uptime',
  async execute({ sock, from }) {
    await sock.sendMessage(from, { text: `⏱ Uptime: ${formatUptime(Date.now() - START_TIME)}` });
  },
});
// playvideo.js - FINAL FIXED VERSION
// playvideo.js - Video ONLY (no audio)
register({
  name: 'playvideo',
  aliases: ['playv', 'ytmp4', 'ytvideo', 'watch', 'vplay'],
  category: 'DOWNLOADER',
  description: 'Search and download YouTube videos as MP4 (video only)',
  async execute({ sock, from, msg, args, prefix, command }) {
    const text = args.join(' ');
    
    if (!text) {
      return await sock.sendMessage(from, { 
        text: `🎬 Usage: ${prefix || '.'}playvideo <song name or URL>\nExample: ${prefix || '.'}playvideo Music Video 4K` 
      });
    }

    await sock.sendMessage(from, { text: `🔍 Searching video: ${text}` });

    try {
      let videoUrl = text;
      let videoTitle = 'YouTube Video';
      let thumbnail = '';
      let duration = '';
      let artist = '';
      let views = '';

      // ─── RESOLVE URL OR SEARCH ───
      if (text.includes('youtube.com') || text.includes('youtu.be')) {
        const videoId = text.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];
        if (videoId) {
          try {
            const yts = require('yt-search');
            const search = await yts({ videoId });
            if (search) {
              videoTitle = search.title || 'YouTube Video';
              thumbnail = search.thumbnail || '';
              duration = search.timestamp || search.duration || '';
              artist = search.author?.name || search.author || '';
              views = search.views ? `${search.views.toLocaleString()} views` : '';
            }
          } catch (e) {}
        }
        videoUrl = text;
      } else {
        const yts = require('yt-search');
        const search = await yts(text);
        if (!search?.videos?.length) {
          return await sock.sendMessage(from, { text: '❌ No video results found.' });
        }
        // Pick highest quality video (filter by duration > 10s to avoid shorts)
        const videos = search.videos.filter(v => (v.durationSeconds || 0) > 10);
        const video = videos.length ? videos[0] : search.videos[0];
        videoUrl = video.url;
        videoTitle = video.title || 'YouTube Video';
        thumbnail = video.thumbnail || '';
        duration = video.timestamp || video.duration || '';
        artist = video.author?.name || video.author || '';
        views = video.views ? `${video.views.toLocaleString()} views` : '';
      }

      // ─── SEND THUMBNAIL PREVIEW ───
      if (thumbnail) {
        try {
          await sock.sendMessage(from, {
            image: { url: thumbnail },
            caption: `🎬 *${videoTitle}*\n${artist ? `👤 ${artist}\n` : ''}${duration ? `⏱️ ${duration}\n` : ''}${views ? `👁️ ${views}\n` : ''}\n⏳ Downloading video...`
          });
        } catch (e) {}
      }

      // ─── VIDEO-ONLY API ENDPOINTS ───
      let videoData = null;
      const apis = [
        { 
          name: 'EliteProTech', 
          url: `https://eliteprotech-apis.zone.id/ytmp4?url=${encodeURIComponent(videoUrl)}`,
          extract: (d) => d?.result?.url || d?.result?.download_url || d?.download_url || d?.url || d?.video || d?.download
        },
        { 
          name: 'David Cyril', 
          url: `https://apis.davidcyril.name.ng/play?url=${encodeURIComponent(videoUrl)}&format=mp4`,
          extract: (d) => d?.result?.url || d?.download_url || d?.url || d?.video
        },
        { 
          name: 'Prince Tech', 
          url: `https://api.princetechn.com/api/download/ytmp4?apikey=prince&url=${encodeURIComponent(videoUrl)}`,
          extract: (d) => d?.result?.download_url || d?.download_url || d?.url
        },
        { 
          name: 'OmegaTech', 
          url: `https://api.omegatech.app/api/download/play?search=${encodeURIComponent(videoUrl)}`,
          extract: (d) => d?.result?.url || d?.download || d?.url
        },
        { 
          name: 'Vexa API', 
          url: `https://api.vexa.tech/ytdl?url=${encodeURIComponent(videoUrl)}&format=video`,
          extract: (d) => d?.video?.url || d?.download || d?.url
        },
        { 
          name: 'Zeltrax Downloader', 
          url: `https://zeltrax-api.vercel.app/ytmp4?url=${encodeURIComponent(videoUrl)}`,
          extract: (d) => d?.video || d?.url || d?.download
        },
        {
          name: 'NexOracle',
          url: `https://api.nexoracle.com/downloader/yt-video?url=${encodeURIComponent(videoUrl)}${NEXORACLE_API_KEY ? `&apikey=${NEXORACLE_API_KEY}` : ''}`,
          extract: (d) => d?.result?.download_url || d?.result?.url || d?.download_url || d?.url
        }
      ];

      for (const api of apis) {
        try {
          const res = await fetch(api.url, { 
            method: 'GET',
            headers: { 
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
          });
          
          if (!res.ok) continue;
          const data = await res.json();
          const download = api.extract(data);
          
          if (download && typeof download === 'string' && download.startsWith('http')) {
            videoData = { 
              download, 
              title: data?.result?.title || data?.title || videoTitle,
              quality: data?.result?.quality || data?.quality || '720p'
            };
            break;
          }
        } catch (e) {
          console.log(`❌ ${api.name} failed:`, e.message);
        }
      }

      if (!videoData) {
        // ─── FALLBACK: Direct ytdl-core (video only) ───
        try {
          const ytdl = require('ytdl-core');
          const info = await ytdl.getInfo(videoUrl);
          const format = ytdl.chooseFormat(info.formats, { 
            quality: 'highestvideo',
            filter: 'videoonly'
          });
          if (format && format.url) {
            videoData = {
              download: format.url,
              title: info.videoDetails.title,
              quality: format.qualityLabel || '720p'
            };
          }
        } catch (e) {
          console.log('❌ ytdl-core fallback failed:', e.message);
        }
      }

      if (!videoData) {
        return await sock.sendMessage(from, { text: '❌ All video download sources failed. Try a different video.' });
      }

      // ─── FETCH VIDEO BUFFER ───
      const videoRes = await fetch(videoData.download, {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Range': 'bytes=0-' // Force full download
        },
        signal: AbortSignal.timeout(60000) // 60s timeout for large videos
      });

      if (!videoRes.ok) {
        return await sock.sendMessage(from, { text: `❌ Failed to download video (HTTP ${videoRes.status}).` });
      }

      let videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      if (videoBuffer.length < 5000) {
        return await sock.sendMessage(from, { text: '❌ Downloaded file is too small (corrupted).' });
      }

      const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);

      // ─── SEND VIDEO ONLY ───
      const safeTitle = (videoData.title || 'video').replace(/[^\w\s-]/g, '').trim();
      const caption = `🎬 *${videoData.title || videoTitle}*\n📦 Size: ${fileSizeMB} MB\n🎯 Quality: ${videoData.quality || 'Auto'}\n📹 Format: MP4 (Video Only)`;

      // If video > 16MB, send as document
      if (videoBuffer.length > 16 * 1024 * 1024) {
        await sock.sendMessage(from, {
          document: videoBuffer,
          mimetype: 'video/mp4',
          fileName: `${safeTitle}.mp4`,
          caption: `${caption}\n⚠️ Sent as document (WhatsApp 16MB limit)`,
          contextInfo: {
            externalAdReply: {
              title: videoData.title || videoTitle,
              body: `🎥 ${duration || 'Video'}`,
              thumbnail: thumbnail ? await fetch(thumbnail).then(r => r.buffer()).catch(() => null) : null,
              mediaType: 2,
              renderLargerThumbnail: true
            }
          }
        });
      } else {
        try {
          await sock.sendMessage(from, {
            video: videoBuffer,
            mimetype: 'video/mp4',
            caption: caption,
            contextInfo: {
              externalAdReply: {
                title: videoData.title || videoTitle,
                body: `🎥 ${duration || 'Video'}`,
                thumbnail: thumbnail ? await fetch(thumbnail).then(r => r.buffer()).catch(() => null) : null,
                mediaType: 2,
                renderLargerThumbnail: true
              }
            }
          });
        } catch (sendErr) {
          // Fallback: send as document if video fails
          await sock.sendMessage(from, {
            document: videoBuffer,
            mimetype: 'video/mp4',
            fileName: `${safeTitle}.mp4`,
            caption: caption
          });
        }
      }

      // ─── LOG ───
      console.log(`✅ Video sent: ${videoData.title} (${fileSizeMB}MB)`);

    } catch (err) {
      console.error('Playvideo error:', err);
      await sock.sendMessage(from, { 
        text: `❌ Error: ${err.message || 'Unknown error'}\n${err.stack ? 'Check logs for details' : ''}` 
      });
    }
  }
});

register({
  name: 'calc',
  aliases: ['calculate', 'math'],
  category: 'TOOLS',
  description: 'Evaluate a math expression, e.g. .calc (12+8)*3/4',
  async execute({ sock, from, text, prefix, command }) {
    if (!text) {
      return sock.sendMessage(from, { text: `🧮 Usage: ${prefix}${command} <expression>\nExample: ${prefix}${command} (12+8)*3/4` });
    }
    // Only allow digits, whitespace, and basic arithmetic characters — no letters,
    // so this can never execute arbitrary JS via the expression string.
    if (!/^[\d\s+\-*/().%]+$/.test(text)) {
      return sock.sendMessage(from, { text: '❌ Only numbers and + - * / % ( ) are allowed.' });
    }
    try {
      const result = Function(`"use strict"; return (${text})`)();
      if (typeof result !== 'number' || !isFinite(result)) throw new Error('Invalid result');
      await sock.sendMessage(from, { text: `🧮 *${text}* = *${result}*` });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not evaluate that expression.' });
    }
  },
});

register({
  name: 'roll',
  aliases: ['dice'],
  category: 'TOOLS',
  description: 'Roll a dice — .roll [sides] [count]',
  async execute({ sock, from, args }) {
    const sides = Math.max(2, Math.min(1000, parseInt(args[0]) || 6));
    const count = Math.max(1, Math.min(20, parseInt(args[1]) || 1));
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    const total = rolls.reduce((a, b) => a + b, 0);
    const text = count === 1
      ? `🎲 You rolled a *${rolls[0]}* (d${sides})`
      : `🎲 Rolls: ${rolls.join(', ')}\n➕ Total: *${total}*`;
    await sock.sendMessage(from, { text });
  },
});

register({
  name: 'flip',
  aliases: ['coinflip', 'coin'],
  category: 'TOOLS',
  description: 'Flip a coin',
  async execute({ sock, from }) {
    const result = Math.random() < 0.5 ? 'Heads 🪙' : 'Tails 🪙';
    await sock.sendMessage(from, { text: `🪙 ${result}` });
  },
});

register({
  name: 'choose',
  aliases: ['pick'],
  category: 'TOOLS',
  description: 'Pick randomly from a list — .choose pizza, sushi, tacos',
  async execute({ sock, from, text, prefix, command }) {
    if (!text) {
      return sock.sendMessage(from, { text: `🤔 Usage: ${prefix}${command} option1, option2, option3` });
    }
    const options = text.split(',').map((o) => o.trim()).filter(Boolean);
    if (options.length < 2) {
      return sock.sendMessage(from, { text: '❓ Give me at least two options, separated by commas.' });
    }
    const pick = options[Math.floor(Math.random() * options.length)];
    await sock.sendMessage(from, { text: `🎯 I choose: *${pick}*` });
  },
});

register({
  name: 'qr',
  aliases: ['qrcode'],
  category: 'TOOLS',
  description: 'Generate a QR code from text or a link',
  async execute({ sock, from, text, prefix, command }) {
    if (!text) {
      return sock.sendMessage(from, { text: `📱 Usage: ${prefix}${command} <text or url>` });
    }
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(text)}`;
    try {
      await sock.sendMessage(from, { image: { url }, caption: `📱 QR code for: ${text}` });
    } catch (e) {
      await sock.sendMessage(from, { text: '⚠️ Could not generate QR code: ' + e.message });
    }
  },
});

register({
  name: 'currency',
  aliases: ['convert', 'exchangerate'],
  category: 'TOOLS',
  description: 'Convert currency — .currency 100 USD to EUR',
  async execute({ sock, from, args, prefix, command }) {
    if (args.length < 4) {
      return sock.sendMessage(from, { text: `💱 Usage: ${prefix}${command} <amount> <from> to <to>\nExample: ${prefix}${command} 100 USD to EUR` });
    }
    const amount = parseFloat(args[0]);
    const from_ = (args[1] || '').toUpperCase();
    const to = (args[3] || '').toUpperCase();
    if (!amount || !from_ || !to) {
      return sock.sendMessage(from, { text: `💱 Usage: ${prefix}${command} <amount> <from> to <to>` });
    }
    try {
      const res = await fetch(`https://open.er-api.com/v6/latest/${from_}`);
      const data = await res.json();
      const rate = data.rates?.[to];
      if (!rate) return sock.sendMessage(from, { text: `❌ Could not find a rate for ${from_} → ${to}.` });
      const converted = (amount * rate).toFixed(2);
      await sock.sendMessage(from, { text: `💱 ${amount} ${from_} = *${converted} ${to}*\n📊 Rate: 1 ${from_} = ${rate} ${to}` });
    } catch (e) {
      await sock.sendMessage(from, { text: '⚠️ Currency lookup failed: ' + e.message });
    }
  },
});

// ---------- INFO ----------

register({
  name: 'jid',
  category: 'INFO',
  description: 'Get the JID of this chat',
  async execute({ sock, from }) {
    await sock.sendMessage(from, { text: `\`\`\`${from}\`\`\`` });
  },
});

register({
  name: 'owner',
  category: 'INFO',
  description: 'Get owner contact',
  async execute({ sock, from }) {
    const ownerJid = getOwnerJid(sock);
    const ownerNum = ownerJid ? ownerJid.split('@')[0] : 'unknown';
    await sock.sendMessage(from, { text: `👑 Owner: wa.me/${ownerNum}` });
  },
});

register({
  name: 'source',
  category: 'INFO',
  description: 'About this bot',
  async execute({ sock, from, sessionId }) {
    await sock.sendMessage(from, {
      text: `${getBotName(sessionId)} — a multi-user WhatsApp bot built with Baileys, deployed on Railway.`,
    });
  },
});
register({
  name: 'repo',
  aliases: ['repository', 'sourcecode', 'github', 'source'],
  category: 'MAIN',
  description: 'Get the bot repository and source code information',
  async execute({ sock, from, prefix, command, sessionId }) {
    const repoInfo = `╭───────────────⭓
│ 🤖 *${getBotName(sessionId)}* REPO
╰───────────────⭓

📦 *Project:* ${getBotName(sessionId)}
⚡ *Version:* 2.0.0

> inconnuxdv2.vercel.app

> BY ${DEV_NAME}`;

    // Send as text
    await sock.sendMessage(from, { text: repoInfo });
  }
});
// ---------- TOOLS ----------

register({
  name: 'sticker',
  aliases: ['s'],
  category: 'TOOLS',
  description: 'Reply to / send an image or short video to make a sticker',
  async execute({ sock, msg, from, quoted, sessionId }) {
    const target = quoted || msg;
    const imageMsg = target?.message?.imageMessage;
    const videoMsg = target?.message?.videoMessage;

    if (!imageMsg && !videoMsg) {
      await sock.sendMessage(from, { text: `📎 Send or reply to an image/video with *${PREFIX}sticker*` });
      return;
    }

    const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
    const stream = await downloadContentFromMessage(imageMsg || videoMsg, imageMsg ? 'image' : 'video');
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

    const sticker = new Sticker(buffer, {
      pack: getBotName(sessionId),
      author: DEV_NAME,
      type: StickerTypes.FULL,
      quality: 70,
    });

    const stickerBuffer = await sticker.toBuffer();
    await sock.sendMessage(from, { sticker: stickerBuffer });
  },
});

register({
  name: 'take',
  aliases: ['stake'],
  category: 'TOOLS',
  description: 'Reply to a sticker to re-tag it with your own bot name',
  async execute({ sock, msg, from, quoted, sessionId }) {
    const target = quoted || msg;
    const stickerMsg = target?.message?.stickerMessage;

    if (!stickerMsg) {
      await sock.sendMessage(from, { text: `📎 Reply to a sticker with *${PREFIX}take*` });
      return;
    }

    try {
      const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
      const stream = await downloadContentFromMessage(stickerMsg, 'sticker');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

      const sticker = new Sticker(buffer, {
        pack: getBotName(sessionId),
        author: DEV_NAME,
        type: StickerTypes.FULL,
        quality: 70,
      });

      const stickerBuffer = await sticker.toBuffer();
      await sock.sendMessage(from, { sticker: stickerBuffer });
    } catch (e) {
      await sock.sendMessage(from, { text: `❌ Could not take that sticker. (${e.message})` });
    }
  },
});


// ---------- GROUP-SECURITY ----------

async function requireAdminOrOwner({ sock, from, sender, isGroup, msg, isOwner }) {
  // isOwner (fromMe, or granted via .sudoadd) always has full access.
  if (isOwner || msg.key.fromMe) return true;
  if (!isGroup) {
    await sock.sendMessage(from, { text: '⚠️ This setting only applies inside groups.' });
    return false;
  }
  const admin = await isSenderAdmin(sock, from, sender);
  if (!admin) {
    await sock.sendMessage(from, { text: '❌ Only group admins or the bot owner can change this.' });
    return false;
  }
  return true;
}

function toggleCommand({ name, aliases, settingKey, label, emoji }) {
  register({
    name,
    aliases,
    category: 'GROUP-SECURITY',
    description: `${label} — on/off`,
    async execute(ctx) {
      const { sock, from, args, isGroup } = ctx;
      const ok = await requireAdminOrOwner(ctx);
      if (!ok) return;

      const state = getGroupSettings(from);
      const arg = (args[0] || '').toLowerCase();

      if (!arg || !['on', 'off'].includes(arg)) {
        await sock.sendMessage(from, {
          text: `${emoji} *${label}* is currently *${state[settingKey] ? 'ON' : 'OFF'}*.\nUse: ${PREFIX}${name} on | ${PREFIX}${name} off`,
        });
        return;
      }

      const enabled = arg === 'on';
      setGroupSetting(from, settingKey, enabled);
      await sock.sendMessage(from, {
        text: `${emoji} *${label}* turned *${enabled ? 'ON ✅' : 'OFF ❌'}* for this group.`,
      });
    },
  });
}

toggleCommand({
  name: 'antidelete',
  settingKey: 'antidelete',
  label: 'Antidelete',
  emoji: '🗑️',
});

toggleCommand({
  name: 'antiedit',
  settingKey: 'antiedit',
  label: 'Antiedit',
  emoji: '✏️',
});

toggleCommand({
  name: 'antisticker',
  settingKey: 'antisticker',
  label: 'Antisticker',
  emoji: '🎴',
});

toggleCommand({
  name: 'antigroupmention',
  aliases: ['antitag'],
  settingKey: 'antigroupmention',
  label: 'Antigroupmention',
  emoji: '🚫',
});

toggleCommand({
  name: 'antilink',
  settingKey: 'antilink',
  label: 'Antilink',
  emoji: '🔗',
});

toggleCommand({
  name: 'antigif',
  settingKey: 'antigif',
  label: 'Antigif',
  emoji: '🎬',
});

toggleCommand({
  name: 'antispam',
  settingKey: 'antispam',
  label: 'Antispam',
  emoji: '🚿',
});

toggleCommand({
  name: 'antibot',
  settingKey: 'antibot',
  label: 'Antibot',
  emoji: '🤖',
});

toggleCommand({
  name: 'antipromote',
  settingKey: 'antipromote',
  label: 'Antipromote',
  emoji: '⬆️',
});

toggleCommand({
  name: 'antidemote',
  settingKey: 'antidemote',
  label: 'Antidemote',
  emoji: '⬇️',
});

// ---------- Warnings (shared pool: antispam / antibot / antipromote / antidemote / .mute) ----------

register({
  name: 'setwarn',
  category: 'GROUP-SECURITY',
  description: 'Set how many warnings before an auto-kick — applies to every warn-issuing command in this group',
  async execute(ctx) {
    const { sock, from, args, isGroup } = ctx;
    if (!isGroup) {
      await sock.sendMessage(from, { text: '⚠️ This only applies inside groups.' });
      return;
    }
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    const n = parseInt(args[0], 10);
    if (!args[0] || isNaN(n) || n < 1) {
      const current = getGroupSettings(from).warnLimit || 3;
      await sock.sendMessage(from, {
        text: `⚠️ *Warn limit* is currently *${current}*.\nUse: ${PREFIX}setwarn <number> — e.g. ${PREFIX}setwarn 3`,
      });
      return;
    }
    setGroupSetting(from, 'warnLimit', n);
    await sock.sendMessage(from, { text: `⚠️ *Warn limit* set to *${n}* — applies to antispam, antibot, antipromote, antidemote and .mute in this group.` });
  },
});

register({
  name: 'delwarn',
  category: 'GROUP-SECURITY',
  description: "Clear a user's warnings — mention them, reply to them, or give their number",
  async execute(ctx) {
    const { sock, from, args, quoted, msg, isGroup } = ctx;
    if (!isGroup) {
      await sock.sendMessage(from, { text: '⚠️ This only applies inside groups.' });
      return;
    }
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    const target = getTargetJid({ msg, quoted, args });
    if (!target) {
      await sock.sendMessage(from, { text: `📝 Mention, reply to, or give the number of whoever to clear — e.g. ${PREFIX}delwarn @user` });
      return;
    }
    const cleared = removeWarn(from, target);
    await sock.sendMessage(from, {
      text: cleared ? `✅ Cleared warnings for @${bareNumber(target)}.` : `ℹ️ @${bareNumber(target)} has no warnings.`,
      mentions: [target],
    });
  },
});

register({
  name: 'delallwarn',
  category: 'GROUP-SECURITY',
  description: 'Clear every warning in this group',
  async execute(ctx) {
    const { sock, from, isGroup } = ctx;
    if (!isGroup) {
      await sock.sendMessage(from, { text: '⚠️ This only applies inside groups.' });
      return;
    }
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    const had = removeAllWarns(from);
    await sock.sendMessage(from, { text: had ? '✅ All warnings in this group were cleared.' : 'ℹ️ There were no warnings to clear.' });
  },
});

register({
  name: 'listwarn',
  aliases: ['warnlist', 'warnings'],
  category: 'GROUP-SECURITY',
  description: 'List everyone with active warnings in this group',
  async execute(ctx) {
    const { sock, from, isGroup, sessionId } = ctx;
    if (!isGroup) {
      await sock.sendMessage(from, { text: '⚠️ This only applies inside groups.' });
      return;
    }
    const entries = Object.entries(listWarns(from));
    if (!entries.length) {
      await sock.sendMessage(from, { text: 'ℹ️ No one has any warnings in this group.' });
      return;
    }
    const limit = getGroupSettings(from).warnLimit || 3;
    const mentions = entries.map(([jid]) => jid);
    const lines = entries.map(([jid, count]) => `• @${bareNumber(jid)} — ${count}/${limit}`).join('\n');
    await sock.sendMessage(from, { text: `⚠️ *Warnings in this group*\n\n${lines}`, mentions });
  },
});

// Antinum — auto-kicks anyone who joins with a blocked calling code. Supports
// several codes active at once (e.g. .antinum +55 then .antinum +509).
register({
  name: 'antinum',
  category: 'GROUP-SECURITY',
  description: 'Auto-kick anyone who joins with a given calling code — e.g. .antinum +55, .antinum +55 off, .antinum off',
  async execute(ctx) {
    const { sock, from, args, isGroup } = ctx;
    if (!isGroup) {
      await sock.sendMessage(from, { text: '⚠️ This only applies inside groups.' });
      return;
    }
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    const state = getGroupSettings(from);
    const codes = state.antinumCodes || [];
    const arg0 = (args[0] || '').toLowerCase();

    if (!arg0) {
      await sock.sendMessage(from, {
        text: codes.length
          ? `🚫 *Antinum* is blocking joiners with: ${codes.map((c) => `+${c}`).join(', ')}\nUse: ${PREFIX}antinum +<code> to add, ${PREFIX}antinum +<code> off to remove, or ${PREFIX}antinum off to clear all.`
          : `🚫 *Antinum* has no blocked codes set.\nUse: ${PREFIX}antinum +<code> — e.g. ${PREFIX}antinum +55`,
      });
      return;
    }

    if (arg0 === 'off') {
      setGroupSetting(from, 'antinumCodes', []);
      await sock.sendMessage(from, { text: '🚫 *Antinum* cleared — no codes are blocked now.' });
      return;
    }

    const code = arg0.replace(/[^0-9]/g, '');
    if (!code) {
      await sock.sendMessage(from, { text: `📝 Give a calling code, e.g. ${PREFIX}antinum +55` });
      return;
    }

    const turningOff = (args[1] || '').toLowerCase() === 'off';
    if (turningOff) {
      const next = codes.filter((c) => c !== code);
      setGroupSetting(from, 'antinumCodes', next);
      await sock.sendMessage(from, { text: `🚫 *Antinum* +${code} removed.${next.length ? ` Still blocking: ${next.map((c) => `+${c}`).join(', ')}` : ''}` });
      return;
    }

    if (codes.includes(code)) {
      await sock.sendMessage(from, { text: `🚫 *Antinum* +${code} is already blocked.` });
      return;
    }
    setGroupSetting(from, 'antinumCodes', [...codes, code]);
    await sock.sendMessage(from, { text: `🚫 *Antinum* now auto-kicking anyone who joins with +${code}.` });
  },
});

// Auto-react is owner-level (not per-group) so it works in DMs too, not just groups.
// Scope is one of: dm | group | both | off.
register({
  name: 'autoreact',
  category: 'GROUP-SECURITY',
  description: 'React to incoming messages with a random emoji (owner only) — dm / group / both / off',
  async execute({ sock, from, args, sessionId, isOwner }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    const arg = (args[0] || '').toLowerCase();
    const valid = ['dm', 'group', 'both', 'off', 'on'];
    if (!arg || !valid.includes(arg)) {
      await sock.sendMessage(from, {
        text:
          `😄 *Auto-react* is currently set to *${getGlobalSetting(sessionId, 'autoreact').toUpperCase()}*.\n` +
          `Use: ${PREFIX}autoreact dm | ${PREFIX}autoreact group | ${PREFIX}autoreact both | ${PREFIX}autoreact off`,
      });
      return;
    }
    // "on" is kept as a friendly alias for "both".
    const scope = arg === 'on' ? 'both' : arg;
    setGlobalSetting(sessionId, 'autoreact', scope);
    const label = { dm: 'DMs only', group: 'groups only', both: 'DMs and groups', off: 'disabled' }[scope];
    await sock.sendMessage(from, { text: `😄 *Auto-react* set to *${scope.toUpperCase()}* — ${label}.` });
  },
});

register({
  name: 'ownerreact',
  category: 'GROUP-SECURITY',
  description: "React to every message the session owner sends themselves (owner only) — on/off",
  async execute({ sock, from, args, sessionId, isOwner }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    const arg = (args[0] || '').toLowerCase();
    if (!arg || !['on', 'off'].includes(arg)) {
      await sock.sendMessage(from, {
        text: `👑 *Owner-react* is currently *${getGlobalSetting(sessionId, 'ownerreact') ? 'ON' : 'OFF'}*.\nUse: ${PREFIX}ownerreact on | ${PREFIX}ownerreact off`,
      });
      return;
    }
    setGlobalSetting(sessionId, 'ownerreact', arg === 'on');
    await sock.sendMessage(from, {
      text: `👑 *Owner-react* turned *${arg === 'on' ? 'ON ✅' : 'OFF ❌'}* — reacts to your own messages too.`,
    });
  },
});

register({
  name: 'autotyping',
  category: 'GROUP-SECURITY',
  description: 'Show a "typing…" presence on every incoming message (owner only) — on/off',
  async execute({ sock, from, args, sessionId, isOwner }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    const arg = (args[0] || '').toLowerCase();
    if (!arg || !['on', 'off'].includes(arg)) {
      await sock.sendMessage(from, {
        text: `⌨️ *Auto-typing* is currently *${getGlobalSetting(sessionId, 'autotyping') ? 'ON' : 'OFF'}*.\nUse: ${PREFIX}autotyping on | ${PREFIX}autotyping off`,
      });
      return;
    }
    setGlobalSetting(sessionId, 'autotyping', arg === 'on');
    if (arg === 'on') setGlobalSetting(sessionId, 'autorecording', false); // the two are mutually exclusive presences
    await sock.sendMessage(from, { text: `⌨️ *Auto-typing* turned *${arg === 'on' ? 'ON ✅' : 'OFF ❌'}*.` });
  },
});

register({
  name: 'autorecording',
  category: 'GROUP-SECURITY',
  description: 'Show a "recording audio…" presence on every incoming message (owner only) — on/off',
  async execute({ sock, from, args, sessionId, isOwner }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    const arg = (args[0] || '').toLowerCase();
    if (!arg || !['on', 'off'].includes(arg)) {
      await sock.sendMessage(from, {
        text: `🎙️ *Auto-recording* is currently *${getGlobalSetting(sessionId, 'autorecording') ? 'ON' : 'OFF'}*.\nUse: ${PREFIX}autorecording on | ${PREFIX}autorecording off`,
      });
      return;
    }
    setGlobalSetting(sessionId, 'autorecording', arg === 'on');
    if (arg === 'on') setGlobalSetting(sessionId, 'autotyping', false); // the two are mutually exclusive presences
    await sock.sendMessage(from, { text: `🎙️ *Auto-recording* turned *${arg === 'on' ? 'ON ✅' : 'OFF ❌'}*.` });
  },
});

register({
  name: 'autolikestatus',
  aliases: ['autolike', 'likestatus'],
  category: 'GROUP-SECURITY',
  description: "Auto-react ❤️ to every contact's WhatsApp Status update (owner only) — on/off",
  async execute({ sock, from, args, sessionId, isOwner }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    const arg = (args[0] || '').toLowerCase();
    if (!arg || !['on', 'off'].includes(arg)) {
      await sock.sendMessage(from, {
        text: `❤️ *Auto-like status* is currently *${getGlobalSetting(sessionId, 'autolikestatus') ? 'ON' : 'OFF'}*.\nUse: ${PREFIX}autolikestatus on | ${PREFIX}autolikestatus off`,
      });
      return;
    }
    setGlobalSetting(sessionId, 'autolikestatus', arg === 'on');
    await sock.sendMessage(from, { text: `❤️ *Auto-like status* turned *${arg === 'on' ? 'ON ✅' : 'OFF ❌'}*.` });
  },
});

register({
  name: 'autoviewstatus',
  aliases: ['autoview', 'viewstatus'],
  category: 'GROUP-SECURITY',
  description: "Automatically view every contact's WhatsApp Status update (owner only) — on/off",
  async execute({ sock, from, args, sessionId, isOwner }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    const arg = (args[0] || '').toLowerCase();
    if (!arg || !['on', 'off'].includes(arg)) {
      await sock.sendMessage(from, {
        text: `👁️ *Auto-view status* is currently *${getGlobalSetting(sessionId, 'autoviewstatus') ? 'ON' : 'OFF'}*.\nUse: ${PREFIX}autoviewstatus on | ${PREFIX}autoviewstatus off`,
      });
      return;
    }
    setGlobalSetting(sessionId, 'autoviewstatus', arg === 'on');
    await sock.sendMessage(from, { text: `👁️ *Auto-view status* turned *${arg === 'on' ? 'ON ✅' : 'OFF ❌'}*.` });
  },
});

register({
  name: 'save',
  aliases: ['statussave', 'sstatus'],
  category: 'TOOLS',
  description: "Reply to someone's forwarded status update to save its media/text",
  async execute({ sock, from, quoted }) {
    if (!quoted || !quoted.message) {
      await sock.sendMessage(from, {
        text: `📥 Reply to a status update (or any message) with *${PREFIX}save* to save its media/text.`,
      });
      return;
    }

    const qm = quoted.message;
    try {
      if (qm.imageMessage) {
        const stream = await downloadContentFromMessage(qm.imageMessage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        await sock.sendMessage(from, { image: buffer, caption: qm.imageMessage.caption || '💾 Status saved' });
      } else if (qm.videoMessage) {
        const stream = await downloadContentFromMessage(qm.videoMessage, 'video');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        await sock.sendMessage(from, {
          video: buffer,
          caption: qm.videoMessage.caption || '💾 Status saved',
          gifPlayback: !!qm.videoMessage.gifPlayback,
        });
      } else if (qm.audioMessage) {
        const stream = await downloadContentFromMessage(qm.audioMessage, 'audio');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        await sock.sendMessage(from, {
          audio: buffer,
          mimetype: qm.audioMessage.mimetype || 'audio/mpeg',
          ptt: !!qm.audioMessage.ptt,
        });
      } else if (qm.conversation || qm.extendedTextMessage?.text) {
        await sock.sendMessage(from, { text: `💾 *Status saved:*\n\n${qm.conversation || qm.extendedTextMessage.text}` });
      } else {
        await sock.sendMessage(from, { text: "⚠️ Couldn't find any savable media or text in that reply." });
      }
    } catch (err) {
      await sock.sendMessage(from, { text: `❌ Failed to save that status. (${err.message})` });
    }
  },
});

register({
  name: 'dev',
  aliases: ['alias', 'tech', 'devlink', 'channel'],
  category: 'MAIN',
  description: 'Show developer / tech contact info',
  async execute({ sock, from, sessionId }) {
    const card =
      `╭───────────────⭓\n` +
      `│ 👨‍💻 *${getBotName(sessionId)}* DEV\n` +
      `╰───────────────⭓\n\n` +
      `📛 *Name:* ${DEV_NAME}\n` +
      `🌎 *Country:* 🇧🇷 ${DEV_COUNTRY}\n` +
      `🔗 *GitHub:* ${DEV_GITHUB}\n` +
      `📢 *Channel:* ${CHANNEL_LINK}`;
    await sock.sendMessage(from, { text: card });
  },
});

register({
  name: 'anticall',
  category: 'GROUP-SECURITY',
  description: 'Auto-reject incoming calls to this bot (owner only) — on/off',
  async execute({ sock, from, args, msg, sessionId, isOwner }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    const arg = (args[0] || '').toLowerCase();
    if (!arg || !['on', 'off'].includes(arg)) {
      await sock.sendMessage(from, {
        text: `📵 *Anticall* is currently *${getGlobalSetting(sessionId, 'anticall') ? 'ON' : 'OFF'}*.\nUse: ${PREFIX}anticall on | ${PREFIX}anticall off`,
      });
      return;
    }
    setGlobalSetting(sessionId, 'anticall', arg === 'on');
    await sock.sendMessage(from, { text: `📵 *Anticall* turned *${arg === 'on' ? 'ON ✅' : 'OFF ❌'}*.` });
  },
});

register({
  name: 'mode',
  aliases: ['private', 'public'],
  category: 'GROUP-SECURITY',
  description: 'Switch the bot between public and private mode (owner only)',
  async execute({ sock, from, args, msg, sessionId, text, isOwner }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    // Support both ".mode private" and the bare ".private" / ".public" aliases.
    const invoked = text.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase();
    const arg = ['private', 'public'].includes(invoked) ? invoked : (args[0] || '').toLowerCase();

    if (!arg || !['public', 'private'].includes(arg)) {
      const current = getGlobalSetting(sessionId, 'mode');
      await sock.sendMessage(from, {
        text: `⚙️ Bot is currently in *${current.toUpperCase()}* mode.\nUse: ${PREFIX}mode public | ${PREFIX}mode private`,
      });
      return;
    }

    setGlobalSetting(sessionId, 'mode', arg);
    await sock.sendMessage(from, {
      text:
        arg === 'private'
          ? '🔒 *Private mode* enabled — only the owner can use commands now.'
          : '🌐 *Public mode* enabled — everyone can use commands.',
    });
  },
});

register({
  name: 'security',
  aliases: ['groupsettings', 'settings'],
  category: 'GROUP-SECURITY',
  description: 'View all group-security toggles at a glance',
  async execute({ sock, from, isGroup, sessionId }) {
    if (!isGroup) {
      await sock.sendMessage(from, { text: '⚠️ This only applies inside groups.' });
      return;
    }
    const s = getGroupSettings(from);
    const flag = (v) => (v ? '✅ ON' : '❌ OFF');
    const antinumLine = (s.antinumCodes && s.antinumCodes.length)
      ? s.antinumCodes.map((c) => `+${c}`).join(', ')
      : '❌ none';
    const text =
      `🛡️ *Group Security Status*\n\n` +
      `🗑️ Antidelete        : ${flag(s.antidelete)}\n` +
      `✏️ Antiedit          : ${flag(s.antiedit)}\n` +
      `🎴 Antisticker       : ${flag(s.antisticker)}\n` +
      `🎬 Antigif           : ${flag(s.antigif)}\n` +
      `🚫 Antigroupmention  : ${flag(s.antigroupmention)}\n` +
      `🔗 Antilink          : ${flag(s.antilink)}\n` +
      `🚿 Antispam          : ${flag(s.antispam)}\n` +
      `🤖 Antibot           : ${flag(s.antibot)}\n` +
      `⬆️ Antipromote       : ${flag(s.antipromote)}\n` +
      `⬇️ Antidemote        : ${flag(s.antidemote)}\n` +
      `⚠️ Warn limit        : ${s.warnLimit || 3}\n` +
      `🚫 Antinum           : ${antinumLine}\n\n` +
      `😄 Auto-react             : ${getGlobalSetting(sessionId, 'autoreact').toUpperCase()}\n` +
      `👑 Owner-react            : ${flag(getGlobalSetting(sessionId, 'ownerreact'))}\n` +
      `⌨️ Auto-typing            : ${flag(getGlobalSetting(sessionId, 'autotyping'))}\n` +
      `🎙️ Auto-recording         : ${flag(getGlobalSetting(sessionId, 'autorecording'))}\n` +
      `❤️ Auto-like status       : ${flag(getGlobalSetting(sessionId, 'autolikestatus'))}\n` +
      `👁️ Auto-view status       : ${flag(getGlobalSetting(sessionId, 'autoviewstatus'))}\n` +
      `📵 Anticall (all chats)   : ${flag(getGlobalSetting(sessionId, 'anticall'))}\n\n` +
      `_Group toggles: ${PREFIX}<name> on/off. Owner-level toggles above are owner-only and apply everywhere. Reset everything with ${PREFIX}resetsettings._`;
    await sock.sendMessage(from, { text });
  },
});

register({
  name: 'resetsettings',
  category: 'GROUP-SECURITY',
  description: 'Reset every group-security/welcome toggle for this group back to default',
  async execute(ctx) {
    const { sock, from, isGroup } = ctx;
    if (!isGroup) {
      await sock.sendMessage(from, { text: '⚠️ This only applies inside groups.' });
      return;
    }
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    resetGroupSettings(from);
    await sock.sendMessage(from, { text: `♻️ All group settings were reset to default. Check them with ${PREFIX}settings.` });
  },
});

// ---------- GROUP-ADMIN ----------

// Resolves a target JID from a mention, a quoted message's sender, or a raw
// number passed as an argument — in that order of preference.
// Strips the WhatsApp domain suffix (and any device id) from a JID, leaving
// just the raw phone number — used whenever we need to @-mention someone.
function bareNumber(jid) {
  return (jid || '').split('@')[0].split(':')[0];
}

function getTargetJid({ msg, quoted, args }) {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (mentioned && mentioned.length) return mentioned[0];
  if (quoted?.key?.participant) return quoted.key.participant;
  const num = (args[0] || '').replace(/[^0-9]/g, '');
  if (num) return `${num}@s.whatsapp.net`;
  return null;
}

function requireGroup({ sock, from, isGroup }) {
  if (!isGroup) {
    sock.sendMessage(from, { text: '⚠️ This command only works inside groups.' });
    return false;
  }
  return true;
}

register({
  name: 'tagall',
  category: 'GROUP-ADMIN',
  description: 'Mention every member in the group',
  async execute(ctx) {
    const { sock, from, isGroup, args } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    const meta = await sock.groupMetadata(from);
    const mentions = meta.participants.map((p) => p.id);
    const note = args.join(' ');

    let text = `📢 *Tag All* (${mentions.length} members)\n\n`;
    mentions.forEach((jid) => {
      text += `• @${bareNumber(jid)}\n`;
    });
    if (note) text += `\n💬 ${note}`;

    await sock.sendMessage(from, { text, mentions });
  },
});

register({
  name: 'hidetag',
  category: 'GROUP-ADMIN',
  description: 'Notify everyone without listing numbers — add a message or reply to one',
  async execute(ctx) {
    const { sock, from, args, quoted } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    const meta = await sock.groupMetadata(from);
    const mentions = meta.participants.map((p) => p.id);
    const quotedText = quoted?.message?.conversation || quoted?.message?.extendedTextMessage?.text;
    const text = args.join(' ') || quotedText || '📢';

    await sock.sendMessage(from, { text, mentions });
  },
});

register({
  name: 'mute',
  category: 'GROUP-ADMIN',
  description: 'Mute the whole group — only admins can send messages. For muting a single member, use .muteuser instead.',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    try {
      await sock.groupSettingUpdate(from, 'announcement');
      await sock.sendMessage(from, { text: '🔇 Group muted — only admins can send messages now.' });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not mute — is the bot an admin here?' });
    }
  },
});

register({
  name: 'unmute',
  category: 'GROUP-ADMIN',
  description: 'Unmute the whole group — everyone can send messages again. For unmuting a single member, use .unmuteuser instead.',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    try {
      await sock.groupSettingUpdate(from, 'not_announcement');
      await sock.sendMessage(from, { text: '🔊 Group unmuted — everyone can send messages.' });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not unmute — is the bot an admin here?' });
    }
  },
});

register({
  name: 'muteuser',
  category: 'GROUP-ADMIN',
  description: 'Mute a single member: .muteuser <number|mention|reply> [limit]. Their messages get deleted and they are auto-kicked after <limit> messages (default 3).',
  async execute(ctx) {
    const { sock, from, args, msg, quoted } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    const target = getTargetJid({ msg, quoted, args });
    if (!target) {
      await sock.sendMessage(from, { text: `📎 Use: ${PREFIX}muteuser <number> [limit] — or reply to / mention the member.` });
      return;
    }

    const numbers = args.join(' ').match(/\d+/g) || [];
    const mentionedFromMsg = (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).length > 0;
    let limit = 3;
    if (mentionedFromMsg || quoted?.key?.participant) {
      if (numbers.length) limit = parseInt(numbers[numbers.length - 1], 10);
    } else if (numbers.length > 1) {
      limit = parseInt(numbers[1], 10);
    }
    if (!limit || limit < 1) limit = 3;

    muteUser(from, target, limit);
    await sock.sendMessage(from, {
      text: `🔇 @${bareNumber(target)} has been muted.\n📩 Messages allowed before auto-kick: ${limit}\n🗑️ Their messages will be deleted while muted.`,
      mentions: [target],
    });
  },
});

register({
  name: 'unmuteuser',
  category: 'GROUP-ADMIN',
  description: 'Unmute a single member: .unmuteuser <number|mention|reply>',
  async execute(ctx) {
    const { sock, from, args, msg, quoted } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    const target = getTargetJid({ msg, quoted, args });
    if (!target) {
      await sock.sendMessage(from, { text: `📎 Use: ${PREFIX}unmuteuser <number> — or reply to / mention the member.` });
      return;
    }

    unmuteUser(from, target);
    await sock.sendMessage(from, {
      text: `🔊 @${bareNumber(target)} has been unmuted.`,
      mentions: [target],
    });
  },
});

register({
  name: 'unmuteall',
  category: 'GROUP-ADMIN',
  description: 'Unmute every member currently muted in this group',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;
    unmuteAllUsers(from);
    await sock.sendMessage(from, { text: '🔊 All muted members in this group have been unmuted.' });
  },
});

// ---------- OWNER (sudo & ban) ----------

register({
  name: 'sudoadd',
  category: 'OWNER',
  description: 'Grant a user full owner access for this session: .sudoadd <number|mention|reply> (owner only)',
  async execute(ctx) {
    const { sock, from, args, msg, quoted, sessionId } = ctx;
    // Restricted to the actual linked account (not sudo users themselves) so
    // sudo access can't be chained/escalated by a sudo user granting it to others.
    if (!msg.key.fromMe) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    const target = getTargetJid({ msg, quoted, args });
    if (!target) {
      await sock.sendMessage(from, { text: `📎 Use: ${PREFIX}sudoadd <number> — or reply to / mention the user.` });
      return;
    }
    const number = bareNumber(target);
    addSudo(sessionId, number);
    await sock.sendMessage(from, {
      text: `👑 @${number} now has full owner access for this session.`,
      mentions: [target],
    });
  },
});

register({
  name: 'delsudo',
  aliases: ['sudodel', 'removesudo'],
  category: 'OWNER',
  description: "Revoke a user's sudo access: .delsudo <number|mention|reply> (owner only)",
  async execute(ctx) {
    const { sock, from, args, msg, quoted, sessionId } = ctx;
    if (!msg.key.fromMe) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    const target = getTargetJid({ msg, quoted, args });
    if (!target) {
      await sock.sendMessage(from, { text: `📎 Use: ${PREFIX}delsudo <number> — or reply to / mention the user.` });
      return;
    }
    const number = bareNumber(target);
    removeSudo(sessionId, number);
    await sock.sendMessage(from, {
      text: `✅ @${number}'s sudo access has been revoked.`,
      mentions: [target],
    });
  },
});

register({
  name: 'listsudo',
  category: 'OWNER',
  description: 'List every user with sudo (full owner) access for this session',
  async execute({ sock, from, sessionId, isOwner }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only command.' });
      return;
    }
    const list = listSudoUsers(sessionId);
    if (!list.length) {
      await sock.sendMessage(from, { text: '👑 No sudo users yet.' });
      return;
    }
    const mentions = list.map((n) => `${n}@s.whatsapp.net`);
    await sock.sendMessage(from, { text: `👑 *Sudo users*\n\n${list.map((n) => `• @${n}`).join('\n')}`, mentions });
  },
});

register({
  name: 'ban',
  category: 'OWNER',
  description: 'Ban a user from using this bot session: .ban <number|mention|reply>',
  async execute(ctx) {
    const { sock, from, args, msg, quoted, sessionId, isOwner } = ctx;
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only command.' });
      return;
    }
    const target = getTargetJid({ msg, quoted, args });
    if (!target) {
      await sock.sendMessage(from, { text: `📎 Use: ${PREFIX}ban <number> — or reply to / mention the user.` });
      return;
    }
    const number = bareNumber(target);
    banUser(sessionId, number);
    await sock.sendMessage(from, {
      text: `⛔ @${number} has been banned from using this bot.`,
      mentions: [target],
    });
  },
});

register({
  name: 'unban',
  aliases: ['unbban'],
  category: 'OWNER',
  description: 'Unban a user: .unban <number|mention|reply>',
  async execute(ctx) {
    const { sock, from, args, msg, quoted, sessionId, isOwner } = ctx;
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only command.' });
      return;
    }
    const target = getTargetJid({ msg, quoted, args });
    if (!target) {
      await sock.sendMessage(from, { text: `📎 Use: ${PREFIX}unban <number> — or reply to / mention the user.` });
      return;
    }
    const number = bareNumber(target);
    unbanUser(sessionId, number);
    await sock.sendMessage(from, {
      text: `✅ @${number} has been unbanned.`,
      mentions: [target],
    });
  },
});

register({
  name: 'banlist',
  category: 'OWNER',
  description: 'List every user banned from this bot session',
  async execute({ sock, from, sessionId, isOwner }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only command.' });
      return;
    }
    const list = listBannedUsers(sessionId);
    if (!list.length) {
      await sock.sendMessage(from, { text: '⛔ No banned users.' });
      return;
    }
    const mentions = list.map((n) => `${n}@s.whatsapp.net`);
    await sock.sendMessage(from, { text: `⛔ *Banned users*\n\n${list.map((n) => `• @${n}`).join('\n')}`, mentions });
  },
});

// ---------- ADDCASE / DELCASE (custom commands) ----------
// Lets the owner create their own commands on the fly: .addcase <trigger>|<response>
// registers "<prefix><trigger>" to reply with <response>, exactly like a
// built-in command — no code edit, no restart. Checked in bot.js after the
// built-in command map comes up empty. See src/store.js for persistence.

register({
  name: 'addcase',
  aliases: ['newcase'],
  category: 'OWNER',
  description: 'Add a custom command: .addcase <trigger>|<response> — e.g. .addcase rules|Read the pinned message.',
  async execute(ctx) {
    const { sock, from, args, sessionId, isOwner } = ctx;
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only command.' });
      return;
    }
    const raw = args.join(' ');
    const sep = raw.indexOf('|');
    if (sep === -1) {
      await sock.sendMessage(from, {
        text: `📝 Use: ${PREFIX}addcase <trigger>|<response>\nExample: ${PREFIX}addcase rules|Read the pinned message before posting.`,
      });
      return;
    }
    const trigger = raw.slice(0, sep).trim().toLowerCase();
    const response = raw.slice(sep + 1).trim();
    if (!trigger || !response) {
      await sock.sendMessage(from, { text: `📝 Both a trigger and a response are needed: ${PREFIX}addcase <trigger>|<response>` });
      return;
    }
    if (/\s/.test(trigger)) {
      await sock.sendMessage(from, { text: '📝 The trigger must be a single word (no spaces) — that becomes the command name.' });
      return;
    }
    if (commands.has(trigger)) {
      await sock.sendMessage(from, { text: `❌ *${trigger}* is already a built-in command — pick a different trigger.` });
      return;
    }
    addCase(sessionId, trigger, response);
    await sock.sendMessage(from, { text: `✅ Case added — ${PREFIX}${trigger} now replies with your custom message.` });
  },
});

register({
  name: 'delcase',
  aliases: ['delcases', 'removecase'],
  category: 'OWNER',
  description: 'Remove a custom command added with .addcase: .delcase <trigger>',
  async execute(ctx) {
    const { sock, from, args, sessionId, isOwner } = ctx;
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only command.' });
      return;
    }
    const trigger = (args[0] || '').trim().toLowerCase();
    if (!trigger) {
      await sock.sendMessage(from, { text: `📝 Use: ${PREFIX}delcase <trigger>` });
      return;
    }
    const removed = removeCase(sessionId, trigger);
    await sock.sendMessage(from, {
      text: removed ? `🗑️ Case *${trigger}* removed.` : `❌ No custom case named *${trigger}*.`,
    });
  },
});

register({
  name: 'listcase',
  aliases: ['cases', 'listcases'],
  category: 'OWNER',
  description: 'List every custom command added with .addcase',
  async execute(ctx) {
    const { sock, from, sessionId, isOwner } = ctx;
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only command.' });
      return;
    }
    const all = listCases(sessionId);
    const entries = Object.entries(all);
    if (!entries.length) {
      await sock.sendMessage(from, { text: `📭 No custom cases yet. Add one with ${PREFIX}addcase <trigger>|<response>` });
      return;
    }
    const text = `🗂️ *Custom cases*\n\n${entries.map(([t, r]) => `• ${PREFIX}${t} → ${r.length > 60 ? r.slice(0, 60) + '…' : r}`).join('\n')}`;
    await sock.sendMessage(from, { text });
  },
});

register({
  name: 'setgcname',
  category: 'GROUP-ADMIN',
  description: 'Change the group name',
  async execute(ctx) {
    const { sock, from, args } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;
    const name = args.join(' ');
    if (!name) {
      await sock.sendMessage(from, { text: `📝 Use: ${PREFIX}setgcname <new name>` });
      return;
    }
    try {
      await sock.groupUpdateSubject(from, name);
      await sock.sendMessage(from, { text: `✅ Group name updated to *${name}*.` });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not update the group name — is the bot an admin here?' });
    }
  },
});

register({
  name: 'setgcpic',
  category: 'GROUP-ADMIN',
  description: 'Reply to an image with this to set it as the group photo',
  async execute(ctx) {
    const { sock, from, quoted, msg } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    const target = quoted || msg;
    const imageMsg = target?.message?.imageMessage;
    if (!imageMsg) {
      await sock.sendMessage(from, { text: `📎 Reply to an image with *${PREFIX}setgcpic*` });
      return;
    }

    try {
      const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
      const stream = await downloadContentFromMessage(imageMsg, 'image');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      await sock.updateProfilePicture(from, buffer);
      await sock.sendMessage(from, { text: '✅ Group photo updated.' });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not update the group photo — is the bot an admin here?' });
    }
  },
});

register({
  name: 'groupdesc',
  aliases: ['setgcdesc', 'gcdesc'],
  category: 'GROUP-ADMIN',
  description: 'Set the group description',
  async execute(ctx) {
    const { sock, from, args } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;
    const desc = args.join(' ');
    if (!desc) {
      await sock.sendMessage(from, { text: `📝 Use: ${PREFIX}groupdesc <new description>` });
      return;
    }
    try {
      await sock.groupUpdateDescription(from, desc);
      await sock.sendMessage(from, { text: '✅ Group description updated.' });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not update the description — is the bot an admin here?' });
    }
  },
});

register({
  name: 'link',
  aliases: ['invitelink', 'grouplink'],
  category: 'GROUP-ADMIN',
  description: 'Get the group invite link',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;
    try {
      const code = await sock.groupInviteCode(from);
      await sock.sendMessage(from, { text: `🔗 https://chat.whatsapp.com/${code}` });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not fetch the invite link — is the bot an admin here?' });
    }
  },
});

register({
  name: 'revokelink',
  aliases: ['resetlink'],
  category: 'GROUP-ADMIN',
  description: 'Reset the group invite link (invalidates the old one)',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;
    try {
      const code = await sock.groupRevokeInvite(from);
      await sock.sendMessage(from, { text: `🔄 Invite link reset.\n🔗 https://chat.whatsapp.com/${code}` });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not reset the invite link — is the bot an admin here?' });
    }
  },
});

register({
  name: 'lockinfo',
  category: 'GROUP-ADMIN',
  description: 'Only admins can edit group info (name, photo, description)',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;
    try {
      await sock.groupSettingUpdate(from, 'locked');
      await sock.sendMessage(from, { text: '🔒 Group info locked — only admins can edit name/photo/description now.' });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not lock group info — is the bot an admin here?' });
    }
  },
});

register({
  name: 'unlockinfo',
  category: 'GROUP-ADMIN',
  description: 'Everyone can edit group info again',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;
    try {
      await sock.groupSettingUpdate(from, 'unlocked');
      await sock.sendMessage(from, { text: '🔓 Group info unlocked — everyone can edit name/photo/description again.' });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not unlock group info — is the bot an admin here?' });
    }
  },
});
// joke.js - Random Joke Generator
register({
  name: 'joke',
  aliases: ['jokes', 'dadjoke', 'funny', 'laugh'],
  category: 'FUN',
  description: 'Get a random joke from David Cyril API',
  async execute({ sock, from, msg, args, prefix, command }) {
    await sock.sendMessage(from, { text: `🤣 Fetching a joke for you...` });

    try {
      // ─── API ENDPOINT ───
      const apiUrl = 'https://apis.davidcyril.name.ng/api/games/joke';
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      // ─── EXTRACT JOKE ───
      let joke = '';
      let setup = '';
      let punchline = '';
      let category = '';

      // Try different response structures
      if (data.result) {
        joke = data.result.joke || data.result.text || data.result.message || data.result.response || data.result;
        setup = data.result.setup || '';
        punchline = data.result.punchline || data.result.delivery || '';
        category = data.result.category || data.result.type || '';
      } else if (data.joke) {
        joke = data.joke;
        category = data.category || '';
      } else if (data.setup && data.punchline) {
        setup = data.setup;
        punchline = data.punchline;
        joke = `${setup}\n\n${punchline}`;
        category = data.category || '';
      } else if (data.text) {
        joke = data.text;
      } else if (data.message) {
        joke = data.message;
      } else if (data.response) {
        joke = data.response;
      } else if (data.value) {
        joke = data.value;
      } else if (typeof data === 'string') {
        joke = data;
      } else {
        // Fallback: convert to string
        joke = JSON.stringify(data, null, 2);
      }

      if (!joke || joke.length < 2) {
        throw new Error('Empty response from API.');
      }

      // ─── FORMAT RESPONSE ───
      let reply = `🤣 *Random Joke*\n\n`;

      if (category) {
        reply += `📂 *Category:* ${category}\n\n`;
      }

      // Clean up joke (remove excessive newlines)
      let cleanJoke = joke
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\r/g, '')
        .trim();

      // If it's a setup/punchline format, format nicely
      if (setup && punchline) {
        cleanJoke = `📝 *${setup}*\n\n😂 ${punchline}`;
      }

      reply += cleanJoke;

      // Add footer
      reply += `\n\n💡 Want another? Use ${prefix}joke again!`;

      // ─── SEND REPLY ───
      if (reply.length > 4096) {
        const chunks = reply.match(/.{1,4000}/g) || [reply];
        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(from, { 
            text: i === 0 ? chunks[i] : `*(continued)*\n\n${chunks[i]}`
          });
        }
      } else {
        await sock.sendMessage(from, { text: reply });
      }

      console.log(`✅ Joke sent successfully`);

    } catch (error) {
      console.error('Joke API error:', error);

      // ─── FALLBACK: Try alternative joke API ───
      try {
        const fallbackUrl = 'https://official-joke-api.appspot.com/random_joke';
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          if (fallbackData.setup && fallbackData.punchline) {
            return await sock.sendMessage(from, { 
              text: `🤣 *Random Joke (Fallback)*\n\n📝 ${fallbackData.setup}\n\n😂 ${fallbackData.punchline}\n\n💡 Want another? Use ${prefix}joke again!` 
            });
          }
        }
      } catch (fallbackErr) {}

      // ─── SECOND FALLBACK: Dad Joke API ───
      try {
        const dadUrl = 'https://icanhazdadjoke.com/';
        const dadRes = await fetch(dadUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (dadRes.ok) {
          const dadData = await dadRes.json();
          if (dadData.joke) {
            return await sock.sendMessage(from, { 
              text: `🤣 *Dad Joke (Fallback)*\n\n${dadData.joke}\n\n💡 Want another? Use ${prefix}joke again!` 
            });
          }
        }
      } catch (dadErr) {}

      // ─── THIRD FALLBACK: Chuck Norris Joke ───
      try {
        const chuckUrl = 'https://api.chucknorris.io/jokes/random';
        const chuckRes = await fetch(chuckUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (chuckRes.ok) {
          const chuckData = await chuckRes.json();
          if (chuckData.value) {
            return await sock.sendMessage(from, { 
              text: `🥋 *Chuck Norris Joke (Fallback)*\n\n${chuckData.value}\n\n💡 Want another? Use ${prefix}joke again!` 
            });
          }
        }
      } catch (chuckErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ *Joke Error*\n\n${error.message || 'Could not fetch a joke.'}\n\n💡 Try again later or use:\n• ${prefix}dadjoke\n• ${prefix}chuck` 
      });
    }
  }
});
// truth.js - Random Truth Questions
register({
  name: 'truth',
  aliases: ['truths', 'truthquestion', 'asktruth'],
  category: 'FUN',
  description: 'Get a random truth question',
  async execute({ sock, from, msg, args, prefix, command }) {
    await sock.sendMessage(from, { text: `🤔 Fetching a truth question...` });

    try {
      // ─── API ENDPOINT ───
      const apiUrl = 'https://apis.davidcyril.name.ng/api/games/truth';
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      // ─── EXTRACT TRUTH ───
      let truth = '';
      let category = '';
      let difficulty = '';

      // Try different response structures
      if (data.result) {
        truth = data.result.truth || data.result.text || data.result.message || data.result.response || data.result.question || data.result;
        category = data.result.category || data.result.type || '';
        difficulty = data.result.difficulty || data.result.level || '';
      } else if (data.truth) {
        truth = data.truth;
        category = data.category || '';
        difficulty = data.difficulty || '';
      } else if (data.question) {
        truth = data.question;
        category = data.category || '';
        difficulty = data.difficulty || '';
      } else if (data.text) {
        truth = data.text;
      } else if (data.message) {
        truth = data.message;
      } else if (data.response) {
        truth = data.response;
      } else if (typeof data === 'string') {
        truth = data;
      } else {
        // Fallback: convert to string
        truth = JSON.stringify(data, null, 2);
      }

      if (!truth || truth.length < 2) {
        throw new Error('Empty response from API.');
      }

      // ─── FORMAT RESPONSE ───
      let reply = `🤔 *Truth Question*\n\n`;

      if (category) {
        reply += `📂 *Category:* ${category}\n`;
      }

      if (difficulty) {
        reply += `📊 *Difficulty:* ${difficulty}\n`;
      }

      reply += `\n📝 ${truth}`;

      reply += `\n\n💡 Use ${prefix}dare for a dare challenge!`;

      // ─── SEND REPLY ───
      if (reply.length > 4096) {
        const chunks = reply.match(/.{1,4000}/g) || [reply];
        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(from, { 
            text: i === 0 ? chunks[i] : `*(continued)*\n\n${chunks[i]}`
          });
        }
      } else {
        await sock.sendMessage(from, { text: reply });
      }

      console.log(`✅ Truth sent successfully`);

    } catch (error) {
      console.error('Truth API error:', error);

      // ─── FALLBACK: Alternative Truth API ───
      try {
        const fallbackUrl = 'https://api.truthordare.io/truth';
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          const truth = fallbackData.question || fallbackData.text || fallbackData.message || 'No truth found.';
          return await sock.sendMessage(from, { 
            text: `🤔 *Truth Question (Fallback)*\n\n📝 ${truth}\n\n💡 Use ${prefix}dare for a dare challenge!` 
          });
        }
      } catch (fallbackErr) {}

      // ─── SECOND FALLBACK: Hardcoded truths ───
      try {
        const truths = [
          "What's the most embarrassing thing you've ever done?",
          "Have you ever lied to your best friend?",
          "What's your biggest fear?",
          "Who is your celebrity crush?",
          "What's the worst date you've ever been on?",
          "Have you ever cheated on a test?",
          "What's the most illegal thing you've ever done?",
          "What's the biggest lie you've ever told?",
          "Have you ever been in love?",
          "What's the most embarrassing thing in your search history?",
          "Do you believe in ghosts?",
          "What's the most money you've ever found?",
          "Have you ever broken something expensive?",
          "What's the worst thing you've ever said to someone?",
          "Do you still have a childhood toy?",
          "What's the most awkward situation you've been in?",
          "Have you ever had a crush on a teacher?",
          "What's the most childish thing you still do?",
          "What's the worst job you've ever had?",
          "Have you ever been caught in a lie?",
          "What's the most embarrassing song on your playlist?",
          "What's the weirdest dream you've ever had?",
          "Have you ever kissed someone you didn't like?",
          "What's the most expensive thing you've broken?",
          "Do you have any secret talents?"
        ];
        const randomTruth = truths[Math.floor(Math.random() * truths.length)];
        return await sock.sendMessage(from, { 
          text: `🤔 *Truth Question (Fallback)*\n\n📝 ${randomTruth}\n\n💡 Use ${prefix}dare for a dare challenge!` 
        });
      } catch (hardErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ *Truth Error*\n\n${error.message || 'Could not fetch a truth question.'}\n\n💡 Try again later or use ${prefix}dare` 
      });
    }
  }
});
// dare.js - Random Dare Challenges
register({
  name: 'dare',
  aliases: ['dares', 'darechallenge', 'challenge'],
  category: 'FUN',
  description: 'Get a random dare challenge',
  async execute({ sock, from, msg, args, prefix, command }) {
    await sock.sendMessage(from, { text: `🔥 Fetching a dare challenge...` });

    try {
      // ─── API ENDPOINT ───
      const apiUrl = 'https://apis.davidcyril.name.ng/api/games/dare';
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      // ─── EXTRACT DARE ───
      let dare = '';
      let category = '';
      let difficulty = '';
      let points = '';

      // Try different response structures
      if (data.result) {
        dare = data.result.dare || data.result.text || data.result.message || data.result.response || data.result.challenge || data.result;
        category = data.result.category || data.result.type || '';
        difficulty = data.result.difficulty || data.result.level || '';
        points = data.result.points || data.result.score || '';
      } else if (data.dare) {
        dare = data.dare;
        category = data.category || '';
        difficulty = data.difficulty || '';
        points = data.points || '';
      } else if (data.challenge) {
        dare = data.challenge;
        category = data.category || '';
        difficulty = data.difficulty || '';
        points = data.points || '';
      } else if (data.text) {
        dare = data.text;
      } else if (data.message) {
        dare = data.message;
      } else if (data.response) {
        dare = data.response;
      } else if (typeof data === 'string') {
        dare = data;
      } else {
        // Fallback: convert to string
        dare = JSON.stringify(data, null, 2);
      }

      if (!dare || dare.length < 2) {
        throw new Error('Empty response from API.');
      }

      // ─── FORMAT RESPONSE ───
      let reply = `🔥 *Dare Challenge*\n\n`;

      if (category) {
        reply += `📂 *Category:* ${category}\n`;
      }

      if (difficulty) {
        reply += `📊 *Difficulty:* ${difficulty}\n`;
      }

      if (points) {
        reply += `⭐ *Points:* ${points}\n`;
      }

      reply += `\n📝 ${dare}`;

      reply += `\n\n💡 Use ${prefix}truth for a truth question!`;

      // ─── SEND REPLY ───
      if (reply.length > 4096) {
        const chunks = reply.match(/.{1,4000}/g) || [reply];
        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(from, { 
            text: i === 0 ? chunks[i] : `*(continued)*\n\n${chunks[i]}`
          });
        }
      } else {
        await sock.sendMessage(from, { text: reply });
      }

      console.log(`✅ Dare sent successfully`);

    } catch (error) {
      console.error('Dare API error:', error);

      // ─── FALLBACK: Alternative Dare API ───
      try {
        const fallbackUrl = 'https://api.truthordare.io/dare';
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          const dare = fallbackData.question || fallbackData.text || fallbackData.message || 'No dare found.';
          return await sock.sendMessage(from, { 
            text: `🔥 *Dare Challenge (Fallback)*\n\n📝 ${dare}\n\n💡 Use ${prefix}truth for a truth question!` 
          });
        }
      } catch (fallbackErr) {}

      // ─── SECOND FALLBACK: Hardcoded dares ───
      try {
        const dares = [
          "Do 20 push-ups right now!",
          "Sing the national anthem out loud.",
          "Speak in an accent for the next 5 minutes.",
          "Send a selfie to the last person you texted.",
          "Do your best impression of a celebrity.",
          "Tell a joke and make everyone laugh.",
          "Do a dance for 30 seconds.",
          "Recite a poem from memory.",
          "Act like a robot for 2 minutes.",
          "Do 10 jumping jacks.",
          "Send a funny meme to a friend.",
          "Speak in rhyme for the next 5 messages.",
          "Do a handstand (if you can).",
          "Make up a song about the person next to you.",
          "Do 15 squats.",
          "Talk in a British accent for 3 minutes.",
          "Send a compliment to someone you don't usually talk to.",
          "Do your best chicken dance.",
          "Name 5 things you love about yourself.",
          "Do a dramatic reading of a famous speech.",
          "Send a random meme to a group chat.",
          "Do the worm (dance move).",
          "Speak in whispers for the next 2 minutes.",
          "Tell a funny story from your childhood.",
          "Do a spinning jump and land perfectly."
        ];
        const randomDare = dares[Math.floor(Math.random() * dares.length)];
        return await sock.sendMessage(from, { 
          text: `🔥 *Dare Challenge (Fallback)*\n\n📝 ${randomDare}\n\n💡 Use ${prefix}truth for a truth question!` 
        });
      } catch (hardErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ *Dare Error*\n\n${error.message || 'Could not fetch a dare challenge.'}\n\n💡 Try again later or use ${prefix}truth` 
      });
    }
  }
});
// roast.js - Roast Generator
register({
  name: 'roast',
  aliases: ['burn', 'insult', 'roastme', 'roastuser'],
  category: 'FUN',
  description: 'Get a random roast to burn someone',
  async execute({ sock, from, msg, args, prefix, command }) {
    let target = '';

    // Check if user mentioned someone or provided a name
    if (args[0]) {
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (mentioned.length > 0) {
        target = `@${mentioned[0].split('@')[0]}`;
      } else {
        target = args.join(' ');
      }
    }

    await sock.sendMessage(from, { text: `🔥 Cooking up a roast...` });

    try {
      // ─── API ENDPOINT ───
      const apiUrl = 'https://apis.davidcyril.name.ng/api/games/roast';
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      // ─── EXTRACT ROAST ───
      let roast = '';
      let category = '';
      let rating = '';

      // Try different response structures
      if (data.result) {
        roast = data.result.roast || data.result.text || data.result.message || data.result.response || data.result.insult || data.result;
        category = data.result.category || data.result.type || '';
        rating = data.result.rating || data.result.spice || data.result.level || '';
      } else if (data.roast) {
        roast = data.roast;
        category = data.category || '';
        rating = data.rating || '';
      } else if (data.insult) {
        roast = data.insult;
        category = data.category || '';
        rating = data.rating || '';
      } else if (data.text) {
        roast = data.text;
      } else if (data.message) {
        roast = data.message;
      } else if (data.response) {
        roast = data.response;
      } else if (typeof data === 'string') {
        roast = data;
      } else {
        // Fallback: convert to string
        roast = JSON.stringify(data, null, 2);
      }

      if (!roast || roast.length < 2) {
        throw new Error('Empty response from API.');
      }

      // ─── FORMAT RESPONSE ───
      let reply = `🔥 *Roast*\n\n`;

      if (category) {
        reply += `📂 *Category:* ${category}\n`;
      }

      if (rating) {
        const spiceEmojis = {
          'mild': '🌶️',
          'medium': '🌶️🌶️',
          'spicy': '🌶️🌶️🌶️',
          'hot': '🔥',
          'extreme': '💀'
        };
        const spice = spiceEmojis[rating.toLowerCase()] || '🔥';
        reply += `📊 *Spice Level:* ${spice} ${rating}\n`;
      }

      // Add target if mentioned
      if (target) {
        reply += `🎯 *Target:* ${target}\n`;
      }

      reply += `\n💬 ${roast}`;

      // Add random reaction emoji
      const emojis = ['😭', '💀', '🔥', '😱', '😂', '🤣', '🫣', '👀'];
      reply += `\n\n${emojis[Math.floor(Math.random() * emojis.length)]} *Roasted!*`;

      reply += `\n\n💡 Want more? Use ${prefix}roast again!`;

      // ─── SEND REPLY ───
      if (reply.length > 4096) {
        const chunks = reply.match(/.{1,4000}/g) || [reply];
        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(from, { 
            text: i === 0 ? chunks[i] : `*(continued)*\n\n${chunks[i]}`
          });
        }
      } else {
        await sock.sendMessage(from, { text: reply });
      }

      console.log(`✅ Roast sent successfully`);

    } catch (error) {
      console.error('Roast API error:', error);

      // ─── FALLBACK: Alternative Roast API ───
      try {
        const fallbackUrl = 'https://api.roastmaster.com/random';
        const fallbackRes = await fetch(fallbackUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          const roast = fallbackData.roast || fallbackData.text || fallbackData.message || 'No roast found.';
          let reply = `🔥 *Roast (Fallback)*\n\n💬 ${roast}`;
          if (target) reply = `🔥 *Roast (Fallback)*\n\n🎯 *Target:* ${target}\n\n💬 ${roast}`;
          return await sock.sendMessage(from, { text: reply });
        }
      } catch (fallbackErr) {}

      // ─── SECOND FALLBACK: Hardcoded roasts ───
      try {
        const roasts = [
          "You bring everyone so much joy... when you leave the room.",
          "You're like a software update. Every time I see you, I say 'Not now.'",
          "You're proof that evolution can go in reverse.",
          "I'd explain it to you, but I left my crayons at home.",
          "You're the reason God created the middle finger.",
          "You're not stupid; you just have bad luck thinking.",
          "You're like a cloud. When you disappear, it's a beautiful day.",
          "You're the human equivalent of a participation trophy.",
          "I'd agree with you, but then we'd both be wrong.",
          "You're like a broken pencil... pointless.",
          "You're the reason they put directions on shampoo bottles.",
          "You're not a clown, you're the entire circus.",
          "If I wanted to hear from an idiot, I'd watch your TikTok.",
          "You're like a Monday. Nobody likes you.",
          "You're proof that even a broken clock is right twice a day.",
          "You're so annoying, you make mosquito bites look attractive.",
          "You're the reason the gene pool needs a lifeguard.",
          "You're like a parking ticket. Nobody wants you.",
          "You're the human version of a glitch.",
          "You're so basic, you make white bread look spicy.",
          "You're like a candle. You burn out fast and leave a mess.",
          "You're the reason they put warning labels on everything.",
          "You're like a bad WiFi signal. Weak and unreliable.",
          "You're so boring, you put people to sleep just by existing.",
          "You're the human equivalent of a loading screen."
        ];
        const randomRoast = roasts[Math.floor(Math.random() * roasts.length)];
        let reply = `🔥 *Roast (Fallback)*\n\n💬 ${randomRoast}`;
        if (target) reply = `🔥 *Roast (Fallback)*\n\n🎯 *Target:* ${target}\n\n💬 ${randomRoast}`;
        return await sock.sendMessage(from, { text: reply });
      } catch (hardErr) {}

      await sock.sendMessage(from, { 
        text: `⚠️ *Roast Error*\n\n${error.message || 'Could not fetch a roast.'}\n\n💡 Try again later or use ${prefix}joke for something less spicy.` 
      });
    }
  }
});
register({
  name: 'getpp',
  aliases: ['pp'],
  category: 'GROUP-ADMIN',
  description: "Get someone's profile picture — reply, mention, or give a number",
  async execute(ctx) {
    const { sock, from, sender } = ctx;
    const target = getTargetJid(ctx) || sender;
    try {
      const url = await sock.profilePictureUrl(target, 'image');
      await sock.sendMessage(from, {
        image: { url },
        caption: `🖼️ Profile photo of @${bareNumber(target)}`,
        mentions: [target],
      });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not fetch a profile photo (it may be private or unset).' });
    }
  },
});

register({
  name: 'setpp',
  category: 'GROUP-ADMIN',
  description: "Reply to an image to set it as the bot's own profile picture (owner only)",
  async execute({ sock, from, quoted, msg, isOwner }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    const target = quoted || msg;
    const imageMsg = target?.message?.imageMessage;
    if (!imageMsg) {
      await sock.sendMessage(from, { text: `📎 Reply to an image with *${PREFIX}setpp*` });
      return;
    }
    try {
      const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
      const stream = await downloadContentFromMessage(imageMsg, 'image');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      await sock.updateProfilePicture(sock.user.id, buffer);
      await sock.sendMessage(from, { text: '✅ Bot profile photo updated.' });
    } catch {
      await sock.sendMessage(from, { text: '❌ Could not update the profile photo.' });
    }
  },
});

register({
  name: 'setbotname',
  category: 'OWNER',
  description: 'Set a custom bot name for this session — used in the menu, alive, stickers, etc. (owner only)',
  async execute({ sock, from, args, isOwner, sessionId }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }
    const name = args.join(' ').trim();
    if (!name) {
      await sock.sendMessage(from, { text: `📝 Usage: ${PREFIX}setbotname <name>` });
      return;
    }
    setGlobalSetting(sessionId, 'botName', name);
    await sock.sendMessage(from, { text: `✅ Bot name set to *${name}*.` });
  },
});

register({
  name: 'setbotimg',
  category: 'OWNER',
  description: 'Reply to an image (or give a URL) to set the bot image used in the menu (owner only)',
  async execute({ sock, from, quoted, msg, args, isOwner, sessionId }) {
    if (!isOwner) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }

    const urlArg = (args[0] || '').trim();
    if (urlArg && /^https?:\/\//i.test(urlArg)) {
      setGlobalSetting(sessionId, 'botImage', urlArg);
      await sock.sendMessage(from, { text: '✅ Bot image updated.' });
      return;
    }

    const target = quoted || msg;
    const imageMsg = target?.message?.imageMessage;
    if (!imageMsg) {
      await sock.sendMessage(from, { text: `📎 Reply to an image, or give a URL, with *${PREFIX}setbotimg*` });
      return;
    }

    try {
      const path = require('path');
      const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
      const stream = await downloadContentFromMessage(imageMsg, 'image');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

      const dir = path.join(__dirname, '..', '..', 'data', 'bot-images');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${sessionId}.jpg`);
      await fs.promises.writeFile(filePath, buffer);

      setGlobalSetting(sessionId, 'botImage', filePath);
      await sock.sendMessage(from, { text: '✅ Bot image updated.' });
    } catch (e) {
      await sock.sendMessage(from, { text: `❌ Could not update the bot image. (${e.message})` });
    }
  },
});

function memberActionCommand({ name, action, verb, pastTense, emoji }) {
  register({
    name,
    category: 'GROUP-ADMIN',
    description: `${verb} a member — reply, mention, or give a number`,
    async execute(ctx) {
      const { sock, from } = ctx;
      if (!requireGroup(ctx)) return;
      const ok = await requireAdminOrOwner(ctx);
      if (!ok) return;

      const target = getTargetJid(ctx);
      if (!target) {
        await sock.sendMessage(from, { text: `👤 Reply to, mention, or give a number: ${PREFIX}${name} @user` });
        return;
      }

      try {
        await sock.groupParticipantsUpdate(from, [target], action);
        await sock.sendMessage(from, {
          text: `${emoji} @${bareNumber(target)} — ${pastTense}.`,
          mentions: [target],
        });
      } catch {
        await sock.sendMessage(from, { text: `❌ Could not ${verb.toLowerCase()} — is the bot an admin here?` });
      }
    },
  });
}

memberActionCommand({ name: 'promote', action: 'promote', verb: 'Promote', pastTense: 'promoted to admin', emoji: '⬆️' });
memberActionCommand({ name: 'demote', action: 'demote', verb: 'Demote', pastTense: 'demoted to member', emoji: '⬇️' });
memberActionCommand({ name: 'kick', action: 'remove', verb: 'Kick', pastTense: 'removed from the group', emoji: '👢' });

// ---------- MASS KICK COMMANDS ----------

// Returns every non-admin, non-bot participant of the group as full
// participant objects ({ id, admin, ... }) — the shared base for kickall,
// kickall2, and kicknum below.
async function getKickableParticipants(sock, from) {
  const meta = await sock.groupMetadata(from);
  const botId = sock.user?.id;
  return meta.participants.filter((p) => !p.admin && bareNumber(p.id) !== bareNumber(botId));
}

register({
  name: 'kickall',
  category: 'GROUP-ADMIN',
  description: 'Kick every non-admin member at once, in a single batch (admins are kept)',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    try {
      const targets = await getKickableParticipants(sock, from);
      if (!targets.length) {
        return sock.sendMessage(from, { text: '✅ No non-admin members to kick.' });
      }
      await sock.sendMessage(from, { text: `👢 Kicking ${targets.length} member(s)...` });
      await sock.groupParticipantsUpdate(from, targets.map((p) => p.id), 'remove');
      await sock.sendMessage(from, { text: `✅ Removed ${targets.length} non-admin member(s). Admins were kept.` });
    } catch (err) {
      await sock.sendMessage(from, { text: `❌ Could not kick everyone — is the bot an admin here? (${err.message})` });
    }
  },
});

register({
  name: 'kickall2',
  category: 'GROUP-ADMIN',
  description: 'Kick every non-admin member one by one (admins are kept)',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    try {
      const targets = await getKickableParticipants(sock, from);
      if (!targets.length) {
        return sock.sendMessage(from, { text: '✅ No non-admin members to kick.' });
      }
      await sock.sendMessage(from, { text: `👢 Kicking ${targets.length} member(s) one by one...` });
      let removed = 0;
      for (const p of targets) {
        try {
          await sock.groupParticipantsUpdate(from, [p.id], 'remove');
          removed++;
        } catch {
          // Skip a member that fails (e.g. already left) and keep going.
        }
      }
      await sock.sendMessage(from, { text: `✅ Removed ${removed}/${targets.length} member(s). Admins were kept.` });
    } catch (err) {
      await sock.sendMessage(from, { text: `❌ Could not kick everyone — is the bot an admin here? (${err.message})` });
    }
  },
});

register({
  name: 'kicknum',
  category: 'GROUP-ADMIN',
  description: 'Kick every non-admin member whose number starts with a given code — e.g. .kicknum +55',
  async execute(ctx) {
    const { sock, from, args } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    const code = (args[0] || '').replace(/[^0-9]/g, '');
    if (!code) {
      return sock.sendMessage(from, { text: `📋 Usage: ${PREFIX}kicknum <code>\nExample: ${PREFIX}kicknum +55` });
    }

    try {
      const all = await getKickableParticipants(sock, from);
      const targets = all.filter((p) => bareNumber(p.id).startsWith(code));
      if (!targets.length) {
        return sock.sendMessage(from, { text: `✅ No non-admin members found starting with +${code}.` });
      }
      await sock.sendMessage(from, { text: `👢 Kicking ${targets.length} member(s) starting with +${code}...` });
      await sock.groupParticipantsUpdate(from, targets.map((p) => p.id), 'remove');
      await sock.sendMessage(from, { text: `✅ Removed ${targets.length} member(s) starting with +${code}.` });
    } catch (err) {
      await sock.sendMessage(from, { text: `❌ Could not kick — is the bot an admin here? (${err.message})` });
    }
  },
});

// ---------- MASS PROMOTE / DEMOTE COMMANDS ----------

register({
  name: 'promoteall',
  category: 'GROUP-ADMIN',
  description: 'Promote every non-admin member to admin at once',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    try {
      const meta = await sock.groupMetadata(from);
      const botId = sock.user?.id;
      const targets = meta.participants.filter(
        (p) => !p.admin && bareNumber(p.id) !== bareNumber(botId)
      );
      if (!targets.length) {
        return sock.sendMessage(from, { text: '✅ Everyone is already an admin.' });
      }
      await sock.sendMessage(from, { text: `⬆️ Promoting ${targets.length} member(s)...` });
      await sock.groupParticipantsUpdate(from, targets.map((p) => p.id), 'promote');
      await sock.sendMessage(from, { text: `✅ Promoted ${targets.length} member(s) to admin.` });
    } catch (err) {
      await sock.sendMessage(from, { text: `❌ Could not promote everyone — is the bot an admin here? (${err.message})` });
    }
  },
});

register({
  name: 'demoteall',
  category: 'GROUP-ADMIN',
  description: 'Demote every admin except the bot owner and sudo users',
  async execute(ctx) {
    const { sock, from, sessionId } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    try {
      const meta = await sock.groupMetadata(from);
      const botId = sock.user?.id;
      // The linked account itself (owner) and any .sudoadd-ed numbers are
      // never demoted, regardless of who ran the command.
      const ownerNumber = bareNumber(botId || '');
      const sudoNumbers = new Set(listSudoUsers(sessionId));

      const targets = meta.participants.filter((p) => {
        if (!p.admin) return false; // already a regular member
        const num = bareNumber(p.id);
        if (num === ownerNumber) return false;
        if (sudoNumbers.has(num)) return false;
        return true;
      });

      if (!targets.length) {
        return sock.sendMessage(from, { text: '✅ No admins to demote (owner and sudo are kept).' });
      }
      await sock.sendMessage(from, { text: `⬇️ Demoting ${targets.length} admin(s)...` });
      await sock.groupParticipantsUpdate(from, targets.map((p) => p.id), 'demote');
      await sock.sendMessage(from, { text: `✅ Demoted ${targets.length} admin(s). Owner and sudo were kept.` });
    } catch (err) {
      await sock.sendMessage(from, { text: `❌ Could not demote everyone — is the bot an admin here? (${err.message})` });
    }
  },
});

// ---------- ACCEPTALL / REJECTALL (join requests) ----------

function joinRequestCommand({ name, action, verb, emoji }) {
  register({
    name,
    category: 'GROUP-ADMIN',
    description: `${verb} every pending join request for this group (needs "Approve new members" enabled)`,
    async execute(ctx) {
      const { sock, from } = ctx;
      if (!requireGroup(ctx)) return;
      const ok = await requireAdminOrOwner(ctx);
      if (!ok) return;

      try {
        const pending = await sock.groupRequestParticipantsList(from);
        if (!pending || !pending.length) {
          await sock.sendMessage(from, { text: '✅ No pending join requests.' });
          return;
        }
        const jids = pending.map((p) => p.jid);
        await sock.groupRequestParticipantsUpdate(from, jids, action);
        await sock.sendMessage(from, { text: `${emoji} ${verb}ed ${jids.length} join request(s).` });
      } catch (err) {
        await sock.sendMessage(from, { text: `❌ Could not ${verb.toLowerCase()} the requests — is the bot an admin here? (${err.message})` });
      }
    },
  });
}

joinRequestCommand({ name: 'acceptall', action: 'approve', verb: 'Accept', emoji: '✅' });
joinRequestCommand({ name: 'rejectall', action: 'reject', verb: 'Reject', emoji: '❌' });

// ---------- KICKADMIN ----------

register({
  name: 'kickadmin',
  category: 'GROUP-ADMIN',
  description: 'Kick every admin in the group except the bot owner and sudo users',
  async execute(ctx) {
    const { sock, from, sessionId } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;

    try {
      const meta = await sock.groupMetadata(from);
      const botId = sock.user?.id;
      // Same "who's protected" rule as .demoteall: the linked account itself
      // and any .sudoadd-ed number are never touched, no matter who ran this.
      const ownerNumber = bareNumber(botId || '');
      const sudoNumbers = new Set(listSudoUsers(sessionId));

      const targets = meta.participants.filter((p) => {
        if (!p.admin) return false; // only admins are in scope
        const num = bareNumber(p.id);
        if (num === ownerNumber) return false;
        if (sudoNumbers.has(num)) return false;
        return true;
      });

      if (!targets.length) {
        return sock.sendMessage(from, { text: '✅ No admins to kick (owner and sudo are kept).' });
      }
      await sock.sendMessage(from, { text: `👢 Kicking ${targets.length} admin(s)...` });
      await sock.groupParticipantsUpdate(from, targets.map((p) => p.id), 'remove');
      await sock.sendMessage(from, { text: `✅ Removed ${targets.length} admin(s). Owner and sudo were kept.` });
    } catch (err) {
      await sock.sendMessage(from, { text: `❌ Could not kick the admins — is the bot an admin here? (${err.message})` });
    }
  },
});

// ---------- UNLOCK ----------

register({
  name: 'unlock',
  aliases: ['open'],
  category: 'GROUP-ADMIN',
  description: 'Open the group right now — everyone can send messages again',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;
    const ok = await requireAdminOrOwner(ctx);
    if (!ok) return;
    try {
      await sock.groupSettingUpdate(from, 'not_announcement');
      await sock.sendMessage(from, { text: '🔓 Group unlocked — everyone can send messages now.' });
    } catch (err) {
      await sock.sendMessage(from, { text: `❌ Could not unlock the group — is the bot an admin here? (${err.message})` });
    }
  },
});

// ---------- OPENTIME / CLOSETIME ----------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function scheduleTimeCommand({ name, settingKey, label, emoji }) {
  register({
    name,
    category: 'GROUP-ADMIN',
    description: `Schedule the group to auto-${label} at a set time every day (24h, server time) — e.g. ${PREFIX}${name} 08:00, or ${PREFIX}${name} off`,
    async execute(ctx) {
      const { sock, from, args, sessionId } = ctx;
      if (!requireGroup(ctx)) return;
      const ok = await requireAdminOrOwner(ctx);
      if (!ok) return;

      const arg = (args[0] || '').trim().toLowerCase();
      const current = getGroupSettings(from);

      if (!arg) {
        await sock.sendMessage(from, {
          text:
            `${emoji} Auto-${label} is currently ${current[settingKey] ? `set to *${current[settingKey]}*` : '*not set*'}.\n` +
            `Use: ${PREFIX}${name} HH:MM (24h, server time) — or ${PREFIX}${name} off`,
        });
        return;
      }

      if (arg === 'off') {
        setGroupSetting(from, settingKey, null);
        await sock.sendMessage(from, { text: `${emoji} Auto-${label} schedule cleared for this group.` });
        return;
      }

      if (!TIME_RE.test(arg)) {
        await sock.sendMessage(from, { text: `📝 Give a 24h time like 08:00 or 22:30. Use: ${PREFIX}${name} HH:MM` });
        return;
      }

      setGroupSetting(from, settingKey, arg);
      // Remembers which linked account manages this group, so the scheduler
      // knows which connected session to fire groupSettingUpdate from.
      setGroupSetting(from, 'scheduleSessionId', sessionId);
      await sock.sendMessage(from, {
        text: `${emoji} This group will auto-${label} every day at *${arg}* (server time).`,
      });
    },
  });
}

scheduleTimeCommand({ name: 'opentime', settingKey: 'openTime', label: 'open', emoji: '🔓' });
scheduleTimeCommand({ name: 'closetime', settingKey: 'closeTime', label: 'close', emoji: '🔒' });

// ---------- BLOCK / UNBLOCK ----------

function blockCommand({ name, action, verb, emoji }) {
  register({
    name,
    category: 'GROUP-ADMIN',
    description: `${verb} a user's number on the bot's WhatsApp account — reply, mention, or give a number`,
    async execute(ctx) {
      const { sock, from, msg, quoted, args } = ctx;
      const ok = await requireAdminOrOwner(ctx);
      if (!ok) return;

      const target = getTargetJid({ msg, quoted, args });
      if (!target) {
        await sock.sendMessage(from, { text: `👤 Reply to, mention, or give a number: ${PREFIX}${name} @user` });
        return;
      }

      try {
        await sock.updateBlockStatus(target, action);
        await sock.sendMessage(from, { text: `${emoji} @${bareNumber(target)} — ${verb.toLowerCase()}ed.`, mentions: [target] });
      } catch (err) {
        await sock.sendMessage(from, { text: `❌ Could not ${verb.toLowerCase()} that number. (${err.message})` });
      }
    },
  });
}

blockCommand({ name: 'block', action: 'block', verb: 'Block', emoji: '🚫' });
blockCommand({ name: 'unblock', action: 'unblock', verb: 'Unblock', emoji: '✅' });

// ---------- LEFT / VCF / BROADCASTER ----------

register({
  name: 'left',
  aliases: ['leave'],
  category: 'GROUP-ADMIN',
  description: 'Make the bot leave the current group (owner only)',
  async execute(ctx) {
    const { sock, from, isOwner, msg } = ctx;
    if (!requireGroup(ctx)) return;
    if (!isOwner && !msg.key.fromMe) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }

    try {
      await sock.sendMessage(from, { text: '👋 Leaving this group...' });
      await sock.groupLeave(from);
    } catch (err) {
      await sock.sendMessage(from, { text: `❌ Could not leave the group. (${err.message})` });
    }
  },
});

register({
  name: 'vcf',
  category: 'GROUP-ADMIN',
  description: 'Export every group member as a .vcf contact file',
  async execute(ctx) {
    const { sock, from } = ctx;
    if (!requireGroup(ctx)) return;

    try {
      const meta = await sock.groupMetadata(from);
      const participants = meta.participants || [];
      if (!participants.length) {
        await sock.sendMessage(from, { text: '⚠️ No members found in this group.' });
        return;
      }

      const vcfLines = participants.map((p, i) => {
        const num = bareNumber(p.id);
        return (
          `BEGIN:VCARD\n` +
          `VERSION:3.0\n` +
          `FN:Contact ${i + 1}\n` +
          `TEL;type=CELL;type=VOICE;waid=${num}:+${num}\n` +
          `END:VCARD`
        );
      });
      const vcfContent = vcfLines.join('\n');

      await sock.sendMessage(from, {
        document: Buffer.from(vcfContent, 'utf-8'),
        mimetype: 'text/vcard',
        fileName: `${meta.subject || 'group'}.vcf`,
        caption: `📇 ${participants.length} contact(s) from *${meta.subject || 'this group'}*.`,
      });
    } catch (err) {
      await sock.sendMessage(from, { text: `❌ Could not build the .vcf file. (${err.message})` });
    }
  },
});

register({
  name: 'broadcaster',
  aliases: ['bc'],
  category: 'OWNER',
  description: 'Send a message to every group the bot is in (owner only) — give text or reply to a message',
  async execute(ctx) {
    const { sock, from, args, quoted, isOwner, msg } = ctx;
    if (!isOwner && !msg.key.fromMe) {
      await sock.sendMessage(from, { text: '❌ Owner only — link the account and send this command from it.' });
      return;
    }

    const quotedText = quoted?.message?.conversation || quoted?.message?.extendedTextMessage?.text;
    const text = args.join(' ') || quotedText;
    if (!text) {
      await sock.sendMessage(from, { text: `📢 Give text, or reply to a message, with ${PREFIX}broadcaster` });
      return;
    }

    try {
      const groups = await sock.groupFetchAllParticipating();
      const groupIds = Object.keys(groups || {});
      if (!groupIds.length) {
        await sock.sendMessage(from, { text: '⚠️ The bot is not in any groups.' });
        return;
      }

      await sock.sendMessage(from, { text: `📢 Broadcasting to ${groupIds.length} group(s)...` });
      let sent = 0;
      for (const gid of groupIds) {
        try {
          await sock.sendMessage(gid, { text: `📢 *Broadcast*\n\n${text}` });
          sent++;
        } catch {
          // Skip a group that fails (e.g. bot removed) and keep going.
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      await sock.sendMessage(from, { text: `✅ Broadcast sent to ${sent}/${groupIds.length} group(s).` });
    } catch (err) {
      await sock.sendMessage(from, { text: `❌ Broadcast failed. (${err.message})` });
    }
  },
});

module.exports = { commands, PREFIX, BOT_NAME, setAutoBio, channelContext };
