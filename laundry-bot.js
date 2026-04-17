// ============================================================================
// TELEGRAM LAUNDRY BOT - Bot de albaranes de lavandería
// Registra entregas de ropa y guarda en Google Sheets
// Clínica Bandama
// ============================================================================

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// ============================================================================
// CONFIGURACIÓN
// ============================================================================

// Leer credenciales Google: primero desde Secret File, luego desde variable de entorno
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

const CONFIG = {
  telegram_token: process.env.LAUNDRY_TELEGRAM_TOKEN || process.env.TELEGRAM_TOKEN,
  google_sheet_id: process.env.GOOGLE_SHEET_ID,
  google_credentials_json: loadGoogleCredentials(),
  app_url: process.env.APP_URL || '',
  allowed_chat_ids: (process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
};

// ============================================================================
// ARTÍCULOS DEL ALBARÁN
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

// ============================================================================
// ESTADO DE SESIONES (en memoria)
// { chatId: { state, step, responsable, data: {key: cantidad, ...} } }
// ============================================================================
const sessions = new Map();

const STATE = {
  IDLE:               'idle',
  ASKING_RESPONSABLE: 'asking_responsable',
  ASKING_ITEM:        'asking_item',
  CONFIRMING:         'confirming',
};

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { state: STATE.IDLE, step: 0, responsable: null, data: {} });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, { state: STATE.IDLE, step: 0, responsable: null, data: {} });
}

// ============================================================================
// TELEGRAM: ENVIAR MENSAJE
// ============================================================================
async function sendMessage(chatId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${CONFIG.telegram_token}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...extra,
    }, { timeout: 10000 });
  } catch (err) {
    console.error('❌ Error enviando mensaje Telegram:', err.message);
  }
}

// ============================================================================
// TELEGRAM: REGISTRAR WEBHOOK
// ============================================================================
async function registerWebhook() {
  if (!CONFIG.app_url) {
    console.log('⚠️  APP_URL no configurada — el bot usará polling manual');
    return;
  }
  const webhookUrl = `${CONFIG.app_url}/webhook`;
  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.telegram_token}/setWebhook`,
      { url: webhookUrl, allowed_updates: ['message', 'callback_query'] },
      { timeout: 10000 }
    );
    console.log(`✅ Webhook registrado: ${webhookUrl}`);
  } catch (err) {
    console.error('❌ Error registrando webhook:', err.message);
  }
}

// ============================================================================
// GOOGLE SHEETS: GUARDAR FILA
// ============================================================================
async function appendToSheet(responsable, data) {
  if (!CONFIG.google_sheet_id || !CONFIG.google_credentials_json) {
    console.log('⚠️  Google Sheets no configurado — guardando solo en consola');
    return false;
  }

  try {
    const credentials = JSON.parse(CONFIG.google_credentials_json);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    const now = new Date();
    const dateStr = now.toLocaleDateString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
    const timeStr = now.toLocaleTimeString('es-ES', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    const row = [
      dateStr,
      timeStr,
      data.sabanas          || 0,
      data.mantas           || 0,
      data.colchas          || 0,
      data.fundas_almohadas || 0,
      data.almohadas        || 0,
      data.toallas          || 0,
      data.toallas_pequenas || 0,
      data.alfombrillas     || 0,
      responsable,
      'Telegram Bot',
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.google_sheet_id,
      range: 'Albarán!A:L',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });

    console.log(`✅ Albarán guardado en Google Sheets — ${responsable} ${dateStr} ${timeStr}`);
    return true;
  } catch (err) {
    console.error('❌ Error guardando en Google Sheets:', err.message);
    return false;
  }
}

// ============================================================================
// LÓGICA DE CONVERSACIÓN
// ============================================================================

function buildSummaryText(responsable, data) {
  const lines = ITEMS.map(item => {
    const qty = data[item.key] || 0;
    return `  • ${item.label}: *${qty}*`;
  });
  return `📋 *Resumen del albarán*\n\n👤 Responsable: *${responsable}*\n\n${lines.join('\n')}\n\n¿Confirmas la entrega?`;
}

async function handleMessage(chatId, text, fromName) {
  // Verificar acceso
  if (CONFIG.allowed_chat_ids.length > 0 && !CONFIG.allowed_chat_ids.includes(String(chatId))) {
    await sendMessage(chatId, '⛔ No tienes acceso a este bot. Contacta con el administrador.');
    return;
  }

  const session = getSession(chatId);
  const textTrim = text.trim();

  // Comandos globales (siempre disponibles)
  if (textTrim === '/start' || textTrim === '/inicio') {
    resetSession(chatId);
    await sendMessage(chatId,
      `👕 *Bot de Albaranes de Lavandería*\n\nHola ${fromName}! Aquí puedes registrar las entregas de ropa de Selava.\n\n` +
      `*Comandos disponibles:*\n` +
      `/nuevo — Registrar nueva entrega\n` +
      `/cancelar — Cancelar registro en curso\n` +
      `/ayuda — Ver esta ayuda`
    );
    return;
  }

  if (textTrim === '/ayuda' || textTrim === '/help') {
    await sendMessage(chatId,
      `📖 *Ayuda — Bot de Lavandería*\n\n` +
      `/nuevo — Registrar nueva entrega de Selava\n` +
      `/cancelar — Cancelar el registro en curso\n` +
      `/ayuda — Ver esta ayuda\n\n` +
      `El bot te irá preguntando la cantidad de cada artículo.\nEscribe *0* si no hay ninguno de ese tipo.`
    );
    return;
  }

  if (textTrim === '/cancelar' || textTrim === '/cancel') {
    resetSession(chatId);
    await sendMessage(chatId, '❌ Registro cancelado. Escribe /nuevo para empezar de nuevo.');
    return;
  }

  // ---- FLUJO NUEVO ALBARÁN ----
  if (textTrim === '/nuevo') {
    resetSession(chatId);
    const s = getSession(chatId);
    s.state = STATE.ASKING_RESPONSABLE;
    sessions.set(chatId, s);
    await sendMessage(chatId, '👤 ¿Cuál es tu nombre? (Responsable de la entrega)');
    return;
  }

  // ---- ESTADO: PREGUNTANDO RESPONSABLE ----
  if (session.state === STATE.ASKING_RESPONSABLE) {
    if (!textTrim || textTrim.length < 2) {
      await sendMessage(chatId, '⚠️ Por favor introduce un nombre válido.');
      return;
    }
    session.responsable = textTrim;
    session.state = STATE.ASKING_ITEM;
    session.step = 0;
    await sendMessage(chatId,
      `✅ Hola *${textTrim}*!\n\nVamos a registrar la entrega. Te preguntaré la cantidad de cada artículo.\nEscribe *0* si no hay ninguno.\n\n` +
      `*${ITEMS[0].label}* — ¿Cuántas unidades?`
    );
    return;
  }

  // ---- ESTADO: PREGUNTANDO ARTÍCULOS ----
  if (session.state === STATE.ASKING_ITEM) {
    const qty = parseInt(textTrim, 10);
    if (isNaN(qty) || qty < 0) {
      await sendMessage(chatId, `⚠️ Introduce un número válido (o *0* si no hay ninguno).\n\n*${ITEMS[session.step].label}* — ¿Cuántas unidades?`);
      return;
    }

    session.data[ITEMS[session.step].key] = qty;
    session.step++;

    if (session.step < ITEMS.length) {
      await sendMessage(chatId, `*${ITEMS[session.step].label}* — ¿Cuántas unidades?`);
    } else {
      session.state = STATE.CONFIRMING;
      const summary = buildSummaryText(session.responsable, session.data);
      await sendMessage(chatId, summary, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Confirmar', callback_data: 'confirm' },
              { text: '❌ Cancelar', callback_data: 'cancel' },
            ],
          ],
        },
      });
    }
    return;
  }

  // ---- ESTADO: CONFIRMANDO (texto libre, no botón) ----
  if (session.state === STATE.CONFIRMING) {
    await sendMessage(chatId, 'Por favor usa los botones de arriba para confirmar o cancelar.');
    return;
  }

  // ---- SIN ESTADO ACTIVO ----
  await sendMessage(chatId,
    'Escribe /nuevo para registrar una entrega de lavandería.\nO /ayuda para ver los comandos disponibles.'
  );
}

async function handleCallbackQuery(chatId, callbackData, fromName, queryId) {
  // Responder al callback para quitar el "loading" del botón
  await axios.post(
    `https://api.telegram.org/bot${CONFIG.telegram_token}/answerCallbackQuery`,
    { callback_query_id: queryId },
    { timeout: 5000 }
  ).catch(() => {});

  const session = getSession(chatId);

  if (session.state !== STATE.CONFIRMING) {
    await sendMessage(chatId, 'No hay ningún albarán pendiente de confirmar. Usa /nuevo para empezar.');
    return;
  }

  if (callbackData === 'cancel') {
    resetSession(chatId);
    await sendMessage(chatId, '❌ Albarán cancelado. Usa /nuevo para empezar de nuevo.');
    return;
  }

  if (callbackData === 'confirm') {
    await sendMessage(chatId, '⏳ Guardando albarán...');

    const saved = await appendToSheet(session.responsable, session.data);
    const { responsable, data } = session;
    resetSession(chatId);

    const now = new Date();
    const dateStr = now.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

    const total = ITEMS.reduce((sum, item) => sum + (data[item.key] || 0), 0);

    if (saved) {
      await sendMessage(chatId,
        `✅ *Albarán registrado correctamente*\n\n` +
        `📅 Fecha: ${dateStr} a las ${timeStr}\n` +
        `👤 Responsable: ${responsable}\n` +
        `📦 Total artículos: *${total} unidades*\n\n` +
        `_Los datos se han guardado en Google Sheets._\n\n` +
        `Usa /nuevo para registrar otra entrega.`
      );
    } else {
      await sendMessage(chatId,
        `⚠️ *Albarán registrado (sin Google Sheets)*\n\n` +
        `📅 Fecha: ${dateStr} a las ${timeStr}\n` +
        `👤 Responsable: ${responsable}\n` +
        `📦 Total artículos: *${total} unidades*\n\n` +
        `_Aviso: no se pudo guardar en Google Sheets. Contacta con el administrador._\n\n` +
        `Usa /nuevo para registrar otra entrega.`
      );
    }
  }
}

// ============================================================================
// RUTAS EXPRESS
// ============================================================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Laundry Bot — Albaranes Selava',
    timestamp: new Date(),
  });
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const update = req.body;

  // Mensaje de texto
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const fromName = msg.from?.first_name || msg.from?.username || 'Usuario';
    await handleMessage(chatId, text, fromName);
  }

  // Callback de botón inline
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const fromName = cb.from?.first_name || cb.from?.username || 'Usuario';
    await handleCallbackQuery(chatId, cb.data, fromName, cb.id);
  }
});

app.post('/trigger-test', async (req, res) => {
  const testChatId = req.body?.chat_id;
  if (!testChatId) {
    return res.status(400).json({ error: 'Proporciona chat_id en el body' });
  }
  await sendMessage(testChatId,
    '✅ *Bot de Lavandería activo*\n\nUsa /nuevo para registrar una entrega de Selava.'
  );
  res.json({ status: 'ok', message: 'Mensaje de prueba enviado' });
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================
app.listen(PORT, async () => {
  console.log(`\n🧺 Bot de Albaranes de Lavandería`);
  console.log(`🎯 Servidor en puerto ${PORT}`);
  console.log(`\n📋 Endpoints:`);
  console.log(`   GET  / — Estado`);
  console.log(`   POST /webhook — Webhook de Telegram`);
  console.log(`   POST /trigger-test — Test (requiere chat_id en body)\n`);

  await registerWebhook();
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada:', reason);
});
