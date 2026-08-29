// ============================================================================
// INTENCIONES DE RESPUESTA PARA LA CARPETA IA
// Guarda, por correo, qué tipo de contestación quiere el usuario cuando lo
// manda a la carpeta IA desde Telegram (acuse de recibo, positiva, negativa o
// desarrollada a partir de sus comentarios). La clave es el Message-ID del
// correo, porque el UID cambia al moverlo de INBOX a la carpeta IA.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// Cada tipo aporta la instrucción concreta que se le añade al prompt de Claude
// al redactar el borrador. El resto del system prompt (tono, saludo, firma)
// sigue aplicando igual para todos.
const INTENT_TYPES = {
  acuse: {
    label: 'Acuse de recibo',
    emoji: '📨',
    instruction:
      'TIPO DE RESPUESTA: ACUSE DE RECIBO. Redacta una contestación breve y cortés que ' +
      'confirme la recepción del correo, agradezca el mensaje e indique que se está revisando ' +
      'y se dará respuesta con detalle a la mayor brevedad. NO tomes decisiones, NO aceptes ' +
      'ni rechaces nada y NO te comprometas con importes, fechas ni condiciones concretas.',
  },
  positiva: {
    label: 'Respuesta positiva',
    emoji: '✅',
    instruction:
      'TIPO DE RESPUESTA: AFIRMATIVA. Redacta una contestación que acepte, confirme o dé el ' +
      'visto bueno a lo que el remitente solicita o propone, en términos profesionales, e ' +
      'indica los siguientes pasos que correspondan. No inventes datos que no aparezcan en el ' +
      'correo (importes, fechas, referencias): si falta alguno, indica que se confirmará.',
  },
  negativa: {
    label: 'Respuesta negativa',
    emoji: '❌',
    instruction:
      'TIPO DE RESPUESTA: NEGATIVA. Redacta una contestación que decline la petición o la ' +
      'propuesta del remitente de forma cortés y profesional, agradeciendo su interés. Sé claro ' +
      'en la negativa, sin dar explicaciones comprometidas ni justificaciones detalladas, y deja ' +
      'la puerta abierta a futuras colaboraciones solo cuando tenga sentido.',
  },
  comentarios: {
    label: 'Según mis comentarios',
    emoji: '✍️',
    instruction:
      'TIPO DE RESPUESTA: SEGÚN LAS INDICACIONES DE LA DIRECCIÓN. Más abajo se incluyen las ' +
      'indicaciones del responsable de la clínica sobre qué debe decir la contestación. ' +
      'Desarróllalas hasta convertirlas en un correo profesional, completo y bien redactado en ' +
      'español, respetando su sentido: no añadas compromisos, importes ni condiciones que no ' +
      'estén en ellas, y no las contradigas.',
  },
};

const DEFAULT_INTENT_TYPE = 'acuse';

// Fichero de respaldo: mantiene las intenciones si el proceso se reinicia entre
// el momento de mover el correo y la ejecución de /ia. Si el disco es de solo
// lectura o efímero, el módulo sigue funcionando solo con la caché en memoria.
const STORE_FILE = process.env.IA_INTENTS_FILE || path.join(__dirname, '..', 'data', 'ia-intents.json');
const MAX_ENTRIES = 300;

let store = null;

function isValidType(type) {
  return Object.prototype.hasOwnProperty.call(INTENT_TYPES, type);
}

function normalizeKey(value) {
  return String(value || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

// Clave alternativa por remitente + asunto, para los correos sin Message-ID
// (algunos remitentes automáticos no lo incluyen).
function fallbackKey(from, subject) {
  return `alt:${normalizeKey(from)}|${normalizeKey(subject)}`;
}

function buildKeys({ messageId, from, subject }) {
  const keys = [];
  const id = normalizeKey(messageId);
  if (id) keys.push(id);
  if (from || subject) keys.push(fallbackKey(from, subject));
  return keys;
}

function load() {
  if (store) return store;
  store = {};
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') store = parsed;
    }
  } catch (err) {
    console.log(`⚠️  No se pudo leer ${STORE_FILE}: ${err.message}`);
  }
  return store;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.log(`⚠️  No se pudo guardar ${STORE_FILE}: ${err.message}`);
  }
}

// Descarta las entradas más antiguas cuando el fichero crece demasiado.
function prune() {
  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) return;
  keys
    .sort((a, b) => (store[a].saved_at || 0) - (store[b].saved_at || 0))
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach(key => { delete store[key]; });
}

// Guarda la intención bajo todas las claves disponibles (Message-ID y
// remitente+asunto), para poder recuperarla aunque falte alguna cabecera.
function setIntent({ messageId, from, subject }, { type, comments = '' }) {
  if (!isValidType(type)) throw new Error(`Tipo de respuesta desconocido: ${type}`);
  load();
  const entry = { type, comments: String(comments || '').trim(), saved_at: Date.now() };
  const keys = buildKeys({ messageId, from, subject });
  for (const key of keys) store[key] = entry;
  prune();
  persist();
  return { entry, keys };
}

function getIntent({ messageId, from, subject }) {
  load();
  for (const key of buildKeys({ messageId, from, subject })) {
    if (store[key]) return store[key];
  }
  return null;
}

// Recupera la intención y la borra: una vez creado el borrador ya no hace falta
// y así el correo no arrastra la elección si vuelve a pasar por la carpeta IA.
function consumeIntent({ messageId, from, subject }) {
  const entry = getIntent({ messageId, from, subject });
  if (!entry) return null;
  let changed = false;
  for (const key of buildKeys({ messageId, from, subject })) {
    if (store[key]) { delete store[key]; changed = true; }
  }
  if (changed) persist();
  return entry;
}

function describeIntent(type) {
  const intent = INTENT_TYPES[type] || INTENT_TYPES[DEFAULT_INTENT_TYPE];
  return `${intent.emoji} ${intent.label}`;
}

module.exports = {
  INTENT_TYPES,
  DEFAULT_INTENT_TYPE,
  isValidType,
  setIntent,
  getIntent,
  consumeIntent,
  describeIntent,
};
