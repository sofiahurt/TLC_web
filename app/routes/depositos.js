// Autorización de depósitos: muestra Empresa2.DepoSolicitud por día y permite
// marcar FlagDeposito (autorizado). "Pasar a Depósitos" (FlagEnDeposito) es un
// proceso posterior e independiente; las solicitudes con FlagEnDeposito=1 ya no
// se muestran ni se pueden desmarcar aquí.
const express = require('express');
const ExcelJS = require('exceljs');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { requierePermiso } = require('../middleware/permisos');

const trim = v => (v == null ? '' : String(v).trim());

const CONCEPTOS = ['Prestamo','Talachas','Llantas','Diesel','Comidas','Pension','Bascula','Casetas','Refacciones','Maniobra','Otros','Estadias','Demoras'];
const SUMA_SQL = CONCEPTOS.map(c => `ISNULL(${c},0)`).join('+');
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const hoyISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const fechaDe = v => (FECHA_RE.test(trim(v)) ? trim(v) : hoyISO());

const SELECT_BASE = `
  SELECT Id_DepoSol, TC, ID_OPERADOR, OPERADOR, Serie, CartaPorte,
         ${CONCEPTOS.map(c => `ISNULL(${c},0) AS ${c}`).join(', ')},
         ${SUMA_SQL} AS Total, ISNULL(FlagDeposito,0) AS FlagDeposito, ISNULL(FlagEnDeposito,0) AS FlagEnDeposito
    FROM Empresa2.DepoSolicitud`;

router.get('/', requierePermiso('depositos.ver'), (req, res) =>
  res.render('depositos', { usuario: req.session.usuario, modulo: 'depositos', conceptos: CONCEPTOS, hoy: hoyISO() }));

router.get('/data', requierePermiso('depositos.ver'), async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().input('f', sql.Date, fechaDe(req.query.fecha)).query(`
      ${SELECT_BASE}
      WHERE Fecha=@f AND ISNULL(FlagEnDeposito,0)=0
      ORDER BY Id_DepoSol`);
    res.json({ filas: r.recordset.map(x => ({
      ...x, TC: trim(x.TC), OPERADOR: trim(x.OPERADOR), Serie: trim(x.Serie), CartaPorte: trim(x.CartaPorte),
    })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Marca/desmarca FlagDeposito. Solo si la solicitud aún no pasó a Depósitos.
router.post('/autorizar', requierePermiso('depositos.autorizar'), async (req, res) => {
  try {
    const id = parseInt(req.body.Id_DepoSol);
    if (!id) return res.status(400).json({ error: 'Solicitud inválida.' });
    const marcar = req.body.FlagDeposito === true || req.body.FlagDeposito === 1 || req.body.FlagDeposito === '1' || req.body.FlagDeposito === 'true';
    const quien = [req.session.usuario.nombre, req.session.usuario.apellido].filter(Boolean).map(trim).join(' ').slice(0, 100);
    const pool = await getPool();
    const r = await pool.request()
      .input('id', sql.Decimal(9), id)
      .input('flag', sql.Int, marcar ? 1 : 0)
      .input('quien', sql.VarChar(100), marcar ? quien : null)
      .input('hoy', sql.Date, marcar ? hoyISO() : null)
      .query(`UPDATE Empresa2.DepoSolicitud
                 SET FlagDeposito=@flag, WhoAutoriza=@quien, FechaAutorizacion=@hoy
               WHERE Id_DepoSol=@id AND ISNULL(FlagEnDeposito,0)=0`);
    if (!r.rowsAffected[0]) return res.status(409).json({ error: 'La solicitud ya pasó a Depósitos o no existe; actualiza la lista.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Verificación de depósitos ────────────────────────────────────────────────
// Sobre TODAS las solicitudes del día (estén o no autorizadas): se captura lo que realmente
// se depositó (total por Carta Porte), la diferencia contra lo solicitado se calcula aquí
// (solicitado - depositado) y la verificación se cierra con Validado. Una solicitud
// validada ya no se edita hasta que se quita la validación.
const SELECT_VERIF = `
  SELECT Id_DepoSol, TC, ID_OPERADOR, OPERADOR, Serie, CartaPorte,
         ${CONCEPTOS.map(c => `ISNULL(${c},0) AS ${c}`).join(', ')}, ${SUMA_SQL} AS Solicitado,
         ISNULL(FlagDeposito,0) AS FlagDeposito, MontoDepositado, Diferencia, ISNULL(Validado,0) AS Validado, WhoValida, FechaValida,
         NoCuenta, ISNULL(FlagEnDeposito,0) AS FlagEnDeposito
    FROM Empresa2.DepoSolicitud`;

router.get('/verificar', requierePermiso('depositos.ver'), (req, res) =>
  res.render('depositos-verificar', { usuario: req.session.usuario, modulo: 'depositos-verificar', conceptos: CONCEPTOS, hoy: hoyISO() }));

router.get('/verificar/data', requierePermiso('depositos.ver'), async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().input('f', sql.Date, fechaDe(req.query.fecha)).query(`
      ${SELECT_VERIF}
      WHERE Fecha=@f
      ORDER BY Id_DepoSol`);
    const fechaTxt = v => (v instanceof Date ? v.toISOString().slice(0, 10) : trim(v));
    res.json({ filas: r.recordset.map(x => ({
      ...x, TC: trim(x.TC), OPERADOR: trim(x.OPERADOR), Serie: trim(x.Serie), CartaPorte: trim(x.CartaPorte),
      WhoValida: trim(x.WhoValida), FechaValida: fechaTxt(x.FechaValida),
      NoCuenta: trim(x.NoCuenta),
    })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Guarda lo depositado y la cuenta; recalcula la diferencia con lo solicitado.
router.post('/verificar/guardar', requierePermiso('depositos.verificar'), async (req, res) => {
  try {
    const id = parseInt(req.body.Id_DepoSol);
    if (!id) return res.status(400).json({ error: 'Solicitud inválida.' });
    const txt = trim(req.body.MontoDepositado).replace(/[$,\s]/g, '');
    let monto = null;
    if (txt !== '') {
      monto = Math.round(Number(txt) * 100) / 100;
      if (!Number.isFinite(monto) || monto < 0 || monto > 999999999) return res.status(400).json({ error: 'El monto depositado no es válido.' });
    }
    const pool = await getPool();
    const r = await pool.request()
      .input('id', sql.Decimal(9), id).input('monto', sql.Decimal(11, 2), monto)
      .input('cuenta', sql.VarChar(20), trim(req.body.NoCuenta).slice(0, 20) || null)
      .query(`UPDATE Empresa2.DepoSolicitud
                 SET MontoDepositado=@monto,
                     Diferencia=CASE WHEN @monto IS NULL THEN NULL ELSE ROUND((${SUMA_SQL}) - @monto, 2) END,
                     NoCuenta=@cuenta
               WHERE Id_DepoSol=@id AND ISNULL(Validado,0)=0`);
    if (!r.rowsAffected[0]) return res.status(409).json({ error: 'La solicitud ya está validada o no existe; actualiza la lista.' });
    const f = (await pool.request().input('id', sql.Decimal(9), id).query(`${SELECT_VERIF} WHERE Id_DepoSol=@id`)).recordset[0];
    res.json({ ok: true, Solicitado: f.Solicitado, MontoDepositado: f.MontoDepositado, Diferencia: f.Diferencia });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Valida / quita la validación. Para validar ya debe haber un monto depositado.
router.post('/verificar/validar', requierePermiso('depositos.verificar'), async (req, res) => {
  try {
    const id = parseInt(req.body.Id_DepoSol);
    if (!id) return res.status(400).json({ error: 'Solicitud inválida.' });
    const validar = req.body.Validado === true || req.body.Validado === 1 || req.body.Validado === '1' || req.body.Validado === 'true';
    const quien = [req.session.usuario.nombre, req.session.usuario.apellido].filter(Boolean).map(trim).join(' ').slice(0, 40);
    const pool = await getPool();
    const r = await pool.request()
      .input('id', sql.Decimal(9), id).input('v', sql.TinyInt, validar ? 1 : 0)
      .input('quien', sql.VarChar(40), validar ? quien : null).input('hoy', sql.Date, validar ? hoyISO() : null)
      .query(`UPDATE Empresa2.DepoSolicitud
                 SET Validado=@v, WhoValida=@quien, FechaValida=@hoy,
                     Diferencia=CASE WHEN @v=1 THEN ROUND((${SUMA_SQL}) - MontoDepositado, 2) ELSE Diferencia END
               WHERE Id_DepoSol=@id AND (@v=0 OR MontoDepositado IS NOT NULL)`);
    if (!r.rowsAffected[0]) {
      return res.status(409).json({ error: validar ? 'Captura primero el monto depositado.' : 'La solicitud no existe; actualiza la lista.' });
    }
    const f = (await pool.request().input('id', sql.Decimal(9), id).query(`${SELECT_VERIF} WHERE Id_DepoSol=@id`)).recordset[0];
    res.json({ ok: true, Diferencia: f.Diferencia, Validado: f.Validado, WhoValida: trim(f.WhoValida),
      FechaValida: f.FechaValida instanceof Date ? f.FechaValida.toISOString().slice(0, 10) : '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Excel de las solicitudes marcadas (FlagDeposito=1) del día.
router.get('/excel', requierePermiso('depositos.ver'), async (req, res) => {
  try {
    const fecha = fechaDe(req.query.fecha);
    const pool = await getPool();
    const r = await pool.request().input('f', sql.Date, fecha).query(`
      ${SELECT_BASE}
      WHERE Fecha=@f AND ISNULL(FlagDeposito,0)=1
      ORDER BY Id_DepoSol`);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Depositos');
    ws.addRow([`Depósitos autorizados del ${fecha.split('-').reverse().join('/')}`]).font = { bold: true, size: 13 };
    ws.addRow([]);
    const enc = ws.addRow(['No', 'TC', 'Operador', 'Carta Porte', ...CONCEPTOS, 'Total']);
    enc.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    enc.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } }; c.alignment = { horizontal: 'center' }; });

    const sumas = new Array(CONCEPTOS.length + 1).fill(0);
    for (const x of r.recordset) {
      const importes = [...CONCEPTOS.map(c => Number(x[c]) || 0), Number(x.Total) || 0];
      importes.forEach((v, i) => { sumas[i] += v; });
      ws.addRow([
        Number(x.Id_DepoSol), trim(x.TC),
        `${x.ID_OPERADOR == null ? '' : Number(x.ID_OPERADOR)} - ${trim(x.OPERADOR)}`,
        `${trim(x.Serie)}-${trim(x.CartaPorte)}`, ...importes,
      ]);
    }
    const tot = ws.addRow(['Totales:', '', '', '', ...sumas.map(v => Math.round(v * 100) / 100)]);
    tot.font = { bold: true };
    ws.columns.forEach((col, i) => {
      if (i >= 4) col.numFmt = '$#,##0.00';
      col.width = i === 2 ? 34 : i === 3 ? 18 : i >= 4 ? 13 : 10;
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Depositos_${fecha}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message }); else res.end();
  }
});

module.exports = router;
