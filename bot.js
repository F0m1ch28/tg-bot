require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const { Client } = require('pg');
const express = require('express');
const bodyParser = require('body-parser');

const client = new Client({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    query_timeout: 120000
});

client.connect()
    .then(() => console.log('Connected to PostgreSQL'))
    .catch(err => console.error('Connection error', err.stack));

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PAGE_SIZE = 10;
const FEEDBACK_INTERVAL_HOURS = 24;

const app = express();
app.use(bodyParser.json());

const HOST_URL = 'https://tg-bot-k259.onrender.com';
bot.telegram.setWebhook(`${HOST_URL}/webhook/${process.env.BOT_TOKEN}`);
app.post(`/webhook/${process.env.BOT_TOKEN}`, (req, res) => {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
});

bot.use(session());

function notifyAdmin(message) {
    bot.telegram.sendMessage(ADMIN_CHAT_ID, message);
}

function saveFeedback(type, text, userId, contact = null) {
    console.log(`Saving feedback: Type=${type}, Text=${text}, UserId=${userId}, Contact=${contact}`);
    client.query(
        'INSERT INTO feedbacks (feedback_type, feedback_text, contact_info, user_id, created_at) VALUES ($1, $2, $3, $4, NOW())',
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

async function canSubmitFeedback(userId) {
    const query = 'SELECT created_at FROM feedbacks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1';
    const res = await client.query(query, [userId]);
    if (res.rows.length > 0) {
        const lastFeedbackTime = new Date(res.rows[0].created_at);
        const now = new Date();
        const hoursSinceLastFeedback = (now - lastFeedbackTime) / (1000 * 60 * 60);
        console.log(`Last feedback: ${lastFeedbackTime}, Hours since last feedback: ${hoursSinceLastFeedback}`);
        return hoursSinceLastFeedback >= FEEDBACK_INTERVAL_HOURS;
    }
    return true;
}

async function showFeedbacks(ctx, page = 1, filterType = '', filterStartDate = null, filterEndDate = null) {
    const offset = (page - 1) * PAGE_SIZE;

    let query = 'SELECT * FROM feedbacks WHERE 1=1';
    let queryParams = [];
    let paramIndex = 1;

    if (filterType) {
        query += ` AND feedback_type = $${paramIndex++}`;
        queryParams.push(filterType);
    }

    if (filterStartDate) {
        query += ` AND created_at >= $${paramIndex++}`;
        queryParams.push(new Date(filterStartDate).toISOString());
    }

    if (filterEndDate) {
        query += ` AND created_at <= $${paramIndex++}`;
        queryParams.push(new Date(filterEndDate).toISOString());
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    queryParams.push(PAGE_SIZE, offset);

    try {
        console.log(`Executing query: ${query}`);
        console.log(`With parameters: ${queryParams}`);

        const res = await client.query(query, queryParams);
        const feedbacks = res.rows.map(fb =>
            `ID: ${fb.id}\nТип: ${fb.feedback_type}\nОтзыв: ${fb.feedback_text}\nКонтакт: ${fb.contact_info || 'Не указан'}\nДата: ${fb.created_at}`
        ).join('\n\n');

        const totalFeedbacks = await client.query(
            'SELECT COUNT(*) FROM feedbacks WHERE 1=1' +
            (filterType ? ` AND feedback_type = '${filterType}'` : '') +
            (filterStartDate ? ` AND created_at >= '${new Date(filterStartDate).toISOString()}'` : '') +
            (filterEndDate ? ` AND created_at <= '${new Date(filterEndDate).toISOString()}'` : '')
        );

        const total = parseInt(totalFeedbacks.rows[0].count);
        const totalPages = Math.ceil(total / PAGE_SIZE);

        ctx.reply(
            feedbacks || 'Нет отзывов.',
            Markup.inlineKeyboard([
                Markup.button.callback('Предыдущая', `prev_${page}`),
                Markup.button.callback('Следующая', `next_${page}`),
                Markup.button.callback(`Страница ${page} из ${totalPages}`, `page_${page}`)
            ])
        );
    } catch (err) {
        console.error('Error executing query:', err.stack);
        ctx.reply('Ошибка получения отзывов из базы данных.');
    }
}

bot.start((ctx) => {
    ctx.reply(
        'Здравствуйте! Я бот сети суши-баров «Вкус и Лосось» для обратной связи. Нажмите «/start», чтобы оставить обратную связь',
        Markup.inlineKeyboard([
            Markup.button.callback('Да', 'positive'),
            Markup.button.callback('Нет', 'negative')
        ])
    );
});

bot.command('show_feedbacks', async (ctx) => {
    if (ctx.from.id.toString() === ADMIN_CHAT_ID) {
        const args = ctx.message.text.split(' ');
        const page = parseInt(args[1]) || 1;

        await showFeedbacks(ctx, page);
    } else {
        ctx.reply('У вас нет доступа к этой команде.');
    }
});

bot.action(/prev_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    if (page > 1) {
        await showFeedbacks(ctx, page - 1);
    } else {
        ctx.answerCbQuery('Это первая страница.');
    }
});

bot.action(/next_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    await showFeedbacks(ctx, page + 1);
});

bot.action(/page_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    await showFeedbacks(ctx, page);
});

bot.action('positive', async (ctx) => {
    if (await canSubmitFeedback(ctx.from.id)) {
        ctx.reply('Опишите Вашу проблему. Также, просим Вас оставить номер, дату, время заказа и ваш контактный номер телефона, через который мы сможем с Вами связаться для решения вашей проблемы');
        ctx.session = ctx.session || {};
        ctx.session.feedbackType = 'positive';
    } else {
        ctx.reply('Вы уже оставляли отзыв недавно. Пожалуйста, попробуйте снова через 24 часа.');
    }
});

bot.action('negative', async (ctx) => {
    if (await canSubmitFeedback(ctx.from.id)) {
        ctx.reply('Опишите Вашу проблему. Также, просим Вас оставить номер, дату, время заказа и ваш контактный номер телефона, через который мы сможем с Вами связаться для решения вашей проблемы');
        ctx.session = ctx.session || {};
        ctx.session.feedbackType = 'negative';
    } else {
        ctx.reply('Вы уже оставляли отзыв недавно. Пожалуйста, попробуйте снова через 24 часа.');
    }
});

bot.on('text', async (ctx) => {
    ctx.session = ctx.session || {};
    const feedbackType = ctx.session.feedbackType;

    if (feedbackType) {
        const feedback = ctx.message.text;

        if (feedbackType === 'positive') {
            ctx.reply('Благодарим за обратную связь. Ваш ответ был направлен менеджеру. Мы постараемся связаться с Вами в ближайшее время!');
            saveFeedback('positive', feedback, ctx.from.id);
            notifyAdmin(`Получен положительный отзыв\n\nОтзыв: ${feedback}`);
        } else if (feedbackType === 'negative') {
            ctx.reply('Благодарим за обратную связь. Ваш ответ был направлен менеджеру. Мы постараемся связаться с Вами в ближайшее время!');
            saveFeedback('negative', feedback, ctx.from.id);
            notifyAdmin(`Получен отрицательный отзыв\n\nОтзыв: ${feedback}`);
        }

        delete ctx.session.feedbackType;
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});