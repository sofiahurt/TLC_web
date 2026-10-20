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
