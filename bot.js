require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const { Client } = require('pg');
const express = require('express');
const bodyParser = require('body-parser');

const ssl = { rejectUnauthorized: false };

const client = new Client({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: ssl,
    connectionTimeoutMillis: 10000,
    query_timeout: 120000
});

client.connect()
    .then(() => console.log('Connected to PostgreSQL'))
    .catch(err => console.error('Connection error', err.stack));

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const app = express();
app.use(bodyParser.json());

async function startBot() {
    await bot.telegram.deleteWebhook();
    console.log('Webhook deleted. Switching to polling mode.');
    bot.startPolling();
}

startBot();

bot.use(session());

function notifyAdmin(message) {
    bot.telegram.sendMessage(ADMIN_CHAT_ID, message);
}

function saveFeedback(type, text, userId, contact = null) {
    console.log(`Saving feedback: Type=${type}, Text=${text}, UserId=${userId}, Contact=${contact}`);
    client.query(
        'INSERT INTO feedback (feedback_type, feedback_text, contact_info, user_id, created_at) VALUES ($1, $2, $3, $4, NOW())',
        [type, text, contact, userId],
        (err) => {
            if (err) {
                console.error('Error saving to database:', err.stack);
            } else {
                console.log('Feedback saved to database');
            }
        }
    );
}

bot.on('text', async (ctx) => {
    ctx.session = ctx.session || {};
    const feedback = ctx.message.text;

    if (ctx.session.feedbackExpected) {
        ctx.reply('Благодарим за обратную связь. Ваш ответ был направлен менеджеру. Мы постараемся связаться с Вами в ближайшее время!');
        saveFeedback('feedback', feedback, ctx.from.id);
        notifyAdmin(`Получен отзыв от пользователя ID ${ctx.from.id}\n\nОтзыв: ${feedback}`);
        delete ctx.session.feedbackExpected;
    } else {
        ctx.reply('Нажмите /start для отправки отзыва.');
    }
});

bot.start((ctx) => {
    ctx.reply('Здравствуйте! Я бот сети суши-баров «Вкус и Лосось» для обратной связи. Нажмите «/start», чтобы оставить обратную связь');
});

bot.command('start', async (ctx) => {
    ctx.session = ctx.session || {};
    ctx.session.feedbackExpected = true;
    ctx.reply('Опишите Вашу проблему. Также, просим Вас оставить номер, дату, время заказа и ваш контактный номер телефона, через который мы сможем с Вами связаться для решения вашей проблемы.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
