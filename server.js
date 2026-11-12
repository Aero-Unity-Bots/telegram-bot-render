const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
app.use(express.json());

// Environment Variables
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? Number(process.env.ADMIN_USER_ID) : null;
const BOTPRESS_WEBHOOK_URL = process.env.BOTPRESS_WEBHOOK_URL || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Initialize Telegram Bot & Gemini SDK
const bot = new TelegramBot(TOKEN, { polling: false });
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Set Webhook for Render
if (RENDER_EXTERNAL_URL) {
    bot.setWebHook(`${RENDER_EXTERNAL_URL}/bot${TOKEN}`);
    console.log(`Webhook active: ${RENDER_EXTERNAL_URL}/bot${TOKEN}`);
}

// Bot State & Stats
const BOT_START_TIME = Date.now();
const botStats = {
    totalMessages: 0,
    activeUsers: new Set(),
    commandsExecuted: 0
};

// Dynamic Force-Sub Channels
let fsubChannels = process.env.FORCE_SUB_CHANNEL
    ? process.env.FORCE_SUB_CHANNEL.split(',').map(ch => ch.trim())
    : [];

// --- HELPER FUNCTIONS ---

function isAdmin(userId) {
    if (!ADMIN_USER_ID) return true;
    return userId === ADMIN_USER_ID;
}

async function getUnjoinedChannels(userId) {
    if (fsubChannels.length === 0) return [];
    const unjoined = [];
    for (const channel of fsubChannels) {
        try {
            const member = await bot.getChatMember(channel, userId);
            if (!['creator', 'administrator', 'member'].includes(member.status)) {
                unjoined.push(channel);
            }
        } catch (err) {
            console.error(`FSub check failed for ${channel}:`, err.message);
        }
    }
    return unjoined;
}

// 1. Dictionary Lookup Helper
async function getWordDefinition(word) {
    try {
        const cleanWord = word.replace(/[^a-zA-Z-]/g, '').toLowerCase();
        const res = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${cleanWord}`);
        const entry = res.data[0];
        const phonetic = entry.phonetic || '';
        const meaning = entry.meanings[0];
        const definition = meaning.definitions[0].definition;
        const example = meaning.definitions[0].example;

        let reply = `📖 **${entry.word.toUpperCase()}** ${phonetic}\n`;
        reply += `*(${meaning.partOfSpeech})*\n\n`;
        reply += `**Meaning:** ${definition}`;
        if (example) reply += `\n**Example:** _"${example}"_`;
        return reply;
    } catch (error) {
        return null; // Word not found
    }
}

// 2. Botpress Webhook Query Helper
async function askBotpress(chatId, userName, text) {
    if (!BOTPRESS_WEBHOOK_URL) return null;
    try {
        const res = await axios.post(
            BOTPRESS_WEBHOOK_URL,
            { chatId: String(chatId), user: userName, text: text },
            { timeout: 8000 }
        );
        // Adapt based on your Botpress webhook response payload structure
        const reply = res.data?.reply || res.data?.text || res.data?.responses?.[0]?.text;
        if (reply && !reply.includes("don't have information")) {
            return `📚 **Knowledge Base:**\n\n${reply}`;
        }
        return null;
    } catch (error) {
        console.error('Botpress API Error:', error.message);
        return null;
    }
}

// 3. Gemini AI Query Helper
async function askGemini(text) {
    if (!ai) return null;
    
    // Try the latest model first, then fallback to stable baseline models if 503 occurs
    const modelsToTry = ['gemini-3.8-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
    
    for (const modelName of modelsToTry) {
        try {
            const response = await ai.models.generateContent({
                model: modelName,
                contents: text,
                config: {
                    systemInstruction: 'You are a helpful, concise Telegram assistant. Keep answers clear and well-formatted for mobile screens.'
                }
            });
            if (response && response.text) {
                return response.text;
            }
        } catch (error) {
            console.warn(`Model ${modelName} failed:`, error.message);
            // If it's a 503 or unavailable, loop continues to the next fallback model
            continue;
        }
    }
    
    return "⚠️ Google's AI servers are currently experiencing heavy traffic across all models. Please try your request again in a minute!";
}


// --- WEBHOOK ENDPOINT ---

app.post(`/bot${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// --- BOT COMMANDS ---

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    botStats.commandsExecuted++;
    botStats.activeUsers.add(userId);

    const unjoined = await getUnjoinedChannels(userId);
    if (unjoined.length > 0) {
        const buttons = unjoined.map(ch => [{ text: `📢 Join ${ch}`, url: `https://t.me/${ch.replace('@', '')}` }]);
        return bot.sendMessage(chatId, `⚠️ **Access Denied!**\n\nPlease join our required channel(s) first:\n• ${unjoined.join('\n• ')}`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    const welcome = `👋 **Welcome, ${msg.from.first_name || 'User'}!**\n\n` +
        `I am a **3-in-1 Smart Assistant**:\n` +
        `1. 📚 **Knowledge Base:** Answers from custom docs\n` +
        `2. ✨ **Gemini AI:** Answers any general question\n` +
        `3. 📖 **Dictionary:** Use \`/define <word>\` for meanings\n\n` +
        `Send any message to begin!`;

    await bot.sendMessage(chatId, welcome, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📢 Updates', url: 'https://t.me/Aero_Unity' }, { text: '💬 Support', url: 'https://t.me/Coders_Grp' }]
            ]
        }
    });
});

bot.onText(/\/define(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    botStats.commandsExecuted++;
    const word = match[1] ? match[1].trim() : '';

    if (!word) {
        return bot.sendMessage(chatId, `⚠️ Please provide a word.\nExample: \`/define ephemeral\``, { parse_mode: 'Markdown' });
    }

    await bot.sendChatAction(chatId, 'typing');
    const definition = await getWordDefinition(word);
    if (definition) {
        await bot.sendMessage(chatId, definition, { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, `❌ Could not find dictionary definition for **"${word}"**.`, { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/info/, async (msg) => {
    botStats.commandsExecuted++;
    const info = `ℹ️ **Bot System Status**\n\n` +
        `• **Botpress RAG:** ${BOTPRESS_WEBHOOK_URL ? '✅ Connected' : '❌ Not Set'}\n` +
        `• **Gemini AI:** ${GEMINI_API_KEY ? '✅ Connected' : '❌ Not Set'}\n` +
        `• **Dictionary API:** ✅ Active\n` +
        `• **FSub Channels:** \`${fsubChannels.length}\``;
    await bot.sendMessage(msg.chat.id, info, { parse_mode: 'Markdown' });
});

bot.onText(/\/uptime/, async (msg) => {
    botStats.commandsExecuted++;
    const ms = Date.now() - BOT_START_TIME;
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms / 3600000) % 24);
    const m = Math.floor((ms / 60000) % 60);
    await bot.sendMessage(msg.chat.id, `⏱️ **Uptime:** \`${d}d ${h}h ${m}m\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/usage/, async (msg) => {
    botStats.commandsExecuted++;
    const usage = `📊 **Commands & Usage**\n\n` +
        `• Type any question for AI / Knowledge Base\n` +
        `• \`/define <word>\` - Dictionary lookup\n` +
        `• \`/id\` - Your Telegram User & Chat ID\n` +
        `• \`/stats\` - Live bot metrics\n` +
        `• \`/fsublist\` - View required channels\n` +
        `• \`/addfsub @ch\` & \`/removefsub @ch\` - Admin FSub controls`;
    await bot.sendMessage(msg.chat.id, usage, { parse_mode: 'Markdown' });
});

bot.onText(/\/fsublist/, async (msg) => {
    botStats.commandsExecuted++;
    if (fsubChannels.length === 0) return bot.sendMessage(msg.chat.id, `📢 No Force-Sub channels active.`);
    await bot.sendMessage(msg.chat.id, `📢 **Force-Sub Channels:**\n\n${fsubChannels.map((c, i) => `${i + 1}. \`${c}\``).join('\n')}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/addfsub(?:\s+(.+))?/, async (msg, match) => {
    botStats.commandsExecuted++;
    if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, `❌ Admin only.`);
    const ch = match[1]?.trim();
    if (!ch || !ch.startsWith('@')) return bot.sendMessage(msg.chat.id, `⚠️ Usage: \`/addfsub @channel\``, { parse_mode: 'Markdown' });
    if (!fsubChannels.includes(ch)) fsubChannels.push(ch);
    await bot.sendMessage(msg.chat.id, `✅ Added \`${ch}\`.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/removefsub(?:\s+(.+))?/, async (msg, match) => {
    botStats.commandsExecuted++;
    if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, `❌ Admin only.`);
    const ch = match[1]?.trim();
    const idx = fsubChannels.indexOf(ch);
    if (idx === -1) return bot.sendMessage(msg.chat.id, `❌ Not found.`);
    fsubChannels.splice(idx, 1);
    await bot.sendMessage(msg.chat.id, `✅ Removed \`${ch}\`.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/id/, async (msg) => {
    botStats.commandsExecuted++;
    await bot.sendMessage(msg.chat.id, `👤 **User ID:** \`${msg.from.id}\`\n💬 **Chat ID:** \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, async (msg) => {
    botStats.commandsExecuted++;
    const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    await bot.sendMessage(msg.chat.id, `📈 **Stats**\n\n• Users: \`${botStats.activeUsers.size}\`\n• Messages: \`${botStats.totalMessages}\`\n• RAM: \`${mem} MB\``, { parse_mode: 'Markdown' });
});

// --- SMART MESSAGE ROUTER (DICTIONARY -> BOTPRESS -> GEMINI) ---

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim();

    botStats.totalMessages++;
    botStats.activeUsers.add(userId);

    // 1. Force-Sub Check
    const unjoined = await getUnjoinedChannels(userId);
    if (unjoined.length > 0) {
        const buttons = unjoined.map(ch => [{ text: `📢 Join ${ch}`, url: `https://t.me/${ch.replace('@', '')}` }]);
        return bot.sendMessage(chatId, `⚠️ Please join our channels first:\n• ${unjoined.join('\n• ')}`, {
            reply_markup: { inline_keyboard: buttons }
        });
    }

    await bot.sendChatAction(chatId, 'typing');

    // 2. Check if user typed "meaning of <word>"
    const meaningMatch = text.match(/^(?:meaning of|define)\s+([a-zA-Z-]+)$/i);
    if (meaningMatch) {
        const def = await getWordDefinition(meaningMatch[1]);
        if (def) return bot.sendMessage(chatId, def, { parse_mode: 'Markdown' });
    }

    // 3. Try Botpress Knowledge Base First
    const botpressReply = await askBotpress(chatId, msg.from.first_name, text);
    if (botpressReply) {
        return bot.sendMessage(chatId, botpressReply, { parse_mode: 'Markdown' });
    }

    // 4. Fallback to Gemini AI
    const geminiReply = await askGemini(text);
    if (geminiReply) {
        return bot.sendMessage(chatId, geminiReply);
    }

    // 5. Fallback if no API keys are set
    await bot.sendMessage(chatId, `⚠️ Neither Botpress nor Gemini AI is configured yet. Please add \`GEMINI_API_KEY\` or \`BOTPRESS_WEBHOOK_URL\` in Render environment variables.`, { parse_mode: 'Markdown' });
});

// Health Check Endpoint
app.get('/', (req, res) => res.status(200).send({ status: 'active', mode: 'Hybrid AI + Dictionary + Botpress' }));

app.listen(PORT, () => console.log(`Hybrid Bot running on port ${PORT}`));
