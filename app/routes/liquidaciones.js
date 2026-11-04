'use strict';

// ── Liquidaciones de operadores ─────────────────────────────────────────────
// API REST (JSON) y pantalla (cuando se navega con el navegador). El cálculo vive en
// services/liquidaciones-calc.js y se ejecuta SIEMPRE aquí en el servidor.
//
// Identificador de liquidación: "mes-número" (p. ej. 10-3), porque el número se reinicia cada mes.
// El mismo path es página para el navegador (Accept: text/html) y JSON para las llamadas fetch.

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { requierePermiso } = require('../middleware/permisos');
const svc = require('../services/liquidaciones');
const { generarRecibosPDF } = require('../services/liquidaciones-recibo-pdf');
const cfg = require('../config/liquidaciones');

const trim = v => (v == null ? '' : String(v).trim());
const quien = req => [req.session.usuario.nombre, req.session.usuario.apellido].filter(Boolean).map(trim).join(' ');
const manejar = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (!e.status || e.status >= 500) console.error('liquidaciones:', e);
    res.status(e.status || 500).json({ error: e.message });
  }
};
const quiereHtml = req => !req.query.format && /text\/html/.test(req.headers.accept || '');

// ── Pantalla / listado ──────────────────────────────────────────────────────
router.get('/', requierePermiso('liquidaciones.ver'), manejar(async (req, res) => {
  if (quiereHtml(req)) {
    return res.render('liquidaciones', { usuario: req.session.usuario, modulo: 'liquidaciones', mesActivo: cfg.mesActivo() });
  }
  res.json(await svc.listar(req.query));
}));

router.post('/', requierePermiso('liquidaciones.crear'), manejar(async (req, res) => {
  const r = await svc.crear(req.body.idOperador, quien(req));
  res.status(201).json(r);
}));

// ── Cartas porte candidatas (antes de /:id) ─────────────────────────────────
router.get('/candidatas', requierePermiso('liquidaciones.ver'), manejar(async (req, res) => {
  res.json({ rows: await svc.candidatas(req.query.idOperador, { anio: req.query.anio, limit: req.query.limit }) });
}));

// Operadores para elegir en la pantalla (solo activos)
router.get('/operadores', requierePermiso('liquidaciones.ver'), manejar(async (req, res) => {
  const pool = await getPool();
  const q = trim(req.query.q);
  const r = await pool.request().input('q', sql.VarChar(80), '%' + q + '%').query(
    `SELECT TOP 30 ID_OPERADOR, OPERADOR FROM Empresa2.Operadores
      WHERE UPPER(LTRIM(RTRIM(STATUS)))='ACTIVO' AND (OPERADOR LIKE @q OR CAST(ID_OPERADOR AS VARCHAR(10)) LIKE @q) ORDER BY OPERADOR`);
  res.json({ rows: r.recordset.map(o => ({ idOperador: o.ID_OPERADOR, operador: trim(o.OPERADOR) })) });
}));

// ── Recibos (PDF) ───────────────────────────────────────────────────────────
const enviarPDF = (res, buffer, nombre) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);
  res.end(buffer);
};
router.get('/recibos', requierePermiso('liquidaciones.ver'), manejar(async (req, res) => {
  const liqs = await svc.paraRecibos(req.query);
  enviarPDF(res, await generarRecibosPDF(liqs), `Recibos_${trim(req.query.fechaIni)}_a_${trim(req.query.fechaFin)}.pdf`);
}));

// ── Depósitos (catálogo propio, no ligado al cálculo) ───────────────────────
const DEPOSITO_CONCEPTOS = ['Casetas', 'Diesel', 'Llanta', 'Otros', 'Talacha'];   // los usados en el histórico de Depositos
const depositoAModelo = r => ({
  idDeposito: Number(r.ID_DEPOSITO), fecha: r.FECHA instanceof Date ? r.FECHA.toISOString().slice(0, 10) : '',
  idOperador: r.ID_OPERADOR, operador: trim(r.OPERADOR), concepto: trim(r.CONCEPTO), descOtros: trim(r.DESCOTROS),
  idPedido: r.ID_PEDIDO == null ? null : Number(r.ID_PEDIDO), serie: trim(r.SERIE), cartaPorte: trim(r.CARTAPORTE),
  monto: Number(r.MONTO || 0), diferencia: Number(r.DIFERENCIA || 0), noCuenta: trim(r.NOCUENTA), validado: Number(r.VALIDADO || 0),
  observaciones: trim(r.OBSERVACIONES), flagAplicado: Number(r.FLAGAPLICADO || 0), flagVerificado: Number(r.FLAGVERIFICADO || 0),
  cobrado: Number(r.COBRADO || 0), flagCobrar: Number(r.FLAGCOBRAR || 0), flagJustificar: Number(r.FLAGJUSTIFICAR || 0),
  mesLiq: r.MESLIQ == null ? null : Number(r.MESLIQ), noLiq: r.NOLIQ == null ? null : Number(r.NOLIQ),
});

async function validarDeposito(pool, b) {
  const e = (m) => Object.assign(new Error(m), { status: 400 });
  const concepto = DEPOSITO_CONCEPTOS.find(c => c.toLowerCase() === trim(b.concepto).toLowerCase());
  if (!concepto) throw e(`Concepto inválido. Valores permitidos: ${DEPOSITO_CONCEPTOS.join(', ')}.`);
  const idOperador = parseInt(b.idOperador, 10);
  if (!idOperador) throw e('Indique el operador.');
  const op = (await pool.request().input('id', sql.Int, idOperador).query(`SELECT OPERADOR FROM Empresa2.Operadores WHERE ID_OPERADOR=@id`)).recordset[0];
  if (!op) throw e('El operador no existe.');
  const serie = trim(b.serie).toUpperCase();
  if (!serie) throw e('Indique la serie.');
  const ser = (await pool.request().input('s', sql.VarChar(3), serie).query(`SELECT 1 x FROM Empresa2.Centrales WHERE UPPER(LTRIM(RTRIM(Central)))=@s`)).recordset[0];
  if (!ser) throw e(`La serie ${serie} no existe en el catálogo de centrales.`);
  const cartaPorte = trim(b.cartaPorte);
  if (!cartaPorte) throw e('Indique la carta porte.');
  const monto = Number(b.monto);
  if (!isFinite(monto) || monto < 0) throw e('El monto debe ser un número mayor o igual a 0.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trim(b.fecha))) throw e('Indique la fecha (aaaa-mm-dd).');
  return { concepto, idOperador, operador: trim(op.OPERADOR), serie, cartaPorte, monto, fecha: trim(b.fecha) };
}

function parametrosDeposito(r, v, b, quienEs) {
  return r.input('fecha', sql.Date, v.fecha).input('op', sql.Int, v.idOperador).input('nom', sql.VarChar(45), v.operador.slice(0, 45))
    .input('con', sql.VarChar(30), v.concepto).input('desc', sql.VarChar(149), trim(b.descOtros).slice(0, 149) || null)
    .input('ped', sql.Decimal(9, 0), parseInt(b.idPedido, 10) || null).input('serie', sql.VarChar(3), v.serie)
    .input('cp', sql.VarChar(30), v.cartaPorte).input('monto', sql.Decimal(11, 2), v.monto)
    .input('cta', sql.VarChar(20), trim(b.noCuenta).slice(0, 20) || null).input('obs', sql.VarChar(254), trim(b.observaciones).slice(0, 254) || null)
    .input('fcobrar', sql.TinyInt, b.flagCobrar ? 1 : 0).input('fjust', sql.TinyInt, b.flagJustificar ? 1 : 0)
    .input('who', sql.VarChar(79), quienEs.slice(0, 79) || null).input('hoy', sql.Date, new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10));
}

router.get('/depositos', requierePermiso('liquidaciones.depositos'), manejar(async (req, res) => {
  const pool = await getPool();
  const r = pool.request();
  const where = [];
  if (parseInt(req.query.idOperador, 10)) { r.input('op', sql.Int, parseInt(req.query.idOperador, 10)); where.push('ID_OPERADOR=@op'); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trim(req.query.fechaIni))) { r.input('fi', sql.Date, req.query.fechaIni); where.push('FECHA>=@fi'); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trim(req.query.fechaFin))) { r.input('ff', sql.Date, req.query.fechaFin); where.push('FECHA<=@ff'); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  res.json({ conceptos: DEPOSITO_CONCEPTOS, rows: (await r.query(`SELECT TOP 500 * FROM Empresa2.Depositos ${W} ORDER BY FECHA DESC, ID_DEPOSITO DESC`)).recordset.map(depositoAModelo) });
}));

router.get('/depositos/:id', requierePermiso('liquidaciones.depositos'), manejar(async (req, res) => {
  const pool = await getPool();
  const d = (await pool.request().input('id', sql.Decimal(9, 0), parseInt(req.params.id, 10) || 0).query(`SELECT * FROM Empresa2.Depositos WHERE ID_DEPOSITO=@id`)).recordset[0];
  if (!d) return res.status(404).json({ error: 'Depósito no encontrado.' });
  res.json(depositoAModelo(d));
}));

router.post('/depositos', requierePermiso('liquidaciones.depositos'), manejar(async (req, res) => {
  const pool = await getPool();
  const v = await validarDeposito(pool, req.body);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const id = (await new sql.Request(tx).query(`SELECT ISNULL(MAX(ID_DEPOSITO),0)+1 AS n FROM Empresa2.Depositos WITH (UPDLOCK, HOLDLOCK)`)).recordset[0].n;
    await parametrosDeposito(new sql.Request(tx).input('id', sql.Decimal(9, 0), id), v, req.body, quien(req))
      .query(`INSERT INTO Empresa2.Depositos(ID_DEPOSITO, FECHA, ID_OPERADOR, OPERADOR, CONCEPTO, DESCOTROS, ID_PEDIDO, SERIE, CARTAPORTE, MONTO, NOCUENTA,
                OBSERVACIONES, FLAGCOBRAR, FLAGJUSTIFICAR, WHOCAPTURA, FECHACAPTURA)
              VALUES(@id, @fecha, @op, @nom, @con, @desc, @ped, @serie, @cp, @monto, @cta, @obs, @fcobrar, @fjust, @who, @hoy)`);
    await tx.commit();
    res.status(201).json({ ok: true, idDeposito: Number(id) });
  } catch (e) { try { await tx.rollback(); } catch (_) { /* ya revertida */ } throw e; }
}));

router.put('/depositos/:id', requierePermiso('liquidaciones.depositos'), manejar(async (req, res) => {
  const pool = await getPool();
  const id = parseInt(req.params.id, 10) || 0;
  const actual = (await pool.request().input('id', sql.Decimal(9, 0), id).query(`SELECT MESLIQ FROM Empresa2.Depositos WHERE ID_DEPOSITO=@id`)).recordset[0];
  if (!actual) return res.status(404).json({ error: 'Depósito no encontrado.' });
  if (actual.MESLIQ != null) return res.status(409).json({ error: 'El depósito ya fue considerado en una liquidación; no se puede modificar.' });
  const v = await validarDeposito(pool, req.body);
  await parametrosDeposito(pool.request().input('id', sql.Decimal(9, 0), id), v, req.body, quien(req))
    .query(`UPDATE Empresa2.Depositos SET FECHA=@fecha, ID_OPERADOR=@op, OPERADOR=@nom, CONCEPTO=@con, DESCOTROS=@desc, ID_PEDIDO=@ped, SERIE=@serie,
              CARTAPORTE=@cp, MONTO=@monto, NOCUENTA=@cta, OBSERVACIONES=@obs, FLAGCOBRAR=@fcobrar, FLAGJUSTIFICAR=@fjust, WHOMODIFICA=@who, FECHAULTMOD=@hoy
            WHERE ID_DEPOSITO=@id`);
  res.json({ ok: true });
}));

router.delete('/depositos/:id', requierePermiso('liquidaciones.depositos'), manejar(async (req, res) => {
  const pool = await getPool();
  const id = parseInt(req.params.id, 10) || 0;
  const actual = (await pool.request().input('id', sql.Decimal(9, 0), id).query(`SELECT MESLIQ FROM Empresa2.Depositos WHERE ID_DEPOSITO=@id`)).recordset[0];
  if (!actual) return res.status(404).json({ error: 'Depósito no encontrado.' });
  if (actual.MESLIQ != null) return res.status(409).json({ error: 'El depósito ya fue considerado en una liquidación; no se puede borrar.' });
  await pool.request().input('id', sql.Decimal(9, 0), id).query(`DELETE FROM Empresa2.Depositos WHERE ID_DEPOSITO=@id`);
  res.json({ ok: true });
}));

// ── Una liquidación ─────────────────────────────────────────────────────────
router.get('/:id', requierePermiso('liquidaciones.ver'), manejar(async (req, res) => res.json(await svc.obtener(req.params.id))));

router.get('/:id/recibo', requierePermiso('liquidaciones.ver'), manejar(async (req, res) => {
  const liq = await svc.obtener(req.params.id);
  enviarPDF(res, await generarRecibosPDF([liq]), `Recibo_${liq.id}.pdf`);
}));

router.patch('/:id', requierePermiso('liquidaciones.editar'), manejar(async (req, res) => res.json(await svc.editar(req.params.id, req.body, quien(req)))));
router.delete('/:id', requierePermiso('liquidaciones.eliminar'), manejar(async (req, res) => res.json(await svc.eliminar(req.params.id))));

router.post('/:id/viajes', requierePermiso('liquidaciones.editar'), manejar(async (req, res) => res.status(201).json(await svc.agregarViaje(req.params.id, req.body || {}, quien(req)))));
router.delete('/:id/viajes/:idDeta', requierePermiso('liquidaciones.editar'), manejar(async (req, res) => res.json(await svc.quitarViaje(req.params.id, req.params.idDeta, quien(req)))));

router.post('/:id/recalcular-diferencias', requierePermiso('liquidaciones.editar'), manejar(async (req, res) => res.json(await svc.recalcularDiferencias(req.params.id, quien(req)))));
// Suma totalDif a extraDescuento una sola vez (lo ya aplicado queda registrado en DifAplicada).
router.post('/:id/aplicar-diferencias', requierePermiso('liquidaciones.editar'), manejar(async (req, res) => res.json(await svc.aplicarDiferencias(req.params.id, quien(req)))));
router.post('/:id/pagar', requierePermiso('liquidaciones.pagar'), manejar(async (req, res) => res.json(await svc.pagar(req.params.id, quien(req)))));
router.post('/:id/cancelar', requierePermiso('liquidaciones.cancelar'), manejar(async (req, res) => res.json(await svc.cancelar(req.params.id, quien(req)))));
router.post('/:id/reabrir', requierePermiso('liquidaciones.reabrir'), manejar(async (req, res) => res.json(await svc.reabrir(req.params.id, quien(req)))));

module.exports = router;
