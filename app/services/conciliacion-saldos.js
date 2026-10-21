'use strict';

// Conciliación de saldos: compara lo que dice cada Factura (PagosReal /
// NotasCredito / Status) contra lo que realmente respaldan los documentos que la
// afectan, y permite ajustar solo lo que el usuario seleccione.
//
//   PagosReal esperado    = SUM(PagFac.TOTALPAGO) de cobros en Status REALIZADO
//   NotasCredito esperado = SUM(NotaCredDeta.IMPORTEAPLICA) de notas Tipo NC en Status EMITIDA
//   Status esperado       = statusPorSaldo(TOTAL, PagosReal, NotasCredito)
//
// Las Notas de Débito se concilian solo en Status (cobradas por Pagos o por Notas
// de Crédito). Nunca se toca AnioPago/AnioNotaCred.

const { sql } = require('../config/db');
const { statusPorSaldo } = require('./saldo-factura');

const num = v => (v === '' || v == null || isNaN(parseFloat(v))) ? 0 : parseFloat(v);
const trim = v => (v == null ? '' : String(v).trim());
const r2 = v => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const dif = (a, b) => Math.abs(num(a) - num(b)) > 0.005;
const SK = c => `ISNULL(LTRIM(RTRIM(${c})),'')`;

// ── Facturas ────────────────────────────────────────────────────────────────
const sqlFacturas = (lock, where) => `
WITH P AS (
  SELECT pf.NOFACTURA id, ${SK('pf.SERIEFAC')} s, SUM(pf.TOTALPAGO) tp,
         COUNT(DISTINCT pg.Id_NoPago) nc, STRING_AGG(CAST(pg.Id_NoPago AS varchar(12)), ',') ids
  FROM Empresa2.PagFac pf JOIN Empresa2.Pagos pg ON pg.Id_NoPago = pf.ID_NOPAGO
  WHERE LTRIM(RTRIM(pg.Status)) = 'REALIZADO' AND pf.NOFACTURA > 0
  GROUP BY pf.NOFACTURA, ${SK('pf.SERIEFAC')}),
N AS (
  SELECT d.ID_NOFACTURA id, ${SK('d.SerieFac')} s, SUM(d.IMPORTEAPLICA) nc,
         STRING_AGG(CAST(d.ID_NOTACREDITO AS varchar(12)), ',') ids
  FROM Empresa2.NotaCredDeta d JOIN Empresa2.NotaCred n
    ON n.Id_NotaCredito = d.ID_NOTACREDITO AND ${SK('n.Serie')} = ${SK('d.SERIE')} AND LTRIM(RTRIM(n.Tipo)) = LTRIM(RTRIM(d.TIPO))
  WHERE LTRIM(RTRIM(n.Status)) = 'EMITIDA' AND LTRIM(RTRIM(n.Tipo)) = 'NC' AND d.ID_NOFACTURA > 0
  GROUP BY d.ID_NOFACTURA, ${SK('d.SerieFac')})
SELECT f.Id_NoFactura, ${SK('f.SerieFac')} SerieFac, f.Id_Cliente, LTRIM(RTRIM(f.NombreCom)) Cliente, f.FechaFactura,
       LTRIM(RTRIM(f.Status)) Status, f.TOTAL, ISNULL(f.PagosReal,0) PagosReal, ISNULL(f.NotasCredito,0) NotasCredito,
       ISNULL(P.tp,0) PagosExp, ISNULL(N.nc,0) NCExp, ISNULL(P.nc,0) NumCobros, P.ids CobrosIds, N.ids NotasIds
FROM Empresa2.Factura f ${lock}
LEFT JOIN P ON P.id = f.Id_NoFactura AND P.s = ${SK('f.SerieFac')}
LEFT JOIN N ON N.id = f.Id_NoFactura AND N.s = ${SK('f.SerieFac')}
WHERE ${where}`;
const WHERE_FACTURAS = `(@cli IS NULL OR f.Id_Cliente = @cli) AND (@desde IS NULL OR f.FechaFactura >= @desde)
  AND (@hasta IS NULL OR f.FechaFactura <= @hasta) AND (@fol IS NULL OR f.Id_NoFactura = @fol)
  AND (@folD IS NULL OR f.Id_NoFactura >= @folD) AND (@folH IS NULL OR f.Id_NoFactura <= @folH)`;

// Clasifica una fila ya leída. `hallazgos` describe qué está mal; `adjustable`
// indica si el ajuste automático es seguro; `riesgo` marca lo que requiere
// revisión humana antes de ajustar.
function evaluarFactura(f) {
  const total = num(f.TOTAL), pr = num(f.PagosReal), nc = num(f.NotasCredito);
  const pe = r2(f.PagosExp), ne = r2(f.NCExp);
  const status = trim(f.Status).toUpperCase();
  const hallazgos = [];
  let riesgo = null;

  if (status === 'CANCELADA') {
    if (pe > 0.005 || ne > 0.005) hallazgos.push('Factura CANCELADA con cobros/notas aplicados');
    return { ...base(f, pe, ne, status), hallazgos, adjustable: false, riesgo: hallazgos.length ? 'cancelada' : null };
  }

  if (dif(pr, pe)) hallazgos.push(pr < pe ? 'Pagos no aplicados a la factura' : (pe < 0.005 ? 'Pagos en la factura sin cobro que los respalde' : 'Pagos de más en la factura'));
  if (dif(nc, ne)) hallazgos.push(nc < ne ? 'Notas de crédito no aplicadas' : (ne < 0.005 ? 'Notas en la factura sin nota que las respalde' : 'Notas de crédito de más en la factura'));

  const statusEsp = statusPorSaldo(total, pe, ne);
  // Factura en cero (borrador/sin importe) y sin cobros: no hay saldo que conciliar.
  const sinImporte = total < 0.005 && pe < 0.005 && ne < 0.005;
  const equivalente = sinImporte || status === statusEsp || (status === 'VENCIDA' && statusEsp === 'EMITIDA');
  if (!equivalente) hallazgos.push(`Status ${status || '(vacío)'} debería ser ${statusEsp}`);

  if (pe + ne > total + 0.01) { hallazgos.push('Sobreaplicada: cobros + notas superan el total (posible cobro duplicado)'); riesgo = 'sobreaplicada'; }
  // El saldo registrado supera lo que respaldan los cobros/notas de este sistema:
  // puede incluir pagos del sistema anterior. Ajustar los borraría, así que solo se
  // ajusta si el usuario lo pide explícitamente.
  else if (pr > pe + 0.005 || nc > ne + 0.005) riesgo = 'sin_respaldo';

  return { ...base(f, pe, ne, status), statusEsp, hallazgos, adjustable: hallazgos.length > 0, riesgo };
}

function base(f, pe, ne, status) {
  return {
    Id_NoFactura: f.Id_NoFactura, SerieFac: trim(f.SerieFac), Id_Cliente: f.Id_Cliente, Cliente: f.Cliente,
    FechaFactura: f.FechaFactura, Status: status, TOTAL: r2(f.TOTAL),
    PagosReal: r2(f.PagosReal), NotasCredito: r2(f.NotasCredito),
    PagosExp: pe, NCExp: ne, NumCobros: f.NumCobros, CobrosIds: f.CobrosIds || '', NotasIds: f.NotasIds || '',
  };
}

function reqFiltros(pool, filtros) {
  const r = pool.request ? pool.request() : new sql.Request(pool);
  const f = filtros || {};
  return r.input('cli', sql.Decimal(9), f.idCliente ? Number(f.idCliente) : null)
    .input('desde', sql.Date, f.desde || null).input('hasta', sql.Date, f.hasta || null)
    .input('fol', sql.Decimal(9), f.folio ? Number(f.folio) : null)
    .input('folD', sql.Decimal(9), f.folioDesde ? Number(f.folioDesde) : null)
    .input('folH', sql.Decimal(9), f.folioHasta ? Number(f.folioHasta) : null);
}

async function analizarFacturas(pool, filtros) {
  const res = await reqFiltros(pool, filtros).query(sqlFacturas('', WHERE_FACTURAS));
  return res.recordset.map(evaluarFactura);
}

// ── Notas de Débito (solo Status) ───────────────────────────────────────────
const sqlND = (lock, where) => `
WITH P AS (
  SELECT pf.ID_NOTACREDITO id, ${SK('pf.SERIEND')} s, SUM(pf.IMPRTE + ISNULL(pf.COMPESACION,0)) ap,
         STRING_AGG(CAST(pg.Id_NoPago AS varchar(12)), ',') ids
  FROM Empresa2.PagFac pf JOIN Empresa2.Pagos pg ON pg.Id_NoPago = pf.ID_NOPAGO
  WHERE LTRIM(RTRIM(pg.Status)) = 'REALIZADO' AND pf.ID_NOTACREDITO > 0 AND ISNULL(pf.NOFACTURA,0) = 0
  GROUP BY pf.ID_NOTACREDITO, ${SK('pf.SERIEND')}),
N AS (
  SELECT d.Id_NotaDebito id, ${SK('d.SerieND')} s, SUM(d.IMPORTEAPLICA) ap,
         STRING_AGG(CAST(d.ID_NOTACREDITO AS varchar(12)), ',') ids
  FROM Empresa2.NotaCredDeta d JOIN Empresa2.NotaCred n
    ON n.Id_NotaCredito = d.ID_NOTACREDITO AND ${SK('n.Serie')} = ${SK('d.SERIE')} AND LTRIM(RTRIM(n.Tipo)) = LTRIM(RTRIM(d.TIPO))
  WHERE LTRIM(RTRIM(n.Status)) = 'EMITIDA' AND LTRIM(RTRIM(n.Tipo)) = 'NC' AND d.Id_NotaDebito > 0
  GROUP BY d.Id_NotaDebito, ${SK('d.SerieND')})
SELECT nd.Id_NotaCredito, ${SK('nd.Serie')} Serie, nd.Id_Cliente, LTRIM(RTRIM(nd.NombreCom)) Cliente, nd.Fecha,
       LTRIM(RTRIM(nd.Status)) Status, nd.ImporteTotal,
       ISNULL(P.ap,0) + ISNULL(N.ap,0) Aplicado, P.ids CobrosIds, N.ids NotasIds
FROM Empresa2.NotaCred nd ${lock}
LEFT JOIN P ON P.id = nd.Id_NotaCredito AND P.s = ${SK('nd.Serie')}
LEFT JOIN N ON N.id = nd.Id_NotaCredito AND N.s = ${SK('nd.Serie')}
WHERE LTRIM(RTRIM(nd.Tipo)) = 'ND' AND LTRIM(RTRIM(nd.Status)) IN ('EMITIDA','PAGADA','PAGO PARCIAL') AND ${where}`;
const WHERE_ND = `(@cli IS NULL OR nd.Id_Cliente = @cli) AND (@desde IS NULL OR nd.Fecha >= @desde)
  AND (@hasta IS NULL OR nd.Fecha <= @hasta) AND (@fol IS NULL OR nd.Id_NotaCredito = @fol)
  AND (@folD IS NULL OR nd.Id_NotaCredito >= @folD) AND (@folH IS NULL OR nd.Id_NotaCredito <= @folH)`;

async function analizarNotasDebito(pool, filtros) {
  const res = await reqFiltros(pool, filtros).query(sqlND('', WHERE_ND));
  return res.recordset.map(n => {
    const status = trim(n.Status).toUpperCase();
    const esp = statusPorSaldo(n.ImporteTotal, 0, n.Aplicado);
    const hallazgos = status === esp ? [] : [`Status ${status} debería ser ${esp}`];
    return {
      Id_NotaCredito: n.Id_NotaCredito, Serie: trim(n.Serie), Id_Cliente: n.Id_Cliente, Cliente: n.Cliente, Fecha: n.Fecha,
      Status: status, StatusEsp: esp, ImporteTotal: r2(n.ImporteTotal), Aplicado: r2(n.Aplicado),
      CobrosIds: n.CobrosIds || '', NotasIds: n.NotasIds || '', hallazgos, adjustable: hallazgos.length > 0,
      riesgo: num(n.Aplicado) > num(n.ImporteTotal) + 0.01 ? 'sobreaplicada'
        : (hallazgos.length && status === 'PAGADA' && num(n.Aplicado) < 0.005 ? 'sin_respaldo' : null),
    };
  });
}

// ── Ajuste ──────────────────────────────────────────────────────────────────
// Recalcula dentro de la transacción (con bloqueo) y aplica; nunca confía en los
// valores que mande el navegador. Devuelve antes/después de cada documento.
async function ajustarFacturas(tx, items, { incluirSinRespaldo = false } = {}) {
  const out = [];
  for (const it of items) {
    const res = await new sql.Request(tx)
      .input('fol', sql.Decimal(9), Number(it.id)).input('serie', sql.VarChar(20), trim(it.serie) || null)
      .query(sqlFacturas('WITH (UPDLOCK, ROWLOCK)', `f.Id_NoFactura = @fol AND ${SK('f.SerieFac')} = ISNULL(@serie,'')`));
    const f = res.recordset[0];
    if (!f) { out.push({ id: it.id, serie: trim(it.serie), ok: false, motivo: 'Factura no encontrada.' }); continue; }
    const e = evaluarFactura(f);
    if (!e.adjustable) { out.push({ id: it.id, serie: e.SerieFac, ok: false, motivo: e.riesgo === 'cancelada' ? 'Factura cancelada: no se ajusta.' : 'Ya está conciliada.' }); continue; }
    if (e.riesgo === 'sin_respaldo' && !incluirSinRespaldo) { out.push({ id: it.id, serie: e.SerieFac, ok: false, motivo: 'Sin documento de respaldo (posible dato del sistema anterior); no se ajustó.' }); continue; }

    const statusNuevo = (e.Status === 'VENCIDA' && e.statusEsp === 'EMITIDA') ? 'VENCIDA' : e.statusEsp;
    await new sql.Request(tx)
      .input('fol', sql.Decimal(9), e.Id_NoFactura).input('serie', sql.VarChar(20), e.SerieFac || null)
      .input('pr', sql.Decimal(9, 2), e.PagosExp).input('nc', sql.Decimal(9, 2), e.NCExp).input('st', sql.VarChar(20), statusNuevo)
      .query(`UPDATE Empresa2.Factura SET PagosReal=@pr, NotasCredito=@nc, Status=@st
              WHERE Id_NoFactura=@fol AND ${SK('SerieFac')} = ISNULL(@serie,'')`);
    out.push({
      id: e.Id_NoFactura, serie: e.SerieFac, ok: true,
      antes: { PagosReal: e.PagosReal, NotasCredito: e.NotasCredito, Status: e.Status },
      despues: { PagosReal: e.PagosExp, NotasCredito: e.NCExp, Status: statusNuevo },
    });
  }
  return out;
}

async function ajustarNotasDebito(tx, items, { incluirSinRespaldo = false } = {}) {
  const out = [];
  for (const it of items) {
    const res = await new sql.Request(tx)
      .input('fol', sql.Decimal(9), Number(it.id)).input('serie', sql.VarChar(20), trim(it.serie) || null)
      .query(sqlND('WITH (UPDLOCK, ROWLOCK)', `nd.Id_NotaCredito = @fol AND ${SK('nd.Serie')} = ISNULL(@serie,'')`));
    const n = res.recordset[0];
    if (!n) { out.push({ id: it.id, serie: trim(it.serie), ok: false, motivo: 'Nota de débito no encontrada o fuera de estatus conciliable.' }); continue; }
    const status = trim(n.Status).toUpperCase();
    const esp = statusPorSaldo(n.ImporteTotal, 0, n.Aplicado);
    if (status === esp) { out.push({ id: it.id, serie: trim(n.Serie), ok: false, motivo: 'Ya está conciliada.' }); continue; }
    if (status === 'PAGADA' && num(n.Aplicado) < 0.005 && !incluirSinRespaldo) { out.push({ id: it.id, serie: trim(n.Serie), ok: false, motivo: 'Sin documento de respaldo (posible dato del sistema anterior); no se ajustó.' }); continue; }
    await new sql.Request(tx)
      .input('fol', sql.Decimal(9), n.Id_NotaCredito).input('serie', sql.VarChar(20), trim(n.Serie) || null).input('st', sql.VarChar(20), esp)
      .query(`UPDATE Empresa2.NotaCred SET Status=@st WHERE Id_NotaCredito=@fol AND LTRIM(RTRIM(Tipo))='ND' AND ${SK('Serie')} = ISNULL(@serie,'')`);
    out.push({ id: n.Id_NotaCredito, serie: trim(n.Serie), ok: true, antes: { Status: status }, despues: { Status: esp } });
  }
  return out;
}

module.exports = { analizarFacturas, analizarNotasDebito, ajustarFacturas, ajustarNotasDebito, evaluarFactura };
