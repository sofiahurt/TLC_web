const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');
const { requierePermiso } = require('../middleware/permisos');
const { getSatDb } = require('../config/sat-db');
const ExcelJS = require('exceljs');

router.get('/', (req, res) => res.render('tarifas', { usuario: req.session.usuario, modulo: 'tarifas' }));

// Excel de las tarifas (respeta la búsqueda activa del browse).
const EXCEL_BUSCABLES = new Set(['ID_TARIFA','CDORIGEN','CDDESTINO','DESFLETE','NOMBRECOMUNCLI','NOMBRECOMUNTRANS','FLETE']);
router.get('/excel', requierePermiso('tarifas.btn_exportar'), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim(), col = String(req.query.col || '');
    const pool = await getPool();
    const r = pool.request();
    let where = '';
    if (q && EXCEL_BUSCABLES.has(col)) { where = `WHERE LTRIM(RTRIM(CAST(${col} AS NVARCHAR(MAX)))) LIKE @q`; r.input('q', `%${q}%`); }
    const data = await r.query(`SELECT ID_TARIFA, NOMBRECOMUNCLI, FLETE, CDORIGEN, CDDESTINO, RENTA, COSTOKILOMTS, COSTOAUTOPISTAS, VENTA,
        DIESELPERMITIDO, PAGOTARIFA, KILOMETROS, MONVENTA, FLAGIVA, FLAGRET
      FROM Empresa2.Tarifas ${where} ORDER BY ID_TARIFA`);

    const t = v => String(v == null ? '' : v).trim();
    const n = v => (v == null ? null : Number(v));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tarifas');
    const cols = ['NoTarifa', 'Cliente', 'Tipo', 'CD_Origen', 'CD_Destino', 'Flete/Renta', 'Costo Kilómetros', 'Costo Autopistas', 'Venta',
      'Diesel Permitido', 'Pago Tarifa', 'Kilómetros', 'Moneda', 'Sin IVA', 'Sin Retención'];
    const enc = ws.addRow(cols);
    enc.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    enc.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } }; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
    for (const x of data.recordset) {
      ws.addRow([n(x.ID_TARIFA), t(x.NOMBRECOMUNCLI), t(x.FLETE), t(x.CDORIGEN), t(x.CDDESTINO), n(x.RENTA), n(x.COSTOKILOMTS), n(x.COSTOAUTOPISTAS), n(x.VENTA),
        n(x.DIESELPERMITIDO), n(x.PAGOTARIFA), n(x.KILOMETROS), t(x.MONVENTA), Number(x.FLAGIVA) === 1 ? 'Sí' : 'No', Number(x.FLAGRET) === 1 ? 'Sí' : 'No']);
    }
    const anchos = [11, 38, 22, 26, 26, 14, 16, 16, 14, 16, 14, 12, 10, 9, 14];
    ws.columns.forEach((c, i) => { c.width = anchos[i]; if (i >= 5 && i <= 10) c.numFmt = '$#,##0.00'; if (i === 11) c.numFmt = '#,##0.00'; if (i >= 13) c.alignment = { horizontal: 'center' }; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Tarifas.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message }); else res.end();
  }
});

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'Empresa2.Tarifas',
      columns: ['ID_TARIFA','CDORIGEN','CDDESTINO','DESFLETE','FLETE','NOMBRECOMUNCLI','NOMBRECOMUNTRANS','COSTO','VENTA','MONCOMPRA','MONVENTA','TIPOCAMBIO','KILOMETROS','FLAGOCULTAR','ID_CIUDADORIGEN','ID_CIUDADDESTINO','ID_TIPOFLETE','ID_TRANSPORTISTA','ID_CLIENTE','FLAGIVA','FLAGRET','RENTA','COSTOKILOMTS','COSTOAUTOPISTAS','DIESELPERMITIDO','PAGOTARIFA'],
      searchableCols: ['ID_TARIFA','CDORIGEN','CDDESTINO','DESFLETE','NOMBRECOMUNCLI','NOMBRECOMUNTRANS','FLETE'],
      req
    });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.ID_TARIFA}">
        <td data-field="ID_TARIFA" data-value="${r.ID_TARIFA}">${r.ID_TARIFA}</td>
        <td data-field="CDORIGEN" data-value="${(r.CDORIGEN||'').trim()}">${(r.CDORIGEN||'').trim()}</td>
        <td data-field="CDDESTINO" data-value="${(r.CDDESTINO||'').trim()}">${(r.CDDESTINO||'').trim()}</td>
        <td data-field="FLETE" data-value="${(r.FLETE||'').trim()}">${(r.FLETE||'').trim()}</td>
        <td data-field="NOMBRECOMUNCLI" data-value="${(r.NOMBRECOMUNCLI||'').trim()}">${(r.NOMBRECOMUNCLI||'').trim()}</td>
        <td data-field="NOMBRECOMUNTRANS" data-value="${(r.NOMBRECOMUNTRANS||'').trim()}">${(r.NOMBRECOMUNTRANS||'').trim()}</td>
        <td data-field="COSTO" data-value="${r.COSTO||''}">${r.COSTO||''}</td>
        <td data-field="VENTA" data-value="${r.VENTA||''}">${r.VENTA||''}</td>
        <td data-field="DESFLETE" data-value="${(r.DESFLETE||'').trim()}" style="display:none"></td>
        <td data-field="MONCOMPRA" data-value="${(r.MONCOMPRA||'').trim()}" style="display:none"></td>
        <td data-field="MONVENTA" data-value="${(r.MONVENTA||'').trim()}" style="display:none"></td>
        <td data-field="TIPOCAMBIO" data-value="${r.TIPOCAMBIO||''}" style="display:none"></td>
        <td data-field="KILOMETROS" data-value="${r.KILOMETROS||''}" style="display:none"></td>
        <td data-field="FLAGOCULTAR" data-value="${r.FLAGOCULTAR||0}" style="display:none"></td>
        <td data-field="FLAGIVA" data-value="${r.FLAGIVA||0}" style="display:none"></td>
        <td data-field="FLAGRET" data-value="${r.FLAGRET||0}" style="display:none"></td>
        <td data-field="RENTA" data-value="${r.RENTA||''}" style="display:none"></td>
        <td data-field="COSTOKILOMTS" data-value="${r.COSTOKILOMTS||''}" style="display:none"></td>
        <td data-field="COSTOAUTOPISTAS" data-value="${r.COSTOAUTOPISTAS||''}" style="display:none"></td>
        <td data-field="DIESELPERMITIDO" data-value="${r.DIESELPERMITIDO||''}" style="display:none"></td>
        <td data-field="PAGOTARIFA" data-value="${r.PAGOTARIFA||''}" style="display:none"></td>
        <td data-field="ID_CIUDADORIGEN" data-value="${r.ID_CIUDADORIGEN||''}" style="display:none"></td>
        <td data-field="ID_CIUDADDESTINO" data-value="${r.ID_CIUDADDESTINO||''}" style="display:none"></td>
        <td data-field="ID_TIPOFLETE" data-value="${r.ID_TIPOFLETE||''}" style="display:none"></td>
        <td data-field="ID_TRANSPORTISTA" data-value="${r.ID_TRANSPORTISTA||''}" style="display:none"></td>
        <td data-field="ID_CLIENTE" data-value="${r.ID_CLIENTE||''}" style="display:none"></td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lookup endpoints
async function lookupGeneric(res, table, idCol, descCol, q, page) {
  try {
    const pool = await getPool();
    const where = q ? `WHERE ${descCol} LIKE @q` : '';
    const count = await pool.request().input('q', `%${q}%`).query(`SELECT COUNT(*) AS total FROM ${table} ${where}`);
    const total = count.recordset[0].total;
    const offset = (Math.max(1, page) - 1) * 10;
    const result = await pool.request().input('q', `%${q}%`)
      .query(`SELECT ${idCol},${descCol} FROM ${table} ${where} ORDER BY ${descCol} OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`);
    res.json({ rows: result.recordset, total, totalPages: Math.ceil(total/10), page: Math.max(1, page) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

router.get('/lookup/ciudades', (req, res) => lookupGeneric(res, 'Empresa2.Ciudades', 'ID_CIUDAD', 'CIUDAD', (req.query.q||'').trim(), parseInt(req.query.page)||1));
router.get('/lookup/tipoflete', (req, res) => lookupGeneric(res, 'Empresa2.TipoFlete', 'ID_TIPOFLETE', 'FLETE', (req.query.q||'').trim(), parseInt(req.query.page)||1));
router.get('/lookup/transport', (req, res) => lookupGeneric(res, 'Empresa2.Transport', 'ID_TRANSPORTISTA', 'NOMBRECOMUN', (req.query.q||'').trim(), parseInt(req.query.page)||1));
router.get('/lookup/clientes', (req, res) => lookupGeneric(res, 'Empresa2.Clientes', 'ID_CLIENTE', 'NOMBRECOMUN', (req.query.q||'').trim(), parseInt(req.query.page)||1));

// Catálogo SAT de monedas (misma fuente que el lookup de Clientes)
router.get('/lookup/moneda', (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const all = getSatDb().prepare('SELECT c_Moneda AS clave, "Descripción" AS descripcion FROM SAT_Moneda ORDER BY clave').all();
    const filtered = q ? all.filter(r => String(r.clave).toLowerCase().includes(q) || String(r.descripcion).toLowerCase().includes(q)) : all;
    res.json({ rows: filtered.slice((page - 1) * 10, page * 10), total: filtered.length, totalPages: Math.max(1, Math.ceil(filtered.length / 10)), page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', requierePermiso('tarifas.editar'), async (req, res) => {
  const f = req.body;
  try {
    // Venta = Renta + Costo Kilómetros + Costo Autopistas (se recalcula aquí, no se confía en el cliente);
    // DesFlete = Origen - Destino.
    const renta = parseFloat(f.RENTA) || 0, costoKm = parseFloat(f.COSTOKILOMTS) || 0, costoAuto = parseFloat(f.COSTOAUTOPISTAS) || 0;
    const venta = Math.round((renta + costoKm + costoAuto) * 100) / 100;
    const desflete = `${(f.CDORIGEN || '').trim()} - ${(f.CDDESTINO || '').trim()}`.slice(0, 80);
    const pool = await getPool();
    const r = pool.request()
      .input('id', sql.Decimal(7), f.ID_TARIFA)
      .input('renta', sql.Decimal(11,2), renta)
      .input('costokm', sql.Decimal(9,2), costoKm)
      .input('costoauto', sql.Decimal(9,2), costoAuto)
      .input('venta', sql.Decimal(9,2), venta)
      .input('diesel', sql.Decimal(7,2), parseFloat(f.DIESELPERMITIDO) || 0)
      .input('pagotar', sql.Decimal(9,2), parseFloat(f.PAGOTARIFA) || 0)
      .input('idorig', sql.Decimal(9), f.ID_CIUDADORIGEN || null)
      .input('iddest', sql.Decimal(9), f.ID_CIUDADDESTINO || null)
      .input('cdorig', sql.Char(50), f.CDORIGEN)
      .input('cddest', sql.Char(50), f.CDDESTINO)
      .input('desflete', sql.Char(80), desflete)
      .input('idtipo', sql.Decimal(7), f.ID_TIPOFLETE || null)
      .input('flete', sql.Char(50), f.FLETE)
      .input('idtrans', sql.Decimal(7), f.ID_TRANSPORTISTA || null)
      .input('ntrans', sql.Char(80), f.NOMBRECOMUNTRANS)
      .input('idcli', sql.Decimal(7), f.ID_CLIENTE || null)
      .input('ncli', sql.Char(80), f.NOMBRECOMUNCLI)
            .input('monven', sql.Char(10), f.MONVENTA)
      .input('tc', sql.Decimal(9,4), f.TIPOCAMBIO || null)
      .input('flagoc', sql.TinyInt, f.FLAGOCULTAR ? 1 : 0)
      .input('km', sql.Decimal(7), f.KILOMETROS || null)
      .input('flagiva', sql.TinyInt, f.FLAGIVA ? 1 : 0)
      .input('flagret', sql.TinyInt, f.FLAGRET ? 1 : 0);
    if (f._mode === 'add') {
      await r.query(`INSERT INTO Empresa2.Tarifas(ID_TARIFA,RENTA,COSTOKILOMTS,COSTOAUTOPISTAS,VENTA,DIESELPERMITIDO,PAGOTARIFA,ID_CIUDADORIGEN,ID_CIUDADDESTINO,CDORIGEN,CDDESTINO,DESFLETE,ID_TIPOFLETE,FLETE,ID_TRANSPORTISTA,NOMBRECOMUNTRANS,ID_CLIENTE,NOMBRECOMUNCLI,MONVENTA,TIPOCAMBIO,FLAGOCULTAR,KILOMETROS,FLAGIVA,FLAGRET)
        VALUES(@id,@renta,@costokm,@costoauto,@venta,@diesel,@pagotar,@idorig,@iddest,@cdorig,@cddest,@desflete,@idtipo,@flete,@idtrans,@ntrans,@idcli,@ncli,@monven,@tc,@flagoc,@km,@flagiva,@flagret)`);
    } else {
      await r.query(`UPDATE Empresa2.Tarifas SET RENTA=@renta,COSTOKILOMTS=@costokm,COSTOAUTOPISTAS=@costoauto,VENTA=@venta,DIESELPERMITIDO=@diesel,PAGOTARIFA=@pagotar,ID_CIUDADORIGEN=@idorig,ID_CIUDADDESTINO=@iddest,CDORIGEN=@cdorig,CDDESTINO=@cddest,DESFLETE=@desflete,ID_TIPOFLETE=@idtipo,FLETE=@flete,ID_TRANSPORTISTA=@idtrans,NOMBRECOMUNTRANS=@ntrans,ID_CLIENTE=@idcli,NOMBRECOMUNCLI=@ncli,MONVENTA=@monven,TIPOCAMBIO=@tc,FLAGOCULTAR=@flagoc,KILOMETROS=@km,FLAGIVA=@flagiva,FLAGRET=@flagret WHERE ID_TARIFA=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', requierePermiso('tarifas.editar'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Decimal(7), req.body.ID_TARIFA)
      .query(`DELETE FROM Empresa2.Tarifas WHERE ID_TARIFA=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
