// ============================================================================
// DIFERENCIAS ENVÍO vs RECEPCIÓN — Selava
//
// Módulo puro (sin red ni Google Sheets): compara lo enviado a Selava (fila de
// "Albaran Entrega Selava") con lo recibido (albarán de recepción) y construye
// el correo. server.js se encarga de leer la hoja y de enviarlo.
// ============================================================================

// Artículo del envío ↔ artículo equivalente en la recepción de Selava
const DIFF_ITEMS = [
  { sendKey: 'sabanas',          recvKey: 'sabanas',        label: 'Sábanas' },
  { sendKey: 'mantas',           recvKey: 'mantas',         label: 'Mantas' },
  { sendKey: 'colchas',          recvKey: 'colchas',        label: 'Colchas' },
  { sendKey: 'fundas_almohadas', recvKey: 'fundas_almohadas', label: 'F. Almohadas' },
  { sendKey: 'almohadas',        recvKey: 'almohadas',      label: 'Almohadas' },
  { sendKey: 'toallas',          recvKey: 'toallas_bano',   label: 'Toallas Baño' },
  { sendKey: 'toallas_pequenas', recvKey: 'toallas_lavabo', label: 'Toallas Lavabo' },
  { sendKey: 'alfombrillas',     recvKey: 'alfombrillas',   label: 'Alfombrillas' },
];

// Columnas de la hoja "Albaran Entrega Selava": D..K = artículos (en el orden
// de ITEMS de server.js), L = período, A = marca temporal.
const RESUMEN_ITEM_KEYS = ['sabanas', 'mantas', 'colchas', 'fundas_almohadas', 'almohadas', 'toallas', 'toallas_pequenas', 'alfombrillas'];
const RESUMEN_COL_START = 3;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Fila de la hoja de resumen → { sent: {sabanas: n, ...}, periodo }
function resumenRowToSent(row) {
  const sent = {};
  RESUMEN_ITEM_KEYS.forEach((key, i) => {
    const n = parseInt(row[RESUMEN_COL_START + i], 10);
    sent[key] = isNaN(n) ? 0 : n;
  });
  return { sent, periodo: String(row[11] || '').replace(/\s+—\s+\d+\s+envíos?\s*$/, '').trim() };
}

function compare(sent, received) {
  const rows = DIFF_ITEMS.map(it => {
    const enviado = sent[it.sendKey] || 0;
    const recibido = received[it.recvKey] || 0;
    return { label: it.label, enviado, recibido, diff: recibido - enviado };
  });
  const faltan = rows.reduce((s, r) => s + (r.diff < 0 ? -r.diff : 0), 0);
  const extra = rows.reduce((s, r) => s + (r.diff > 0 ? r.diff : 0), 0);
  return { rows, faltan, extra };
}

function buildSubject(albaranNum, faltan, extra) {
  const partes = [];
  if (faltan) partes.push(`faltan ${faltan}`);
  if (extra) partes.push(`${extra} extra`);
  const estado = partes.length ? partes.join(', ') : 'todo correcto';
  return `Diferencias Selava — Albarán ${albaranNum || 's/n'} (${estado})`;
}

function buildHtml({ rows, faltan, extra }, info) {
  const { albaranNum, responsable, recibidoFecha, enviadoTs, enviadoPeriodo, enviadoResp, diasAntes } = info;
  let banner;
  if (!faltan && !extra) {
    banner = `<span style="color:#27ae60">✅ <strong>Todo correcto</strong>: lo recibido coincide con lo enviado.</span>`;
  } else {
    const p = [];
    if (faltan) p.push(`🔴 <strong>Faltan ${faltan} pieza(s)</strong> en esta entrega.`);
    if (extra) p.push(`🟡 <strong>${extra} pieza(s) extra</strong> recibidas.`);
    banner = `${p.join(' ')} Revisa la tabla para el detalle.`;
  }
  const bannerColor = faltan ? '#e74c3c' : extra ? '#f1c40f' : '#27ae60';

  const body = rows.map(r => {
    let diffCell, estado;
    if (r.diff < 0) {
      diffCell = `<strong style="color:#c0392b">${r.diff}</strong>`;
      estado = `<span style="color:#c0392b">⚠️ Faltan ${-r.diff}</span>`;
    } else if (r.diff > 0) {
      diffCell = `<strong style="color:#b7791f">+${r.diff}</strong>`;
      estado = `<span style="color:#b7791f">➕ ${r.diff} extra</span>`;
    } else {
      diffCell = `<strong style="color:#1e8449">✓ 0</strong>`;
      estado = `<span style="color:#1e8449">✅ Correcto</span>`;
    }
    return `<tr>
      <td style="padding:6px 12px">${esc(r.label)}</td>
      <td style="padding:6px 12px;text-align:center">${r.enviado}</td>
      <td style="padding:6px 12px;text-align:center"><strong>${r.recibido}</strong></td>
      <td style="padding:6px 12px;text-align:center">${diffCell}</td>
      <td style="padding:6px 12px">${estado}</td>
    </tr>`;
  }).join('');

  const enviadoLinea = enviadoTs
    ? `<strong>Enviado:</strong> ${esc(enviadoTs)}${enviadoPeriodo ? ` · ${esc(enviadoPeriodo)}` : ''}${diasAntes != null ? ` · ${diasAntes === 0 ? 'mismo día' : `${diasAntes} día${diasAntes !== 1 ? 's' : ''} antes`}` : ''}`
    : `<strong>Enviado:</strong> sin albarán de envío registrado`;

  return `
<div style="font-family:Arial,sans-serif;max-width:640px">
  <h2 style="color:#2c3e50">🧺 Diferencias Envío vs Recepción — Selava</h2>
  <p><strong>Recibido:</strong> ${esc(recibidoFecha)} · Albarán ${esc(albaranNum || '—')} · Resp.: ${esc(responsable)}<br>
     ${enviadoLinea}</p>
  <div style="border-left:4px solid ${bannerColor};padding:8px 12px;margin:12px 0">${banner}</div>
  <table style="border-collapse:collapse;width:100%">
    <thead><tr>
      <th style="padding:6px 12px;text-align:left">Artículo</th>
      <th style="padding:6px 12px">Enviado</th>
      <th style="padding:6px 12px">Recibido</th>
      <th style="padding:6px 12px">Diferencia</th>
      <th style="padding:6px 12px;text-align:left">Estado</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p style="color:#888;font-size:12px;margin-top:16px">Registrado vía Telegram — Bot Lavandería Clínica Bandama</p>
</div>`;
}

module.exports = { DIFF_ITEMS, resumenRowToSent, compare, buildSubject, buildHtml };
