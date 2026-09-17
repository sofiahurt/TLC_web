'use strict';

const { sql } = require('../config/db');

// ── Efecto de saldo sobre una Factura — compartido entre Notas de Crédito y
// Pagos (en el legado es literalmente la misma función; aquí se generaliza
// por `tipo` en vez de duplicarla) ──────────────────────────────────────────
//
// tipo='nota_credito' -> toca Factura.NotasCredito (+ AnioNotaCred al aplicar)
// tipo='pago'          -> toca Factura.PagosReal    (+ AnioPago al aplicar)
// En ambos casos se recalcula Factura.Status: PAGADA / PAGO PARCIAL / EMITIDA.
//
// Extraído de app/routes/notacred.js (statusPorSaldo + el ciclo de aplicar en
// /cabecera/grabar + revertirEfectoSaldo) sin cambiar su comportamiento --
// notacred.js ahora importa de aquí.

const num = v => (v === '' || v == null || isNaN(parseFloat(v))) ? 0 : parseFloat(v);
const trim = v => (v == null ? '' : String(v).trim());
const serieKey = v => { const t = trim(v); return t || null; };

const COLUMNA_POR_TIPO = { pago: 'PagosReal', nota_credito: 'NotasCredito' };
const COLUMNA_ANIO_POR_TIPO = { pago: 'AnioPago', nota_credito: 'AnioNotaCred' };

function statusPorSaldo(total, pagosReal, notasCredito) {
  const cubierto = num(pagosReal) + num(notasCredito);
  if (cubierto >= num(total) - 0.005) return 'PAGADA';
  if (cubierto > 0.005) return 'PAGO PARCIAL';
  return 'EMITIDA';
}

// signo=+1 al aplicar (grabar), signo=-1 al revertir (cancelar). `anio` solo
// se escribe al aplicar (signo>0) -- igual que ya hacía notacred.js, que
// nunca toca AnioNotaCred al revertir.
async function ajustarSaldoFactura(tx, tipo, { idNoFactura, serieFac, importe, signo, anio }) {
  const columna = COLUMNA_POR_TIPO[tipo];
  if (!columna) throw new Error(`tipo inválido para ajustarSaldoFactura: "${tipo}"`);

  const facRes = await new sql.Request(tx)
    .input('id', sql.Decimal(9), idNoFactura).input('serieFac', sql.VarChar(20), serieKey(serieFac))
    .query(`SELECT TOTAL, PagosReal, NotasCredito FROM Empresa2.Factura WITH (UPDLOCK, ROWLOCK)
            WHERE Id_NoFactura=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'')`);
  const fac = facRes.recordset[0];
  if (!fac) return null;

  const actual = tipo === 'pago' ? num(fac.PagosReal) : num(fac.NotasCredito);
  const nuevoValor = Math.max(0, actual + signo * num(importe));
  const nuevoPagosReal = tipo === 'pago' ? nuevoValor : num(fac.PagosReal);
  const nuevoNotasCredito = tipo === 'nota_credito' ? nuevoValor : num(fac.NotasCredito);
  const nuevoStatus = statusPorSaldo(fac.TOTAL, nuevoPagosReal, nuevoNotasCredito);

  const req2 = new sql.Request(tx)
    .input('id', sql.Decimal(9), idNoFactura).input('serieFac', sql.VarChar(20), serieKey(serieFac))
    .input('nuevo', sql.Decimal(9,2), nuevoValor).input('status', sql.VarChar(20), nuevoStatus);
  let sets = `${columna}=@nuevo, Status=@status`;
  if (signo > 0 && anio != null) {
    req2.input('anio', sql.Decimal(5), anio);
    sets += `, ${COLUMNA_ANIO_POR_TIPO[tipo]}=@anio`;
  }
  await req2.query(`UPDATE Empresa2.Factura SET ${sets} WHERE Id_NoFactura=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'')`);

  return { TOTAL: num(fac.TOTAL), PagosReal: nuevoPagosReal, NotasCredito: nuevoNotasCredito, Status: nuevoStatus };
}

// Nota de Débito previa como destino de la línea (Empresa2.NotaCred con
// Tipo='ND'). `importeAplicado` decide el estatus vía la misma statusPorSaldo
// (PAGADA si cubre el total, PAGO PARCIAL si cubre algo, EMITIDA si es 0) --
// esto es exactamente lo que Notas de Crédito ya hace hoy pasando el importe
// real de su línea (puede ser parcial). Pagos, que maneja ND todo-o-nada,
// simplemente llama con importeAplicado=nd.ImporteTotal (fuerza PAGADA) al
// aplicar o con 0 (fuerza EMITIDA) al revertir/cancelar.
async function ajustarSaldoNotaDebito(tx, { idNotaDebito, serieND, importeAplicado }) {
  const ndRes = await new sql.Request(tx)
    .input('id', sql.Decimal(7), idNotaDebito).input('serie', sql.VarChar(10), serieKey(serieND))
    .query(`SELECT ImporteTotal FROM Empresa2.NotaCred WITH (UPDLOCK, ROWLOCK)
            WHERE Id_NotaCredito=@id AND LTRIM(RTRIM(Tipo))='ND' AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`);
  const nd = ndRes.recordset[0];
  if (!nd) return null;
  const nuevoStatus = statusPorSaldo(nd.ImporteTotal, 0, importeAplicado);
  await new sql.Request(tx)
    .input('id', sql.Decimal(7), idNotaDebito).input('serie', sql.VarChar(10), serieKey(serieND))
    .input('status', sql.VarChar(20), nuevoStatus)
    .query(`UPDATE Empresa2.NotaCred SET Status=@status WHERE Id_NotaCredito=@id AND LTRIM(RTRIM(Tipo))='ND' AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`);
  return { Status: nuevoStatus };
}

module.exports = { statusPorSaldo, ajustarSaldoFactura, ajustarSaldoNotaDebito };
