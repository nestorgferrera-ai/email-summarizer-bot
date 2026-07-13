#!/usr/bin/env node
// ============================================================================
// SERVIDOR MCP — Búsqueda de correos IONOS como herramienta de Claude
// ============================================================================
'use strict';

require('dotenv').config();
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const {
  withRetry,
  getImapConfigFromEnv,
  connectToImap,
  fetchEmails,
  parseSearchQuery,
  searchEmails,
} = require('./lib/imap-client');

const server = new McpServer({ name: 'email-search-mcp', version: '1.0.0' });

function formatEmail(email, index) {
  const dateStr = email.date.toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return `${index + 1}. ${email.subject}\n   De: ${email.from}\n   Fecha: ${dateStr}\n   Preview: ${email.preview}`;
}

async function withImapConnection(fn) {
  const config = getImapConfigFromEnv();
  if (!config.user || !config.password) {
    throw new Error('Faltan credenciales IMAP (IONOS_EMAIL / IONOS_PASSWORD). Configura estas variables de entorno.');
  }
  const connection = await withRetry(() => connectToImap(config));
  try {
    return await fn(connection);
  } finally {
    try { await connection.end(); } catch { /* noop */ }
  }
}

server.registerTool(
  'search_emails',
  {
    title: 'Buscar correos',
    description:
      'Busca correos en la bandeja de entrada (IMAP) por texto libre, remitente o asunto. ' +
      'Admite prefijos "de:"/"from:" y "asunto:"/"subject:" en el propio texto de búsqueda ' +
      '(p.ej. "de:mapfre" o "asunto:factura"); si no se indica prefijo, busca en todo el mensaje.',
    inputSchema: {
      query: z.string().min(1).describe('Texto a buscar, opcionalmente con prefijo de:/asunto:'),
      days: z.number().int().min(1).max(365).optional()
        .describe('Limitar la búsqueda a los últimos N días (opcional)'),
      unread: z.boolean().optional()
        .describe('Si es true, busca solo entre correos no leídos (IMAP UNSEEN)'),
      limit: z.number().int().min(1).max(50).optional()
        .describe('Número máximo de resultados a devolver (por defecto 15)'),
    },
  },
  async ({ query, days, unread = false, limit = 15 }) => {
    const { query: parsedQuery, field } = parseSearchQuery(query);

    const emails = await withImapConnection(async connection => {
      const results = await searchEmails(connection, { query: parsedQuery, field, days: days || null, unread }, { limit });
      // Si se buscó por remitente/asunto y no hubo resultados, reintenta en
      // todo el mensaje: el término puede estar en una parte distinta a la
      // que se asumió (p.ej. en el asunto de un correo de otro remitente).
      if (results.length === 0 && field !== 'text') {
        return searchEmails(connection, { query: parsedQuery, field: 'text', days: days || null, unread }, { limit });
      }
      return results;
    });

    if (emails.length === 0) {
      return { content: [{ type: 'text', text: `No se encontraron correos para "${query}".` }] };
    }

    const text = `${emails.length} correo(s) encontrados para "${query}":\n\n` +
      emails.map(formatEmail).join('\n\n');
    return { content: [{ type: 'text', text }] };
  }
);

server.registerTool(
  'list_recent_emails',
  {
    title: 'Listar correos recientes',
    description: 'Lista los correos más recientes de la bandeja de entrada, opcionalmente limitados a los últimos N días.',
    inputSchema: {
      last: z.number().int().min(1).max(50).optional()
        .describe('Número de correos recientes a listar (por defecto 20, ignorado si se indica "days")'),
      days: z.number().int().min(1).max(365).optional()
        .describe('Listar todos los correos de los últimos N días en vez de un número fijo'),
      unread: z.boolean().optional()
        .describe('Si es true, lista solo correos no leídos (IMAP UNSEEN)'),
    },
  },
  async ({ last = 20, days, unread = false }) => {
    const emails = await withImapConnection(connection =>
      fetchEmails(connection, days ? { days, unread } : { last, unread })
    );

    if (emails.length === 0) {
      return { content: [{ type: 'text', text: 'No hay correos en el rango solicitado.' }] };
    }

    const text = `${emails.length} correo(s):\n\n` + emails.map(formatEmail).join('\n\n');
    return { content: [{ type: 'text', text }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('✅ Servidor MCP de correo iniciado (stdio)');
}

main().catch(err => {
  console.error('❌ Error fatal en el servidor MCP:', err);
  process.exit(1);
});
