// ============================================================================
// CLIENTE IMAP COMPARTIDO — usado por el bot de Telegram, el servidor MCP y el
// análisis de correos con borradores. Basado en imapflow.
// ============================================================================
'use strict';

const { ImapFlow } = require('imapflow');

// Tope de UIDs por comando FETCH, para no pasarse del límite de línea del servidor.
const FETCH_CHUNK = 250;
// Bytes que se descargan como máximo de una parte de texto (el HTML lleva mucho
// marcado, así que se deja más margen antes de quitarle las etiquetas).
const MAX_PLAIN_BYTES = 64 * 1024;
const MAX_HTML_BYTES = 256 * 1024;

async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error.response?.status;
      // Una contraseña incorrecta no se arregla reintentando (y puede bloquear la cuenta).
      const nonRetryable = (status >= 400 && status < 500) || error.authenticationFailed;
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
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    tls: { rejectUnauthorized: true },
  });
  // Sin listener, un corte de socket (p.ej. el servidor cierra la conexión por
  // inactividad) tumbaría todo el proceso con una excepción no capturada.
  client.on('error', err => console.error(`⚠️ Error IMAP: ${err.message}`));

  try {
    await client.connect();
  } catch (err) {
    if (err.authenticationFailed) {
      const e = new Error('Autenticación IMAP rechazada (revisa IONOS_EMAIL / IONOS_PASSWORD)');
      e.authenticationFailed = true;
      throw e;
    }
    throw new Error(err.responseText || err.message);
  }
  return client;
}

// Cierra la conexión sin lanzar nunca: se usa en los `finally`.
async function closeImap(client) {
  if (!client) return;
  try {
    await client.logout();
  } catch {
    try { client.close(); } catch { /* noop */ }
  }
}

// --- Normalización de mensajes ----------------------------------------------

// Los nombres con caracteres especiales (p.ej. "Pérez, Jerónimo") van entre
// comillas, para que la cadena siga siendo una dirección válida si se reutiliza
// como destinatario de un correo.
function formatAddresses(list) {
  return (list || [])
    .map(a => {
      if (!(a.name && a.address)) return a.address || a.name || '';
      const name = /[()<>[\]:;@\\,."]/.test(a.name) ? `"${a.name.replace(/(["\\])/g, '\\$1')}"` : a.name;
      return `${name} <${a.address}>`;
    })
    .filter(Boolean)
    .join(', ');
}

// El FETCH con `headers: ['references']` devuelve las líneas de cabecera en bruto
// ("References: <a> <b>\r\n\r\n", posiblemente plegadas en varias líneas).
function parseReferences(headersBuffer) {
  if (!headersBuffer) return '';
  return headersBuffer.toString('utf8')
    .replace(/\r?\n[ \t]+/g, ' ')
    .replace(/^\s*references:\s*/i, '')
    .trim();
}

function normalizeMessage(msg) {
  const env = msg.envelope || {};
  let date = env.date ? new Date(env.date) : null;
  if (date && isNaN(date.getTime())) date = null;
  return {
    uid: msg.uid,
    from: formatAddresses(env.from),
    to: formatAddresses(env.to),
    subject: env.subject || '',
    date,
    messageId: env.messageId || '',
    inReplyTo: env.inReplyTo || '',
    references: parseReferences(msg.headers),
    bodyStructure: msg.bodyStructure,
  };
}

// Descarga cabeceras y estructura de los UIDs indicados (en el buzón abierto).
// Se recoge todo antes de devolver: no se puede lanzar otro comando IMAP
// mientras se itera el FETCH.
async function fetchMessages(connection, uids, { references = false } = {}) {
  const query = { uid: true, envelope: true, bodyStructure: true };
  if (references) query.headers = ['references'];

  const messages = [];
  for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
    const chunk = uids.slice(i, i + FETCH_CHUNK);
    for await (const msg of connection.fetch(chunk.join(','), query, { uid: true })) {
      messages.push(normalizeMessage(msg));
    }
  }
  return messages.sort((a, b) => a.uid - b.uid);
}

// Un único mensaje por UID, o null si ya no está en el buzón abierto.
async function fetchMessageByUid(connection, uid, opts = {}) {
  const [message] = await fetchMessages(connection, [Number(uid)], opts);
  return message || null;
}

// UIDs (ascendentes) que cumplen el criterio, en el buzón abierto.
async function searchUids(connection, query) {
  const uids = await connection.search(query, { uid: true });
  return uids || [];
}

// --- Cuerpo del mensaje -------------------------------------------------------

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Hojas del árbol MIME que son texto (no adjuntos ni mensajes reenviados).
function collectTextParts(node, acc = []) {
  if (!node) return acc;
  if (node.childNodes && node.childNodes.length) {
    if (String(node.type).toLowerCase() === 'message/rfc822') return acc;
    node.childNodes.forEach(child => collectTextParts(child, acc));
    return acc;
  }
  const type = String(node.type || '').toLowerCase();
  if (type.startsWith('text/') && node.disposition !== 'attachment') acc.push({ ...node, type });
  return acc;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Texto del correo: la parte text/plain, o el HTML sin etiquetas si no la hay.
// imapflow ya decodifica la codificación de transferencia y pasa el texto a UTF-8.
async function fetchBodyText(connection, message) {
  const parts = collectTextParts(message.bodyStructure);
  const plain = parts.find(p => p.type === 'text/plain');
  const chosen = plain || parts.find(p => p.type === 'text/html');
  if (!chosen) return '';

  const { content } = await connection.download(String(message.uid), chosen.part || '1', {
    uid: true,
    maxBytes: plain ? MAX_PLAIN_BYTES : MAX_HTML_BYTES,
  });
  if (!content) return '';
  const text = await streamToString(content);
  return plain ? text : stripHtml(text);
}

async function messageToEmail(connection, message) {
  let date = message.date;
  if (!date) date = new Date();

  let preview = '';
  try {
    const text = await fetchBodyText(connection, message);
    preview = text.replace(/\s+/g, ' ').trim().substring(0, 200);
  } catch {
    preview = '(no se pudo obtener preview)';
  }

  return {
    from: message.from || 'Desconocido',
    subject: message.subject || '(sin asunto)',
    preview: preview || '(sin contenido)',
    date,
    uid: message.uid,
  };
}

// --- Búsqueda ---------------------------------------------------------------

// IMAP SEARCH compara solo el día. imapflow formatea las fechas en UTC, así que
// se le pasa la medianoche UTC del día natural local (el mismo que usaba el
// formato "D-Mon-YYYY" anterior) para que no se desplace un día.
function toImapDay(date) {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

// Combina "sin leer" y "últimos N días" en un único criterio de SEARCH; ambos
// se aplican con AND si se piden a la vez.
function buildBaseCriteria({ days = null, unread = false } = {}) {
  const criteria = {};
  if (unread) criteria.seen = false;
  if (days) criteria.since = toImapDay(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  return Object.keys(criteria).length ? criteria : { all: true };
}

async function fetchEmails(connection, { days = null, last = 50, unread = false } = {}) {
  await connection.mailboxOpen('INBOX');

  const cutoff = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
  const uids = await searchUids(connection, buildBaseCriteria({ days, unread }));
  const selected = days ? uids : uids.slice(Math.max(0, uids.length - last));
  const messages = await fetchMessages(connection, selected);

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

// Interpreta prefijos "de:"/"from:" y "asunto:"/"subject:" como búsqueda por
// remitente o asunto; cualquier otro texto se busca en todo el mensaje (TEXT).
// También reconoce "sin leer"/"no leídos"/"unread" en cualquier parte del
// texto como filtro de correos no leídos (IMAP UNSEEN).
function parseSearchQuery(rawQuery) {
  let text = rawQuery;
  let unread = false;
  const unreadMatch = text.match(/\b(sin leer|no le[íi]dos?|unread)\b/i);
  if (unreadMatch) {
    unread = true;
    text = (text.slice(0, unreadMatch.index) + text.slice(unreadMatch.index + unreadMatch[0].length)).trim();
  }

  const fromMatch = text.match(/^(?:de|from):\s*(.+)$/i);
  if (fromMatch) return { query: fromMatch[1].trim(), field: 'from', unread };
  const subjectMatch = text.match(/^(?:asunto|subject):\s*(.+)$/i);
  if (subjectMatch) return { query: subjectMatch[1].trim(), field: 'subject', unread };
  return { query: text.trim(), field: 'text', unread };
}

// --- Carpetas ---------------------------------------------------------------

async function listFolders(connection) {
  try {
    return await connection.list();
  } catch {
    return [];
  }
}

// Busca una carpeta por nombre en cualquier nivel del árbol de buzones y
// devuelve su ruta real, con el delimitador del servidor (necesario para
// localizar subcarpetas tipo "INBOX.IA" o "INBOX/IA"). Si no aparece en el
// listado, prueba directamente los nombres de fallbackNames (rutas habituales).
async function findFolderByName(connection, targetName, fallbackNames = []) {
  const folders = await listFolders(connection);
  const found = folders.find(f => f.name === targetName);
  if (found) return found.path;
  return fallbackNames.find(name => folders.some(f => f.path === name)) || null;
}

// Busca una carpeta por su atributo especial (p.ej. "\Drafts") y, si el
// servidor no lo informa, por los nombres habituales.
async function findSpecialUseFolder(connection, specialUse, fallbackNames = []) {
  const folders = await listFolders(connection);
  const found = folders.find(f => f.specialUse === specialUse);
  if (found) return found.path;
  return fallbackNames.find(name => folders.some(f => f.path === name)) || null;
}

// Mueve un mensaje (por UID) de la carpeta actualmente seleccionada a
// targetFolder. imapflow usa MOVE si el servidor lo soporta, y si no, hace
// COPY + marcar \Deleted + EXPUNGE.
async function moveMessageToFolder(connection, uid, targetFolder) {
  const result = await connection.messageMove(String(uid), targetFolder, { uid: true });
  if (!result) throw new Error(`No se pudo mover el correo ${uid} a ${targetFolder}`);
}

// Añade un mensaje (Buffer con el MIME completo) a una carpeta.
async function appendMessage(connection, folder, rawMime, { flags = [], date = new Date() } = {}) {
  const result = await connection.append(folder, rawMime, flags, date);
  if (!result) throw new Error(`No se pudo guardar el mensaje en ${folder}`);
}

async function markAnswered(connection, uid) {
  await connection.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true });
}

// Busca coincidencias comparando texto ya decodificado (from/subject/preview),
// en vez de delegar en el SEARCH del servidor IMAP: la mayoría de los cuerpos
// de correo van codificados en quoted-printable/base64, así que un SEARCH
// TEXT/SUBJECT del propio servidor compara contra esos bytes crudos y casi
// nunca encuentra coincidencias con el texto tal como lo ve un humano.
async function searchEmails(connection, { query, field = 'text', days = null, unread = false } = {}, { limit = 15, scanLimit = 200 } = {}) {
  await connection.mailboxOpen('INBOX');

  const uids = await searchUids(connection, buildBaseCriteria({ days, unread }));
  // Más recientes primero, limitando cuántos mensajes se inspeccionan en profundidad
  const messages = await fetchMessages(connection, uids.slice(-scanLimit));
  const candidates = messages.reverse();

  // Cada palabra del término de búsqueda debe aparecer en algún sitio (AND),
  // sin exigir que formen una frase exacta contigua.
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = [];

  for (const msg of candidates) {
    const from = msg.from.toLowerCase();
    const subject = msg.subject.toLowerCase();

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
  closeImap,
  toImapDay,
  searchUids,
  fetchMessages,
  fetchMessageByUid,
  fetchBodyText,
  stripHtml,
  messageToEmail,
  fetchEmails,
  parseSearchQuery,
  searchEmails,
  findFolderByName,
  findSpecialUseFolder,
  moveMessageToFolder,
  appendMessage,
  markAnswered,
};
