const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? Number(process.env.ADMIN_USER_ID) : null;

// Initialize Telegram Bot in Webhook Mode
const bot = new TelegramBot(TOKEN, { polling: false });

// Set Webhook for Render deployment
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
    bot.setWebHook(`${RENDER_EXTERNAL_URL}/bot${TOKEN}`);
    console.log(`Webhook set to: ${RENDER_EXTERNAL_URL}/bot${TOKEN}`);
}

// Track Bot Start Time & Statistics
const BOT_START_TIME = Date.now();
const botStats = {
    totalMessages: 0,
    activeUsers: new Set(),
    commandsExecuted: 0
};

// Dynamic Force-Subscription channels list
let fsubChannels = process.env.FORCE_SUB_CHANNEL 
    ? process.env.FORCE_SUB_CHANNEL.split(',').map(ch => ch.trim()) 
    : [];

// Helper: Check unjoined force-sub channels
async function getUnjoinedChannels(userId) {
    if (fsubChannels.length === 0) return [];
    const unjoined = [];
    for (const channel of fsubChannels) {
        try {
            const chatMember = await bot.getChatMember(channel, userId);
            const isMember = ['creator', 'administrator', 'member'].includes(chatMember.status);
            if (!isMember) unjoined.push(channel);
        } catch (error) {
            console.error(`Error checking membership for ${channel}:`, error.message);
        }
    }
    return unjoined;
}

// Handle Incoming Telegram Webhooks
app.post(`/bot${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Admin Authentication Helper
function isAdmin(userId) {
    if (!ADMIN_USER_ID) return true;
    return userId === ADMIN_USER_ID;
}

// --- COMMAND HANDLERS ---

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'User';

    botStats.commandsExecuted++;
    botStats.activeUsers.add(userId);

    const unjoined = await getUnjoinedChannels(userId);
    if (unjoined.length > 0) {
        const joinButtons = unjoined.map(ch => [{ text: `📢 Join ${ch}`, url: `https://t.me/${ch.replace('@', '')}` }]);
        joinButtons.push([{ text: '🔄 I Have Joined (Try Again)', callback_data: 'btn_start_retry' }]);

        await bot.sendMessage(
            chatId,
            `⚠️ **Access Denied!**\n\nYou must join our required channel(s) below to use this bot:\n\n• ${unjoined.join('\n• ')}`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: joinButtons } }
        );
        return;
    }

    await bot.sendMessage(chatId, `👋 **Welcome, ${firstName}!**\n\nI am your AI Knowledge Base Assistant. Send any query to search documentation.`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📢 Updates', url: 'https://t.me/Aero_Unity' }, { text: '💬 Support Group', url: 'https://t.me/Coders_Grp' }]
            ]
        }
    });
});

bot.onText(/\/info/, async (msg) => {
    botStats.commandsExecuted++;
    await bot.sendMessage(msg.chat.id, `ℹ️ **Bot Information**\n\n• Status: Active (Render)\n• Active FSub Channels: \`${fsubChannels.length}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/uptime/, async (msg) => {
    botStats.commandsExecuted++;
    const uptimeMs = Date.now() - BOT_START_TIME;
    const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptimeMs / (1000 * 60 * 60)) % 24);
    const mins = Math.floor((uptimeMs / (1000 * 60)) % 60);
    await bot.sendMessage(msg.chat.id, `⏱️ **Bot Uptime:** \`${days}d ${hours}h ${mins}m\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/usage/, async (msg) => {
    botStats.commandsExecuted++;
    await bot.sendMessage(msg.chat.id, `📊 **Usage Guide**\n\n• Send any query for KB search.\n• /id - View user ID\n• /stats - Live stats\n• /fsublist - List fsub channels\n• /addfsub & /removefsub - Manage channels (Admin)`, { parse_mode: 'Markdown' });
});

bot.onText(/\/fsublist/, async (msg) => {
    botStats.commandsExecuted++;
    if (fsubChannels.length === 0) {
        await bot.sendMessage(msg.chat.id, `📢 No active Force-Sub channels.`);
        return;
    }
    await bot.sendMessage(msg.chat.id, `📢 **Force-Sub Channels:**\n\n${fsubChannels.map((ch, i) => `${i + 1}. \`${ch}\``).join('\n')}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/addfsub(?:\s+(.+))?/, async (msg, match) => {
    botStats.commandsExecuted++;
    if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, `❌ Unauthorized.`);
    const channel = match[1] ? match[1].trim() : '';
    if (!channel || !channel.startsWith('@')) return bot.sendMessage(msg.chat.id, `⚠️ Usage: \`/addfsub @channel\``, { parse_mode: 'Markdown' });
    if (fsubChannels.includes(channel)) return bot.sendMessage(msg.chat.id, `⚠️ Already exists.`);
    fsubChannels.push(channel);
    await bot.sendMessage(msg.chat.id, `✅ Added \`${channel}\`.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/removefsub(?:\s+(.+))?/, async (msg, match) => {
    botStats.commandsExecuted++;
    if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, `❌ Unauthorized.`);
    const channel = match[1] ? match[1].trim() : '';
    const index = fsubChannels.indexOf(channel);
    if (index === -1) return bot.sendMessage(msg.chat.id, `❌ Channel not found.`);
    fsubChannels.splice(index, 1);
    await bot.sendMessage(msg.chat.id, `✅ Removed \`${channel}\`.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/id/, async (msg) => {
    botStats.commandsExecuted++;
    await bot.sendMessage(msg.chat.id, `👤 **Your ID:** \`${msg.from.id}\`\n**Chat ID:** \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, async (msg) => {
    botStats.commandsExecuted++;
    const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    await bot.sendMessage(msg.chat.id, `📈 **Stats**\n\n• Users: \`${botStats.activeUsers.size}\`\n• Messages: \`${botStats.totalMessages}\`\n• Memory: \`${mem} MB\``, { parse_mode: 'Markdown' });
});

// Default Text Message Handler
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    botStats.totalMessages++;
    botStats.activeUsers.add(msg.from.id);

    const unjoined = await getUnjoinedChannels(msg.from.id);
    if (unjoined.length > 0) {
        await bot.sendMessage(msg.chat.id, `⚠️ Please join our channels first:\n• ${unjoined.join('\n• ')}`);
        return;
    }

    await bot.sendMessage(msg.chat.id, `🔍 Processing: "${msg.text}"...`);
});

// Health Check Route for Render
app.get('/', (req, res) => res.status(200).send({ status: 'active' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
