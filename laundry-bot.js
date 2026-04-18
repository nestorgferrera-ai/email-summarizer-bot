// ============================================================================
// TELEGRAM LAUNDRY BOT — Albaranes + Envío Diario + Resumen por período
// Clínica Bandama / Selava
//
// Comandos:
//   /nuevo   → registra albarán de RECEPCIÓN (ropa recibida de Selava)
//   /diario  → registra ENVÍO DIARIO (ropa enviada a Selava)
//   /resumen → totaliza por período (Mar-Jue / Vie-Lun) y vuelca en Google Sheets
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
  telegram_token:        process.env.LAUNDRY_TELEGRAM_TOKEN || process.env.TELEGRAM_TOKEN,
  // Hoja de albaranes de recepción (ropa recibida DE Selava)
  albaran_sheet_id:      process.env.GOOGLE_SHEET_ID,
  albaran_sheet_tab:     process.env.ALBARAN_SHEET_TAB     || 'Respuestas de formulario 1',
  // Hoja de envíos diarios (ropa enviada A Selava)
  daily_sheet_id:        process.env.DAILY_SHEET_ID,
  daily_sheet_tab:       process.env.DAILY_SHEET_TAB       || 'Envío Diario',
  // Hoja donde se vuelca el resumen por período
  resumen_sheet_id:      process.env.RESUMEN_SHEET_ID      || process.env.DAILY_SHEET_ID,
  resumen_sheet_tab:     process.env.RESUMEN_SHEET_TAB     || 'Albaran Entrega Selava',
  google_credentials_json: loadGoogleCredentials(),
  app_url:               process.env.APP_URL || '',
  allowed_chat_ids:      (process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
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

// Columnas: A=MarcaTemporal B=Fecha C=Hora D=Responsable E..L=artículos
const ITEM_COL_START = 4;

// ============================================================================
// UTILIDADES DE FECHAS
// ============================================================================

function formatDate(date) {
  return date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Devuelve el Date del día de semana más reciente (≤ hoy)
// 0=Dom 1=Lun 2=Mar 3=Mié 4=Jue 5=Vie 6=Sáb
function mostRecentWeekday(target) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (d.getDay() - target + 7) % 7);
  return d;
}

function getPeriodDates(period) {
  if (period === 'martes_jueves') {
    const start = mostRecentWeekday(2);
    const end = new Date(start);
    end.setDate(start.getDate() + 2);
    return { startDate: start, endDate: end, label: 'Martes – Jueves' };
  }
  const start = mostRecentWeekday(5);
  const end = new Date(start);
  end.setDate(start.getDate() + 3);
  return { startDate: start, endDate: end, label: 'Viernes – Lunes' };
}

function parseSheetDate(str) {
  if (!str) return null;
  const [d, m, y] = str.split('/').map(Number);
  if (!d || !m || !y) return null;
  const date = new Date(y, m - 1, d);
  date.setHours(0, 0, 0, 0);
  return date;
}

// ============================================================================
// ESTADO DE SESIONES
// { state, flow ('albaran'|'diario'), step, responsable, data }
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
    sessions.set(chatId, { state: STATE.IDLE, flow: null, step: 0, responsable: null, data: {} });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, { state: STATE.IDLE, flow: null, step: 0, responsable: null, data: {} });
}

// ============================================================================
// TELEGRAM: ENVIAR MENSAJE
// ============================================================================
async function sendMessage(chatId, text, extra = {}) {
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegram_token}/sendMessage`, {
      chat_id: chatId, text, parse_mode: 'Markdown', ...extra,
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
// GOOGLE SHEETS: GUARDAR ALBARÁN DE RECEPCIÓN
// ============================================================================
async function saveAlbaran(responsable, data) {
  if (!CONFIG.albaran_sheet_id || !CONFIG.google_credentials_json) {
    console.log('⚠️  Google Sheets (albarán) no configurado');
    return false;
  }
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(CONFIG.google_credentials_json),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date();
    const marcaTemporal = now.toLocaleString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const dateStr = formatDate(now);
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const row = [
      marcaTemporal, dateStr, timeStr,
      data.sabanas || 0, data.mantas || 0, data.colchas || 0,
      data.fundas_almohadas || 0, data.almohadas || 0,
      data.toallas || 0, data.toallas_pequenas || 0, data.alfombrillas || 0,
      'Telegram Bot', responsable,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.albaran_sheet_id,
      range: `${CONFIG.albaran_sheet_tab}!A:M`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });
    console.log(`✅ Albarán guardado — ${responsable} ${dateStr}`);
    return true;
  } catch (err) {
    console.error('❌ Error guardando albarán:', err.message);
    return false;
  }
}

// ============================================================================
// GOOGLE SHEETS: GUARDAR ENVÍO DIARIO
// ============================================================================
async function saveDailyEntry(responsable, data) {
  if (!CONFIG.daily_sheet_id || !CONFIG.google_credentials_json) {
    console.log('⚠️  Google Sheets (envío diario) no configurado');
    return false;
  }
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(CONFIG.google_credentials_json),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date();
    const marcaTemporal = now.toLocaleString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const dateStr = formatDate(now);
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Columnas: A=MarcaTemporal B=Fecha C=Hora D=Responsable E-L=artículos
    const row = [
      marcaTemporal, dateStr, timeStr, responsable,
      data.sabanas || 0, data.mantas || 0, data.colchas || 0,
      data.fundas_almohadas || 0, data.almohadas || 0,
      data.toallas || 0, data.toallas_pequenas || 0, data.alfombrillas || 0,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.daily_sheet_id,
      range: `${CONFIG.daily_sheet_tab}!A:L`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });
    console.log(`✅ Envío diario guardado — ${responsable} ${dateStr}`);
    return true;
  } catch (err) {
    console.error('❌ Error guardando envío diario:', err.message);
    return false;
  }
}

// ============================================================================
// GOOGLE SHEETS: LEER TOTALES POR PERÍODO
// ============================================================================
async function getTotalsForPeriod(startDate, endDate) {
  if (!CONFIG.daily_sheet_id || !CONFIG.google_credentials_json) return null;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(CONFIG.google_credentials_json),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.daily_sheet_id,
      range: `${CONFIG.daily_sheet_tab}!A:M`,
    });

    const rows = response.data.values || [];
    const totals = Object.fromEntries(ITEMS.map(i => [i.key, 0]));
    let rowCount = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[1]) continue;
      const rowDate = parseSheetDate(row[1]);
      if (!rowDate || rowDate < startDate || rowDate > endDate) continue;
      rowCount++;
      ITEMS.forEach((item, idx) => {
        const val = parseInt(row[ITEM_COL_START + idx], 10);
        if (!isNaN(val)) totals[item.key] += val;
      });
    }

    return { totals, rowCount };
  } catch (err) {
    console.error('❌ Error leyendo envíos diarios:', err.message);
    return null;
  }
}

// ============================================================================
// GOOGLE SHEETS: ESCRIBIR RESUMEN EN "Albaran Entrega Selava"
// ============================================================================
async function saveResumen(periodLabel, startDate, endDate, totals, rowCount) {
  if (!CONFIG.resumen_sheet_id || !CONFIG.google_credentials_json) return false;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(CONFIG.google_credentials_json),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const now = new Date();
    const generadoEl = now.toLocaleString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const grandTotal = ITEMS.reduce((sum, item) => sum + (totals[item.key] || 0), 0);

    // Generado el | Período | Fecha inicio | Fecha fin | Registros |
    // Sábanas | Mantas | Colchas | Fundas | Almohadas |
    // Toallas | Toallas pequeñas | Alfombrillas | TOTAL
    const row = [
      generadoEl, periodLabel,
      formatDate(startDate), formatDate(endDate), rowCount,
      totals.sabanas || 0, totals.mantas || 0, totals.colchas || 0,
      totals.fundas_almohadas || 0, totals.almohadas || 0,
      totals.toallas || 0, totals.toallas_pequenas || 0, totals.alfombrillas || 0,
      grandTotal,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.resumen_sheet_id,
      range: `${CONFIG.resumen_sheet_tab}!A:N`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });
    console.log(`✅ Resumen guardado en "${CONFIG.resumen_sheet_tab}" — ${periodLabel}`);
    return true;
  } catch (err) {
    console.error('❌ Error guardando resumen:', err.message);
    return false;
  }
}

// ============================================================================
// LÓGICA DE CONVERSACIÓN
// ============================================================================

function buildConfirmText(flow, responsable, data) {
  const lines = ITEMS.map(item => `  • ${item.label}: *${data[item.key] || 0}*`);
  const titulo = flow === 'albaran'
    ? '📋 *Resumen del albarán de recepción*'
    : '🚚 *Resumen del envío diario*';
  const pregunta = flow === 'albaran' ? '¿Confirmas la recepción?' : '¿Confirmas el envío?';
  return `${titulo}\n\n👤 Responsable: *${responsable}*\n\n${lines.join('\n')}\n\n${pregunta}`;
}

async function startFlow(chatId, flow) {
  resetSession(chatId);
  const s = getSession(chatId);
  s.state = STATE.ASKING_RESPONSABLE;
  s.flow = flow;
  const prompt = flow === 'albaran'
    ? '👤 ¿Cuál es tu nombre? (Responsable de la recepción)'
    : '👤 ¿Cuál es tu nombre? (Responsable del envío)';
  await sendMessage(chatId, prompt);
}

async function handleMessage(chatId, text, fromName) {
  if (CONFIG.allowed_chat_ids.length > 0 && !CONFIG.allowed_chat_ids.includes(String(chatId))) {
    await sendMessage(chatId, '⛔ No tienes acceso a este bot. Contacta con el administrador.');
    return;
  }

  const session = getSession(chatId);
  const t = text.trim();

  // ---- COMANDOS GLOBALES ----
  if (t === '/start' || t === '/inicio') {
    resetSession(chatId);
    await sendMessage(chatId,
      `🧺 *Bot de Lavandería — Clínica Bandama*\n\nHola ${fromName}!\n\n` +
      `*Comandos disponibles:*\n` +
      `/nuevo — Registrar recepción de ropa de Selava\n` +
      `/diario — Registrar envío de ropa a Selava\n` +
      `/resumen — Generar albarán de envíos por período\n` +
      `/cancelar — Cancelar registro en curso\n` +
      `/ayuda — Ver esta ayuda`
    );
    return;
  }

  if (t === '/ayuda' || t === '/help') {
    await sendMessage(chatId,
      `📖 *Ayuda — Bot de Lavandería*\n\n` +
      `/nuevo — Registrar recepción de ropa de Selava\n` +
      `/diario — Registrar envío diario de ropa a Selava\n` +
      `/resumen — Generar albarán por período (Mar-Jue / Vie-Lun)\n` +
      `/cancelar — Cancelar el registro en curso\n\n` +
      `Escribe *0* si no hay unidades de algún artículo.`
    );
    return;
  }

  if (t === '/cancelar' || t === '/cancel') {
    resetSession(chatId);
    await sendMessage(chatId, '❌ Registro cancelado.');
    return;
  }

  // ---- INICIAR FLUJOS ----
  if (t === '/nuevo') {
    await sendMessage(chatId,
      `ℹ️ */nuevo* es para registrar la *recepción* de ropa de Selava.\n\n` +
      `Para registrar un *envío a Selava* usa */diario*.\n\n¿Qué quieres hacer?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📦 Registrar recepción de Selava (/nuevo)', callback_data: 'start_albaran' }],
            [{ text: '🚚 Registrar envío a Selava (/diario)',     callback_data: 'start_diario'  }],
          ],
        },
      }
    );
    return;
  }

  if (t === '/diario') {
    await startFlow(chatId, 'diario');
    return;
  }

  // ---- COMANDO /resumen ----
  if (t === '/resumen') {
    const { startDate: sMJ, endDate: eMJ } = getPeriodDates('martes_jueves');
    const { startDate: sVM, endDate: eVM } = getPeriodDates('viernes_lunes');
    await sendMessage(chatId,
      `📊 *Generar albarán de envío a Selava*\n\nElige el período a totalizar:\n\n` +
      `📅 *Martes – Jueves:* ${formatDate(sMJ)} → ${formatDate(eMJ)}\n` +
      `📅 *Viernes – Lunes:* ${formatDate(sVM)} → ${formatDate(eVM)}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📅 Martes – Jueves', callback_data: 'resumen_martes_jueves' }],
            [{ text: '📅 Viernes – Lunes',  callback_data: 'resumen_viernes_lunes' }],
          ],
        },
      }
    );
    return;
  }

  // ---- ESTADO: PREGUNTANDO RESPONSABLE ----
  if (session.state === STATE.ASKING_RESPONSABLE) {
    if (!t || t.length < 2) {
      await sendMessage(chatId, '⚠️ Por favor introduce un nombre válido.');
      return;
    }
    session.responsable = t;
    session.state = STATE.ASKING_ITEM;
    session.step = 0;
    await sendMessage(chatId,
      `✅ Hola *${t}*! Escribe *0* si no hay ninguno.\n\n*${ITEMS[0].label}* — ¿Cuántas unidades?`
    );
    return;
  }

  // ---- ESTADO: PREGUNTANDO ARTÍCULOS ----
  if (session.state === STATE.ASKING_ITEM) {
    const qty = parseInt(t, 10);
    if (isNaN(qty) || qty < 0) {
      await sendMessage(chatId, `⚠️ Introduce un número válido.\n\n*${ITEMS[session.step].label}* — ¿Cuántas unidades?`);
      return;
    }
    session.data[ITEMS[session.step].key] = qty;
    session.step++;

    if (session.step < ITEMS.length) {
      await sendMessage(chatId, `*${ITEMS[session.step].label}* — ¿Cuántas unidades?`);
    } else {
      session.state = STATE.CONFIRMING;
      await sendMessage(chatId, buildConfirmText(session.flow, session.responsable, session.data), {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Confirmar', callback_data: 'confirm' },
            { text: '❌ Cancelar',  callback_data: 'cancel'  },
          ]],
        },
      });
    }
    return;
  }

  if (session.state === STATE.CONFIRMING) {
    await sendMessage(chatId, 'Por favor usa los botones de arriba para confirmar o cancelar.');
    return;
  }

  await sendMessage(chatId,
    'Escribe /nuevo para registrar una recepción, /diario para un envío, o /ayuda para ver los comandos.'
  );
}

async function handleCallbackQuery(chatId, callbackData, fromName, queryId) {
  await axios.post(
    `https://api.telegram.org/bot${CONFIG.telegram_token}/answerCallbackQuery`,
    { callback_query_id: queryId },
    { timeout: 5000 }
  ).catch(() => {});

  // ---- INICIAR FLUJO DESDE BOTÓN ----
  if (callbackData === 'start_albaran') {
    await startFlow(chatId, 'albaran');
    return;
  }
  if (callbackData === 'start_diario') {
    await startFlow(chatId, 'diario');
    return;
  }

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

    if (rowCount === 0) {
      await sendMessage(chatId,
        `ℹ️ No hay registros de envíos para *${label}* (${formatDate(startDate)} → ${formatDate(endDate)}).\n\nUsa /diario para registrar envíos.`
      );
      return;
    }

    await sendMessage(chatId, '⏳ Guardando albarán en Google Sheets...');
    const saved = await saveResumen(label, startDate, endDate, totals, rowCount);

    const grandTotal = ITEMS.reduce((sum, item) => sum + (totals[item.key] || 0), 0);
    const lines = ITEMS.map(item => `  • ${item.label}: *${totals[item.key] || 0}*`);
    const sheetsMsg = saved
      ? `\n\n✅ _Guardado en la hoja "${CONFIG.resumen_sheet_tab}"._`
      : `\n\n⚠️ _No se pudo guardar en Google Sheets._`;

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

  // ---- CONFIRMAR / CANCELAR REGISTRO ----
  const session = getSession(chatId);

  if (session.state !== STATE.CONFIRMING) {
    await sendMessage(chatId, 'No hay ningún registro pendiente. Usa /nuevo o /diario para empezar.');
    return;
  }

  if (callbackData === 'cancel') {
    resetSession(chatId);
    await sendMessage(chatId, '❌ Registro cancelado.');
    return;
  }

  if (callbackData === 'confirm') {
    const isAlbaran = session.flow === 'albaran';
    await sendMessage(chatId, `⏳ Guardando ${isAlbaran ? 'albarán' : 'envío diario'}...`);

    const saved = isAlbaran
      ? await saveAlbaran(session.responsable, session.data)
      : await saveDailyEntry(session.responsable, session.data);

    const { responsable, data } = session;
    resetSession(chatId);

    const now = new Date();
    const dateStr = formatDate(now);
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const total = ITEMS.reduce((sum, item) => sum + (data[item.key] || 0), 0);

    const titulo = isAlbaran ? '✅ *Albarán registrado correctamente*' : '✅ *Envío diario registrado*';
    const nextCmd = isAlbaran
      ? 'Usa /nuevo para registrar otra recepción.'
      : 'Usa /diario para registrar otro envío.\nUsa /resumen para generar el albarán por período.';

    if (saved) {
      await sendMessage(chatId,
        `${titulo}\n\n` +
        `📅 Fecha: ${dateStr} a las ${timeStr}\n` +
        `👤 Responsable: ${responsable}\n` +
        `📦 Total artículos: *${total} unidades*\n\n` +
        `_Los datos se han guardado en Google Sheets._\n\n${nextCmd}`
      );
    } else {
      await sendMessage(chatId,
        `⚠️ *Registrado (sin Google Sheets)*\n\n` +
        `📅 Fecha: ${dateStr} a las ${timeStr}\n` +
        `👤 Responsable: ${responsable}\n` +
        `📦 Total artículos: *${total} unidades*\n\n` +
        `_No se pudo guardar en Google Sheets. Contacta con el administrador._\n\n${nextCmd}`
      );
    }
  }
}

// ============================================================================
// RUTAS EXPRESS
// ============================================================================

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Laundry Bot — Clínica Bandama', timestamp: new Date() });
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (update.message) {
    const { chat, text, from } = update.message;
    await handleMessage(chat.id, text || '', from?.first_name || from?.username || 'Usuario');
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
    '✅ *Bot de Lavandería activo*\n\n/nuevo — recepción\n/diario — envío\n/resumen — albarán por período'
  );
  res.json({ status: 'ok' });
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================
app.listen(PORT, async () => {
  console.log(`\n🧺 Bot de Lavandería — Clínica Bandama v2`);
  console.log(`🎯 Puerto: ${PORT}`);
  console.log(`📋 Albaranes recepción → ${CONFIG.albaran_sheet_id} / "${CONFIG.albaran_sheet_tab}"`);
  console.log(`📋 Envíos diarios      → ${CONFIG.daily_sheet_id} / "${CONFIG.daily_sheet_tab}"`);
  console.log(`📋 Resumen períodos    → ${CONFIG.resumen_sheet_id} / "${CONFIG.resumen_sheet_tab}"\n`);
  await registerWebhook();
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada:', reason);
});
