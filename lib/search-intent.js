// ============================================================================
// INTERPRETACIÓN DE BÚSQUEDAS EN LENGUAJE NATURAL (Claude API)
// Convierte frases como "de José Roca, los últimos 5 correos" en una consulta
// estructurada { field, query, limit } para lib/imap-client.js.
// ============================================================================
'use strict';

const axios = require('axios');

const SYSTEM_PROMPT = `Conviertes instrucciones en español natural para buscar correos electrónicos en una consulta estructurada.

Devuelve ÚNICAMENTE un objeto JSON, sin texto adicional ni bloques de código, con esta forma exacta:
{
  "field": "text" | "from" | "subject",
  "query": "términos de búsqueda limpios",
  "limit": número entero o null
}

Reglas:
- "field": usa "from" SOLO si la instrucción busca ÚNICAMENTE identificar correos por su remitente, con un marcador explícito ("de", "desde", "remitente", "quién me escribió") y SIN ningún otro criterio de contenido (p.ej. "correos de José", "qué me escribió Mapfre"). Usa "subject" SOLO si busca ÚNICAMENTE por asunto/tema, con marcador explícito ("asunto", "tema", "sobre") y sin otro criterio. Si la instrucción COMBINA remitente con contenido adicional a buscar (p.ej. "correo de Jerónimo que mencione a Carlos Roca", "de Mapfre sobre la póliza vencida"), usa "text" e incluye TODOS los términos relevantes (remitente + contenido) en "query" — "text" ya busca a la vez en remitente, asunto y cuerpo, así que no pierde el criterio de remitente por dejar de usar "from". Si la instrucción es solo un nombre o palabras sueltas SIN marcador explícito (p.ej. "Jose Roca", "factura selava"), usa también "text".
- "query": solo el contenido real a buscar (nombres, palabras clave), SIN incluir palabras de relleno como "últimos", "recientes", "correos", "mensajes", "emails", "buscar", "de", "asunto", "que mencione(n)", "sobre", cantidades en número o en palabras, ni artículos sueltos.
- "limit": si el usuario pide un número de resultados (p.ej. "los últimos 5", "cinco correos", "10 mensajes"), conviértelo a un entero. Si no se especifica, usa null.
- Si la instrucción no tiene contenido de búsqueda real (solo pide "los últimos N correos" sin remitente/asunto/tema), usa field "text" y query "" (cadena vacía).`;

async function interpretSearchQuery(rawQuery, { apiKey, model } = {}) {
  if (!apiKey || !rawQuery?.trim()) return null;

  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: model || 'claude-haiku-4-5',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Instrucción: "${rawQuery}"` }],
    }, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      timeout: 15000,
    });

    const raw = response.data.content[0]?.text?.trim() || '{}';
    const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(jsonText);

    if (typeof parsed.query !== 'string') return null;

    return {
      field: ['from', 'subject'].includes(parsed.field) ? parsed.field : 'text',
      query: parsed.query.trim(),
      limit: Number.isInteger(parsed.limit) && parsed.limit > 0 ? parsed.limit : null,
    };
  } catch (err) {
    console.error('⚠️ No se pudo interpretar la búsqueda con Claude, usando modo literal:', err.message);
    return null;
  }
}

module.exports = { interpretSearchQuery };
