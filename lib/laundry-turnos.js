// ============================================================================
// TURNOS DE RETIRADA DE ROPA DE CAMA — puestos, cuadro semanal y controles
//
// Todo lo de este módulo es puro (sin red ni Google Sheets) para poder
// probarlo aislado. server.js se encarga de leer la hoja y de enviar.
//
// El cuadro se repite de lunes a domingo (ver Planificación Retirada de Ropa
// de Cama y Registro de Cambios de Toallas): aquí solo se guarda QUÉ PUESTOS toca registrar cada día, no QUIÉN,
// porque las personas cambian (bajas, cambios de turno...). El nombre lo
// escribe cada persona al registrar el envío.
// ============================================================================

const TZ = 'Atlantic/Canary';

const PUESTOS = [
  { key: 'UCA100', rol: 'Aux. noche' },
  { key: 'UCA400', rol: 'Refuerzo mañana' },
  { key: 'URA300', rol: 'Refuerzo mañana' },
  { key: 'URA500', rol: 'Aux. mañana' },
  { key: 'LIMPIEZA', rol: 'Aux. limpieza' },
];

// Puestos que deben registrar el envío cada día. 0=Dom 1=Lun ... 6=Sáb
const TURNOS_SEMANA = {
  0: ['UCA100', 'LIMPIEZA'],
  1: ['UCA100', 'UCA400'],
  2: ['UCA100', 'UCA400'],
  3: ['UCA100', 'UCA400', 'URA300', 'URA500', 'LIMPIEZA'],
  4: ['UCA100', 'UCA400'],
  5: ['UCA100', 'UCA400'],
  6: ['UCA100'],
};

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIAS_CORTO = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function puestoLabel(key) {
  const p = PUESTOS.find(x => x.key === key);
  return p ? `${p.key} · ${p.rol}` : key;
}

// ---------------------------------------------------------------------------
// FECHAS (siempre como 'YYYY-MM-DD'; el día "de hoy" se calcula en hora de
// Canarias aunque el servidor corra en UTC)
// ---------------------------------------------------------------------------
function canaryToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function isoToUtc(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(iso, n) {
  const d = isoToUtc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dowOf(iso) {
  return isoToUtc(iso).getUTCDay();
}

function mondayOf(iso) {
  return addDays(iso, -((dowOf(iso) + 6) % 7));
}

function fmtFecha(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function fmtCorta(iso) {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

// 'DD/MM/YYYY' (como lo escribe la hoja) → 'YYYY-MM-DD'
function sheetDateToIso(str) {
  const m = String(str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function normalizePuesto(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, '');
  return PUESTOS.some(p => p.key === s) ? s : null;
}

// Filas de la hoja "Envío Diario" (A=marca B=fecha C=hora D=responsable
// E-L=artículos M=puesto) → [{ iso, puesto, responsable }]. Las filas sin
// puesto (anteriores a este control) se ignoran.
function rowsToEntries(rows) {
  const out = [];
  for (const row of rows || []) {
    if (!row) continue;
    const iso = sheetDateToIso(row[1]);
    const puesto = normalizePuesto(row[12]);
    if (!iso || !puesto) continue;
    out.push({ iso, puesto, responsable: String(row[3] || '').trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CONTROL: qué se esperaba y qué se registró
// ---------------------------------------------------------------------------
// Estado de cada celda: 'ok' (esperado y registrado), 'falta' (esperado y sin
// registrar), 'extra' (registrado sin que tocara ese día), 'na' (ni tocaba ni
// se registró).
function buildDay(iso, entries) {
  const esperados = TURNOS_SEMANA[dowOf(iso)];
  const celdas = PUESTOS.map(p => {
    const responsables = [...new Set(
      entries.filter(e => e.iso === iso && e.puesto === p.key).map(e => e.responsable).filter(Boolean)
    )];
    const registrado = entries.some(e => e.iso === iso && e.puesto === p.key);
    const esperado = esperados.includes(p.key);
    const estado = esperado ? (registrado ? 'ok' : 'falta') : (registrado ? 'extra' : 'na');
    return { puesto: p.key, esperado, registrado, responsables, estado };
  });
  return {
    iso,
    dow: dowOf(iso),
    celdas,
    faltan: celdas.filter(c => c.estado === 'falta').map(c => c.puesto),
  };
}

function buildWeek(mondayIso, entries) {
  const dias = Array.from({ length: 7 }, (_, i) => buildDay(addDays(mondayIso, i), entries));
  return {
    lunes: mondayIso,
    domingo: addDays(mondayIso, 6),
    dias,
    esperados: dias.reduce((n, d) => n + d.celdas.filter(c => c.esperado).length, 0),
    faltan: dias.reduce((n, d) => n + d.faltan.length, 0),
  };
}

// Lunes de la semana COMPLETA anterior a la fecha dada (el control semanal se
// manda el lunes y revisa la semana que acaba de terminar).
function previousWeekMonday(iso) {
  return addDays(mondayOf(iso), -7);
}

// ---------------------------------------------------------------------------
// FORMATOS
// ---------------------------------------------------------------------------
function escapeMd(str) {
  return String(str).replace(/([_*`\[\]])/g, '\\$1');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function nombres(c) {
  return c.responsables.length ? c.responsables.join(', ') : 'sin nombre';
}

function dailyControlText(day) {
  const cab = `🧺 *Control diario de envíos — ${DIAS[day.dow]} ${fmtFecha(day.iso)}*`;
  const lineas = day.celdas
    .filter(c => c.estado !== 'na')
    .map(c => {
      if (c.estado === 'falta') return `❌ *${puestoLabel(c.puesto)} — SIN REGISTRAR*`;
      if (c.estado === 'extra') return `➕ ${puestoLabel(c.puesto)} — ${escapeMd(nombres(c))} _(no tocaba hoy)_`;
      return `✅ ${puestoLabel(c.puesto)} — ${escapeMd(nombres(c))}`;
    });
  const pie = day.faltan.length
    ? `\n⚠️ Faltan por registrar: *${day.faltan.join(', ')}*`
    : '\n👍 Todos los turnos de hoy han registrado su envío.';
  return `${cab}\n\n${lineas.join('\n')}\n${pie}`;
}

function weeklyControlText(week) {
  const cab = `📅 *Control semanal de envíos — ${fmtCorta(week.lunes)} al ${fmtFecha(week.domingo)}*`;
  const lineas = week.dias.map(d => {
    const partes = d.celdas
      .filter(c => c.estado !== 'na')
      .map(c => {
        if (c.estado === 'falta') return `❌ *${c.puesto}*`;
        if (c.estado === 'extra') return `➕ ${c.puesto}`;
        return `✅ ${c.puesto}`;
      });
    return `*${DIAS_CORTO[d.dow]} ${fmtCorta(d.iso)}* — ${partes.join(' · ')}`;
  });
  const faltas = week.dias.flatMap(d =>
    d.faltan.map(p => `• ${DIAS_CORTO[d.dow]} ${fmtFecha(d.iso)} — *${puestoLabel(p)}*`)
  );
  const pie = faltas.length
    ? `⚠️ *Turnos sin registrar (${faltas.length} de ${week.esperados}):*\n${faltas.join('\n')}`
    : `👍 Los ${week.esperados} turnos de la semana registraron su envío.`;
  return `${cab}\n\n${lineas.join('\n')}\n\n${pie}`;
}

const ESTILO = {
  th:   'padding:6px 10px;border:1px solid #ccc;background:#2c3e50;color:#fff;text-align:center;font-size:12px',
  td:   'padding:6px 10px;border:1px solid #ccc;text-align:center;font-size:13px',
  ok:   'background:#e6f4ea;color:#1e6b34',
  falta:'background:#d93025;color:#fff;font-weight:bold',
  extra:'background:#fff4cc;color:#7a5c00',
  na:   'background:#f3f3f3;color:#aaa',
};

function cellHtml(c) {
  let txt;
  if (c.estado === 'falta') txt = '❌ FALTA';
  else if (c.estado === 'na') txt = '—';
  else txt = escapeHtml(nombres(c)) + (c.estado === 'extra' ? '<br><small>(no tocaba)</small>' : '');
  return `<td style="${ESTILO.td};${ESTILO[c.estado]}">${txt}</td>`;
}

function weeklyControlHtml(week) {
  const cabecera = PUESTOS.map(p => `<th style="${ESTILO.th}">${p.key}<br><small>${p.rol}</small></th>`).join('');
  const filas = week.dias.map(d =>
    `<tr><td style="${ESTILO.td};text-align:left;font-weight:bold">${DIAS_CORTO[d.dow]} ${fmtCorta(d.iso)}</td>${d.celdas.map(cellHtml).join('')}</tr>`
  ).join('');
  const resumen = week.faltan
    ? `<p style="color:#d93025;font-weight:bold">⚠️ ${week.faltan} turno${week.faltan !== 1 ? 's' : ''} sin registrar de ${week.esperados}.</p>`
    : `<p style="color:#1e6b34;font-weight:bold">👍 Los ${week.esperados} turnos de la semana registraron su envío.</p>`;
  return `
<div style="font-family:Arial,sans-serif;max-width:640px">
  <h2 style="color:#2c3e50">📅 Control semanal de envíos a Selava</h2>
  <p><strong>Semana:</strong> ${fmtFecha(week.lunes)} → ${fmtFecha(week.domingo)}</p>
  ${resumen}
  <table style="border-collapse:collapse;width:100%">
    <thead><tr><th style="${ESTILO.th}">Día</th>${cabecera}</tr></thead>
    <tbody>${filas}</tbody>
  </table>
  <p style="color:#888;font-size:12px;margin-top:16px">Generado automáticamente — Bot Lavandería Clínica Bandama</p>
</div>`;
}

function dailyControlHtml(day) {
  const filas = day.celdas.filter(c => c.estado !== 'na').map(c => `
    <tr>
      <td style="${ESTILO.td};text-align:left">${puestoLabel(c.puesto)}</td>
      ${cellHtml(c)}
    </tr>`).join('');
  const resumen = day.faltan.length
    ? `<p style="color:#d93025;font-weight:bold">⚠️ Faltan por registrar: ${day.faltan.join(', ')}</p>`
    : `<p style="color:#1e6b34;font-weight:bold">👍 Todos los turnos de hoy han registrado su envío.</p>`;
  return `
<div style="font-family:Arial,sans-serif;max-width:520px">
  <h2 style="color:#2c3e50">🧺 Control diario de envíos a Selava</h2>
  <p><strong>${DIAS[day.dow]} ${fmtFecha(day.iso)}</strong></p>
  ${resumen}
  <table style="border-collapse:collapse;width:100%">
    <thead><tr><th style="${ESTILO.th}">Puesto</th><th style="${ESTILO.th}">Registrado por</th></tr></thead>
    <tbody>${filas}</tbody>
  </table>
  <p style="color:#888;font-size:12px;margin-top:16px">Generado automáticamente — Bot Lavandería Clínica Bandama</p>
</div>`;
}

// ---------------------------------------------------------------------------
// RESUMEN DE LA ÚLTIMA SEMANA (/semana): por día, cada turno y su ropa
// ---------------------------------------------------------------------------
// Como rowsToEntries pero conservando las cantidades y las filas anteriores al
// control de turnos (sin puesto → puesto null). `items` es [{ key, label }] en el
// orden de las columnas de la hoja, a partir de `colStart` (0 = A).
function rowsToDetailedEntries(rows, items, colStart = 4) {
  const out = [];
  for (const row of rows || []) {
    if (!row) continue;
    const iso = sheetDateToIso(row[1]);
    if (!iso) continue;
    const qty = {};
    items.forEach((item, idx) => {
      const n = parseInt(row[colStart + idx], 10);
      qty[item.key] = isNaN(n) ? 0 : n;
    });
    out.push({ iso, puesto: normalizePuesto(row[12]), responsable: String(row[3] || '').trim(), qty });
  }
  return out;
}

// Últimos 7 días terminando en `hoyIso`, del más reciente al más antiguo. Cada
// día lleva sus envíos y los puestos esperados que faltan. Hoy no se da por
// "faltante" (el día no ha terminado: queda como pendiente), y un día con
// envíos anteriores al control de turnos (sin puesto) no se marca porque no se
// puede saber qué puesto era.
function buildRecentDays(hoyIso, detailed, items) {
  const dias = [];
  for (let i = 0; i < 7; i++) {
    const iso = addDays(hoyIso, -i);
    const envios = detailed.filter(e => e.iso === iso);
    const esperados = TURNOS_SEMANA[dowOf(iso)];
    const sinRegistrar = esperados.filter(p => !envios.some(e => e.puesto === p));
    const hayLegado = envios.some(e => !e.puesto);
    dias.push({
      iso,
      dow: dowOf(iso),
      envios,
      total: envios.reduce((n, e) => n + items.reduce((m, it) => m + (e.qty[it.key] || 0), 0), 0),
      faltan: iso !== hoyIso && !hayLegado ? sinRegistrar : [],
      pendientes: iso === hoyIso ? sinRegistrar : [],
    });
  }
  return dias;
}

function piezasEnvio(envio, items) {
  return items.reduce((n, it) => n + (envio.qty[it.key] || 0), 0);
}

function recentSummaryBlocks(dias, items) {
  const bloques = dias.map(d => {
    const lineas = [`📅 *${DIAS_CORTO[d.dow]} ${fmtFecha(d.iso)}* — *${d.total} piezas*`];
    // Los envíos con puesto en el orden del cuadro; los sin puesto al final
    const orden = e => (e.puesto ? PUESTOS.findIndex(p => p.key === e.puesto) : 99);
    [...d.envios].sort((a, b) => orden(a) - orden(b)).forEach(e => {
      const etiqueta = e.puesto ? puestoLabel(e.puesto) : 'Sin puesto';
      const detalle = items.filter(it => e.qty[it.key] > 0).map(it => `${it.label} ${e.qty[it.key]}`).join(' · ');
      lineas.push(`${e.puesto ? '✅' : '▫️'} ${etiqueta} — ${escapeMd(e.responsable || 'sin nombre')} · *${piezasEnvio(e, items)}*`);
      if (detalle) lineas.push(`      ${detalle}`);
    });
    d.faltan.forEach(p => lineas.push(`❌ *${puestoLabel(p)} — SIN REGISTRAR*`));
    d.pendientes.forEach(p => lineas.push(`⏳ ${puestoLabel(p)} — pendiente de hoy`));
    return lineas.join('\n');
  });
  const total = dias.reduce((n, d) => n + d.total, 0);
  const faltan = dias.reduce((n, d) => n + d.faltan.length, 0);
  const pie = `📦 *Total 7 días: ${total} piezas*` +
    (faltan ? `\n⚠️ Turnos sin registrar: *${faltan}*` : '\n👍 Sin turnos pendientes de registrar.');
  return { cabecera: '📆 *Resumen últimos 7 días — por turno*', bloques, pie };
}

// Parte un texto en mensajes de Telegram (límite 4096) cortando entre bloques.
function splitMessage(bloques, max = 3800) {
  const out = [];
  let actual = '';
  for (const b of bloques) {
    if (actual && (actual + '\n\n' + b).length > max) { out.push(actual); actual = b; }
    else actual = actual ? actual + '\n\n' + b : b;
  }
  if (actual) out.push(actual);
  return out;
}

module.exports = {
  PUESTOS, TURNOS_SEMANA, DIAS, DIAS_CORTO,
  puestoLabel, canaryToday, addDays, dowOf, mondayOf, previousWeekMonday,
  fmtFecha, fmtCorta, sheetDateToIso, normalizePuesto, rowsToEntries,
  buildDay, buildWeek,
  dailyControlText, weeklyControlText, dailyControlHtml, weeklyControlHtml,
  escapeMd,
  rowsToDetailedEntries, buildRecentDays, recentSummaryBlocks, splitMessage,
};
