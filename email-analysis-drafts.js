// ============================================================================
// EMAIL ANALYSIS & DRAFTS — Node.js
// Lee correos del día anterior, analiza con Claude (Anthropic SDK + caché),
// guarda borradores en IMAP y envía un resumen por email al buzón propio.
// ============================================================================

'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const ImapSimple = require('imap-simple');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

// ============================================================================
// CLIENTE ANTHROPIC
// ============================================================================
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// ============================================================================
// CONFIGURACIÓN
// ============================================================================
const CONFIG = {
  ionos_email:   process.env.IONOS_EMAIL,
  ionos_pass:    process.env.IONOS_PASSWORD,
  imap_host:     process.env.IONOS_IMAP_HOST || 'imap.ionos.es',
  imap_port:     parseInt(process.env.IONOS_IMAP_PORT || '993'),
  smtp_host:     process.env.IONOS_SMTP_HOST || 'smtp.ionos.es',
  smtp_port:     parseInt(process.env.IONOS_SMTP_PORT || '587'),
  clinic_name:   process.env.CLINIC_NAME || 'Clínica Bandama',
  summary_to:    process.env.SUMMARY_RECIPIENT || process.env.IONOS_EMAIL,
  model:         process.env.CLAUDE_MODEL_DRAFTS || 'claude-opus-4-7',
  max_body_chars: 3000,
};

// ============================================================================
// SYSTEM PROMPT — detallado para activar prompt caching
// ============================================================================
const SYSTEM_PROMPT = `Eres el asistente ejecutivo de ${CONFIG.clinic_name}, una clínica médica privada española.

Tu función es analizar cada correo electrónico recibido y determinar tres cosas:
1. Si el correo requiere una respuesta por parte de la dirección de la clínica.
2. Si requiere respuesta, redactar un borrador profesional en español.
3. Clasificar el correo por prioridad, categoría y proporcionar un resumen de una línea.

=== CRITERIOS: CORREOS QUE SÍ NECESITAN RESPUESTA ===

- Consultas de pacientes sobre citas, tratamientos, resultados, facturas o presupuestos.
- Peticiones de información clínica o administrativa de pacientes, médicos o instituciones sanitarias.
- Correos de aseguradoras (Adeslas, Sanitas, Mapfre, DKV, Asisa, Cigna, Caser Salud, Muface, etc.)
  que requieran documentación, autorización, aclaración o respuesta a requerimientos.
- Comunicaciones de proveedores que necesiten confirmación de pedido, entrega, presupuesto o pago.
- Quejas, reclamaciones o sugerencias de pacientes o familiares.
- Solicitudes de informes médicos, certificados, referencias o derivaciones.
- Correos de organismos oficiales (Seguridad Social, Consejería de Sanidad, AEMPS, etc.)
- Notificaciones de auditorías o inspecciones que requieran preparación o documentación.
- Avisos de vencimiento de contratos, seguros o autorizaciones administrativas.
- Propuestas de colaboración o comerciales que requieran respuesta de interés o rechazo.
- Solicitudes de candidatos a empleo sobre ofertas de trabajo activas.
- Cualquier correo con una pregunta directa o una petición que espera confirmación.

=== CRITERIOS: CORREOS QUE NO NECESITAN RESPUESTA ===

- Newsletters, boletines informativos o publicaciones periódicas automáticas.
- Notificaciones automáticas de sistemas: confirmaciones de cita por app, alertas de plataformas, etc.
- Facturas o albaranes recibidos sin incidencias ni preguntas pendientes.
- Acuses de recibo automáticos (auto-respuestas de servidores o sistemas).
- Publicidad y correos promocionales no solicitados (spam).
- Informes periódicos automáticos sin incidencias ni solicitud de acción.
- Notificaciones de redes sociales o plataformas digitales.
- Resúmenes automáticos de noticias del sector sanitario.
- Confirmaciones de acciones ya realizadas (pago confirmado, registro completado, etc.).

=== CRITERIOS DE PRIORIDAD ===

URGENTE:
- Asuntos médicos urgentes o que afectan la seguridad o continuidad asistencial del paciente.
- Plazos inminentes (menos de 48 horas) para responder a organismos oficiales o aseguradoras.
- Reclamaciones o quejas formales que exigen atención inmediata.
- Vencimientos críticos de contratos, seguros o autorizaciones que paralizan la operativa.
- Problemas graves con proveedores (suministros médicos, equipos críticos, etc.).
- Requerimientos judiciales o legales.

NORMAL:
- Consultas de pacientes sobre citas, servicios o presupuestos.
- Comunicaciones de aseguradoras con plazo razonable (más de 48 horas).
- Solicitudes de documentación clínica o administrativa sin urgencia declarada.
- Propuestas de colaboración o comerciales que merecen evaluación.
- Facturas con incidencias que requieren gestión.
- Solicitudes de informes o certificados sin fecha límite inmediata.

BAJA:
- Consultas informativas generales sin urgencia.
- Propuestas comerciales de bajo interés o de prospección fría.
- Solicitudes de referencia o información de carácter divulgativo.
- Correspondencia rutinaria sin implicaciones operativas inmediatas.
- Candidaturas espontáneas o solicitudes de prácticas.

=== CATEGORÍAS DISPONIBLES ===

- pacientes       → Correos de pacientes actuales o potenciales.
- aseguradoras    → Comunicaciones de mutuas, aseguradoras médicas o entidades gestoras.
- proveedores     → Correos de proveedores de material, medicamentos, servicios o equipos.
- rrhh            → Recursos humanos: candidatos, empleados, convenios, inspecciones laborales.
- administrativo  → Gestión interna, organismos oficiales, asesorías, auditores.
- comercial       → Propuestas comerciales, nuevas colaboraciones, acuerdos de derivación.
- oficial         → Organismos públicos: Seguridad Social, Consejería de Sanidad, AEMPS, etc.
- otros           → Cualquier categoría no contemplada anteriormente.

=== DIRECTRICES PARA REDACTAR BORRADORES ===

1. SALUDO: empieza el borrador con el nombre del remitente seguido de coma, por ejemplo "Sandra," o "Mapfre,".
   Extrae el nombre del campo DE: del encabezado (la parte antes de <email@dominio>).
   Si el campo DE: solo tiene dirección de email sin nombre, busca la firma en el cuerpo del correo.
   NUNCA uses "Estimado", "Estimada", "Estimados", "Sr.", "Sra." ni ninguna fórmula de cortesía antes del nombre.
   Solo si es imposible determinar ningún nombre, omite el saludo por completo.
2. PIE DE FIRMA: NO incluyas ningún cierre ni firma al final. Nada de "Atentamente", "Un saludo",
   "Quedamos a su disposición", "Dirección", ni el nombre de la clínica. El borrador termina
   en la última frase del cuerpo del mensaje.
3. Sé profesional y cordial; refleja la imagen de una clínica médica de calidad.
4. Responde directamente a lo que pregunta o solicita el remitente.
5. Si no hay información suficiente para responder, indica que se está gestionando
   y que se dará respuesta en breve, sin inventar datos.
6. Para aseguradoras: usa terminología médico-administrativa; menciona el expediente
   o número de referencia si aparece en el correo original.
7. Para pacientes: usa un lenguaje claro, empático y accesible.
8. Para proveedores: sé directo y específico sobre los requerimientos o la decisión.
9. Para organismos oficiales: usa registro formal y menciona plazos si los hay.
10. NO uses tuteo. NO uses marcadores de posición como [INSERTAR DATO] salvo que
    sea genuinamente necesario para completar el borrador.
11. El borrador debe estar listo para enviar con mínimas correcciones.

=== CONSIDERACIONES ESPECIALES ===

- Si el correo está en otro idioma, redacta el borrador en español.
- Si el correo es ambiguo o está incompleto, clasifícalo como needs_reply: true
  con prioridad "normal" y redacta un borrador solicitando aclaración.
- Nunca incluyas datos clínicos detallados de pacientes en el borrador
  salvo que sean estrictamente necesarios para la respuesta.
- Si el correo menciona un incidente grave (efecto adverso, accidente, denuncia),
  clasifícalo siempre como urgente.
- Para requerimientos de aseguradoras con plazo explícito de 24-48 horas,
  clasifícalos como urgente aunque el tono del correo sea rutinario.

=== FORMATO DE RESPUESTA ===

Responde ÚNICAMENTE con un objeto JSON válido. No incluyas texto fuera del JSON.
No uses bloques de código markdown. Solo el objeto JSON puro con esta estructura:

{
  "needs_reply": true o false,
  "reason": "Explicación breve (máx 100 caracteres) de por qué necesita o no respuesta",
  "priority": "urgente" | "normal" | "baja",
  "category": "pacientes" | "aseguradoras" | "proveedores" | "rrhh" | "administrativo" | "comercial" | "oficial" | "otros",
  "summary": "Resumen de una línea del correo (máx 130 caracteres)",
  "draft": "Texto completo del borrador de respuesta, o cadena vacía si no necesita respuesta"
}`;

// ============================================================================
// UTILIDAD: REINTENTOS CON BACKOFF EXPONENCIAL
// ============================================================================
async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`  ⚠️  Intento ${attempt} fallido, reintentando en ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
}

// ============================================================================
// CONECTAR A IONOS IMAP
// ============================================================================
async function connectToIMAP() {
  const connection = await ImapSimple.connect({
    imap: {
      user:       CONFIG.ionos_email,
      password:   CONFIG.ionos_pass,
      host:       CONFIG.imap_host,
      port:       CONFIG.imap_port,
      tls:        true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: true },
    },
  });
  console.log('✅ Conectado a Ionos IMAP');
  return connection;
}

// ============================================================================
// ENCONTRAR CARPETA DE BORRADORES
// ============================================================================
async function findDraftsFolder(connection) {
  // Buscar en los buzones por el atributo \Drafts
  try {
    const boxes = await connection.getBoxes();
    const found = searchBoxByAttrib(boxes, '\\Drafts', '');
    if (found) {
      console.log(`📁 Carpeta borradores: ${found}`);
      return found;
    }
  } catch (_) {}

  // Fallback: probar nombres habituales
  for (const candidate of ['Drafts', 'INBOX.Drafts', 'Borradores', 'Draft']) {
    try {
      await connection.openBox(candidate);
      await connection.openBox('INBOX', false);
      console.log(`📁 Carpeta borradores (fallback): ${candidate}`);
      return candidate;
    } catch (_) {}
  }

  console.log('⚠️  No se encontró carpeta Borradores, usando "Drafts"');
  return 'Drafts';
}

function searchBoxByAttrib(boxes, attrib, prefix) {
  for (const [name, box] of Object.entries(boxes || {})) {
    const fullName = prefix ? `${prefix}.${name}` : name;
    if (Array.isArray(box.attribs) && box.attribs.includes(attrib)) return fullName;
    const child = searchBoxByAttrib(box.children, attrib, fullName);
    if (child) return child;
  }
  return null;
}

// ============================================================================
// OBTENER CORREOS DEL DÍA ANTERIOR
// ============================================================================
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function toImapDate(d) {
  return `${d.getDate()}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

function stripHtml(html) {
  return html
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

async function fetchYesterdayEmails(connection) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  console.log(`🔍 Buscando correos del ${yesterday.toLocaleDateString('es-ES')}...`);

  await connection.openBox('INBOX', false);

  const messages = await connection.search(
    [['SINCE', toImapDate(yesterday)], ['BEFORE', toImapDate(today)]],
    {
      bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)', 'TEXT'],
      struct: true,
      markSeen: false,
    }
  );

  console.log(`📧 ${messages.length} correos encontrados`);
  const emails = [];

  for (const msg of messages) {
    try {
      // imap-simple expone los headers en msg.parts, no en msg.headers
      const headerPart = (msg.parts || []).find(p => p.which && p.which.startsWith('HEADER'));
      const headers = (headerPart && headerPart.body) ? headerPart.body : {};

      const from      = (headers.from?.[0])           || 'Desconocido';
      const to        = (headers.to?.[0])              || CONFIG.ionos_email;
      const subject   = (headers.subject?.[0])         || '(sin asunto)';
      const dateStr   = (headers.date?.[0])            || '';
      const messageId = (headers['message-id']?.[0])   || '';
      const inReplyTo = (headers['in-reply-to']?.[0])  || '';
      const references= (headers.references?.[0])      || '';

      console.log(`  → De: ${from} | Asunto: ${subject}`);
      const date = dateStr ? new Date(dateStr) : new Date();

      // Obtener cuerpo del texto
      let body = '';
      try {
        const parts = ImapSimple.getParts(msg.attributes.struct);
        for (const part of parts) {
          if (part.type !== 'text') continue;
          const data = await connection.getPartData(msg, part);
          const text = data.toString();
          if (part.subtype === 'plain') {
            body = text;
            break;
          } else if (part.subtype === 'html' && !body) {
            body = stripHtml(text);
          }
        }
      } catch (_) {
        body = '(no se pudo obtener el cuerpo)';
      }

      emails.push({
        from, to, subject, date, messageId, inReplyTo, references,
        body: body.trim().substring(0, CONFIG.max_body_chars),
      });
    } catch (err) {
      console.log(`  ⚠️  Error procesando mensaje: ${err.message}`);
    }
  }

  return emails;
}

// ============================================================================
// ANALIZAR CORREO CON CLAUDE (con prompt caching en el system prompt)
// ============================================================================
async function analyzeEmailWithClaude(email, forceReply = false) {
  const userContent = [
    `Analiza el siguiente correo recibido en ${CONFIG.clinic_name}.`,
    forceReply
      ? `IMPORTANTE: El usuario ha movido este correo explícitamente a la carpeta IA para que se redacte una respuesta. SIEMPRE genera un borrador completo en el campo "draft", independientemente de si consideras que necesita respuesta o no.`
      : `Responde ÚNICAMENTE con el objeto JSON indicado en las instrucciones.`,
    ``,
    `DE: ${email.from}`,
    `PARA: ${email.to}`,
    `FECHA: ${email.date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
    `ASUNTO: ${email.subject}`,
    `CUERPO:`,
    `---`,
    email.body || '(sin cuerpo)',
    `---`,
  ].join('\n');

  const response = await withRetry(() =>
    anthropic.messages.create({
      model:      CONFIG.model,
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },  // cachea el system prompt entre llamadas
        },
      ],
      messages: [{ role: 'user', content: userContent }],
    })
  );

  // Parsear JSON de la respuesta
  const raw = response.content[0]?.text?.trim() || '{}';
  // Extraer JSON si Claude lo envuelve en bloque markdown (defensa extra)
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(jsonText);
  } catch (_) {
    console.log(`  ⚠️  JSON inválido, usando análisis por defecto`);
    return {
      needs_reply: false,
      reason:      'Error al parsear respuesta de Claude',
      priority:    'normal',
      category:    'otros',
      summary:     email.subject.substring(0, 130),
      draft:       '',
    };
  }
}

// ============================================================================
// CONSTRUIR MENSAJE MIME RAW (para guardar como borrador en IMAP)
// ============================================================================
async function buildRawMime(options) {
  return new Promise((resolve, reject) => {
    const transport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });
    transport.sendMail(options, (err, info) => {
      if (err) return reject(err);
      const chunks = [];
      info.message.on('data',  c => chunks.push(c));
      info.message.on('end',   () => resolve(Buffer.concat(chunks)));
      info.message.on('error', reject);
    });
  });
}

// ============================================================================
// GUARDAR BORRADOR EN IMAP
// ============================================================================
async function saveDraftToIMAP(connection, rawMime, draftsFolder, subject) {
  return new Promise((resolve, reject) => {
    connection.imap.append(
      rawMime,
      { mailbox: draftsFolder, flags: ['\\Draft', '\\Seen'], date: new Date() },
      (err) => {
        if (err) {
          console.log(`  ⚠️  No se pudo guardar borrador "${subject}": ${err.message}`);
          reject(err);
        } else {
          console.log(`  ✅ Borrador guardado: "${subject}"`);
          resolve();
        }
      }
    );
  });
}

// ============================================================================
// ENVIAR RESUMEN POR EMAIL AL BUZÓN PROPIO
// ============================================================================
async function sendSummaryEmail(replied, notReplied) {
  if (!CONFIG.summary_to) {
    console.log('⚠️  SUMMARY_RECIPIENT / IONOS_EMAIL no configurado — omitiendo email de resumen');
    return;
  }
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const total = replied.length + notReplied.length;

  const lines = [
    `RESUMEN DE CORREOS — ${dateStr.toUpperCase()}`,
    '='.repeat(65),
    '',
    `Total de correos analizados: ${total}`,
    `Borradores creados:          ${replied.length}`,
    `Sin respuesta necesaria:     ${notReplied.length}`,
    '',
  ];

  if (replied.length > 0) {
    lines.push('─'.repeat(65));
    lines.push(`BORRADORES CREADOS (${replied.length})`);
    lines.push('─'.repeat(65));
    lines.push('');
    for (const { email, analysis } of replied) {
      const icon = analysis.priority === 'urgente' ? '🚨' :
                   analysis.priority === 'normal'  ? '📋' : '📌';
      lines.push(`${icon} [${analysis.priority.toUpperCase()}] ${analysis.category.toUpperCase()}`);
      lines.push(`   De:      ${email.from}`);
      lines.push(`   Asunto:  ${email.subject}`);
      lines.push(`   Resumen: ${analysis.summary}`);
      lines.push(`   Motivo:  ${analysis.reason}`);
      lines.push('');
    }
  }

  if (notReplied.length > 0) {
    lines.push('─'.repeat(65));
    lines.push(`SIN RESPUESTA NECESARIA (${notReplied.length})`);
    lines.push('─'.repeat(65));
    lines.push('');
    for (const { email, analysis } of notReplied) {
      lines.push(`• ${email.subject}`);
      lines.push(`  De: ${email.from}`);
      lines.push(`  ${analysis.summary || analysis.reason || ''}`);
      lines.push('');
    }
  }

  lines.push('─'.repeat(65));
  lines.push('Los borradores están disponibles en la carpeta Borradores.');
  lines.push('Revíselos antes de enviar — pueden necesitar completar datos específicos.');
  lines.push('');
  lines.push(`Generado automáticamente · ${CONFIG.clinic_name}`);

  const transport = nodemailer.createTransport({
    host:       CONFIG.smtp_host,
    port:       CONFIG.smtp_port,
    secure:     false,
    requireTLS: true,
    auth:       { user: CONFIG.ionos_email, pass: CONFIG.ionos_pass },
    tls:        { rejectUnauthorized: false },
  });

  console.log(`📤 Enviando resumen a ${CONFIG.summary_to} via ${CONFIG.smtp_host}:${CONFIG.smtp_port}...`);
  await transport.sendMail({
    from:    CONFIG.ionos_email,
    to:      CONFIG.summary_to,
    subject: `Resumen correos ${yesterday.toLocaleDateString('es-ES')} — ${replied.length} borradores creados`,
    text:    lines.join('\n'),
  });

  console.log('✅ Email de resumen enviado a', CONFIG.summary_to);
}

// ============================================================================
// FUNCIÓN PRINCIPAL
// ============================================================================
async function runEmailAnalysisAndDrafts() {
  console.log('\n' + '='.repeat(65));
  console.log('🤖 Análisis de correos y creación de borradores');
  console.log('   Modelo:   ' + CONFIG.model);
  console.log('   IMAP:     ' + CONFIG.imap_host + ':' + CONFIG.imap_port);
  console.log('   SMTP:     ' + CONFIG.smtp_host + ':' + CONFIG.smtp_port);
  console.log('   Email:    ' + (CONFIG.ionos_email || '⚠️  NO CONFIGURADO'));
  console.log('   Resumen→: ' + (CONFIG.summary_to  || '⚠️  NO CONFIGURADO'));
  console.log('='.repeat(65));

  let connection;
  const replied    = [];
  const notReplied = [];

  try {
    connection = await withRetry(connectToIMAP);

    const draftsFolder = await findDraftsFolder(connection);
    const emails       = await fetchYesterdayEmails(connection);

    if (emails.length === 0) {
      console.log('📭 No hay correos del día anterior.');
      await sendSummaryEmail([], []);
      return;
    }

    console.log(`\n🔎 Analizando ${emails.length} correos...\n`);

    for (const email of emails) {
      console.log(`📨 "${email.subject}" — ${email.from}`);
      try {
        const analysis = await analyzeEmailWithClaude(email);

        if (analysis.needs_reply && analysis.draft) {
          // Construir MIME del borrador
          const raw = await buildRawMime({
            from:       CONFIG.ionos_email,
            to:         email.from,
            subject:    `Re: ${email.subject.replace(/^Re:\s*/i, '')}`,
            text:       analysis.draft,
            inReplyTo:  email.messageId,
            references: [email.references, email.messageId].filter(Boolean).join(' '),
            headers:    { 'X-Mailer': 'EmailAnalysisDrafts/1.0' },
          });

          // Guardar en carpeta Borradores
          try {
            await saveDraftToIMAP(connection, raw, draftsFolder, email.subject);
          } catch (_) {
            console.log('  ⚠️  Borrador no guardado en IMAP, continúa el proceso');
          }

          replied.push({ email, analysis });
          console.log(`  → [${analysis.priority.toUpperCase()}] ${analysis.category} — borrador listo`);

        } else {
          notReplied.push({ email, analysis });
          console.log(`  → Sin respuesta: ${analysis.reason}`);
        }

        // Pausa breve entre llamadas a la API
        await new Promise(r => setTimeout(r, 300));

      } catch (err) {
        console.error(`  ❌ Error: ${err.message}`);
        notReplied.push({
          email,
          analysis: {
            needs_reply: false, priority: 'normal', category: 'otros',
            reason: 'Error en análisis', summary: email.subject.substring(0, 130), draft: '',
          },
        });
      }
    }

    await sendSummaryEmail(replied, notReplied);

    console.log('\n' + '='.repeat(65));
    console.log(`✅ Completado: ${replied.length} borradores, ${notReplied.length} sin respuesta`);
    console.log('='.repeat(65) + '\n');

  } finally {
    if (connection) {
      try { connection.end(); } catch (_) {}
      console.log('Conexión IMAP cerrada');
    }
  }
}


// ============================================================================
// CARPETA IA — Correos movidos manualmente por el usuario
// ============================================================================

// Busca 'IA' recursivamente usando el delimiter real del servidor IMAP
function findBoxPath(boxes, targetName, prefix) {
  for (const [name, box] of Object.entries(boxes || {})) {
    const sep      = box.delimiter || '.';
    const fullPath = prefix ? `${prefix}${sep}${name}` : name;
    if (name === targetName) return fullPath;
    const child = findBoxPath(box.children, targetName, fullPath);
    if (child) return child;
  }
  return null;
}

async function findIAFolder(connection) {
  try {
    const boxes = await connection.getBoxes();
    const found  = findBoxPath(boxes, 'IA', '');
    if (found) { console.log(`📁 Carpeta IA: ${found}`); return found; }
  } catch (_) {}
  // Fallback: probar rutas habituales directamente
  for (const name of ['INBOX.IA', 'INBOX/IA', 'IA']) {
    try {
      await connection.openBox(name, false);
      console.log(`📁 Carpeta IA (fallback): ${name}`);
      return name;
    } catch (_) {}
  }
  return null;
}

async function processIAFolder() {
  console.log('\n' + '─'.repeat(65));
  console.log('📁 [IA] Comprobando carpeta IA...');

  let connection;
  const created = [];

  try {
    connection = await withRetry(connectToIMAP);

    // Buscar carpetas (sin cambiar el buzón seleccionado)
    const draftsFolder = await findDraftsFolder(connection);
    const iaFolder     = await findIAFolder(connection);

    if (!iaFolder) {
      console.log('⚠️  [IA] Carpeta IA no encontrada en el buzón — créala en tu cliente de correo');
      return { count: 0, items: [] };
    }

    await connection.openBox(iaFolder, false);

    const messages = await connection.search(
      ['UNANSWERED'],
      {
        bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)', 'TEXT'],
        struct: true,
        markSeen: false,
      }
    );

    if (messages.length === 0) {
      console.log('📭 [IA] Sin correos pendientes');
      return { count: 0, items: [] };
    }

    console.log(`📧 [IA] ${messages.length} correo(s) a procesar`);

    for (const msg of messages) {
      const uid = msg.attributes.uid;
      try {
        const headerPart = (msg.parts || []).find(p => p.which && p.which.startsWith('HEADER'));
        const headers    = (headerPart && headerPart.body) ? headerPart.body : {};

        const from      = (headers.from?.[0])          || 'Desconocido';
        const subject   = (headers.subject?.[0])        || '(sin asunto)';
        const dateStr   = (headers.date?.[0])           || '';
        const messageId = (headers['message-id']?.[0])  || '';
        const inReplyTo = (headers['in-reply-to']?.[0]) || '';
        const references= (headers.references?.[0])     || '';
        const date      = dateStr ? new Date(dateStr) : new Date();

        let body = '';
        try {
          const parts = ImapSimple.getParts(msg.attributes.struct);
          for (const part of parts) {
            if (part.type !== 'text') continue;
            const data = await connection.getPartData(msg, part);
            const text = data.toString();
            if (part.subtype === 'plain')            { body = text; break; }
            else if (part.subtype === 'html' && !body) { body = stripHtml(text); }
          }
        } catch (_) { body = '(no se pudo obtener el cuerpo)'; }

        const email = {
          from, to: CONFIG.ionos_email, subject, date,
          messageId, inReplyTo, references,
          body: body.trim().substring(0, CONFIG.max_body_chars),
        };

        console.log(`  📨 "${subject}" — ${from}`);

        const analysis = await analyzeEmailWithClaude(email, true);

        // Siempre crear borrador: el usuario lo movió a IA explícitamente
        const draftText = analysis.draft ||
          `Hemos recibido su correo y nos ponemos en contacto con usted a la mayor brevedad.`;

        const raw = await buildRawMime({
          from:       CONFIG.ionos_email,
          to:         from,
          subject:    `Re: ${subject.replace(/^Re:\s*/i, '')}`,
          text:       draftText,
          inReplyTo:  messageId,
          references: [references, messageId].filter(Boolean).join(' '),
        });

        await saveDraftToIMAP(connection, raw, draftsFolder, subject);

        // Marcar como respondido para no reprocesar
        await new Promise(resolve => {
          connection.imap.uid.addFlags(uid, ['\\Answered'], err => {
            if (err) console.log(`  ⚠️  No se pudo marcar UID ${uid}: ${err.message}`);
            resolve();
          });
        });

        created.push({ from, subject, priority: analysis.priority || 'normal' });
        console.log(`  ✅ Borrador creado: "${subject}"`);

        await new Promise(r => setTimeout(r, 300));

      } catch (err) {
        console.error(`  ❌ Error UID ${uid}: ${err.message}`);
      }
    }

    return { count: created.length, items: created };

  } finally {
    if (connection) {
      try { connection.end(); } catch (_) {}
    }
  }
}

// ============================================================================
// EXPORTAR + ARRANCAR SI SE EJECUTA DIRECTAMENTE
// ============================================================================
module.exports = { runEmailAnalysisAndDrafts, processIAFolder };

if (require.main === module) {
  runEmailAnalysisAndDrafts().catch(err => {
    console.error('❌ Error fatal:', err.message);
    process.exit(1);
  });
}
