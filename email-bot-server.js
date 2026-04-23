// ============================================================================
// EMAIL SUMMARIZER BACKEND - Node.js
// Lee correos Ionos, resume con Claude, envía por Telegram
// ============================================================================

const express = require('express');
const cron = require('node-cron');
const ImapSimple = require('imap-simple');
const { simpleParser } = require('mailparser');
const axios = require('axios');
require('dotenv').config();

// Módulo de análisis de correos y borradores (arranca su propio cron al importarse)
const { runEmailAnalysisAndDrafts } = require('./email-analysis-drafts');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ============================================================================
// CONFIGURAR CORS (permitir requests desde navegador)
// ============================================================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============================================================================
// CONFIGURACIÓN (todas las credenciales desde variables de entorno)
// ============================================================================
const CONFIG = {
  ionos_email: process.env.IONOS_EMAIL,
  ionos_password: process.env.IONOS_PASSWORD,
  ionos_imap_host: process.env.IONOS_IMAP_HOST || 'imap.ionos.es',
  ionos_imap_port: parseInt(process.env.IONOS_IMAP_PORT || '993'),

  telegram_token: process.env.TELEGRAM_TOKEN,
  telegram_chat_id: process.env.TELEGRAM_CHAT_ID,

  claude_api_key: process.env.CLAUDE_API_KEY,
  claude_model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',

  app_url: process.env.APP_URL || '',

  summary_hour: parseInt(process.env.SUMMARY_HOUR || '7'),
  range_hour: parseInt(process.env.RANGE_HOUR || '7'),
};

// ============================================================================
// UTILIDAD: REINTENTOS CON BACKOFF EXPONENCIAL
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
// CONECTAR A IONOS IMAP
// ============================================================================
async function connectToIonos() {
  const config = {
    imap: {
      user: CONFIG.ionos_email,
      password: CONFIG.ionos_password,
      host: CONFIG.ionos_imap_host,
      port: CONFIG.ionos_imap_port,
      tls: true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: true }
    }
  };

  try {
    const connection = await ImapSimple.connect(config);
    console.log('✅ Conectado a Ionos IMAP');
    return connection;
  } catch (error) {
    console.error('❌ Error conectando a Ionos:', error.message);
    throw error;
  }
}

// ============================================================================
// OBTENER CORREOS (configurable por número de días o últimos N)
// ============================================================================
async function fetchEmails(connection, { days = null, last = 50 } = {}) {
  try {
    await connection.openBox('INBOX', false);

    let searchCriteria = ['ALL'];
    let cutoff = null;

    if (days) {
      cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const sinceDate = `${cutoff.getDate()}-${months[cutoff.getMonth()]}-${cutoff.getFullYear()}`;
      searchCriteria = [['SINCE', sinceDate]];
      console.log(`🔍 Buscando correos de los últimos ${days} días (desde ${sinceDate})...`);
    } else {
      console.log(`🔍 Buscando últimos ${last} correos...`);
    }

    const fetchOptions = {
      bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)',
      struct: true
    };

    const allMessages = await connection.search(searchCriteria, fetchOptions);
    console.log(`📧 Se encontraron ${allMessages.length} correos`);

    // Sin filtro de fecha: tomar los últimos N
    const messages = days
      ? allMessages
      : allMessages.slice(Math.max(0, allMessages.length - last));

    const emails = [];

    for (let msg of messages) {
      try {
        const from = (msg.headers?.from?.[0]) || 'Desconocido';
        const subject = (msg.headers?.subject?.[0]) || '(sin asunto)';
        const dateStr = (msg.headers?.date?.[0]) || new Date().toISOString();

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
        } catch (err) {
          preview = '(no se pudo obtener preview)';
        }

        emails.push({ from, subject, preview: preview || '(sin contenido)', date, uid: msg.attributes.uid });
      } catch (err) {
        console.log(`⚠️ Error procesando correo: ${err.message}`);
      }
    }

    // Filtrar por cutoff si aplica
    const filtered = cutoff ? emails.filter(e => e.date >= cutoff) : emails;
    console.log(`✅ ${filtered.length} correos procesados`);
    return filtered.sort((a, b) => b.date - a.date);

  } catch (error) {
    console.error('❌ Error obteniendo correos:', error.message);
    throw error;
  }
}

// ============================================================================
// RESUMIR CORREOS CON CLAUDE
// ============================================================================
async function summarizeEmailsWithClaude(emails, tipo = 'diario') {
  if (!CONFIG.claude_api_key) {
    throw new Error('CLAUDE_API_KEY no está configurada');
  }

  if (emails.length === 0) {
    return `📧 Sin correos nuevos ${tipo === 'semanal' ? 'esta semana' : 'en las últimas 24 horas'}.`;
  }

  const emailsText = emails.map((email, index) => {
    const timeStr = email.date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const dateStr = email.date.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
    return `${index + 1}. [${dateStr} ${timeStr}] De: ${email.from}\n   Asunto: ${email.subject}\n   Preview: ${email.preview}`;
  }).join('\n\n');

  const instrucciones = tipo === 'semanal'
    ? 'Resume los correos de TODA LA SEMANA. Identifica tendencias, temas recurrentes y pendientes importantes.'
    : 'Resume los correos recientes del día de hoy. Destaca lo más urgente.';

  const prompt = `Eres un asistente ejecutivo que resume correos de manera concisa y práctica para un Director Financiero de una clínica privada.

${instrucciones}

${emailsText}

Por favor, crea un resumen ejecutivo en español que:
1. Agrupe los correos por TEMA/PRIORIDAD (urgentes primero)
2. Destaque asuntos críticos relacionados con: pacientes, facturación, seguros, recursos humanos
3. Sea MUY CONCISO (máximo ${tipo === 'semanal' ? '1200' : '800'} caracteres)
4. Usa emojis para mayor claridad
5. Incluye recomendaciones de acciones inmediatas si las hay

Formato ejemplo:
🚨 URGENTE
• [Asunto 1]: Descripción breve

📊 ADMINISTRATIVO
• [Asunto 2]: Descripción breve

⏭️ PRÓXIMOS PASOS
- Acción 1
- Acción 2`;

  return withRetry(async () => {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: CONFIG.claude_model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': CONFIG.claude_api_key,
        'anthropic-version': '2023-06-01'
      },
      timeout: 30000
    });

    const summary = response.data.content[0].text;
    console.log(`✅ Resumen ${tipo} generado por Claude`);
    return summary;
  });
}

// ============================================================================
// ENVIAR POR TELEGRAM
// ============================================================================
async function sendTelegramMessage(message, chatId = null) {
  const url = `https://api.telegram.org/bot${CONFIG.telegram_token}/sendMessage`;

  const now = new Date();
  const dateStr = now.toLocaleDateString('es-ES', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const fullMessage = `📋 *Resumen de correos - ${dateStr}*\n\n${message}`;

  return withRetry(async () => {
    const response = await axios.post(url, {
      chat_id: chatId || CONFIG.telegram_chat_id,
      text: fullMessage,
      parse_mode: 'Markdown'
    }, { timeout: 15000 });

    console.log('✅ Mensaje enviado por Telegram');
    return response.data;
  });
}

// ============================================================================
// FUNCIÓN PRINCIPAL: RESUMEN DIARIO
// ============================================================================
async function sendDailyEmailSummary(chatId = null) {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 Iniciando resumen diario de correos...');
  console.log('='.repeat(60));

  let connection;
  try {
    connection = await withRetry(() => connectToIonos());
    const emails = await fetchEmails(connection, { last: 50 });
    const summary = await summarizeEmailsWithClaude(emails, 'diario');
    await sendTelegramMessage(summary, chatId);
    console.log('✅ Resumen diario completado\n');
  } catch (error) {
    console.error('❌ Error en resumen diario:', error.message);
    try {
      await sendTelegramMessage(`❌ Error al generar resumen:\n\`\`\`\n${error.message}\n\`\`\``, chatId);
    } catch (e) {
      console.error('❌ No se pudo enviar el error por Telegram:', e.message);
    }
  } finally {
    if (connection) {
      try { await connection.end(); } catch (e) {}
      console.log('Conexión IMAP cerrada');
    }
  }
}

// ============================================================================
// FUNCIÓN PRINCIPAL: RESUMEN SEMANAL (lunes)
// ============================================================================
async function sendWeeklyEmailSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('📅 Iniciando resumen SEMANAL de correos...');
  console.log('='.repeat(60));

  let connection;
  try {
    connection = await withRetry(() => connectToIonos());
    const emails = await fetchEmails(connection, { days: 7 });
    const summary = await summarizeEmailsWithClaude(emails, 'semanal');

    const now = new Date();
    const dateStr = now.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const weeklyMessage = `📅 *RESUMEN SEMANAL - ${dateStr}*\n\n${summary}`;

    await withRetry(async () => {
      await axios.post(`https://api.telegram.org/bot${CONFIG.telegram_token}/sendMessage`, {
        chat_id: CONFIG.telegram_chat_id,
        text: weeklyMessage,
        parse_mode: 'Markdown'
      }, { timeout: 15000 });
    });

    console.log('✅ Resumen semanal completado\n');
  } catch (error) {
    console.error('❌ Error en resumen semanal:', error.message);
    try {
      await sendTelegramMessage(`❌ Error en resumen semanal:\n\`\`\`\n${error.message}\n\`\`\``);
    } catch (e) {
      console.error('❌ No se pudo enviar el error por Telegram:', e.message);
    }
  } finally {
    if (connection) {
      try { await connection.end(); } catch (e) {}
      console.log('Conexión IMAP cerrada');
    }
  }
}

// ============================================================================
// TELEGRAM WEBHOOK: registrar URL al arrancar
// ============================================================================
async function registerTelegramWebhook() {
  if (!CONFIG.app_url) {
    console.log('⚠️ APP_URL no configurada, webhook de Telegram no registrado');
    return;
  }
  const webhookUrl = `${CONFIG.app_url}/telegram-webhook`;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegram_token}/setWebhook`, {
      url: webhookUrl,
      allowed_updates: ['message']
    }, { timeout: 10000 });
    console.log(`✅ Webhook de Telegram registrado: ${webhookUrl}`);
  } catch (error) {
    console.error('❌ Error registrando webhook:', error.message);
  }
}

// ============================================================================
// PROGRAMAR TAREAS AUTOMÁTICAS
// ============================================================================

// Resumen diario: 07:00 Canarias = 15:00 UTC (verano)
cron.schedule('0 15 * * *', () => {
  console.log('⏰ [' + new Date().toISOString() + '] Ejecutando resumen diario...');
  sendDailyEmailSummary();
});

// Resumen semanal: lunes 08:00 Canarias = 16:00 UTC (verano)
cron.schedule('0 16 * * 1', () => {
  console.log('⏰ [' + new Date().toISOString() + '] Ejecutando resumen semanal...');
  sendWeeklyEmailSummary();
});

console.log('✅ Cron diario: 15:00 UTC (07:00 Canarias)');
console.log('✅ Cron semanal: lunes 16:00 UTC (08:00 Canarias)');

// ============================================================================
// RUTAS EXPRESS
// ============================================================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Email Summarizer Bot',
    scheduled: '07:00 diario / 08:00 lunes semanal (horario Canarias)',
    timestamp: new Date()
  });
});

// Webhook de Telegram para recibir comandos
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido a Telegram

  const message = req.body?.message;
  if (!message) return;

  const text = (message.text || '').trim();
  const chatId = message.chat.id.toString();

  // Solo responder al chat autorizado
  if (chatId !== CONFIG.telegram_chat_id) {
    console.log(`⚠️ Mensaje ignorado de chat no autorizado: ${chatId}`);
    return;
  }

  console.log(`📩 Comando recibido: ${text}`);

  if (text === '/resumen') {
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegram_token}/sendMessage`, {
      chat_id: chatId,
      text: '⏳ Generando resumen, un momento...'
    }).catch(() => {});
    await sendDailyEmailSummary(chatId);
  } else if (text === '/semanal') {
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegram_token}/sendMessage`, {
      chat_id: chatId,
      text: '⏳ Generando resumen semanal, un momento...'
    }).catch(() => {});
    await sendWeeklyEmailSummary();
  } else if (text === '/borradores') {
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegram_token}/sendMessage`, {
      chat_id: chatId,
      text: '🤖 Analizando correos del día anterior y creando borradores...\nEsto puede tardar unos minutos. Recibirás un email con el resumen cuando termine.'
    }).catch(() => {});
    runEmailAnalysisAndDrafts()
      .then(() => axios.post(`https://api.telegram.org/bot${CONFIG.telegram_token}/sendMessage`, {
        chat_id: chatId,
        text: '✅ Análisis completado. Revisa tu bandeja de entrada y la carpeta Borradores de tu correo.'
      }).catch(() => {}))
      .catch(err => axios.post(`https://api.telegram.org/bot${CONFIG.telegram_token}/sendMessage`, {
        chat_id: chatId,
        text: `❌ Error durante el análisis: ${err.message}`
      }).catch(() => {}));
  } else if (text === '/ayuda') {
    await axios.post(`https://api.telegram.org/bot${CONFIG.telegram_token}/sendMessage`, {
      chat_id: chatId,
      text: '📋 *Comandos disponibles:*\n\n/resumen — Resumen de los últimos correos\n/semanal — Resumen de los últimos 7 días\n/borradores — Analizar correos de ayer y crear borradores de respuesta\n/ayuda — Ver esta ayuda',
      parse_mode: 'Markdown'
    }).catch(() => {});
  }
});

app.post('/trigger', async (req, res) => {
  console.log('🧪 Trigger manual ejecutado');
  try {
    await sendDailyEmailSummary();
    res.json({ status: 'success', message: 'Resumen enviado' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/trigger-borradores', async (req, res) => {
  console.log('🤖 Trigger borradores ejecutado');
  res.json({ status: 'started', message: 'Análisis iniciado, revisa el email de resumen cuando termine' });
  runEmailAnalysisAndDrafts().catch(err => console.error('❌ Error borradores:', err.message));
});

app.post('/trigger-test', async (req, res) => {
  console.log('🧪 Trigger TEST ejecutado (sin IMAP)');
  try {
    const testEmails = [
      { from: 'adeslas@asegurador.com', subject: 'Rechazo de facturas EMT marzo', preview: 'Rechazo de 3 facturas por falta de justificante', date: new Date() },
      { from: 'dr.garcia@clinicabandama.com', subject: 'Informe de alta urgente', preview: 'Necesito informe de Juan Martínez para derivación', date: new Date() },
      { from: 'rrhh@clinicabandama.com', subject: 'Isabel Jiménez - Entrevista confirmada', preview: 'Psiquiatra recién residenciada. Disponible mañana 16:00', date: new Date() }
    ];

    const summary = await summarizeEmailsWithClaude(testEmails, 'diario');
    await sendTelegramMessage(summary);

    res.json({ status: 'success', message: 'Resumen TEST enviado', summary });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/status', (req, res) => {
  res.json({
    service: 'Email Summarizer',
    status: 'running',
    config: {
      schedule_daily: '07:00 Canarias (lun-dom)',
      schedule_weekly: '08:00 Canarias (solo lunes)',
      model: CONFIG.claude_model,
      webhook_active: !!CONFIG.app_url
    },
    timestamp: new Date()
  });
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================
app.listen(PORT, async () => {
  console.log(`\n🎯 Servidor iniciado en puerto ${PORT}`);
  console.log('\n📋 Endpoints disponibles:');
  console.log(`   GET  / - Estado del servicio`);
  console.log(`   POST /trigger - Ejecutar resumen manualmente`);
  console.log(`   POST /trigger-test - Test sin IMAP`);
  console.log(`   POST /telegram-webhook - Webhook de Telegram`);
  console.log(`   GET  /status - Estado detallado\n`);

  await registerTelegramWebhook();
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada no manejada:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Excepción no capturada:', error);
});
