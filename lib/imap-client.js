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

// imap-simple no expone un `.headers` en los mensajes devueltos por search():
// las cabeceras pedidas via `bodies: 'HEADER.FIELDS (...)'` llegan dentro de
// `msg.parts`, en la parte cuyo `which` empieza por "HEADER", ya parseadas
// como objeto { from: [...], subject: [...], date: [...] }.
function extractHeaders(msg) {
  const headerPart = (msg.parts || []).find(p => p.which && p.which.startsWith('HEADER'));
  return (headerPart && headerPart.body) ? headerPart.body : {};
}

async function messageToEmail(connection, msg) {
  const headers = extractHeaders(msg);
  const from = headers.from?.[0] || 'Desconocido';
  const subject = headers.subject?.[0] || '(sin asunto)';
  const dateStr = headers.date?.[0] || new Date().toISOString();
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

// Busca coincidencias comparando texto ya decodificado (from/subject/preview),
// en vez de delegar en el SEARCH del servidor IMAP: la mayoría de los cuerpos
// de correo van codificados en quoted-printable/base64, así que un SEARCH
// TEXT/SUBJECT del propio servidor compara contra esos bytes crudos y casi
// nunca encuentra coincidencias con el texto tal como lo ve un humano.
async function searchEmails(connection, { query, field = 'text', days = null } = {}, { limit = 15, scanLimit = 200 } = {}) {
  await connection.openBox('INBOX', false);

  let searchCriteria = ['ALL'];
  if (days) searchCriteria = [['SINCE', toImapDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000))]];

  const fetchOptions = { bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)', struct: true };
  const allMessages = await connection.search(searchCriteria, fetchOptions);
  // Más recientes primero, limitando cuántos mensajes se inspeccionan en profundidad
  const candidates = allMessages.slice(-scanLimit).reverse();

  // Cada palabra del término de búsqueda debe aparecer en algún sitio (AND),
  // sin exigir que formen una frase exacta contigua.
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = [];

  for (const msg of candidates) {
    const headers = extractHeaders(msg);
    const from = (headers.from?.[0] || '').toLowerCase();
    const subject = (headers.subject?.[0] || '').toLowerCase();

    // "from"/"subject": solo esa cabecera decide la coincidencia.
    if (field === 'from' || field === 'subject') {
      const haystack = field === 'from' ? from : subject;
      if (!terms.every(term => haystack.includes(term))) continue;
      try {
        matches.push(await messageToEmail(connection, msg));
      } catch (err) {
        console.error(`⚠️ Error procesando correo de búsqueda: ${err.message}`);
        continue;
      }
      if (matches.length >= limit) break;
      continue;
    }

    // "text": los términos pueden repartirse entre remitente/asunto y cuerpo
    // (p.ej. "correo de Jerónimo que menciona a Carlos Roca" — el remitente
    // está en la cabecera y "Carlos Roca" en el cuerpo), así que primero se
    // prueba solo con cabeceras (sin I/O extra) y, si no basta, se descarga
    // el cuerpo y se comprueba contra cabeceras + cuerpo combinados.
    const headerHaystack = `${from} ${subject}`;
    if (terms.every(term => headerHaystack.includes(term))) {
      try {
        matches.push(await messageToEmail(connection, msg));
      } catch (err) {
        console.error(`⚠️ Error procesando correo de búsqueda: ${err.message}`);
        continue;
      }
      if (matches.length >= limit) break;
      continue;
    }

    let email;
    try {
      email = await messageToEmail(connection, msg);
    } catch (err) {
      console.error(`⚠️ Error procesando correo de búsqueda: ${err.message}`);
      continue;
    }
    const fullHaystack = `${headerHaystack} ${email.preview}`.toLowerCase();
    if (terms.every(term => fullHaystack.includes(term))) {
      matches.push(email);
      if (matches.length >= limit) break;
    }
  }

  return matches;
}

module.exports = {
  withRetry,
  getImapConfigFromEnv,
  connectToImap,
  extractHeaders,
  messageToEmail,
  fetchEmails,
  parseSearchQuery,
  searchEmails,
};
