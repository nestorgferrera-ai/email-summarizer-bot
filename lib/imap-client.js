// ============================================================================
// CLIENTE IMAP COMPARTIDO — usado por el bot de Telegram y por el servidor MCP
// ============================================================================
'use strict';

const ImapSimple = require('imap-simple');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error.response?.status;
      const nonRetryable = status >= 400 && status < 500;
      if (attempt === retries || nonRetryable) throw error;
      await new Promise(r => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
}

function getImapConfigFromEnv() {
  return {
    user: process.env.IONOS_EMAIL,
    password: process.env.IONOS_PASSWORD,
    host: process.env.IONOS_IMAP_HOST || 'imap.ionos.es',
    port: parseInt(process.env.IONOS_IMAP_PORT || '993', 10),
  };
}

async function connectToImap(config) {
  if (!config.user || !config.password) {
    throw new Error('Faltan credenciales IMAP (IONOS_EMAIL / IONOS_PASSWORD)');
  }
  return ImapSimple.connect({
    imap: {
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port,
      tls: true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: true },
    },
  });
}

async function messageToEmail(connection, msg) {
  const from = msg.headers?.from?.[0] || 'Desconocido';
  const subject = msg.headers?.subject?.[0] || '(sin asunto)';
  const dateStr = msg.headers?.date?.[0] || new Date().toISOString();
  let date = new Date(dateStr);
  if (isNaN(date.getTime())) date = new Date();

  let preview = '';
  try {
    const parts = ImapSimple.getParts(msg.attributes.struct);
    for (const part of parts) {
      if (part.type === 'text') {
        const partData = await connection.getPartData(msg, part);
        preview = partData.toString().substring(0, 200).replace(/\n/g, ' ');
        break;
      }
    }
  } catch {
    preview = '(no se pudo obtener preview)';
  }

  return { from, subject, preview: preview || '(sin contenido)', date, uid: msg.attributes.uid };
}

async function fetchEmails(connection, { days = null, last = 50 } = {}) {
  await connection.openBox('INBOX', false);

  let searchCriteria = ['ALL'];
  let cutoff = null;

  if (days) {
    cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    searchCriteria = [['SINCE', toImapDate(cutoff)]];
  }

  const fetchOptions = { bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)', struct: true };
  const allMessages = await connection.search(searchCriteria, fetchOptions);
  const messages = days ? allMessages : allMessages.slice(Math.max(0, allMessages.length - last));

  const emails = [];
  for (const msg of messages) {
    try {
      emails.push(await messageToEmail(connection, msg));
    } catch (err) {
      console.error(`⚠️ Error procesando correo: ${err.message}`);
    }
  }

  const filtered = cutoff ? emails.filter(e => e.date >= cutoff) : emails;
  return filtered.sort((a, b) => b.date - a.date);
}

function toImapDate(date) {
  return `${date.getDate()}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

// Interpreta prefijos "de:"/"from:" y "asunto:"/"subject:" como búsqueda por
// remitente o asunto; cualquier otro texto se busca en todo el mensaje (TEXT).
function parseSearchQuery(rawQuery) {
  const fromMatch = rawQuery.match(/^(?:de|from):\s*(.+)$/i);
  if (fromMatch) return { query: fromMatch[1].trim(), field: 'from' };
  const subjectMatch = rawQuery.match(/^(?:asunto|subject):\s*(.+)$/i);
  if (subjectMatch) return { query: subjectMatch[1].trim(), field: 'subject' };
  return { query: rawQuery.trim(), field: 'text' };
}

function buildSearchCriteria(query, field = 'text', { days = null } = {}) {
  const criteria = [];
  const key = field === 'from' ? 'FROM' : field === 'subject' ? 'SUBJECT' : 'TEXT';
  criteria.push([key, query]);
  if (days) criteria.push(['SINCE', toImapDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000))]);
  return criteria;
}

async function searchEmails(connection, criteria, { limit = 15 } = {}) {
  await connection.openBox('INBOX', false);
  const fetchOptions = { bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)', struct: true };
  const messages = await connection.search(criteria, fetchOptions);
  const recent = messages.slice(Math.max(0, messages.length - limit));

  const emails = [];
  for (const msg of recent) {
    try {
      emails.push(await messageToEmail(connection, msg));
    } catch (err) {
      console.error(`⚠️ Error procesando correo de búsqueda: ${err.message}`);
    }
  }

  return emails.sort((a, b) => b.date - a.date);
}

module.exports = {
  withRetry,
  getImapConfigFromEnv,
  connectToImap,
  messageToEmail,
  fetchEmails,
  parseSearchQuery,
  buildSearchCriteria,
  searchEmails,
};
