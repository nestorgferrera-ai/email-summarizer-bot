// ============================================================================
// TELEGRAM DAILY LAUNDRY BOT - Bot de envío diario de lavandería
// Registra ropa enviada a Selava cada día y guarda en Google Sheets
// Incluye /resumen para ver totales acumulados por artículo
// Clínica Bandama
// ============================================================================

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.DAILY_PORT || 3002;

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

const CONFIG = {
  telegram_token: process.env.DAILY_TELEGRAM_TOKEN,
  google_sheet_id: process.env.DAILY_SHEET_ID,
  google_credentials_json: loadGoogleCredentials(),
  app_url: process.env.DAILY_APP_URL || process.env.APP_URL || '',
  allowed_chat_ids: (process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Nombre de la pestaña en el Google Sheet del envío diario
  sheet_tab: process.env.DAILY_SHEET_TAB || 'Envío Diario',
};

// ============================================================================
// ARTÍCULOS
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

// Columnas del sheet: A=MarcaTemporal, B=Fecha, C=Hora, D..K=artículos, L=Origen, M=Responsable
const ITEM_COL_START = 3; // índice 0-based de la primera columna de artículo (columna D)

// ============================================================================
// ESTADO DE SESIONES (en memoria)
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
    console.log('⚠️  DAILY_APP_URL no configurada — el bot usará polling manual');
    return;
  }
  const webhookUrl = `${CONFIG.app_url}/daily-webhook`;
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
// GOOGLE SHEETS: GUARDAR FILA DE ENVÍO
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
    const marcaTemporal = now.toLocaleString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const dateStr = now.toLocaleDateString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
    const timeStr = now.toLocaleTimeString('es-ES', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    // Columnas: MarcaTemporal | Fecha | Hora | Sábanas | Mantas | Colchas |
    // Fundas Almohadas | Almohadas | Toallas | Toallas pequeñas | Alfombrillas |
    // Origen | Responsable
    const row = [
      marcaTemporal,
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
      'Telegram Bot',
      responsable,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.google_sheet_id,
      range: `${CONFIG.sheet_tab}!A:M`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });

    console.log(`✅ Envío diario guardado — ${responsable} ${dateStr} ${timeStr}`);
    return true;
  } catch (err) {
    console.error('❌ Error guardando en Google Sheets:', err.message);
    return false;
  }
}

// ============================================================================
// GOOGLE SHEETS: LEER TOTALES PARA /resumen
// ============================================================================
async function getSheetTotals() {
  if (!CONFIG.google_sheet_id || !CONFIG.google_credentials_json) {
    return null;
  }

  try {
    const credentials = JSON.parse(CONFIG.google_credentials_json);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.google_sheet_id,
      range: `${CONFIG.sheet_tab}!A:M`,
    });

    const rows = response.data.values || [];
    if (rows.length <= 1) {
      // Solo cabecera o vacío
      return { totals: Object.fromEntries(ITEMS.map(i => [i.key, 0])), rowCount: 0 };
    }

    // Sumar columnas D-K (índices 3-10) para cada artículo
    const totals = Object.fromEntries(ITEMS.map(i => [i.key, 0]));
    let rowCount = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // Saltar filas de cabecera secundarias o vacías
      if (!row || !row[0] || isNaN(parseInt(row[ITEM_COL_START], 10))) continue;

      rowCount++;
      ITEMS.forEach((item, idx) => {
        const val = parseInt(row[ITEM_COL_START + idx], 10);
        if (!isNaN(val)) totals[item.key] += val;
      });
    }

    return { totals, rowCount };
  } catch (err) {
    console.error('❌ Error leyendo Google Sheets:', err.message);
    return null;
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
  return `📋 *Resumen del envío diario*\n\n👤 Responsable: *${responsable}*\n\n${lines.join('\n')}\n\n¿Confirmas el envío?`;
}

async function handleMessage(chatId, text, fromName) {
  if (CONFIG.allowed_chat_ids.length > 0 && !CONFIG.allowed_chat_ids.includes(String(chatId))) {
    await sendMessage(chatId, '⛔ No tienes acceso a este bot. Contacta con el administrador.');
    return;
  }

  const session = getSession(chatId);
  const textTrim = text.trim();

  // ---- COMANDOS GLOBALES ----
  if (textTrim === '/start' || textTrim === '/inicio') {
    resetSession(chatId);
    await sendMessage(chatId,
      `🚚 *Bot de Envío Diario de Lavandería*\n\nHola ${fromName}! Aquí puedes registrar la ropa enviada a Selava cada día.\n\n` +
      `*Comandos disponibles:*\n` +
      `/nuevo — Registrar nuevo envío\n` +
      `/resumen — Ver totales acumulados por artículo\n` +
      `/cancelar — Cancelar registro en curso\n` +
      `/ayuda — Ver esta ayuda`
    );
    return;
  }

  if (textTrim === '/ayuda' || textTrim === '/help') {
    await sendMessage(chatId,
      `📖 *Ayuda — Bot de Envío Diario*\n\n` +
      `/nuevo — Registrar envío de ropa a Selava\n` +
      `/resumen — Ver totales acumulados de todos los envíos\n` +
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

  // ---- COMANDO /resumen: LEER TOTALES DEL SHEET ----
  if (textTrim === '/resumen') {
    await sendMessage(chatId, '⏳ Calculando totales...');
    const result = await getSheetTotals();

    if (!result) {
      await sendMessage(chatId, '❌ No se pudo conectar con Google Sheets. Contacta con el administrador.');
      return;
    }

    const { totals, rowCount } = result;
    const grandTotal = ITEMS.reduce((sum, item) => sum + (totals[item.key] || 0), 0);

    const lines = ITEMS.map(item => {
      const qty = totals[item.key] || 0;
      return `  • ${item.label}: *${qty}*`;
    });

    await sendMessage(chatId,
      `📊 *Resumen acumulado — Envíos a Selava*\n\n` +
      `${lines.join('\n')}\n\n` +
      `📦 *Total piezas: ${grandTotal}*\n` +
      `📋 Registros: ${rowCount} envío${rowCount !== 1 ? 's' : ''}`
    );
    return;
  }

  // ---- FLUJO NUEVO ENVÍO ----
  if (textTrim === '/nuevo') {
    resetSession(chatId);
    const s = getSession(chatId);
    s.state = STATE.ASKING_RESPONSABLE;
    sessions.set(chatId, s);
    await sendMessage(chatId, '👤 ¿Cuál es tu nombre? (Responsable del envío)');
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
      `✅ Hola *${textTrim}*!\n\nVamos a registrar el envío. Te preguntaré la cantidad de cada artículo.\nEscribe *0* si no hay ninguno.\n\n` +
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
              { text: '✅ Confirmar envío', callback_data: 'confirm' },
              { text: '❌ Cancelar', callback_data: 'cancel' },
            ],
          ],
        },
      });
    }
    return;
  }

  // ---- ESTADO: CONFIRMANDO (texto libre) ----
  if (session.state === STATE.CONFIRMING) {
    await sendMessage(chatId, 'Por favor usa los botones de arriba para confirmar o cancelar.');
    return;
  }

  // ---- SIN ESTADO ACTIVO ----
  await sendMessage(chatId,
    'Escribe /nuevo para registrar un envío diario.\nO /ayuda para ver los comandos disponibles.'
  );
}

async function handleCallbackQuery(chatId, callbackData, fromName, queryId) {
  await axios.post(
    `https://api.telegram.org/bot${CONFIG.telegram_token}/answerCallbackQuery`,
    { callback_query_id: queryId },
    { timeout: 5000 }
  ).catch(() => {});

  const session = getSession(chatId);

  if (session.state !== STATE.CONFIRMING) {
    await sendMessage(chatId, 'No hay ningún envío pendiente de confirmar. Usa /nuevo para empezar.');
    return;
  }

  if (callbackData === 'cancel') {
    resetSession(chatId);
    await sendMessage(chatId, '❌ Envío cancelado. Usa /nuevo para empezar de nuevo.');
    return;
  }

  if (callbackData === 'confirm') {
    await sendMessage(chatId, '⏳ Guardando envío...');

    const saved = await appendToSheet(session.responsable, session.data);
    const { responsable, data } = session;
    resetSession(chatId);

    const now = new Date();
    const dateStr = now.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const total = ITEMS.reduce((sum, item) => sum + (data[item.key] || 0), 0);

    if (saved) {
      await sendMessage(chatId,
        `✅ *Envío registrado correctamente*\n\n` +
        `📅 Fecha: ${dateStr} a las ${timeStr}\n` +
        `👤 Responsable: ${responsable}\n` +
        `📦 Total artículos: *${total} unidades*\n\n` +
        `_Los datos se han guardado en Google Sheets._\n\n` +
        `Usa /resumen para ver los totales acumulados.\n` +
        `Usa /nuevo para registrar otro envío.`
      );
    } else {
      await sendMessage(chatId,
        `⚠️ *Envío registrado (sin Google Sheets)*\n\n` +
        `📅 Fecha: ${dateStr} a las ${timeStr}\n` +
        `👤 Responsable: ${responsable}\n` +
        `📦 Total artículos: *${total} unidades*\n\n` +
        `_Aviso: no se pudo guardar en Google Sheets. Contacta con el administrador._\n\n` +
        `Usa /nuevo para registrar otro envío.`
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
    service: 'Daily Laundry Bot — Envío Diario Selava',
    timestamp: new Date(),
  });
});

app.post('/daily-webhook', async (req, res) => {
  res.sendStatus(200);

  const update = req.body;

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const fromName = msg.from?.first_name || msg.from?.username || 'Usuario';
    await handleMessage(chatId, text, fromName);
  }

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
    '✅ *Bot de Envío Diario activo*\n\nUsa /nuevo para registrar un envío diario a Selava.\nUsa /resumen para ver los totales acumulados.'
  );
  res.json({ status: 'ok', message: 'Mensaje de prueba enviado' });
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================
app.listen(PORT, async () => {
  console.log(`\n🚚 Bot de Envío Diario de Lavandería`);
  console.log(`🎯 Servidor en puerto ${PORT}`);
  console.log(`\n📋 Endpoints:`);
  console.log(`   GET  /              — Estado`);
  console.log(`   POST /daily-webhook — Webhook de Telegram`);
  console.log(`   POST /trigger-test  — Test (requiere chat_id en body)\n`);

  await registerWebhook();
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada:', reason);
});
