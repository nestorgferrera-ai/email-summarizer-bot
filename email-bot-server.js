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
// OBTENER CORREOS DE LAS ÚLTIMAS 24 HORAS
// ============================================================================
async function fetchEmailsFromToday(connection) {
  try {
    await connection.openBox('INBOX', false);

    // Buscar desde ayer (IMAP SINCE solo acepta fecha, filtro de hora se hace en memoria)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const sinceDate = `${yesterday.getDate()}-${months[yesterday.getMonth()]}-${yesterday.getFullYear()}`;

    console.log(`🔍 Buscando correos desde ${sinceDate}...`);

    const searchCriteria = [['SINCE', sinceDate]];
    const fetchOptions = {
      bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)',
      struct: true
    };

    const allMessages = await connection.search(searchCriteria, fetchOptions);
    console.log(`📧 Se encontraron ${allMessages.length} correos desde ayer`);

    const emails = [];

    for (let msg of allMessages) {
      try {
        const from = (msg.headers && msg.headers.from && msg.headers.from[0]) ? msg.headers.from[0] : 'Desconocido';
        const subject = (msg.headers && msg.headers.subject && msg.headers.subject[0]) ? msg.headers.subject[0] : '(sin asunto)';
        const dateStr = (msg.headers && msg.headers.date && msg.headers.date[0]) ? msg.headers.date[0] : new Date().toISOString();

        let date = new Date(dateStr);
        if (isNaN(date.getTime())) {
          date = new Date();
        }

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

        emails.push({
          from,
          subject,
          preview: preview || '(sin contenido)',
          date,
          uid: msg.attributes.uid
        });
      } catch (err) {
        console.log(`⚠️ Error procesando correo: ${err.message}`);
      }
    }

    // Filtrar correos estrictamente dentro de las últimas 24 horas
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const filteredEmails = emails.filter(e => e.date >= cutoff);

    console.log(`✅ ${filteredEmails.length} correos en las últimas 24 horas`);
    return filteredEmails.sort((a, b) => b.date - a.date);

  } catch (error) {
    console.error('❌ Error obteniendo correos:', error.message);
    throw error;
  }
}

// ============================================================================
// RESUMIR CORREOS CON CLAUDE
// ============================================================================
async function summarizeEmailsWithClaude(emails) {
  if (!CONFIG.claude_api_key) {
    throw new Error('CLAUDE_API_KEY no está configurada');
  }

  if (emails.length === 0) {
    return `📧 Sin correos nuevos desde las ${String(CONFIG.range_hour).padStart(2, '0')}:00 de hoy.`;
  }

  const emailsText = emails.map((email, index) => {
    const timeStr = email.date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    return `${index + 1}. [${timeStr}] De: ${email.from}\n   Asunto: ${email.subject}\n   Preview: ${email.preview}`;
  }).join('\n\n');

  const prompt = `Eres un asistente ejecutivo que resume correos de manera concisa y práctica para un Director Financiero de una clínica privada.

Resume TODOS los correos mostrados a continuación (son los correos recientes recibidos):

${emailsText}

Por favor, crea un resumen ejecutivo en español que:
1. Agrupe los correos por TEMA/PRIORIDAD (urgentes primero)
2. Destaque asuntos críticos relacionados con: pacientes, facturación, seguros, recursos humanos
3. Sea MUY CONCISO (máximo 800 caracteres)
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
    console.log('✅ Resumen generado por Claude');
    return summary;
  });
}

// ============================================================================
// ENVIAR POR TELEGRAM
// ============================================================================
async function sendTelegramMessage(message) {
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
      chat_id: CONFIG.telegram_chat_id,
      text: fullMessage,
      parse_mode: 'Markdown'
    }, { timeout: 15000 });

    console.log('✅ Mensaje enviado por Telegram');
    return response.data;
  });
}

// ============================================================================
// FUNCIÓN PRINCIPAL
// ============================================================================
async function sendDailyEmailSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 Iniciando resumen diario de correos...');
  console.log('='.repeat(60));

  let connection;
  try {
    connection = await withRetry(() => connectToIonos());
    const emails = await fetchEmailsFromToday(connection);
    const summary = await summarizeEmailsWithClaude(emails);
    await sendTelegramMessage(summary);

    console.log('✅ Proceso completado exitosamente\n');

  } catch (error) {
    console.error('❌ Error en el proceso:', error.message);
    try {
      await sendTelegramMessage(`❌ Error al generar resumen:\n\`\`\`\n${error.message}\n\`\`\``);
    } catch (telegramError) {
      console.error('❌ No se pudo enviar el error por Telegram:', telegramError.message);
    }
  } finally {
    if (connection) {
      try {
        await connection.end();
        console.log('Conexión IMAP cerrada');
      } catch (e) {
        // ignorar errores al cerrar
      }
    }
  }
}

// ============================================================================
// PROGRAMAR TAREA AUTOMÁTICA (07:00 Canarias = 15:00 UTC en verano)
// ============================================================================
cron.schedule('0 15 * * *', () => {
  console.log('⏰ [' + new Date().toISOString() + '] Ejecutando resumen diario de correos...');
  sendDailyEmailSummary();
});

console.log('✅ Tarea cron configurada: Se ejecutará cada día a las 15:00 UTC (07:00 Canarias)');

// ============================================================================
// RUTAS EXPRESS
// ============================================================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Email Summarizer Bot',
    scheduled: '07:00 diariamente (horario Canarias)',
    timestamp: new Date()
  });
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

app.post('/trigger-test', async (req, res) => {
  console.log('🧪 Trigger TEST ejecutado (sin IMAP)');
  try {
    const testEmails = [
      {
        from: 'adeslas@asegurador.com',
        subject: 'Rechazo de facturas EMT marzo',
        preview: 'Rechazo de 3 facturas por falta de justificante',
        date: new Date()
      },
      {
        from: 'dr.garcia@clinicabandama.com',
        subject: 'Informe de alta urgente',
        preview: 'Necesito informe de Juan Martínez para derivación',
        date: new Date()
      },
      {
        from: 'rrhh@clinicabandama.com',
        subject: 'Isabel Jiménez - Entrevista confirmada',
        preview: 'Psiquiatra recién residenciada. Disponible mañana 16:00',
        date: new Date()
      }
    ];

    const summary = await summarizeEmailsWithClaude(testEmails);
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
      schedule: '07:00 (horario Canarias)',
      model: CONFIG.claude_model,
      email_range: 'Últimas 24 horas'
    },
    timestamp: new Date()
  });
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================
app.listen(PORT, () => {
  console.log(`\n🎯 Servidor iniciado en puerto ${PORT}`);
  console.log(`📡 Accesible en: http://localhost:${PORT}`);
  console.log('\n📋 Endpoints disponibles:');
  console.log(`   GET  / - Estado del servicio`);
  console.log(`   POST /trigger - Ejecutar resumen manualmente`);
  console.log(`   POST /trigger-test - Test sin IMAP`);
  console.log(`   GET  /status - Estado detallado\n`);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada no manejada:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Excepción no capturada:', error);
});
