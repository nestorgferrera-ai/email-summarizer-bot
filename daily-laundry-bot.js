// ============================================================================
// TELEGRAM DAILY LAUNDRY BOT - Bot de envío diario de lavandería
// Registra ropa enviada a Selava cada día y guarda en Google Sheets
// /resumen → elige período (Mar-Jue o Vie-Lun), suma totales y
//            escribe el albarán en la hoja "Albaran Entrega Selava"
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
  // Sheet de ENVÍOS DIARIOS (fuente de datos)
  google_sheet_id: process.env.DAILY_SHEET_ID,
  // Sheet donde se escribe el albarán final (puede ser el mismo o diferente)
  albaran_sheet_id: process.env.ALBARAN_SHEET_ID || process.env.DAILY_SHEET_ID,
  google_credentials_json: loadGoogleCredentials(),
  app_url: process.env.DAILY_APP_URL || process.env.APP_URL || '',
  allowed_chat_ids: (process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Pestaña del sheet de envíos diarios
  sheet_tab: process.env.DAILY_SHEET_TAB || 'Envío Diario',
  // Pestaña del sheet de albarán final
  albaran_tab: process.env.ALBARAN_SHEET_TAB || 'Albaran Entrega Selava',
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

// Columnas del sheet: A=MarcaTemporal, B=Fecha(DD/MM/YYYY), C=Hora, D..K=artículos, L=Origen, M=Responsable
const ITEM_COL_START = 3; // índice 0-based de la primera columna de artículo (columna D)

// ============================================================================
// UTILIDADES DE FECHAS
// ============================================================================

// Devuelve el Date del día de semana más reciente (≤ hoy)
// dayTarget: 0=Dom,1=Lun,2=Mar,3=Mié,4=Jue,5=Vie,6=Sáb
function mostRecentWeekday(dayTarget) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today.getDay() - dayTarget + 7) % 7;
  const result = new Date(today);
  result.setDate(today.getDate() - diff);
  return result;
}

// Devuelve { startDate, endDate, label } para cada período
function getPeriodDates(period) {
  if (period === 'martes_jueves') {
    const start = mostRecentWeekday(2); // Martes
    const end = new Date(start);
    end.setDate(start.getDate() + 2);  // Jueves
    return { startDate: start, endDate: end, label: 'Martes – Jueves' };
  }
  if (period === 'viernes_lunes') {
    const start = mostRecentWeekday(5); // Viernes
    const end = new Date(start);
    end.setDate(start.getDate() + 3);  // Lunes
    return { startDate: start, endDate: end, label: 'Viernes – Lunes' };
  }
  return null;
}

function formatDate(date) {
  return date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Parsea "DD/MM/YYYY" del sheet a Date
function parseSheetDate(str) {
  if (!str) return null;
  const parts = str.split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  if (isNaN(d) || isNaN(m) || isNaN(y)) return null;
  const date = new Date(y, m - 1, d);
  date.setHours(0, 0, 0, 0);
  return date;
}

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
// GOOGLE SHEETS: GUARDAR FILA DE ENVÍO DIARIO
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
    const dateStr = now.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // A=MarcaTemporal | B=Fecha | C=Hora | D-K=artículos | L=Origen | M=Responsable
    const row = [
      marcaTemporal, dateStr, timeStr,
      data.sabanas || 0, data.mantas || 0, data.colchas || 0,
      data.fundas_almohadas || 0, data.almohadas || 0,
      data.toallas || 0, data.toallas_pequenas || 0, data.alfombrillas || 0,
      'Telegram Bot', responsable,
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
// GOOGLE SHEETS: LEER Y SUMAR TOTALES POR PERÍODO
// ============================================================================
async function getTotalsForPeriod(startDate, endDate) {
  if (!CONFIG.google_sheet_id || !CONFIG.google_credentials_json) return null;

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
    const totals = Object.fromEntries(ITEMS.map(i => [i.key, 0]));
    let rowCount = 0;

    // Empezar desde fila 1 (saltando cabecera en índice 0)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[1]) continue;

      const rowDate = parseSheetDate(row[1]); // columna B = Fecha
      if (!rowDate) continue;

      // Filtrar por rango de fechas del período
      if (rowDate < startDate || rowDate > endDate) continue;

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
// GOOGLE SHEETS: ESCRIBIR ALBARÁN EN "Albaran Entrega Selava"
// ============================================================================
async function writeAlbaranToSheet(periodLabel, startDate, endDate, totals, rowCount) {
  if (!CONFIG.albaran_sheet_id || !CONFIG.google_credentials_json) return false;

  try {
    const credentials = JSON.parse(CONFIG.google_credentials_json);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const now = new Date();
    const generadoEl = now.toLocaleString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const grandTotal = ITEMS.reduce((sum, item) => sum + (totals[item.key] || 0), 0);

    // Columnas: Generado el | Período | Fecha inicio | Fecha fin | Registros |
    //           Sábanas | Mantas | Colchas | Fundas Almohadas | Almohadas |
    //           Toallas | Toallas pequeñas | Alfombrillas | TOTAL
    const row = [
      generadoEl,
      periodLabel,
      formatDate(startDate),
      formatDate(endDate),
      rowCount,
      totals.sabanas          || 0,
      totals.mantas           || 0,
      totals.colchas          || 0,
      totals.fundas_almohadas || 0,
      totals.almohadas        || 0,
      totals.toallas          || 0,
      totals.toallas_pequenas || 0,
      totals.alfombrillas     || 0,
      grandTotal,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.albaran_sheet_id,
      range: `${CONFIG.albaran_tab}!A:N`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });

    console.log(`✅ Albarán escrito en "${CONFIG.albaran_tab}" — ${periodLabel} ${formatDate(startDate)} → ${formatDate(endDate)}`);
    return true;
  } catch (err) {
    console.error('❌ Error escribiendo albarán en Google Sheets:', err.message);
    return false;
  }
}

// ============================================================================
// LÓGICA DE CONVERSACIÓN
// ============================================================================

function buildSummaryText(responsable, data) {
  const lines = ITEMS.map(item => `  • ${item.label}: *${data[item.key] || 0}*`);
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
      `🚚 *Bot de Envío Diario de Lavandería*\n\nHola ${fromName}! Aquí puedes registrar la ropa enviada a Selava.\n\n` +
      `*Comandos disponibles:*\n` +
      `/nuevo — Registrar nuevo envío\n` +
      `/resumen — Generar albarán por período\n` +
      `/cancelar — Cancelar registro en curso\n` +
      `/ayuda — Ver esta ayuda`
    );
    return;
  }

  if (textTrim === '/ayuda' || textTrim === '/help') {
    await sendMessage(chatId,
      `📖 *Ayuda — Bot de Envío Diario*\n\n` +
      `/nuevo — Registrar envío de ropa a Selava\n` +
      `/resumen — Ver totales por período y generar albarán en Google Sheets\n` +
      `/cancelar — Cancelar el registro en curso\n` +
      `/ayuda — Ver esta ayuda\n\n` +
      `Los períodos disponibles son:\n` +
      `  📅 *Martes – Jueves*\n` +
      `  📅 *Viernes – Lunes*`
    );
    return;
  }

  if (textTrim === '/cancelar' || textTrim === '/cancel') {
    resetSession(chatId);
    await sendMessage(chatId, '❌ Registro cancelado. Escribe /nuevo para empezar de nuevo.');
    return;
  }

  // ---- COMANDO /resumen: ELEGIR PERÍODO ----
  if (textTrim === '/resumen') {
    const { startDate: startMJ, endDate: endMJ } = getPeriodDates('martes_jueves');
    const { startDate: startVM, endDate: endVM } = getPeriodDates('viernes_lunes');

    await sendMessage(chatId,
      `📊 *Generar albarán de envío a Selava*\n\nElige el período a totalizar:\n\n` +
      `📅 *Martes – Jueves:* ${formatDate(startMJ)} → ${formatDate(endMJ)}\n` +
      `📅 *Viernes – Lunes:* ${formatDate(startVM)} → ${formatDate(endVM)}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `📅 Martes – Jueves`, callback_data: 'resumen_martes_jueves' },
            ],
            [
              { text: `📅 Viernes – Lunes`, callback_data: 'resumen_viernes_lunes' },
            ],
          ],
        },
      }
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
      `✅ Hola *${textTrim}*!\n\nVamos a registrar el envío. Escribe *0* si no hay ninguno.\n\n` +
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
      await sendMessage(chatId, buildSummaryText(session.responsable, session.data), {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Confirmar envío', callback_data: 'confirm' },
            { text: '❌ Cancelar', callback_data: 'cancel' },
          ]],
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
    'Escribe /nuevo para registrar un envío.\nEscribe /resumen para generar el albarán por período.'
  );
}

async function handleCallbackQuery(chatId, callbackData, fromName, queryId) {
  await axios.post(
    `https://api.telegram.org/bot${CONFIG.telegram_token}/answerCallbackQuery`,
    { callback_query_id: queryId },
    { timeout: 5000 }
  ).catch(() => {});

  // ---- RESUMEN POR PERÍODO ----
  if (callbackData === 'resumen_martes_jueves' || callbackData === 'resumen_viernes_lunes') {
    const periodKey = callbackData === 'resumen_martes_jueves' ? 'martes_jueves' : 'viernes_lunes';
    const { startDate, endDate, label } = getPeriodDates(periodKey);

    await sendMessage(chatId, `⏳ Calculando totales para *${label}* (${formatDate(startDate)} → ${formatDate(endDate)})...`);

    const result = await getTotalsForPeriod(startDate, endDate);
    if (!result) {
      await sendMessage(chatId, '❌ No se pudo conectar con Google Sheets. Contacta con el administrador.');
      return;
    }

    const { totals, rowCount } = result;
    const grandTotal = ITEMS.reduce((sum, item) => sum + (totals[item.key] || 0), 0);

    if (rowCount === 0) {
      await sendMessage(chatId,
        `ℹ️ No hay registros de envíos para el período *${label}*\n` +
        `(${formatDate(startDate)} → ${formatDate(endDate)})\n\n` +
        `Usa /nuevo para registrar envíos primero.`
      );
      return;
    }

    const lines = ITEMS.map(item => `  • ${item.label}: *${totals[item.key] || 0}*`);

    // Escribir albarán en Google Sheets
    await sendMessage(chatId, `⏳ Guardando albarán en Google Sheets...`);
    const saved = await writeAlbaranToSheet(label, startDate, endDate, totals, rowCount);

    const sheetsMsg = saved
      ? `\n✅ _Albarán guardado en la hoja "${CONFIG.albaran_tab}"._`
      : `\n⚠️ _No se pudo guardar en Google Sheets. Contacta con el administrador._`;

    await sendMessage(chatId,
      `📊 *Albarán de Envío a Selava*\n\n` +
      `📅 Período: *${label}*\n` +
      `🗓 ${formatDate(startDate)} → ${formatDate(endDate)}\n` +
      `📋 Registros: ${rowCount} envío${rowCount !== 1 ? 's' : ''}\n\n` +
      `${lines.join('\n')}\n\n` +
      `📦 *TOTAL PIEZAS: ${grandTotal}*` +
      sheetsMsg
    );
    return;
  }

  // ---- CONFIRMAR / CANCELAR ENVÍO DIARIO ----
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
    const dateStr = formatDate(now);
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const total = ITEMS.reduce((sum, item) => sum + (data[item.key] || 0), 0);

    if (saved) {
      await sendMessage(chatId,
        `✅ *Envío registrado correctamente*\n\n` +
        `📅 Fecha: ${dateStr} a las ${timeStr}\n` +
        `👤 Responsable: ${responsable}\n` +
        `📦 Total artículos: *${total} unidades*\n\n` +
        `_Los datos se han guardado en Google Sheets._\n\n` +
        `Usa /resumen para generar el albarán por período.\n` +
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
    await handleMessage(msg.chat.id, msg.text || '', msg.from?.first_name || msg.from?.username || 'Usuario');
  }

  if (update.callback_query) {
    const cb = update.callback_query;
    await handleCallbackQuery(cb.message.chat.id, cb.data, cb.from?.first_name || cb.from?.username || 'Usuario', cb.id);
  }
});

app.post('/trigger-test', async (req, res) => {
  const testChatId = req.body?.chat_id;
  if (!testChatId) return res.status(400).json({ error: 'Proporciona chat_id en el body' });
  await sendMessage(testChatId,
    '✅ *Bot de Envío Diario activo*\n\nUsa /nuevo para registrar un envío.\nUsa /resumen para generar el albarán por período.'
  );
  res.json({ status: 'ok', message: 'Mensaje de prueba enviado' });
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================
app.listen(PORT, async () => {
  console.log(`\n🚚 Bot de Envío Diario de Lavandería`);
  console.log(`🎯 Servidor en puerto ${PORT}`);
  console.log(`📋 Envíos diarios → Sheet: ${CONFIG.google_sheet_id} / Pestaña: "${CONFIG.sheet_tab}"`);
  console.log(`📋 Albarán final  → Sheet: ${CONFIG.albaran_sheet_id} / Pestaña: "${CONFIG.albaran_tab}"\n`);
  await registerWebhook();
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada:', reason);
});
