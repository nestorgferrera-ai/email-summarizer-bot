// ============================================================================
// SERVIDOR COMBINADO — Email Summarizer + Bot de Albaranes de Lavandería
// Clínica Bandama
// ============================================================================

const express = require('express');
const cron = require('node-cron');
const ImapSimple = require('imap-simple');
const { simpleParser } = require('mailparser');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ============================================================================
// CONFIGURACIÓN
// ============================================================================

function loadGoogleCredentials() {
  const secretPath = '/etc/secrets/GOOGLE_CREDENTIALS_JSON';
  if (fs.existsSync(secretPath)) {
    console.log('✅ Credenciales Google cargadas desde Secret File');
    return fs.readFileSync(secretPath, 'utf8');
  }
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    console.log('✅ Credenciales Google cargadas desde variable de entorno');
    return process.env.GOOGLE_CREDENTIALS_JSON;
  }
  console.log('⚠️  No se encontraron credenciales de Google');
  return null;
}

const EMAIL_CFG = {
  ionos_email:      process.env.IONOS_EMAIL,
  ionos_password:   process.env.IONOS_PASSWORD,
  ionos_imap_host:  process.env.IONOS_IMAP_HOST || 'imap.ionos.es',
  ionos_imap_port:  parseInt(process.env.IONOS_IMAP_PORT || '993'),
  telegram_token:   process.env.TELEGRAM_TOKEN,
  telegram_chat_id: process.env.TELEGRAM_CHAT_ID,
  claude_api_key:   process.env.CLAUDE_API_KEY,
  claude_model:     process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  app_url:          process.env.APP_URL || '',
};

const LAUNDRY_CFG = {
  telegram_token:        process.env.LAUNDRY_TELEGRAM_TOKEN || process.env.TELEGRAM_TOKEN,
  google_sheet_id:       process.env.GOOGLE_SHEET_ID,
  google_credentials:    loadGoogleCredentials(),
  app_url:               process.env.APP_URL || '',
  allowed_chat_ids:      (process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
};

// ============================================================================
// UTILIDAD: REINTENTOS
// ============================================================================
async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) throw error;
      console.log(`⚠️ Intento ${attempt} fallido, reintentando en ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
}

// ============================================================================
// EMAIL BOT — IMAP
// ============================================================================
async function connectToIonos() {
  const config = {
    imap: {
      user: EMAIL_CFG.ionos_email,
      password: EMAIL_CFG.ionos_password,
      host: EMAIL_CFG.ionos_imap_host,
      port: EMAIL_CFG.ionos_imap_port,
      tls: true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: true },
    },
  };
  const connection = await ImapSimple.connect(config);
  console.log('✅ Conectado a Ionos IMAP');
  return connection;
}

async function fetchEmails(connection, { days = null, last = 50 } = {}) {
  await connection.openBox('INBOX', false);

  let searchCriteria = ['ALL'];
  let cutoff = null;

  if (days) {
    cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const sinceDate = `${cutoff.getDate()}-${months[cutoff.getMonth()]}-${cutoff.getFullYear()}`;
    searchCriteria = [['SINCE', sinceDate]];
  }

  const fetchOptions = { bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)', struct: true };
  const allMessages = await connection.search(searchCriteria, fetchOptions);
  const messages = days ? allMessages : allMessages.slice(Math.max(0, allMessages.length - last));

  const emails = [];
  for (let msg of messages) {
    try {
      const from    = msg.headers?.from?.[0]    || 'Desconocido';
      const subject = msg.headers?.subject?.[0] || '(sin asunto)';
      const dateStr = msg.headers?.date?.[0]    || new Date().toISOString();
      let date = new Date(dateStr);
      if (isNaN(date.getTime())) date = new Date();

      let preview = '';
      try {
        const parts = ImapSimple.getParts(msg.attributes.struct);
        for (let part of parts) {
          if (part.type === 'text') {
            const partData = await connection.getPartData(msg, part);
            preview = partData.toString().substring(0, 200).replace(/\n/g, ' ');
            break;
          }
        }
      } catch { preview = '(no se pudo obtener preview)'; }

      emails.push({ from, subject, preview: preview || '(sin contenido)', date, uid: msg.attributes.uid });
    } catch (err) {
      console.log(`⚠️ Error procesando correo: ${err.message}`);
    }
  }

  const filtered = cutoff ? emails.filter(e => e.date >= cutoff) : emails;
  return filtered.sort((a, b) => b.date - a.date);
}

async function summarizeWithClaude(emails, tipo = 'diario') {
  if (!EMAIL_CFG.claude_api_key) throw new Error('CLAUDE_API_KEY no configurada');
  if (emails.length === 0) {
    return `📧 Sin correos nuevos ${tipo === 'semanal' ? 'esta semana' : 'en las últimas 24 horas'}.`;
  }

  const emailsText = emails.map((e, i) => {
    const timeStr = e.date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const dateStr = e.date.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
    return `${i + 1}. [${dateStr} ${timeStr}] De: ${e.from}\n   Asunto: ${e.subject}\n   Preview: ${e.preview}`;
  }).join('\n\n');

  const instrucciones = tipo === 'semanal'
    ? 'Resume los correos de TODA LA SEMANA. Identifica tendencias, temas recurrentes y pendientes importantes.'
    : 'Resume los correos recientes del día de hoy. Destaca lo más urgente.';

  const prompt = `Eres un asistente ejecutivo que resume correos de manera concisa y práctica para un Director Financiero de una clínica privada.

${instrucciones}

${emailsText}

Crea un resumen ejecutivo en español que:
1. Agrupe los correos por TEMA/PRIORIDAD (urgentes primero)
2. Destaque asuntos críticos: pacientes, facturación, seguros, recursos humanos
3. Sea MUY CONCISO (máximo ${tipo === 'semanal' ? '1200' : '800'} caracteres)
4. Usa emojis para mayor claridad
5. Incluye recomendaciones de acciones inmediatas si las hay

Formato:
🚨 URGENTE
• [Asunto]: Descripción breve

📊 ADMINISTRATIVO
• [Asunto]: Descripción breve

⏭️ PRÓXIMOS PASOS
- Acción 1`;

  return withRetry(async () => {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: EMAIL_CFG.claude_model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: { 'x-api-key': EMAIL_CFG.claude_api_key, 'anthropic-version': '2023-06-01' },
      timeout: 30000,
    });
    return response.data.content[0].text;
  });
}

async function sendEmailTelegram(message, chatId = null) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const fullMessage = `📋 *Resumen de correos - ${dateStr}*\n\n${message}`;

  return withRetry(async () => {
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
      chat_id: chatId || EMAIL_CFG.telegram_chat_id,
      text: fullMessage,
      parse_mode: 'Markdown',
    }, { timeout: 15000 });
    console.log('✅ Resumen de email enviado por Telegram');
  });
}

async function sendDailyEmailSummary(chatId = null) {
  console.log('\n📧 Iniciando resumen diario de correos...');
  let connection;
  try {
    connection = await withRetry(() => connectToIonos());
    const emails = await fetchEmails(connection, { last: 50 });
    const summary = await summarizeWithClaude(emails, 'diario');
    await sendEmailTelegram(summary, chatId);
    console.log('✅ Resumen diario completado');
  } catch (error) {
    console.error('❌ Error en resumen diario:', error.message);
    try { await sendEmailTelegram(`❌ Error al generar resumen:\n\`\`\`\n${error.message}\n\`\`\``, chatId); } catch {}
  } finally {
    if (connection) { try { await connection.end(); } catch {} }
  }
}

async function sendWeeklyEmailSummary() {
  console.log('\n📅 Iniciando resumen semanal de correos...');
  let connection;
  try {
    connection = await withRetry(() => connectToIonos());
    const emails = await fetchEmails(connection, { days: 7 });
    const summary = await summarizeWithClaude(emails, 'semanal');
    const now = new Date();
    const dateStr = now.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    await withRetry(async () => {
      await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
        chat_id: EMAIL_CFG.telegram_chat_id,
        text: `📅 *RESUMEN SEMANAL - ${dateStr}*\n\n${summary}`,
        parse_mode: 'Markdown',
      }, { timeout: 15000 });
    });
    console.log('✅ Resumen semanal completado');
  } catch (error) {
    console.error('❌ Error en resumen semanal:', error.message);
    try { await sendEmailTelegram(`❌ Error en resumen semanal:\n\`\`\`\n${error.message}\n\`\`\``); } catch {}
  } finally {
    if (connection) { try { await connection.end(); } catch {} }
  }
}

// ============================================================================
// LAUNDRY BOT — ARTÍCULOS Y SESIONES
// ============================================================================
const ITEMS = [
  { key: 'sabanas',          label: 'Sábanas' },
  { key: 'mantas',           label: 'Mantas' },
  { key: 'colchas',          label: 'Colchas' },
  { key: 'fundas_almohadas', label: 'Fundas Almohadas' },
  { key: 'almohadas',        label: 'Almohadas' },
  { key: 'toallas',          label: 'Toallas' },
  { key: 'toallas_pequenas', label: 'Toallas pequeñas' },
  { key: 'alfombrillas',     label: 'Alfombrillas' },
];

const STATE = { IDLE: 'idle', ASKING_RESPONSABLE: 'asking_responsable', ASKING_ITEM: 'asking_item', CONFIRMING: 'confirming' };
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { state: STATE.IDLE, step: 0, responsable: null, data: {} });
  return sessions.get(chatId);
}
function resetSession(chatId) {
  sessions.set(chatId, { state: STATE.IDLE, step: 0, responsable: null, data: {} });
}

async function laundryMsg(chatId, text, extra = {}) {
  try {
    await axios.post(`https://api.telegram.org/bot${LAUNDRY_CFG.telegram_token}/sendMessage`, {
      chat_id: chatId, text, parse_mode: 'Markdown', ...extra,
    }, { timeout: 10000 });
  } catch (err) {
    console.error('❌ Error enviando mensaje lavandería:', err.message);
  }
}

async function appendToSheet(responsable, data) {
  if (!LAUNDRY_CFG.google_sheet_id || !LAUNDRY_CFG.google_credentials) {
    console.log('⚠️  Google Sheets no configurado');
    return false;
  }
  try {
    const credentials = JSON.parse(LAUNDRY_CFG.google_credentials);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });

    const now = new Date();
    const marcaTemporal = now.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = now.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const row = [
      marcaTemporal, dateStr, timeStr,
      data.sabanas || 0, data.mantas || 0, data.colchas || 0,
      data.fundas_almohadas || 0, data.almohadas || 0,
      data.toallas || 0, data.toallas_pequenas || 0, data.alfombrillas || 0,
      'Telegram Bot', responsable,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: LAUNDRY_CFG.google_sheet_id,
      range: 'Respuestas de formulario 1!A:M',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });

    console.log(`✅ Albarán guardado — ${responsable} ${dateStr} ${timeStr}`);
    return true;
  } catch (err) {
    console.error('❌ Error guardando en Google Sheets:', err.message);
    return false;
  }
}

function buildSummary(responsable, data) {
  const lines = ITEMS.map(item => `  • ${item.label}: *${data[item.key] || 0}*`);
  return `📋 *Resumen del albarán*\n\n👤 Responsable: *${responsable}*\n\n${lines.join('\n')}\n\n¿Confirmas la entrega?`;
}

async function handleLaundryMessage(chatId, text, fromName) {
  if (LAUNDRY_CFG.allowed_chat_ids.length > 0 && !LAUNDRY_CFG.allowed_chat_ids.includes(String(chatId))) {
    await laundryMsg(chatId, '⛔ No tienes acceso a este bot. Contacta con el administrador.');
    return;
  }

  const session = getSession(chatId);
  const t = text.trim();

  if (t === '/start' || t === '/inicio') {
    resetSession(chatId);
    await laundryMsg(chatId,
      `👕 *Bot de Albaranes de Lavandería*\n\nHola ${fromName}! Aquí puedes registrar las entregas de ropa de Selava.\n\n` +
      `/nuevo — Registrar nueva entrega\n/cancelar — Cancelar registro\n/ayuda — Ver ayuda`);
    return;
  }
  if (t === '/ayuda' || t === '/help') {
    await laundryMsg(chatId,
      `📖 *Ayuda — Bot de Lavandería*\n\n/nuevo — Registrar nueva entrega de Selava\n/cancelar — Cancelar el registro en curso\n/ayuda — Ver esta ayuda\n\nEscribe *0* si no hay ningún artículo de ese tipo.`);
    return;
  }
  if (t === '/cancelar' || t === '/cancel') {
    resetSession(chatId);
    await laundryMsg(chatId, '❌ Registro cancelado. Escribe /nuevo para empezar de nuevo.');
    return;
  }
  if (t === '/nuevo') {
    resetSession(chatId);
    const s = getSession(chatId);
    s.state = STATE.ASKING_RESPONSABLE;
    await laundryMsg(chatId, '👤 ¿Cuál es tu nombre? (Responsable de la entrega)');
    return;
  }

  if (session.state === STATE.ASKING_RESPONSABLE) {
    if (!t || t.length < 2) { await laundryMsg(chatId, '⚠️ Por favor introduce un nombre válido.'); return; }
    session.responsable = t;
    session.state = STATE.ASKING_ITEM;
    session.step = 0;
    await laundryMsg(chatId,
      `✅ Hola *${t}*!\n\nVamos a registrar la entrega. Escribe *0* si no hay ninguno.\n\n*${ITEMS[0].label}* — ¿Cuántas unidades?`);
    return;
  }

  if (session.state === STATE.ASKING_ITEM) {
    const qty = parseInt(t, 10);
    if (isNaN(qty) || qty < 0) {
      await laundryMsg(chatId, `⚠️ Introduce un número válido (o *0*).\n\n*${ITEMS[session.step].label}* — ¿Cuántas unidades?`);
      return;
    }
    session.data[ITEMS[session.step].key] = qty;
    session.step++;
    if (session.step < ITEMS.length) {
      await laundryMsg(chatId, `*${ITEMS[session.step].label}* — ¿Cuántas unidades?`);
    } else {
      session.state = STATE.CONFIRMING;
      await laundryMsg(chatId, buildSummary(session.responsable, session.data), {
        reply_markup: { inline_keyboard: [[{ text: '✅ Confirmar', callback_data: 'confirm' }, { text: '❌ Cancelar', callback_data: 'cancel' }]] },
      });
    }
    return;
  }

  if (session.state === STATE.CONFIRMING) {
    await laundryMsg(chatId, 'Por favor usa los botones de arriba para confirmar o cancelar.');
    return;
  }

  await laundryMsg(chatId, 'Escribe /nuevo para registrar una entrega.\nO /ayuda para ver los comandos.');
}

async function handleLaundryCallback(chatId, callbackData, queryId) {
  await axios.post(`https://api.telegram.org/bot${LAUNDRY_CFG.telegram_token}/answerCallbackQuery`,
    { callback_query_id: queryId }, { timeout: 5000 }).catch(() => {});

  const session = getSession(chatId);
  if (session.state !== STATE.CONFIRMING) {
    await laundryMsg(chatId, 'No hay ningún albarán pendiente. Usa /nuevo para empezar.');
    return;
  }
  if (callbackData === 'cancel') {
    resetSession(chatId);
    await laundryMsg(chatId, '❌ Albarán cancelado. Usa /nuevo para empezar de nuevo.');
    return;
  }
  if (callbackData === 'confirm') {
    await laundryMsg(chatId, '⏳ Guardando albarán...');
    const saved = await appendToSheet(session.responsable, session.data);
    const { responsable, data } = session;
    resetSession(chatId);

    const now = new Date();
    const dateStr = now.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const total = ITEMS.reduce((sum, item) => sum + (data[item.key] || 0), 0);

    await laundryMsg(chatId,
      `${saved ? '✅' : '⚠️'} *Albarán ${saved ? 'registrado correctamente' : 'registrado (sin Google Sheets)'}*\n\n` +
      `📅 ${dateStr} a las ${timeStr}\n👤 ${responsable}\n📦 Total: *${total} unidades*\n\n` +
      `${saved ? '_Guardado en Google Sheets._' : '_⚠️ No se pudo guardar en Sheets. Avisa al administrador._'}\n\nUsa /nuevo para registrar otra entrega.`
    );
  }
}

// ============================================================================
// WEBHOOKS DE TELEGRAM
// ============================================================================
async function registerWebhooks() {
  if (!EMAIL_CFG.app_url) { console.log('⚠️  APP_URL no configurada'); return; }

  // Webhook del bot de email
  try {
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/setWebhook`,
      { url: `${EMAIL_CFG.app_url}/email-webhook`, allowed_updates: ['message'] }, { timeout: 10000 });
    console.log(`✅ Webhook email: ${EMAIL_CFG.app_url}/email-webhook`);
  } catch (err) { console.error('❌ Error webhook email:', err.message); }

  // Webhook del bot de lavandería
  try {
    await axios.post(`https://api.telegram.org/bot${LAUNDRY_CFG.telegram_token}/setWebhook`,
      { url: `${EMAIL_CFG.app_url}/laundry-webhook`, allowed_updates: ['message', 'callback_query'] }, { timeout: 10000 });
    console.log(`✅ Webhook lavandería: ${EMAIL_CFG.app_url}/laundry-webhook`);
  } catch (err) { console.error('❌ Error webhook lavandería:', err.message); }
}

// ============================================================================
// CRON — Resúmenes automáticos de email
// ============================================================================
cron.schedule('0 15 * * *', () => {
  console.log('⏰ Ejecutando resumen diario...');
  sendDailyEmailSummary();
});
cron.schedule('0 16 * * 1', () => {
  console.log('⏰ Ejecutando resumen semanal...');
  sendWeeklyEmailSummary();
});
console.log('✅ Cron diario: 15:00 UTC (07:00 Canarias)');
console.log('✅ Cron semanal: lunes 16:00 UTC (08:00 Canarias)');

// ============================================================================
// RUTAS EXPRESS
// ============================================================================
app.get('/', (req, res) => res.json({
  status: 'online',
  services: ['Email Summarizer', 'Laundry Bot — Albaranes Selava'],
  schedule: '07:00 diario / 08:00 lunes (Canarias)',
  timestamp: new Date(),
}));

// Webhook bot de email
app.post('/email-webhook', async (req, res) => {
  res.sendStatus(200);
  const message = req.body?.message;
  if (!message) return;
  const text = (message.text || '').trim();
  const chatId = message.chat.id.toString();
  if (chatId !== EMAIL_CFG.telegram_chat_id) return;

  if (text === '/resumen') {
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`,
      { chat_id: chatId, text: '⏳ Generando resumen, un momento...' }).catch(() => {});
    await sendDailyEmailSummary(chatId);
  } else if (text === '/semanal') {
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`,
      { chat_id: chatId, text: '⏳ Generando resumen semanal...' }).catch(() => {});
    await sendWeeklyEmailSummary();
  } else if (text === '/ayuda') {
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
      chat_id: chatId,
      text: '📋 *Comandos:*\n\n/resumen — Últimos correos\n/semanal — Últimos 7 días\n/ayuda — Esta ayuda',
      parse_mode: 'Markdown',
    }).catch(() => {});
  }
});

// Webhook bot de lavandería
app.post('/laundry-webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (update.message) {
    const { chat, text, from } = update.message;
    await handleLaundryMessage(chat.id, text || '', from?.first_name || from?.username || 'Usuario');
  }
  if (update.callback_query) {
    const cb = update.callback_query;
    await handleLaundryCallback(cb.message.chat.id, cb.data, cb.id);
  }
});

// Triggers manuales
app.post('/trigger', async (req, res) => {
  try { await sendDailyEmailSummary(); res.json({ status: 'ok', message: 'Resumen email enviado' }); }
  catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

app.get('/status', (req, res) => res.json({
  services: { email_bot: 'activo', laundry_bot: 'activo' },
  config: { schedule: '07:00 Canarias diario', model: EMAIL_CFG.claude_model },
  timestamp: new Date(),
}));

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================
app.listen(PORT, async () => {
  console.log(`\n🎯 Servidor combinado en puerto ${PORT}`);
  console.log('   📧 Email Summarizer Bot');
  console.log('   🧺 Laundry Bot — Albaranes Selava\n');
  await registerWebhooks();
});

process.on('unhandledRejection', (reason) => console.error('❌ Promesa rechazada:', reason));
process.on('uncaughtException', (error) => console.error('❌ Excepción no capturada:', error));
