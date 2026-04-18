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
const nodemailer = require('nodemailer');
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
  albaran_sheet_id:      process.env.GOOGLE_SHEET_ID,
  albaran_sheet_tab:     process.env.ALBARAN_SHEET_TAB     || 'Respuestas de formulario 1',
  daily_sheet_id:        process.env.DAILY_SHEET_ID,
  daily_sheet_tab:       process.env.DAILY_SHEET_TAB       || 'Envío Diario',
  resumen_sheet_id:      process.env.RESUMEN_SHEET_ID      || process.env.DAILY_SHEET_ID,
  resumen_sheet_tab:     process.env.RESUMEN_SHEET_TAB     || 'Albaran Entrega Selava',
  google_credentials:    loadGoogleCredentials(),
  app_url:               process.env.APP_URL || '',
  allowed_chat_ids:      (process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  resumen_email_to:      (process.env.RESUMEN_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean),
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
// LAUNDRY BOT — ARTÍCULOS, SESIONES Y GOOGLE SHEETS
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

const ITEM_COL_START = 4; // columna D (0-indexed)

const STATE = { IDLE: 'idle', ASKING_RESPONSABLE: 'asking_responsable', ASKING_ITEM: 'asking_item', CONFIRMING: 'confirming' };
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { state: STATE.IDLE, flow: null, step: 0, responsable: null, data: {} });
  return sessions.get(chatId);
}
function resetSession(chatId) {
  sessions.set(chatId, { state: STATE.IDLE, flow: null, step: 0, responsable: null, data: {} });
}

// ---- Utilidades de fecha ----
function formatDate(date) {
  return date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
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

// ---- Telegram ----
async function laundryMsg(chatId, text, extra = {}) {
  try {
    await axios.post(`https://api.telegram.org/bot${LAUNDRY_CFG.telegram_token}/sendMessage`, {
      chat_id: chatId, text, parse_mode: 'Markdown', ...extra,
    }, { timeout: 10000 });
  } catch (err) {
    console.error('❌ Error enviando mensaje lavandería:', err.message);
  }
}

// ---- Google Sheets: albarán de recepción ----
async function saveAlbaran(responsable, data) {
  if (!LAUNDRY_CFG.albaran_sheet_id || !LAUNDRY_CFG.google_credentials) {
    console.log('⚠️  Google Sheets (albarán) no configurado');
    return false;
  }
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(LAUNDRY_CFG.google_credentials),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date();
    const marcaTemporal = now.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
      spreadsheetId: LAUNDRY_CFG.albaran_sheet_id,
      range: `${LAUNDRY_CFG.albaran_sheet_tab}!A:M`,
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

// ---- Google Sheets: envío diario ----
async function saveDailyEntry(responsable, data) {
  if (!LAUNDRY_CFG.daily_sheet_id || !LAUNDRY_CFG.google_credentials) {
    console.log('⚠️  Google Sheets (envío diario) no configurado');
    return false;
  }
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(LAUNDRY_CFG.google_credentials),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date();
    const marcaTemporal = now.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = formatDate(now);
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    // A=MarcaTemporal B=Fecha C=Hora D=Responsable E-L=artículos
    const row = [
      marcaTemporal, dateStr, timeStr, responsable,
      data.sabanas || 0, data.mantas || 0, data.colchas || 0,
      data.fundas_almohadas || 0, data.almohadas || 0,
      data.toallas || 0, data.toallas_pequenas || 0, data.alfombrillas || 0,
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: LAUNDRY_CFG.daily_sheet_id,
      range: `${LAUNDRY_CFG.daily_sheet_tab}!A:L`,
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

// ---- Google Sheets: leer totales por período ----
async function getTotalsForPeriod(startDate, endDate) {
  if (!LAUNDRY_CFG.daily_sheet_id || !LAUNDRY_CFG.google_credentials) return null;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(LAUNDRY_CFG.google_credentials),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: LAUNDRY_CFG.daily_sheet_id,
      range: `${LAUNDRY_CFG.daily_sheet_tab}!A:M`,
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

// ---- Google Sheets: crear pestaña si no existe ----
async function ensureSheetTabExists(sheets, spreadsheetId, tabName) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const exists = meta.data.sheets.some(s => s.properties.title === tabName);
    if (exists) return true;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    console.log(`✅ Pestaña "${tabName}" creada automáticamente en Google Sheets`);
    return true;
  } catch (err) {
    console.error(`❌ Error creando pestaña "${tabName}":`, err.message, err.response?.data || '');
    return false;
  }
}

// ---- Email: enviar resumen de período ----
async function sendResumenEmail(periodLabel, startDate, endDate, totals, rowCount) {
  if (!LAUNDRY_CFG.resumen_email_to.length || !EMAIL_CFG.ionos_email || !EMAIL_CFG.ionos_password) return false;
  try {
    const transporter = nodemailer.createTransport({
      host: EMAIL_CFG.ionos_imap_host.replace('imap.', 'smtp.'),
      port: 587,
      secure: false,
      auth: { user: EMAIL_CFG.ionos_email, pass: EMAIL_CFG.ionos_password },
    });
    const grandTotal = ITEMS.reduce((sum, item) => sum + (totals[item.key] || 0), 0);
    const itemRows = ITEMS.map(item =>
      `<tr><td style="padding:4px 12px">${item.label}</td><td style="padding:4px 12px;text-align:right"><strong>${totals[item.key] || 0}</strong></td></tr>`
    ).join('');
    const html = `
<div style="font-family:Arial,sans-serif;max-width:500px">
  <h2 style="color:#2c3e50">📊 Albarán de Envío a Selava</h2>
  <p><strong>Período:</strong> ${periodLabel}<br>
     <strong>Fechas:</strong> ${formatDate(startDate)} → ${formatDate(endDate)}<br>
     <strong>Registros:</strong> ${rowCount} envío${rowCount !== 1 ? 's' : ''}</p>
  <table style="border-collapse:collapse;width:100%">
    <thead><tr style="background:#f0f0f0">
      <th style="padding:6px 12px;text-align:left">Artículo</th>
      <th style="padding:6px 12px;text-align:right">Unidades</th>
    </tr></thead>
    <tbody>${itemRows}</tbody>
    <tfoot><tr style="background:#2c3e50;color:white">
      <td style="padding:6px 12px"><strong>TOTAL PIEZAS</strong></td>
      <td style="padding:6px 12px;text-align:right"><strong>${grandTotal}</strong></td>
    </tr></tfoot>
  </table>
  <p style="color:#888;font-size:12px;margin-top:16px">Generado automáticamente — Bot Lavandería Clínica Bandama</p>
</div>`;
    await transporter.sendMail({
      from: `"Bot Lavandería" <${EMAIL_CFG.ionos_email}>`,
      to: LAUNDRY_CFG.resumen_email_to.join(', '),
      subject: `Albarán Envío Selava — ${periodLabel} (${formatDate(startDate)} → ${formatDate(endDate)})`,
      html,
    });
    console.log(`✅ Email resumen enviado a: ${LAUNDRY_CFG.resumen_email_to.join(', ')}`);
    return true;
  } catch (err) {
    console.error('❌ Error enviando email resumen:', err.message);
    return false;
  }
}

// ---- Google Sheets: guardar resumen de período ----
async function saveResumen(periodLabel, startDate, endDate, totals, rowCount) {
  if (!LAUNDRY_CFG.resumen_sheet_id || !LAUNDRY_CFG.google_credentials) return false;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(LAUNDRY_CFG.google_credentials),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureSheetTabExists(sheets, LAUNDRY_CFG.resumen_sheet_id, LAUNDRY_CFG.resumen_sheet_tab);
    const now = new Date();
    const marcaTemporal = now.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const grandTotal = ITEMS.reduce((sum, item) => sum + (totals[item.key] || 0), 0);
    // Columnas igual que el sheet de recepción:
    // A=MarcaTemporal B=Fecha C=Hora D=Sabanas E=Mantas F=Colchas G=FundasAlmohadas
    // H=Almohadas I=Toallas J=ToallasPequeñas K=Alfombrillas L=Período M=Total
    const row = [
      marcaTemporal, formatDate(startDate), timeStr,
      totals.sabanas || 0, totals.mantas || 0, totals.colchas || 0,
      totals.fundas_almohadas || 0, totals.almohadas || 0,
      totals.toallas || 0, totals.toallas_pequenas || 0, totals.alfombrillas || 0,
      `${periodLabel} (${formatDate(startDate)} → ${formatDate(endDate)}) — ${rowCount} envíos`,
      grandTotal,
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: LAUNDRY_CFG.resumen_sheet_id,
      range: `${LAUNDRY_CFG.resumen_sheet_tab}!A:M`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });
    console.log(`✅ Resumen guardado en "${LAUNDRY_CFG.resumen_sheet_tab}" — ${periodLabel}`);
    return true;
  } catch (err) {
    console.error('❌ Error guardando resumen:', err.message, err.response?.data || '');
    return false;
  }
}

// ---- Lógica de conversación ----
function buildConfirmText(flow, responsable, data) {
  const lines = ITEMS.map(item => `  • ${item.label}: *${data[item.key] || 0}*`);
  const titulo = flow === 'albaran' ? '📋 *Resumen del albarán de recepción*' : '🚚 *Resumen del envío diario*';
  const pregunta = flow === 'albaran' ? '¿Confirmas la recepción?' : '¿Confirmas el envío?';
  return `${titulo}\n\n👤 Responsable: *${responsable}*\n\n${lines.join('\n')}\n\n${pregunta}`;
}

async function startLaundryFlow(chatId, flow) {
  resetSession(chatId);
  const s = getSession(chatId);
  s.state = STATE.ASKING_RESPONSABLE;
  s.flow = flow;
  const prompt = flow === 'albaran'
    ? '👤 ¿Cuál es tu nombre? (Responsable de la recepción)'
    : '👤 ¿Cuál es tu nombre? (Responsable del envío)';
  await laundryMsg(chatId, prompt);
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
      `🧺 *Bot de Lavandería — Clínica Bandama*\n\nHola ${fromName}!\n\n` +
      `*Comandos disponibles:*\n` +
      `/nuevo — Registrar envío a la empresa de lavandería (no usar)\n` +
      `/diario — Registrar envío de ropa a Selava\n` +
      `/resumen — Generar albarán de envíos por período\n` +
      `/cancelar — Cancelar registro en curso\n` +
      `/ayuda — Ver esta ayuda`);
    return;
  }

  if (t === '/ayuda' || t === '/help') {
    await laundryMsg(chatId,
      `📖 *Ayuda — Bot de Lavandería*\n\n` +
      `/nuevo — Registrar envío a la empresa de lavandería (no usar)\n` +
      `/diario — Registrar envío diario de ropa a Selava\n` +
      `/resumen — Generar albarán por período (Mar-Jue / Vie-Lun)\n` +
      `/cancelar — Cancelar el registro en curso\n\n` +
      `Escribe *0* si no hay unidades de algún artículo.`);
    return;
  }

  if (t === '/cancelar' || t === '/cancel') {
    resetSession(chatId);
    await laundryMsg(chatId, '❌ Registro cancelado.');
    return;
  }

  if (t === '/miid') {
    await laundryMsg(chatId, `🪪 Tu Chat ID es: \`${chatId}\`\n\nPásaselo al administrador para que te añada al bot.`);
    return;
  }

  if (t === '/nuevo') {
    await laundryMsg(chatId,
      `ℹ️ */nuevo* es para registrar la *recepción* de ropa de Selava.\n\n` +
      `Para registrar un *envío a Selava* usa */diario*.\n\n¿Qué quieres hacer?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📦 Registrar envío a la empresa de lavandería (no usar)', callback_data: 'start_albaran' }],
            [{ text: '🚚 Registrar envío a Selava (/diario)',     callback_data: 'start_diario'  }],
          ],
        },
      });
    return;
  }

  if (t === '/diario') {
    await startLaundryFlow(chatId, 'diario');
    return;
  }

  if (t === '/debug') {
    await laundryMsg(chatId, '🔍 Ejecutando diagnóstico...');
    const lines = [];

    // Google Sheets
    lines.push(`📋 *Sheet ID (resumen):* \`${LAUNDRY_CFG.resumen_sheet_id || '❌ NO CONFIGURADO'}\``);
    lines.push(`📑 *Pestaña (resumen):* \`${LAUNDRY_CFG.resumen_sheet_tab}\``);
    lines.push(`🔑 *Credenciales Google:* ${LAUNDRY_CFG.google_credentials ? '✅ Cargadas' : '❌ No encontradas'}`);
    if (LAUNDRY_CFG.resumen_sheet_id && LAUNDRY_CFG.google_credentials) {
      try {
        const auth = new google.auth.GoogleAuth({
          credentials: JSON.parse(LAUNDRY_CFG.google_credentials),
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const sheets = google.sheets({ version: 'v4', auth });
        lines.push('🌐 *Conexión Google API:* ✅ OK');
        try {
          const meta = await sheets.spreadsheets.get({ spreadsheetId: LAUNDRY_CFG.resumen_sheet_id });
          lines.push(`📊 *Spreadsheet:* ✅ "${meta.data.properties.title}"`);
          const tabs = meta.data.sheets.map(s => s.properties.title);
          lines.push(`📂 *Pestañas:* ${tabs.map(t => `\`${t}\``).join(', ')}`);
          const tabExists = tabs.includes(LAUNDRY_CFG.resumen_sheet_tab);
          lines.push(`🎯 *Pestaña "${LAUNDRY_CFG.resumen_sheet_tab}":* ${tabExists ? '✅ Existe' : '❌ NO EXISTE'}`);
        } catch (e) {
          lines.push(`📊 *Spreadsheet:* ❌ \`${e.message}\``);
        }
      } catch (e) {
        lines.push(`🌐 *Conexión Google API:* ❌ \`${e.message}\``);
      }
    }

    // Email
    lines.push('');
    lines.push(`📧 *SMTP host:* \`${EMAIL_CFG.ionos_imap_host.replace('imap.', 'smtp.')}\``);
    lines.push(`👤 *SMTP usuario:* \`${EMAIL_CFG.ionos_email || '❌ NO CONFIGURADO'}\``);
    lines.push(`🔐 *SMTP contraseña:* ${EMAIL_CFG.ionos_password ? '✅ Configurada' : '❌ NO CONFIGURADA'}`);
    lines.push(`📬 *Destinatarios (RESUMEN_EMAIL_TO):* ${LAUNDRY_CFG.resumen_email_to.length ? LAUNDRY_CFG.resumen_email_to.map(e => `\`${e}\``).join(', ') : '❌ NO CONFIGURADO'}`);
    if (EMAIL_CFG.ionos_email && EMAIL_CFG.ionos_password) {
      try {
        const transporter = nodemailer.createTransport({
          host: EMAIL_CFG.ionos_imap_host.replace('imap.', 'smtp.'),
          port: 587,
          secure: false,
          auth: { user: EMAIL_CFG.ionos_email, pass: EMAIL_CFG.ionos_password },
        });
        await transporter.verify();
        lines.push('✉️ *Conexión SMTP:* ✅ OK');
      } catch (e) {
        lines.push(`✉️ *Conexión SMTP:* ❌ \`${e.message}\``);
      }
    }

    await laundryMsg(chatId, lines.join('\n'));
    return;
  }

  if (t === '/resumen') {
    const { startDate: sMJ, endDate: eMJ } = getPeriodDates('martes_jueves');
    const { startDate: sVM, endDate: eVM } = getPeriodDates('viernes_lunes');
    await laundryMsg(chatId,
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
      });
    return;
  }

  if (session.state === STATE.ASKING_RESPONSABLE) {
    if (!t || t.length < 2) { await laundryMsg(chatId, '⚠️ Por favor introduce un nombre válido.'); return; }
    session.responsable = t;
    session.state = STATE.ASKING_ITEM;
    session.step = 0;
    await laundryMsg(chatId, `✅ Hola *${t}*! Escribe *0* si no hay ninguno.\n\n*${ITEMS[0].label}* — ¿Cuántas unidades?`);
    return;
  }

  if (session.state === STATE.ASKING_ITEM) {
    const qty = parseInt(t, 10);
    if (isNaN(qty) || qty < 0) {
      await laundryMsg(chatId, `⚠️ Introduce un número válido.\n\n*${ITEMS[session.step].label}* — ¿Cuántas unidades?`);
      return;
    }
    session.data[ITEMS[session.step].key] = qty;
    session.step++;
    if (session.step < ITEMS.length) {
      await laundryMsg(chatId, `*${ITEMS[session.step].label}* — ¿Cuántas unidades?`);
    } else {
      session.state = STATE.CONFIRMING;
      await laundryMsg(chatId, buildConfirmText(session.flow, session.responsable, session.data), {
        reply_markup: { inline_keyboard: [[{ text: '✅ Confirmar', callback_data: 'confirm' }, { text: '❌ Cancelar', callback_data: 'cancel' }]] },
      });
    }
    return;
  }

  if (session.state === STATE.CONFIRMING) {
    await laundryMsg(chatId, 'Por favor usa los botones de arriba para confirmar o cancelar.');
    return;
  }

  await laundryMsg(chatId, 'Escribe /nuevo para registrar una recepción, /diario para un envío, o /ayuda para ver los comandos.');
}

async function handleLaundryCallback(chatId, callbackData, queryId) {
  await axios.post(`https://api.telegram.org/bot${LAUNDRY_CFG.telegram_token}/answerCallbackQuery`,
    { callback_query_id: queryId }, { timeout: 5000 }).catch(() => {});

  if (callbackData === 'start_albaran') { await startLaundryFlow(chatId, 'albaran'); return; }
  if (callbackData === 'start_diario')  { await startLaundryFlow(chatId, 'diario');  return; }

  if (callbackData === 'resumen_martes_jueves' || callbackData === 'resumen_viernes_lunes') {
    const periodKey = callbackData === 'resumen_martes_jueves' ? 'martes_jueves' : 'viernes_lunes';
    const { startDate, endDate, label } = getPeriodDates(periodKey);
    await laundryMsg(chatId, `⏳ Calculando totales para *${label}* (${formatDate(startDate)} → ${formatDate(endDate)})...`);
    const result = await getTotalsForPeriod(startDate, endDate);
    if (!result) {
      await laundryMsg(chatId, '❌ No se pudo conectar con Google Sheets. Contacta con el administrador.');
      return;
    }
    const { totals, rowCount } = result;
    if (rowCount === 0) {
      await laundryMsg(chatId, `ℹ️ No hay registros de envíos para *${label}* (${formatDate(startDate)} → ${formatDate(endDate)}).\n\nUsa /diario para registrar envíos.`);
      return;
    }
    await laundryMsg(chatId, '⏳ Guardando albarán en Google Sheets...');
    const [saved, emailed] = await Promise.all([
      saveResumen(label, startDate, endDate, totals, rowCount),
      sendResumenEmail(label, startDate, endDate, totals, rowCount),
    ]);
    const grandTotal = ITEMS.reduce((sum, item) => sum + (totals[item.key] || 0), 0);
    const lines = ITEMS.map(item => `  • ${item.label}: *${totals[item.key] || 0}*`);
    const sheetsMsg = saved
      ? `✅ _Guardado en Google Sheets._`
      : `⚠️ _No se pudo guardar en Google Sheets._`;
    const emailMsg = LAUNDRY_CFG.resumen_email_to.length
      ? (emailed ? `✅ _Email enviado._` : `⚠️ _No se pudo enviar el email._`)
      : '';
    const statusMsg = [sheetsMsg, emailMsg].filter(Boolean).join('\n');
    await laundryMsg(chatId,
      `📊 *Albarán de Envío a Selava*\n\n` +
      `📅 Período: *${label}*\n` +
      `🗓 ${formatDate(startDate)} → ${formatDate(endDate)}\n` +
      `📋 Registros: ${rowCount} envío${rowCount !== 1 ? 's' : ''}\n\n` +
      `${lines.join('\n')}\n\n` +
      `📦 *TOTAL PIEZAS: ${grandTotal}*\n\n` + statusMsg);
    return;
  }

  const session = getSession(chatId);
  if (session.state !== STATE.CONFIRMING) {
    await laundryMsg(chatId, 'No hay ningún registro pendiente. Usa /nuevo o /diario para empezar.');
    return;
  }
  if (callbackData === 'cancel') {
    resetSession(chatId);
    await laundryMsg(chatId, '❌ Registro cancelado.');
    return;
  }
  if (callbackData === 'confirm') {
    const isAlbaran = session.flow === 'albaran';
    await laundryMsg(chatId, `⏳ Guardando ${isAlbaran ? 'albarán' : 'envío diario'}...`);
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
      await laundryMsg(chatId,
        `${titulo}\n\n📅 Fecha: ${dateStr} a las ${timeStr}\n👤 Responsable: ${responsable}\n📦 Total artículos: *${total} unidades*\n\n_Los datos se han guardado en Google Sheets._\n\n${nextCmd}`);
    } else {
      await laundryMsg(chatId,
        `⚠️ *Registrado (sin Google Sheets)*\n\n📅 Fecha: ${dateStr} a las ${timeStr}\n👤 Responsable: ${responsable}\n📦 Total artículos: *${total} unidades*\n\n_No se pudo guardar en Google Sheets. Contacta con el administrador._\n\n${nextCmd}`);
    }
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
