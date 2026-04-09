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
// CONFIGURACIÓN
// ============================================================================
const CONFIG = {
  // Ionos IMAP
  ionos_email: 'nestor-garcia@clinicabandama.com',
  ionos_password: '$Noviemb-1979$',
  ionos_imap_host: 'imap.ionos.es',
  ionos_imap_port: 993,
  
  // Telegram
  telegram_token: '8717852588:AAFW6QgY8TNlpkwxhO7qqMWOm9xz2fnJEiY',
  telegram_chat_id: '1771192684',
  
  // Claude
  claude_api_key: process.env.CLAUDE_API_KEY,
  
  // Horarios (España - CET/CEST)
  summary_hour: 7,      // Se ejecuta a las 07:00
  summary_minute: 0,    // Minuto exacto
  
  // Rango: desde 07:00 del día anterior hasta 07:00 del día actual
  range_hour: 7
};

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
      tlsOptions: { rejectUnauthorized: false }
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
// OBTENER CORREOS DESDE LAS 07:00 DEL DÍA ANTERIOR HASTA 07:00 DE HOY
// ============================================================================
async function fetchEmailsFromToday(connection) {
  try {
    // Seleccionar INBOX
    await connection.openBox('INBOX', false);
    
    // Calcular rango de tiempo:
    // - Inicio: 07:00 del día anterior
    // - Fin: 07:00 del día actual
    const now = new Date();
    const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 7, 0, 0);
    const rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 0, 0);
    
    console.log(`🔍 Buscando correos desde ${rangeStart.toLocaleString('es-ES')} hasta ${rangeEnd.toLocaleString('es-ES')}`);
    
    // Buscar correos usando sintaxis correcta de imap-simple
    const searchCriteria = ['SINCE', rangeStart.toISOString().split('T')[0], 'BEFORE', rangeEnd.toISOString().split('T')[0]];
    const fetchOptions = {
      bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)',
      struct: true
    };
    
    const messages = await connection.search(searchCriteria, fetchOptions);
    console.log(`📧 Se encontraron ${messages.length} correos`);
    
    const emails = [];
    
    for (let msg of messages) {
      try {
        const parts = ImapSimple.getParts(msg.attributes.struct);
        let preview = '';
        
        // Intentar obtener vista previa del cuerpo
        for (let part of parts) {
          if (part.type === 'text') {
            const partData = await connection.getPartData(msg, part);
            preview = partData.toString().substring(0, 200).replace(/\n/g, ' ');
            break;
          }
        }
        
        const from = msg.headers.from ? msg.headers.from[0] : 'Desconocido';
        const subject = msg.headers.subject ? msg.headers.subject[0] : '(sin asunto)';
        const date = msg.headers.date ? new Date(msg.headers.date[0]) : new Date();
        
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
    
    return emails.sort((a, b) => b.date - a.date); // Ordenar por fecha descendente
    
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
    return '📧 Sin correos nuevos desde las 09:00 de hoy.';
  }
  
  // Preparar contenido para Claude
  const emailsText = emails.map((email, index) => {
    const timeStr = email.date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    return `${index + 1}. [${timeStr}] De: ${email.from}\n   Asunto: ${email.subject}\n   Preview: ${email.preview}`;
  }).join('\n\n');
  
  const prompt = `Eres un asistente ejecutivo que resume correos de manera concisa y práctica para un Director Financiero de una clínica privada.

Aquí están los ${emails.length} correos recibidos en el último período (desde las 07:00 del día anterior hasta las 07:00 de hoy):

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

  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    }, {
      headers: {
        'x-api-key': CONFIG.claude_api_key,
        'anthropic-version': '2023-06-01'
      }
    });
    
    const summary = response.data.content[0].text;
    console.log('✅ Resumen generado por Claude');
    return summary;
    
  } catch (error) {
    console.error('❌ Error Claude API:', error.response?.data || error.message);
    throw error;
  }
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
  
  try {
    const response = await axios.post(url, {
      chat_id: CONFIG.telegram_chat_id,
      text: fullMessage,
      parse_mode: 'Markdown'
    });
    
    console.log('✅ Mensaje enviado por Telegram');
    return response.data;
    
  } catch (error) {
    console.error('❌ Error enviando Telegram:', error.response?.data || error.message);
    throw error;
  }
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
    // 1. Conectar a Ionos
    connection = await connectToIonos();
    
    // 2. Obtener correos
    const emails = await fetchEmailsFromToday(connection);
    
    // 3. Resumir con Claude
    const summary = await summarizeEmailsWithClaude(emails);
    
    // 4. Enviar por Telegram
    await sendTelegramMessage(summary);
    
    console.log('✅ Proceso completado exitosamente\n');
    
  } catch (error) {
    console.error('❌ Error en el proceso:', error.message);
    await sendTelegramMessage(`❌ Error al generar resumen:\n\`\`\`\n${error.message}\n\`\`\``);
  } finally {
    if (connection) {
      await connection.end();
      console.log('Conexión IMAP cerrada');
    }
  }
}

// ============================================================================
// PROGRAMAR TAREA AUTOMÁTICA (07:00 diariamente)
// ============================================================================
// Formato cron: minuto hora día mes día-semana
// 0 7 * * * = cada día a las 07:00
cron.schedule('0 7 * * *', () => {
  console.log('⏰ Ejecutando tarea programada...');
  sendDailyEmailSummary();
}, {
  timezone: 'Europe/Madrid' // Zona horaria: España
});

console.log('⏰ Tarea programada para ejecutarse a las 07:00 (horario España)');

// ============================================================================
// RUTAS EXPRESS
// ============================================================================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Email Summarizer Bot',
    scheduled: '07:00 diariamente (horario España)',
    timestamp: new Date()
  });
});

// Trigger manual (para testing)
app.post('/trigger', async (req, res) => {
  console.log('🧪 Trigger manual ejecutado');
  
  try {
    await sendDailyEmailSummary();
    res.json({ status: 'success', message: 'Resumen enviado' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Trigger simplificado (testing sin IMAP)
app.post('/trigger-test', async (req, res) => {
  console.log('🧪 Trigger TEST ejecutado (sin IMAP)');
  
  try {
    // Emails de prueba
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
    
    // Resumir y enviar
    const summary = await summarizeEmailsWithClaude(testEmails);
    await sendTelegramMessage(summary);
    
    res.json({ status: 'success', message: 'Resumen TEST enviado', summary: summary });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Obtener estado
app.get('/status', (req, res) => {
  res.json({
    service: 'Email Summarizer',
    status: 'running',
    config: {
      email: CONFIG.ionos_email,
      telegram_chat: CONFIG.telegram_chat_id,
      schedule: '07:00 (horario España)',
      email_range: 'Desde 07:00 del día anterior hasta 07:00 del día actual'
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
  console.log(`   GET  /status - Estado detallado\n`);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada no manejada:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Excepción no capturada:', error);
});
