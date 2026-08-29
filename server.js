// ============================================================================
// SERVIDOR COMBINADO — Email Summarizer + Bot de Albaranes de Lavandería
// Clínica Bandama
// ============================================================================

const express = require('express');
const cron = require('node-cron');
const { simpleParser } = require('mailparser');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const nodemailer = require('nodemailer');
require('dotenv').config();

const { runEmailAnalysisAndDrafts, processIAFolder } = require('./email-analysis-drafts');
const {
  connectToImap,
  extractHeaders,
  fetchEmails,
  parseSearchQuery,
  searchEmails,
  findFolderByName,
  moveMessageToFolder,
} = require('./lib/imap-client');
const { interpretSearchQuery } = require('./lib/search-intent');
const { INTENT_TYPES, isValidType, setIntent, describeIntent } = require('./lib/ia-intents');

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
  ionos_smtp_host:  process.env.IONOS_SMTP_HOST || (process.env.IONOS_IMAP_HOST || 'imap.ionos.es').replace('imap.', 'smtp.'),
  ionos_smtp_port:  parseInt(process.env.IONOS_SMTP_PORT || '465'),
  gmail_user:       process.env.GMAIL_USER,
  gmail_app_pass:   process.env.GMAIL_APP_PASS,
  emailjs_service_id:  process.env.EMAILJS_SERVICE_ID,
  emailjs_template_id: process.env.EMAILJS_TEMPLATE_ID,
  emailjs_public_key:  process.env.EMAILJS_PUBLIC_KEY,
  emailjs_private_key: process.env.EMAILJS_PRIVATE_KEY,
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
  recepcion_sheet_tab:   process.env.RECEPCION_SHEET_TAB   || 'Albaranes PDF',
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
      const status = error.response?.status;
      const nonRetryable = status >= 400 && status < 500;
      if (attempt === retries || nonRetryable) throw error;
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
  const connection = await connectToImap({
    user: EMAIL_CFG.ionos_email,
    password: EMAIL_CFG.ionos_password,
    host: EMAIL_CFG.ionos_imap_host,
    port: EMAIL_CFG.ionos_imap_port,
  });
  console.log('✅ Conectado a Ionos IMAP');
  return connection;
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

Los correos están numerados del 1 al ${emails.length}, siendo el 1 el más reciente.

${emailsText}

Crea un resumen ejecutivo en español que:
1. Agrupe los correos por TEMA/PRIORIDAD (urgentes primero)
2. Destaque asuntos críticos: pacientes, facturación, seguros, recursos humanos
3. Sea MUY CONCISO (máximo ${tipo === 'semanal' ? '1500' : '1000'} caracteres)
4. Usa emojis para mayor claridad
5. Incluye recomendaciones de acciones inmediatas si las hay
6. IMPORTANTE: cada punto debe llevar entre corchetes el número del correo tal como aparece en la lista — ejemplo [3]. Todos los correos sin excepción deben aparecer numerados.

Formato:
🚨 URGENTE
• [1] Asunto: Descripción breve
• [4] Asunto: Descripción breve

📊 ADMINISTRATIVO
• [2] Asunto: Descripción breve

⏭️ PRÓXIMOS PASOS
- Acción 1`;

  return withRetry(async () => {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: EMAIL_CFG.claude_model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: { 'x-api-key': EMAIL_CFG.claude_api_key, 'anthropic-version': '2023-06-01' },
      timeout: 60000,
    });
    if (response.data.stop_reason === 'max_tokens') {
      console.warn(`⚠️ Resumen ${tipo} cortado por max_tokens — considera subir el límite o reducir el nº de correos`);
    }
    return response.data.content[0].text;
  });
}

function splitTelegramMessage(text, limit = 4000) {
  if (text.length <= limit) return [text];
  const chunks = [];
  const lines = text.split('\n');
  let current = '';

  const flush = () => {
    if (current) {
      chunks.push(current.trim());
      current = '';
    }
  };

  for (const line of lines) {
    if (line.length > limit) {
      // Una sola línea ya supera el límite: se trocea en bruto para no perderla.
      flush();
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }
    if ((current + '\n' + line).length > limit) {
      flush();
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  flush();
  return chunks;
}

async function sendTelegramChunks(fullMessage, chatId = null) {
  const chunks = splitTelegramMessage(fullMessage);
  const target = chatId || EMAIL_CFG.telegram_chat_id;
  let sent = 0;

  for (const chunk of chunks) {
    try {
      await withRetry(async () => {
        await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
          chat_id: target,
          text: chunk,
          parse_mode: 'Markdown',
        }, { timeout: 15000 });
      });
      sent++;
    } catch (error) {
      // Un fragmento puede quedar con una entidad Markdown sin cerrar (p.ej. un "*"
      // suelto). Reintentamos ese fragmento en texto plano en vez de abortar el resto.
      console.log(`⚠️ Fallo enviando fragmento en Markdown, reintentando en texto plano: ${error.message}`);
      try {
        await withRetry(async () => {
          await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
            chat_id: target,
            text: chunk,
          }, { timeout: 15000 });
        });
        sent++;
      } catch (plainError) {
        console.error(`❌ No se pudo enviar el fragmento ${sent + 1}/${chunks.length}:`, plainError.message);
      }
    }
  }
  return sent;
}

// Igual que sendTelegramChunks pero para un único mensaje que puede llevar
// extras (p.ej. reply_markup con botones inline); no se trocea porque está
// pensado para textos cortos como una tarjeta de resultado de búsqueda.
async function sendTelegramMessage(chatId, text, extra = {}) {
  try {
    await withRetry(async () => {
      await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
        chat_id: chatId, text, parse_mode: 'Markdown', ...extra,
      }, { timeout: 15000 });
    });
  } catch (error) {
    console.log(`⚠️ Fallo enviando mensaje en Markdown, reintentando en texto plano: ${error.message}`);
    try {
      await withRetry(async () => {
        await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
          chat_id: chatId, text, ...extra,
        }, { timeout: 15000 });
      });
    } catch (plainError) {
      console.error('❌ No se pudo enviar el mensaje:', plainError.message);
    }
  }
}

async function sendEmailTelegram(message, chatId = null) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const fullMessage = `📋 *Resumen de correos - ${dateStr}*\n\n${message}`;
  const count = await sendTelegramChunks(fullMessage, chatId);
  console.log(`✅ Resumen de email enviado por Telegram (${count} mensaje${count > 1 ? 's' : ''})`);
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
    const count = await sendTelegramChunks(`📅 *RESUMEN SEMANAL - ${dateStr}*\n\n${summary}`);
    console.log(`✅ Resumen semanal completado (${count} mensaje${count > 1 ? 's' : ''})`);
  } catch (error) {
    console.error('❌ Error en resumen semanal:', error.message);
    try { await sendEmailTelegram(`❌ Error en resumen semanal:\n\`\`\`\n${error.message}\n\`\`\``); } catch {}
  } finally {
    if (connection) { try { await connection.end(); } catch {} }
  }
}

async function handleEmailSearch(chatId, rawQuery) {
  let connection;
  try {
    // Interpreta la frase en lenguaje natural con Claude (p.ej. "de José Roca,
    // los últimos 5 correos" → { field: 'from', query: 'José Roca', limit: 5 }).
    // Si falla o no hay CLAUDE_API_KEY, cae al parser literal de:/asunto:.
    const interpreted = await interpretSearchQuery(rawQuery, {
      apiKey: EMAIL_CFG.claude_api_key,
    });
    const { query, field, unread } = interpreted || parseSearchQuery(rawQuery);
    const limit = interpreted?.limit ? Math.min(interpreted.limit, 30) : 15;
    const days = interpreted?.days || null;

    connection = await withRetry(() => connectToIonos());
    let emails = query
      ? await searchEmails(connection, { query, field, days, unread }, { limit })
      : await fetchEmails(connection, days ? { days, unread } : { last: limit, unread });

    // Si se buscó por remitente/asunto y no hubo resultados, reintenta en todo
    // el mensaje antes de rendirse: evita falsos negativos cuando el campo
    // interpretado no era el correcto (p.ej. el término está en el asunto de
    // un correo de otro remitente).
    if (emails.length === 0 && query && field !== 'text') {
      emails = await searchEmails(connection, { query, field: 'text', days, unread }, { limit });
    }

    if (emails.length === 0) {
      await sendTelegramChunks(`🔍 No se encontraron correos para: "${rawQuery}"`, chatId);
      return;
    }

    const unreadTag = unread ? ' 📩 sin leer' : '';
    const header = query
      ? `🔍 *Resultados para:* "${rawQuery}"${unreadTag} (${emails.length})`
      : `📬 *Últimos ${emails.length} correos${unreadTag}*`;
    await sendTelegramChunks(header, chatId);

    for (const [i, e] of emails.entries()) {
      const dateStr = e.date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = e.date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      const text = `${i + 1}. 📩 *${e.subject}*\n   De: ${e.from}\n   🗓 ${dateStr} ${timeStr}\n   _${e.preview}_`;
      await sendTelegramMessage(chatId, text, {
        reply_markup: { inline_keyboard: [[{ text: '🤖 IA', callback_data: `ia_menu_${e.uid}` }]] },
      });
    }
    console.log(`✅ Búsqueda de correos completada — "${rawQuery}" (${emails.length} resultados)`);
  } catch (error) {
    console.error('❌ Error en búsqueda de correos:', error.message);
    await sendTelegramChunks(`❌ Error al buscar correos:\n\`\`\`\n${error.message}\n\`\`\``, chatId);
  } finally {
    if (connection) { try { await connection.end(); } catch {} }
  }
}

// Correos a la espera de que el usuario escriba sus indicaciones tras elegir
// "✍️ Según mis comentarios": chatId → { uid, messageId, created_at }.
const pendingIAComments = new Map();
const IA_COMMENTS_TTL_MS = 30 * 60 * 1000;

// Teclado con los cuatro tipos de contestación que puede pedir el usuario
// antes de mandar el correo a la carpeta IA.
function buildIAIntentKeyboard(uid) {
  return {
    inline_keyboard: [
      [{ text: `${INTENT_TYPES.acuse.emoji} ${INTENT_TYPES.acuse.label}`,       callback_data: `ia_set_acuse_${uid}` }],
      [{ text: `${INTENT_TYPES.positiva.emoji} ${INTENT_TYPES.positiva.label}`, callback_data: `ia_set_positiva_${uid}` }],
      [{ text: `${INTENT_TYPES.negativa.emoji} ${INTENT_TYPES.negativa.label}`, callback_data: `ia_set_negativa_${uid}` }],
      [{ text: `${INTENT_TYPES.comentarios.emoji} ${INTENT_TYPES.comentarios.label}`, callback_data: `ia_set_comentarios_${uid}` }],
    ],
  };
}

// Sustituye el botón "🤖 IA" del resultado de búsqueda por el menú de tipos de
// respuesta, sobre el mismo mensaje para no perder de vista de qué correo se
// trata. Si Telegram no deja editarlo (mensaje antiguo), se manda aparte.
async function showIAIntentMenu(chatId, messageId, uid) {
  try {
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/editMessageReplyMarkup`, {
      chat_id: chatId, message_id: messageId, reply_markup: buildIAIntentKeyboard(uid),
    }, { timeout: 10000 });
  } catch (error) {
    console.log(`⚠️ No se pudo editar el teclado del mensaje ${messageId}: ${error.message}`);
    await sendTelegramMessage(chatId, '🤖 ¿Qué tipo de contestación quieres?', {
      reply_markup: buildIAIntentKeyboard(uid),
    });
  }
}

// Quita el teclado inline de un mensaje ya resuelto (para que no se pueda
// pulsar dos veces sobre el mismo correo).
async function clearInlineKeyboard(chatId, messageId) {
  if (!messageId) return;
  await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/editMessageReplyMarkup`, {
    chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
  }, { timeout: 10000 }).catch(() => {});
}

// Lee las cabeceras de un correo del INBOX por UID: hace falta el Message-ID
// para poder asociarle el tipo de respuesta, porque al mover el correo a la
// carpeta IA el UID cambia.
async function readInboxHeaders(connection, uid) {
  const messages = await connection.search([['UID', String(uid)]], {
    bodies: 'HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)',
    markSeen: false,
  });
  if (!messages.length) return null;
  const headers = extractHeaders(messages[0]);
  return {
    from:      headers.from?.[0] || '',
    subject:   headers.subject?.[0] || '(sin asunto)',
    messageId: headers['message-id']?.[0] || '',
  };
}

// Mueve el correo a la carpeta IA dejando anotado qué contestación se quiere,
// para que /ia redacte el borrador en ese sentido.
async function handleMoveToIA(chatId, uid, intentType = 'acuse', comments = '') {
  let connection;
  try {
    connection = await withRetry(() => connectToIonos());
    await connection.openBox('INBOX', false);
    const iaFolder = await findFolderByName(connection, 'IA', ['INBOX.IA', 'INBOX/IA', 'IA']);
    if (!iaFolder) {
      await sendTelegramChunks('⚠️ No se encontró la carpeta *IA* en el buzón. Créala en tu cliente de correo.', chatId);
      return;
    }

    const headers = await readInboxHeaders(connection, uid);
    if (!headers) {
      await sendTelegramChunks('⚠️ Ese correo ya no está en la bandeja de entrada (puede que se moviera antes).', chatId);
      return;
    }

    setIntent(headers, { type: intentType, comments });
    await moveMessageToFolder(connection, uid, iaFolder);

    const detail = comments ? `\n📝 Tus indicaciones: _${comments}_` : '';
    await sendTelegramChunks(
      `✅ Correo movido a la carpeta IA.\n🤖 Contestación: *${describeIntent(intentType)}*${detail}\n\nEjecuta /ia cuando quieras generar el borrador.`,
      chatId
    );
    console.log(`📥 "${headers.subject}" → carpeta IA (${intentType})`);
  } catch (error) {
    console.error('❌ Error moviendo correo a IA:', error.message);
    await sendTelegramChunks(`❌ Error moviendo el correo a IA:\n\`\`\`\n${error.message}\n\`\`\``, chatId);
  } finally {
    if (connection) { try { await connection.end(); } catch {} }
  }
}

async function handleSearchDebug(chatId, rawQuery) {
  const lines = ['🔍 *Diagnóstico de búsqueda*', ''];
  lines.push(`📧 IONOS_EMAIL: ${EMAIL_CFG.ionos_email ? '✅ configurado' : '❌ NO configurado'}`);
  lines.push(`🔐 IONOS_PASSWORD: ${EMAIL_CFG.ionos_password ? '✅ configurada' : '❌ NO configurada'}`);
  lines.push(`🤖 CLAUDE_API_KEY: ${EMAIL_CFG.claude_api_key ? '✅ configurada' : '❌ NO configurada (se usará el modo literal de:/asunto:)'}`);
  lines.push('');

  let connection;
  try {
    connection = await withRetry(() => connectToIonos());
    lines.push('🌐 Conexión IMAP: ✅ OK');

    await connection.openBox('INBOX', false);
    const all = await connection.search(['ALL'], { bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)' });
    lines.push(`📬 Correos en INBOX: ${all.length}`);

    const recent = all.slice(-3).reverse();
    if (recent.length > 0) {
      lines.push('');
      lines.push('*Últimos 3 correos (cabecera cruda):*');
      for (const msg of recent) {
        const headers = extractHeaders(msg);
        const from = headers.from?.[0] || '(sin remitente)';
        const subject = headers.subject?.[0] || '(sin asunto)';
        lines.push(`• ${subject} — ${from}`);
      }
    }
  } catch (err) {
    lines.push(`🌐 Conexión IMAP: ❌ ${err.message}`);
  } finally {
    if (connection) { try { await connection.end(); } catch {} }
  }

  if (rawQuery) {
    lines.push('');
    lines.push(`*Interpretación de:* "${rawQuery}"`);
    const interpreted = await interpretSearchQuery(rawQuery, { apiKey: EMAIL_CFG.claude_api_key });
    if (interpreted) {
      lines.push(`→ Claude: field=${interpreted.field}, query="${interpreted.query}", limit=${interpreted.limit ?? '(sin límite)'}, days=${interpreted.days ?? '(sin rango)'}, unread=${interpreted.unread}`);
    } else {
      const fallback = parseSearchQuery(rawQuery);
      lines.push(`→ Claude no disponible o falló. Modo literal: field=${fallback.field}, query="${fallback.query}"`);
    }
  }

  await sendTelegramChunks(lines.join('\n'), chatId);
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

// Artículos para recepción de Selava (orden de columnas en hoja "Albaranes PDF")
const RECEPCION_ITEMS = [
  { key: 'alfombrillas',     label: 'Alfombrillas' },
  { key: 'almohadas',        label: 'Almohadas' },
  { key: 'colchas',          label: 'Colchas' },
  { key: 'fundas_almohadas', label: 'Fundas Almohada' },
  { key: 'mantas',           label: 'Mantas' },
  { key: 'sabanas',          label: 'Sábanas' },
  { key: 'toallas_bano',     label: 'Toallas Baño' },
  { key: 'toallas_lavabo',   label: 'Toallas Lavabo' },
];

function getItemsForFlow(flow) {
  return flow === 'recepcion' ? RECEPCION_ITEMS : ITEMS;
}

const ITEM_COL_START = 4; // columna D (0-indexed)

const STATE = { IDLE: 'idle', ASKING_RESPONSABLE: 'asking_responsable', ASKING_ALBARAN_NUM: 'asking_albaran_num', ASKING_ITEM: 'asking_item', CONFIRMING: 'confirming' };
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
function parseSheetDateTime(str) {
  if (!str) return null;
  // Extrae DD/MM/YYYY y HH:MM[:SS] ignorando cualquier separador entre fecha y hora
  // (toLocaleString puede usar espacio fino U+202F que no divide con \s en todos los entornos)
  const m = String(str).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})[^\d]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, d, mo, y, hh, mm, ss] = m.map(v => v === undefined ? 0 : Number(v));
  if (!d || !mo || !y || isNaN(hh) || isNaN(mm)) return null;
  return new Date(y, mo - 1, d, hh, mm, ss, 0);
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

// ---- Google Sheets: recepción de Selava (hoja "Albaranes PDF") ----
async function saveRecepcionSelava(responsable, data) {
  if (!LAUNDRY_CFG.resumen_sheet_id || !LAUNDRY_CFG.google_credentials) {
    console.log('⚠️  Google Sheets (recepción Selava) no configurado');
    return false;
  }
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(LAUNDRY_CFG.google_credentials),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureSheetTabExists(sheets, LAUNDRY_CFG.resumen_sheet_id, LAUNDRY_CFG.recepcion_sheet_tab);
    const now = new Date();
    const fechaProceso = now.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const fechaAlbaran = formatDate(now);
    // Columnas: A=FechaProceso B=NºAlbarán C=FechaAlbarán D=Alfombrillas E=Almohadas
    // F=Colchas G=FundasAlmohada H=Mantas I=Sábanas J=ToallasBaño K=ToallasLavabo L=Total€ M=Archivo
    const row = [
      fechaProceso,
      data.albaran_num || '',
      fechaAlbaran,
      data.alfombrillas || 0,
      data.almohadas || 0,
      data.colchas || 0,
      data.fundas_almohadas || 0,
      data.mantas || 0,
      data.sabanas || 0,
      data.toallas_bano || 0,
      data.toallas_lavabo || 0,
      '',
      `Telegram Bot - ${responsable}`,
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: LAUNDRY_CFG.resumen_sheet_id,
      range: `${LAUNDRY_CFG.recepcion_sheet_tab}!A:M`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });
    console.log(`✅ Recepción Selava guardada — ${responsable} ${fechaAlbaran}`);
    return true;
  } catch (err) {
    console.error('❌ Error guardando recepción Selava:', err.message);
    return false;
  }
}

// ---- Email: notificación recepción Selava ----
async function sendRecepcionEmail(responsable, albaranNum, data) {
  const to = ['nestor-garcia@clinicabandama.com'];
  const now = new Date();
  const dateStr = formatDate(now);
  const grandTotal = RECEPCION_ITEMS.reduce((sum, item) => sum + (data[item.key] || 0), 0);
  const itemRows = RECEPCION_ITEMS.map(item =>
    `<tr><td style="padding:4px 12px">${item.label}</td><td style="padding:4px 12px;text-align:right"><strong>${data[item.key] || 0}</strong></td></tr>`
  ).join('');
  const html = `
<div style="font-family:Arial,sans-serif;max-width:500px">
  <h2 style="color:#2c3e50">📦 Recepción de Ropa — Selava</h2>
  <p><strong>Fecha:</strong> ${dateStr}<br>
     <strong>Nº Albarán:</strong> ${albaranNum || '—'}<br>
     <strong>Responsable:</strong> ${responsable}</p>
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
  <p style="color:#888;font-size:12px;margin-top:16px">Registrado vía Telegram — Bot Lavandería Clínica Bandama</p>
</div>`;
  const fmtSubject = d => d.replace(/\//g, '-');
  const subject = `Recepción Selava — Albarán ${albaranNum || fmtSubject(dateStr)} (${fmtSubject(dateStr)})`;

  if (EMAIL_CFG.emailjs_service_id && EMAIL_CFG.emailjs_template_id && EMAIL_CFG.emailjs_public_key) {
    try {
      await axios.post('https://api.emailjs.com/api/v1.0/email/send', {
        service_id:  EMAIL_CFG.emailjs_service_id,
        template_id: EMAIL_CFG.emailjs_template_id,
        user_id:     EMAIL_CFG.emailjs_public_key,
        accessToken: EMAIL_CFG.emailjs_private_key,
        template_params: {
          to_email:     to.join(', '),
          subject,
          html_content: html,
          period:       `Albarán ${albaranNum}`,
          date_range:   dateStr,
          row_count:    '1',
          grand_total:  String(grandTotal),
        },
      }, { timeout: 15000 });
      console.log(`✅ Email recepción enviado (EmailJS) a: ${to.join(', ')}`);
      return true;
    } catch (err) {
      console.error('❌ Error enviando email recepción (EmailJS):', err.response?.data || err.message);
    }
  }

  const useGmail = !!(EMAIL_CFG.gmail_user && EMAIL_CFG.gmail_app_pass);
  const hasIonos  = !!(EMAIL_CFG.ionos_email && EMAIL_CFG.ionos_password);
  if (!useGmail && !hasIonos) return false;
  try {
    const transporter = useGmail
      ? nodemailer.createTransport({
          host: 'smtp.gmail.com', port: 587, secure: false, family: 4,
          auth: { user: EMAIL_CFG.gmail_user, pass: EMAIL_CFG.gmail_app_pass },
          connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 15000,
        })
      : nodemailer.createTransport({
          host: EMAIL_CFG.ionos_smtp_host, port: EMAIL_CFG.ionos_smtp_port,
          secure: EMAIL_CFG.ionos_smtp_port === 465,
          auth: { user: EMAIL_CFG.ionos_email, pass: EMAIL_CFG.ionos_password },
          connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 15000,
        });
    const fromAddress = useGmail ? EMAIL_CFG.gmail_user : EMAIL_CFG.ionos_email;
    await transporter.sendMail({ from: `"Bot Lavandería" <${fromAddress}>`, to, subject, html });
    console.log(`✅ Email recepción enviado (SMTP) a: ${to.join(', ')}`);
    return true;
  } catch (err) {
    console.error('❌ Error enviando email recepción:', err.message);
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

// ---- Google Sheets: desglose diario últimos 7 días ----
async function getDailyBreakdown() {
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
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 6);
    const byDay = {};
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[1]) continue;
      const rowDate = parseSheetDate(row[1]);
      if (!rowDate || rowDate < weekAgo || rowDate > today) continue;
      const key = row[1]; // DD/MM/YYYY como clave
      if (!byDay[key]) byDay[key] = { date: rowDate, totals: Object.fromEntries(ITEMS.map(i => [i.key, 0])), entries: 0 };
      byDay[key].entries++;
      ITEMS.forEach((item, idx) => {
        const val = parseInt(row[ITEM_COL_START + idx], 10);
        if (!isNaN(val)) byDay[key].totals[item.key] += val;
      });
    }
    return byDay;
  } catch (err) {
    console.error('❌ Error leyendo desglose diario:', err.message);
    return null;
  }
}

// ---- Google Sheets: leer totales por período ----
async function getTotalsForPeriod(startDate, endDate, since = null) {
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
      if (since) {
        const rowTs = parseSheetDateTime(row[0]);
        if (!rowTs || rowTs <= since || rowTs > endDate) continue;
      } else {
        const rowDate = parseSheetDate(row[1]);
        if (!rowDate || rowDate < startDate || rowDate > endDate) continue;
      }
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
  if (!LAUNDRY_CFG.resumen_email_to.length) return false;
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
  const fmtSubject = d => formatDate(d).replace(/\//g, '-');
  const subject = `Albarán Envío Selava — ${periodLabel} (${fmtSubject(startDate)} → ${fmtSubject(endDate)})`;
  const to = LAUNDRY_CFG.resumen_email_to;

  // EmailJS (HTTPS) — no usa puertos SMTP, funciona en cualquier plataforma
  if (EMAIL_CFG.emailjs_service_id && EMAIL_CFG.emailjs_template_id && EMAIL_CFG.emailjs_public_key) {
    try {
      await axios.post('https://api.emailjs.com/api/v1.0/email/send', {
        service_id:  EMAIL_CFG.emailjs_service_id,
        template_id: EMAIL_CFG.emailjs_template_id,
        user_id:     EMAIL_CFG.emailjs_public_key,
        accessToken: EMAIL_CFG.emailjs_private_key,
        template_params: {
          to_email:   to.join(', '),
          subject,
          html_content: html,
          period:     periodLabel,
          date_range: `${formatDate(startDate)} → ${formatDate(endDate)}`,
          row_count:  String(rowCount),
          grand_total: String(grandTotal),
        },
      }, { timeout: 15000 });
      console.log(`✅ Email resumen enviado (EmailJS) a: ${to.join(', ')}`);
      return true;
    } catch (err) {
      console.error('❌ Error enviando email resumen (EmailJS):', err.response?.data || err.message);
      return false;
    }
  }

  // Fallback SMTP (IONOS / Gmail) — puede fallar en Render por bloqueo de puertos
  const useGmail = !!(EMAIL_CFG.gmail_user && EMAIL_CFG.gmail_app_pass);
  const hasIonos  = !!(EMAIL_CFG.ionos_email && EMAIL_CFG.ionos_password);
  if (!useGmail && !hasIonos) return false;
  try {
    const transporter = useGmail
      ? nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          family: 4,
          auth: { user: EMAIL_CFG.gmail_user, pass: EMAIL_CFG.gmail_app_pass },
          connectionTimeout: 10000,
          greetingTimeout: 8000,
          socketTimeout: 15000,
        })
      : nodemailer.createTransport({
          host: EMAIL_CFG.ionos_smtp_host,
          port: EMAIL_CFG.ionos_smtp_port,
          secure: EMAIL_CFG.ionos_smtp_port === 465,
          auth: { user: EMAIL_CFG.ionos_email, pass: EMAIL_CFG.ionos_password },
          connectionTimeout: 10000,
          greetingTimeout: 8000,
          socketTimeout: 15000,
        });
    const fromAddress = useGmail ? EMAIL_CFG.gmail_user : EMAIL_CFG.ionos_email;
    await transporter.sendMail({ from: `"Bot Lavandería" <${fromAddress}>`, to, subject, html });
    console.log(`✅ Email resumen enviado (SMTP) a: ${to.join(', ')}`);
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
      marcaTemporal, formatDate(now), timeStr,
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

// ---- Google Sheets: timestamp del último resumen generado ----
async function getLastResumenTimestamp() {
  if (!LAUNDRY_CFG.resumen_sheet_id || !LAUNDRY_CFG.google_credentials) return null;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(LAUNDRY_CFG.google_credentials),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: LAUNDRY_CFG.resumen_sheet_id,
      range: `${LAUNDRY_CFG.resumen_sheet_tab}!A:A`,
    });
    const rows = response.data.values || [];
    for (let i = rows.length - 1; i >= 1; i--) {
      const ts = parseSheetDateTime(rows[i]?.[0]);
      if (ts) return ts;
    }
    return null;
  } catch (err) {
    console.error('❌ Error leyendo último resumen:', err.message);
    return null;
  }
}

// ---- Lógica de conversación ----
function buildConfirmText(flow, responsable, data) {
  const flowItems = getItemsForFlow(flow);
  const lines = flowItems.map(item => `  • ${item.label}: *${data[item.key] || 0}*`);
  let titulo, pregunta, extra;
  if (flow === 'recepcion') {
    titulo = `📦 *Recepción de Selava — Albarán ${data.albaran_num || '—'}*`;
    pregunta = '¿Confirmas la recepción?';
    extra = `📋 Nº Albarán: *${data.albaran_num || '—'}*\n`;
  } else if (flow === 'albaran') {
    titulo = '📋 *Resumen del albarán de recepción*';
    pregunta = '¿Confirmas la recepción?';
    extra = '';
  } else {
    titulo = '🚚 *Resumen del envío diario*';
    pregunta = '¿Confirmas el envío?';
    extra = '';
  }
  return `${titulo}\n\n👤 Responsable: *${responsable}*\n${extra}\n${lines.join('\n')}\n\n${pregunta}`;
}

async function startLaundryFlow(chatId, flow) {
  resetSession(chatId);
  const s = getSession(chatId);
  s.state = STATE.ASKING_RESPONSABLE;
  s.flow = flow;
  const prompt = flow === 'recepcion'
    ? '👤 ¿Cuál es tu nombre? (Responsable de la recepción de Selava)'
    : flow === 'albaran'
    ? '👤 ¿Cuál es tu nombre? (Responsable de la recepción)'
    : '👤 ¿Cuál es tu nombre? (Responsable del envío)';
  await laundryMsg(chatId, prompt);
}

async function handleLaundryMessage(chatId, text, fromName, meta = {}) {
  // En grupos Telegram envía "/comando@NombreDelBot": quitamos el sufijo.
  const t = text.trim().replace(/^(\/[a-zA-Z0-9_]+)@[\w]+/, '$1');

  // /miid se responde ANTES del control de acceso a propósito: quien lo
  // necesita es justamente el integrante que todavía no está autorizado.
  if (t.toLowerCase() === '/miid' || t.toLowerCase() === '/id') {
    const { from, chat } = meta;
    const autorizado = LAUNDRY_CFG.allowed_chat_ids.length === 0 ||
                       LAUNDRY_CFG.allowed_chat_ids.includes(String(chatId));
    const lineas = [
      '🪪 *Tu ID de chat*',
      '',
      `\`${chatId}\``,
      '',
      `👤 ${String(fromName).replace(/([_*`\[\]])/g, '\\$1')}`,
    ];
    // En un grupo el ID que da acceso es el del grupo, no el de la persona.
    if (chat?.type && chat.type !== 'private') {
      lineas.push('👥 Este es el ID del *grupo*. Para dar acceso a una persona ' +
                  'en su chat privado, que escriba /miid hablando directamente con el bot.');
      if (from?.id) lineas.push(`🙋 Tu ID de usuario: \`${from.id}\``);
    }
    lineas.push('');
    lineas.push(autorizado
      ? '✅ Ya tienes acceso al bot.'
      : '⛔ Todavía no tienes acceso. Envía este número al administrador.');
    lineas.push('');
    lineas.push('*Para dar de alta a un nuevo integrante:*\n' +
                '1️⃣ Que abra este chat con el bot y escriba /miid\n' +
                '2️⃣ Que envíe el número al administrador\n' +
                '3️⃣ El administrador lo añade a `ALLOWED_CHAT_IDS` y reinicia el bot');
    await laundryMsg(chatId, lineas.join('\n'));
    return;
  }

  if (LAUNDRY_CFG.allowed_chat_ids.length > 0 && !LAUNDRY_CFG.allowed_chat_ids.includes(String(chatId))) {
    await laundryMsg(chatId,
      '⛔ No tienes acceso a este bot. Escribe /miid para ver tu ID y envíaselo al administrador.');
    return;
  }

  const session = getSession(chatId);

  if (t === '/start' || t === '/inicio') {
    resetSession(chatId);
    await laundryMsg(chatId,
      `🧺 *Bot de Lavandería — Clínica Bandama*\n\nHola ${fromName}!\n\n` +
      `*Comandos disponibles:*\n` +
      `/recepcion — Registrar recepción de ropa de Selava\n` +
      `/diario — Registrar envío de ropa a Selava\n` +
      `/semana — Ver desglose de envíos por día (última semana)\n` +
      `/resumen — Generar albarán de envíos por período\n` +
      `/cancelar — Cancelar registro en curso\n` +
      `/miid — Ver mi ID de chat (para dar de alta a un usuario)\n` +
      `/ayuda — Ver esta ayuda`);
    return;
  }

  if (t === '/ayuda' || t === '/help') {
    await laundryMsg(chatId,
      `📖 *Ayuda — Bot de Lavandería*\n\n` +
      `/recepcion — Registrar recepción de ropa de Selava\n` +
      `/diario — Registrar envío diario de ropa a Selava\n` +
      `/semana — Ver desglose de envíos por día (última semana)\n` +
      `/resumen — Generar albarán por período (Mar-Jue / Vie-Lun)\n` +
      `/cancelar — Cancelar el registro en curso\n` +
      `/miid — Ver mi ID de chat (para dar de alta a un usuario)\n\n` +
      `Escribe *0* si no hay unidades de algún artículo.\n\n` +
      `*¿Añadir un integrante nuevo?* Que abra el chat con el bot, escriba /miid ` +
      `y envíe el número al administrador para darle acceso.`);
    return;
  }

  if (t === '/cancelar' || t === '/cancel') {
    resetSession(chatId);
    await laundryMsg(chatId, '❌ Registro cancelado.');
    return;
  }

  if (t === '/recepcion') {
    await startLaundryFlow(chatId, 'recepcion');
    return;
  }

  if (t === '/nuevo') {
    await laundryMsg(chatId,
      `ℹ️ Usa */recepcion* para registrar la *recepción* de ropa de Selava.\n\n` +
      `Para registrar un *envío a Selava* usa */diario*.\n\n¿Qué quieres hacer?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📦 Registrar recepción de Selava', callback_data: 'start_recepcion' }],
            [{ text: '🚚 Registrar envío a Selava (/diario)', callback_data: 'start_diario'  }],
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
    lines.push(`📧 *SMTP host:* \`${EMAIL_CFG.ionos_smtp_host}\` (puerto ${EMAIL_CFG.ionos_smtp_port})`);
    lines.push(`👤 *SMTP usuario:* \`${EMAIL_CFG.ionos_email || '❌ NO CONFIGURADO'}\``);
    lines.push(`🔐 *SMTP contraseña:* ${EMAIL_CFG.ionos_password ? '✅ Configurada' : '❌ NO CONFIGURADA'}`);
    lines.push(`📬 *Destinatarios (RESUMEN_EMAIL_TO):* ${LAUNDRY_CFG.resumen_email_to.length ? LAUNDRY_CFG.resumen_email_to.map(e => `\`${e}\``).join(', ') : '❌ NO CONFIGURADO'}`);
    if (EMAIL_CFG.ionos_email && EMAIL_CFG.ionos_password) {
      try {
        const transporter = nodemailer.createTransport({
          host: EMAIL_CFG.ionos_smtp_host,
          port: EMAIL_CFG.ionos_smtp_port,
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

  if (t === '/semana') {
    await laundryMsg(chatId, '⏳ Cargando datos de la última semana...');
    const byDay = await getDailyBreakdown();
    if (!byDay) {
      await laundryMsg(chatId, '❌ No se pudo conectar con Google Sheets.');
      return;
    }
    const days = Object.values(byDay).sort((a, b) => b.date - a.date);
    if (days.length === 0) {
      await laundryMsg(chatId, 'ℹ️ No hay registros de envíos en los últimos 7 días.');
      return;
    }
    const lines = days.map(({ date, totals, entries }) => {
      const dateStr = formatDate(date);
      const total = ITEMS.reduce((s, item) => s + (totals[item.key] || 0), 0);
      const detalle = ITEMS.filter(item => totals[item.key] > 0)
        .map(item => `    • ${item.label}: ${totals[item.key]}`).join('\n');
      return `📅 *${dateStr}* — ${entries} envío${entries !== 1 ? 's' : ''} — *${total} piezas*\n${detalle}`;
    });
    await laundryMsg(chatId, `📆 *Resumen últimos 7 días*\n\n${lines.join('\n\n')}`);
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
    session.step = 0;
    if (session.flow === 'recepcion') {
      session.state = STATE.ASKING_ALBARAN_NUM;
      await laundryMsg(chatId, `✅ Hola *${t}*!\n\n📋 ¿Cuál es el *Nº de Albarán* de Selava? (ej: A-26/1234)`);
    } else {
      session.state = STATE.ASKING_ITEM;
      const flowItems = getItemsForFlow(session.flow);
      await laundryMsg(chatId, `✅ Hola *${t}*! Escribe *0* si no hay ninguno.\n\n*${flowItems[0].label}* — ¿Cuántas unidades?`);
    }
    return;
  }

  if (session.state === STATE.ASKING_ALBARAN_NUM) {
    if (!t || t.length < 1) { await laundryMsg(chatId, '⚠️ Por favor introduce el número de albarán.'); return; }
    session.data.albaran_num = t;
    session.state = STATE.ASKING_ITEM;
    session.step = 0;
    await laundryMsg(chatId, `✅ Albarán *${t}* registrado. Escribe *0* si no hay ninguno.\n\n*${RECEPCION_ITEMS[0].label}* — ¿Cuántas unidades?`);
    return;
  }

  if (session.state === STATE.ASKING_ITEM) {
    const qty = parseInt(t, 10);
    const flowItems = getItemsForFlow(session.flow);
    if (isNaN(qty) || qty < 0) {
      await laundryMsg(chatId, `⚠️ Introduce un número válido.\n\n*${flowItems[session.step].label}* — ¿Cuántas unidades?`);
      return;
    }
    session.data[flowItems[session.step].key] = qty;
    session.step++;
    if (session.step < flowItems.length) {
      await laundryMsg(chatId, `*${flowItems[session.step].label}* — ¿Cuántas unidades?`);
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

  await laundryMsg(chatId, 'Escribe /recepcion para registrar una recepción de Selava, /diario para un envío, o /ayuda para ver los comandos.');
}

async function handleLaundryCallback(chatId, callbackData, queryId) {
  await axios.post(`https://api.telegram.org/bot${LAUNDRY_CFG.telegram_token}/answerCallbackQuery`,
    { callback_query_id: queryId }, { timeout: 5000 }).catch(() => {});

  if (callbackData === 'start_recepcion') { await startLaundryFlow(chatId, 'recepcion'); return; }
  if (callbackData === 'start_albaran')   { await startLaundryFlow(chatId, 'albaran');   return; }
  if (callbackData === 'start_diario')    { await startLaundryFlow(chatId, 'diario');    return; }

  if (callbackData === 'resumen_martes_jueves' || callbackData === 'resumen_viernes_lunes') {
    const periodKey = callbackData === 'resumen_martes_jueves' ? 'martes_jueves' : 'viernes_lunes';
    const { startDate: periodStart, label } = getPeriodDates(periodKey);

    const lastTs = await getLastResumenTimestamp();
    let since = null;
    const windowEnd = new Date();

    if (lastTs) {
      since = new Date(lastTs.getTime() + 60 * 1000); // lastTs + 1 minuto
    }

    const displayStart = lastTs || periodStart;

    await laundryMsg(chatId, `⏳ Calculando totales para *${label}*...`);
    const result = await getTotalsForPeriod(periodStart, windowEnd, since);
    if (!result) {
      await laundryMsg(chatId, '❌ No se pudo conectar con Google Sheets. Contacta con el administrador.');
      return;
    }
    const { totals, rowCount } = result;
    if (rowCount === 0) {
      const desdeStr = since
        ? `${formatDate(since)} ${since.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`
        : formatDate(periodStart);
      await laundryMsg(chatId, `ℹ️ No hay registros de envíos para *${label}* desde ${desdeStr}.\n\nUsa /diario para registrar envíos.`);
      return;
    }
    await laundryMsg(chatId, '⏳ Guardando albarán en Google Sheets...');
    const [saved, emailed] = await Promise.all([
      saveResumen(label, displayStart, windowEnd, totals, rowCount),
      sendResumenEmail(label, displayStart, windowEnd, totals, rowCount),
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
      `🗓 ${formatDate(displayStart)} → ${formatDate(windowEnd)}\n` +
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
    const isAlbaran   = session.flow === 'albaran';
    const isRecepcion = session.flow === 'recepcion';
    const flowLabel   = isRecepcion ? 'recepción de Selava' : isAlbaran ? 'albarán' : 'envío diario';
    await laundryMsg(chatId, `⏳ Guardando ${flowLabel}...`);
    let saved;
    if (isRecepcion) {
      saved = await saveRecepcionSelava(session.responsable, session.data);
    } else if (isAlbaran) {
      saved = await saveAlbaran(session.responsable, session.data);
    } else {
      saved = await saveDailyEntry(session.responsable, session.data);
    }
    const { responsable, data, flow } = session;
    resetSession(chatId);
    const now = new Date();
    const dateStr = formatDate(now);
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const flowItems = getItemsForFlow(flow);
    const total = flowItems.reduce((sum, item) => sum + (data[item.key] || 0), 0);

    if (isRecepcion) {
      const albaranInfo = data.albaran_num ? `\n📋 Nº Albarán: *${data.albaran_num}*` : '';
      const itemLines = RECEPCION_ITEMS.map(item => `  • ${item.label}: *${data[item.key] || 0}*`).join('\n');
      if (saved) {
        const emailed = await sendRecepcionEmail(responsable, data.albaran_num, data);
        const emailStatus = emailed
          ? '✅ _Email enviado a nestor-garcia@clinicabandama.com_'
          : '⚠️ _No se pudo enviar el email._';
        await laundryMsg(chatId,
          `✅ *Recepción de Selava registrada*\n\n📅 Fecha: ${dateStr} a las ${timeStr}\n👤 Responsable: ${responsable}${albaranInfo}\n📦 Total artículos: *${total} unidades*\n\n${itemLines}\n\n_Datos guardados en Google Sheets._\n${emailStatus}\n\nUsa /recepcion para registrar otra recepción.`);
      } else {
        await laundryMsg(chatId,
          `⚠️ *Registrado (sin Google Sheets)*\n\n📅 Fecha: ${dateStr} a las ${timeStr}\n👤 Responsable: ${responsable}${albaranInfo}\n📦 Total artículos: *${total} unidades*\n\n_No se pudo guardar en Google Sheets. Contacta con el administrador._\n\nUsa /recepcion para registrar otra recepción.`);
      }
      return;
    }

    const titulo = isAlbaran ? '✅ *Albarán registrado correctamente*' : '✅ *Envío diario registrado*';
    const nextCmd = isAlbaran
      ? 'Usa /recepcion para registrar otra recepción.'
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

async function registerLaundryCommands() {
  if (!LAUNDRY_CFG.telegram_token) return;
  const commands = [
    { command: 'recepcion', description: 'Registrar recepción de ropa de Selava' },
    { command: 'diario',    description: 'Registrar envío diario a Selava' },
    { command: 'semana',    description: 'Ver desglose de envíos (última semana)' },
    { command: 'resumen',   description: 'Generar albarán de envíos por período' },
    { command: 'cancelar',  description: 'Cancelar el registro en curso' },
    { command: 'miid',      description: 'Ver mi ID de chat (para dar de alta a un usuario)' },
    { command: 'ayuda',     description: 'Ver comandos disponibles' },
  ];
  try {
    await axios.post(
      `https://api.telegram.org/bot${LAUNDRY_CFG.telegram_token}/setMyCommands`,
      { commands },
      { timeout: 10000 }
    );
    await axios.post(
      `https://api.telegram.org/bot${LAUNDRY_CFG.telegram_token}/setChatMenuButton`,
      { menu_button: { type: 'commands' } },
      { timeout: 10000 }
    );
    console.log('✅ Comandos y botón Menú registrados — Bot Lavandería');
  } catch (err) {
    console.error('❌ Error registrando comandos lavandería:', err.message);
  }
}

async function registerEmailCommands() {
  if (!EMAIL_CFG.telegram_token) return;
  const commands = [
    { command: 'resumen',    description: 'Resumen de los últimos correos' },
    { command: 'semanal',    description: 'Resumen semanal de correos' },
    { command: 'buscar',     description: 'Buscar correos (texto, de:, asunto:)' },
    { command: 'borradores', description: 'Analizar correos de ayer y crear borradores' },
    { command: 'ia',         description: 'Procesar ahora la carpeta IA' },
    { command: 'ayuda',      description: 'Ver comandos disponibles' },
  ];
  try {
    await axios.post(
      `https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/setMyCommands`,
      { commands },
      { timeout: 10000 }
    );
    console.log('✅ Comandos registrados — Bot Email');
  } catch (err) {
    console.error('❌ Error registrando comandos email:', err.message);
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
      { url: `${EMAIL_CFG.app_url}/email-webhook`, allowed_updates: ['message', 'callback_query'] }, { timeout: 10000 });
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

  const callbackQuery = req.body?.callback_query;
  if (callbackQuery) {
    const chatId = callbackQuery.message.chat.id.toString();
    if (chatId !== EMAIL_CFG.telegram_chat_id) return;

    const data      = callbackQuery.data || '';
    const messageId = callbackQuery.message.message_id;
    const ack = (text) => axios.post(
      `https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/answerCallbackQuery`,
      { callback_query_id: callbackQuery.id, text }, { timeout: 5000 }
    ).catch(() => {});

    // "🤖 IA" → desplegar los cuatro tipos de contestación
    if (data.startsWith('ia_menu_')) {
      const uid = parseInt(data.slice('ia_menu_'.length), 10);
      await ack('🤖 Elige el tipo de contestación');
      if (!isNaN(uid)) await showIAIntentMenu(chatId, messageId, uid);
      return;
    }

    // "ia_set_<tipo>_<uid>" → tipo de contestación elegido
    if (data.startsWith('ia_set_')) {
      const rest = data.slice('ia_set_'.length);
      const sep  = rest.lastIndexOf('_');
      const type = sep > 0 ? rest.slice(0, sep) : '';
      const uid  = parseInt(rest.slice(sep + 1), 10);
      if (!isValidType(type) || isNaN(uid)) {
        await ack('⚠️ Opción no válida');
        return;
      }

      // Con comentarios el correo no se mueve todavía: primero hay que esperar
      // a que el usuario escriba qué quiere que diga la respuesta.
      if (type === 'comentarios') {
        await ack('✍️ Escríbeme tus indicaciones');
        pendingIAComments.set(chatId, { uid, messageId, created_at: Date.now() });
        await sendTelegramChunks(
          '✍️ Escribe en el chat qué quieres que diga la contestación y desarrollaré el borrador a partir de tus indicaciones.\n\nEscribe /cancelar para dejarlo.',
          chatId
        );
        return;
      }

      await ack('⏳ Moviendo a la carpeta IA...');
      pendingIAComments.delete(chatId);
      await clearInlineKeyboard(chatId, messageId);
      await handleMoveToIA(chatId, uid, type);
      return;
    }

    // Botones "📥 Mover a IA" de mensajes anteriores a los cuatro tipos:
    // se mantienen funcionando con el acuse de recibo de siempre.
    if (data.startsWith('move_ia_')) {
      const uid = parseInt(data.slice('move_ia_'.length), 10);
      await ack('⏳ Moviendo a la carpeta IA...');
      if (!isNaN(uid)) await handleMoveToIA(chatId, uid, 'acuse');
    }
    return;
  }

  const message = req.body?.message;
  if (!message) return;
  const text = (message.text || '').trim();
  const chatId = message.chat.id.toString();
  if (chatId !== EMAIL_CFG.telegram_chat_id) return;

  // Indicaciones pedidas tras elegir "✍️ Según mis comentarios": el siguiente
  // mensaje de texto del usuario es el contenido que debe desarrollar el
  // borrador. Cualquier comando cancela la espera.
  const pendingComments = pendingIAComments.get(chatId);
  if (pendingComments) {
    const expired = Date.now() - pendingComments.created_at > IA_COMMENTS_TTL_MS;
    if (expired) {
      pendingIAComments.delete(chatId);
    } else if (/^\/cancelar\b/i.test(text)) {
      pendingIAComments.delete(chatId);
      await clearInlineKeyboard(chatId, pendingComments.messageId);
      await sendTelegramChunks('❎ Cancelado. El correo se queda en la bandeja de entrada.', chatId);
      return;
    } else if (text.startsWith('/')) {
      pendingIAComments.delete(chatId);
      await sendTelegramChunks('❎ Se cancela la espera de indicaciones para la carpeta IA.', chatId);
    } else if (text) {
      pendingIAComments.delete(chatId);
      await clearInlineKeyboard(chatId, pendingComments.messageId);
      await handleMoveToIA(chatId, pendingComments.uid, 'comentarios', text);
      return;
    }
  }

  if (text === '/resumen') {
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`,
      { chat_id: chatId, text: '⏳ Generando resumen, un momento...' }).catch(() => {});
    await sendDailyEmailSummary(chatId);
  } else if (text === '/semanal') {
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`,
      { chat_id: chatId, text: '⏳ Generando resumen semanal...' }).catch(() => {});
    await sendWeeklyEmailSummary();
  } else if (text === '/borradores') {
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
      chat_id: chatId,
      text: '🤖 Analizando correos del día anterior y creando borradores...\nEsto puede tardar unos minutos. Recibirás un email con el resumen cuando termine.',
    }).catch(() => {});
    runEmailAnalysisAndDrafts()
      .then(() => axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
        chat_id: chatId,
        text: '✅ Análisis completado. Revisa tu bandeja de borradores y el resumen en tu email.',
      }).catch(() => {}))
      .catch(err => axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
        chat_id: chatId,
        text: `❌ Error en análisis de borradores: ${err.message}`,
      }).catch(() => {}));
  } else if (text === '/ia') {
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
      chat_id: chatId,
      text: '📁 Comprobando carpeta IA...',
    }).catch(() => {});
    processIAFolder()
      .then(result => {
        const detail = (result.items || [])
          .map(item => `• ${item.intent_label || ''} — ${item.subject}`)
          .join('\n');
        const msg = result.count > 0
          ? `✅ ${result.count} borrador(es) creado(s) desde la carpeta IA.\n${detail}\n\nRevisa la carpeta Borradores.`
          : '📭 No hay correos pendientes en la carpeta IA.';
        return axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
          chat_id: chatId, text: msg,
        }).catch(() => {});
      })
      .catch(err => axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
        chat_id: chatId,
        text: `❌ Error carpeta IA: ${err.message}`,
      }).catch(() => {}));
  } else if (text === '/buscar' || text.startsWith('/buscar ')) {
    const query = text.replace(/^\/buscar\s*/i, '').trim();
    if (!query) {
      await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
        chat_id: chatId,
        text: '🔍 Uso: `/buscar <texto>`\n\nEjemplos:\n• /buscar factura selava\n• /buscar de José Roca\n• /buscar de Jerónimo que mencione a Carlos Roca\n• /buscar de Mapfre del último mes\n• /buscar correos sin leer de Jerónimo\n• /buscar de:mapfre (sintaxis literal también funciona)',
        parse_mode: 'Markdown',
      }).catch(() => {});
      return;
    }
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`,
      { chat_id: chatId, text: `🔍 Buscando "${query}"...` }).catch(() => {});
    await handleEmailSearch(chatId, query);
  } else if (text === '/buscardebug' || text.startsWith('/buscardebug ')) {
    const query = text.replace(/^\/buscardebug\s*/i, '').trim();
    await handleSearchDebug(chatId, query);
  } else if (text === '/ayuda') {
    await axios.post(`https://api.telegram.org/bot${EMAIL_CFG.telegram_token}/sendMessage`, {
      chat_id: chatId,
      text: '📋 *Comandos:*\n\n/resumen — Últimos correos\n/semanal — Últimos 7 días\n/buscar <texto> — Buscar correos (de: / asunto: opcional); cada resultado trae un botón 🤖 IA\n/borradores — Analizar correos de ayer y crear borradores de respuesta\n/ia — Procesar ahora la carpeta IA\n/ayuda — Esta ayuda\n\n🤖 *Botón IA* — al pulsarlo eliges cómo quieres contestar:\n📨 Acuse de recibo\n✅ Respuesta positiva\n❌ Respuesta negativa\n✍️ Según mis comentarios (te pide que escribas qué decir y lo desarrolla)',
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
    await handleLaundryMessage(chat.id, text || '', from?.first_name || from?.username || 'Usuario', { from, chat });
  }
  if (update.callback_query) {
    const cb = update.callback_query;
    await handleLaundryCallback(cb.message.chat.id, cb.data, cb.id);
  }
});

app.post('/set-menu', async (req, res) => {
  try {
    await registerLaundryCommands();
    res.json({ status: 'ok', message: 'Comandos y botón Menú registrados en Telegram' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
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
  await registerEmailCommands();
  await registerLaundryCommands();
});

process.on('unhandledRejection', (reason) => console.error('❌ Promesa rechazada:', reason));
process.on('uncaughtException', (error) => console.error('❌ Excepción no capturada:', error));
