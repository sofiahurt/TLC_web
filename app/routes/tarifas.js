const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

router.get('/', (req, res) => res.render('tarifas', { usuario: req.session.usuario, modulo: 'tarifas' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'Empresa2.Tarifas',
      columns: ['ID_TARIFA','CDORIGEN','CDDESTINO','DESFLETE','FLETE','NOMBRECOMUNCLI','NOMBRECOMUNTRANS','COSTO','VENTA','MONCOMPRA','MONVENTA','TIPOCAMBIO','KILOMETROS','FLAGOCULTAR','ID_CIUDADORIGEN','ID_CIUDADDESTINO','ID_TIPOFLETE','ID_TRANSPORTISTA','ID_CLIENTE','FLAGIVA','FLAGRET'],
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

router.post('/guardar', async (req, res) => {
  const f = req.body;
  try {
    const pool = await getPool();
    const r = pool.request()
      .input('id', sql.Decimal(7), f.ID_TARIFA)
      .input('costo', sql.Decimal(9,2), f.COSTO || null)
      .input('venta', sql.Decimal(9,2), f.VENTA || null)
      .input('repcli', sql.Decimal(9,2), f.REPCLIENTE || null)
      .input('reptrans', sql.Decimal(9,2), f.REPTRANS || null)
      .input('idorig', sql.Decimal(9), f.ID_CIUDADORIGEN || null)
      .input('iddest', sql.Decimal(9), f.ID_CIUDADDESTINO || null)
      .input('cdorig', sql.Char(50), f.CDORIGEN)
      .input('cddest', sql.Char(50), f.CDDESTINO)
      .input('desflete', sql.Char(80), f.DESFLETE)
      .input('idtipo', sql.Decimal(7), f.ID_TIPOFLETE || null)
      .input('flete', sql.Char(50), f.FLETE)
      .input('idtrans', sql.Decimal(7), f.ID_TRANSPORTISTA || null)
      .input('ntrans', sql.Char(80), f.NOMBRECOMUNTRANS)
      .input('idcli', sql.Decimal(7), f.ID_CLIENTE || null)
      .input('ncli', sql.Char(80), f.NOMBRECOMUNCLI)
      .input('moncom', sql.Char(10), f.MONCOMPRA)
      .input('monven', sql.Char(10), f.MONVENTA)
      .input('tc', sql.Decimal(9,4), f.TIPOCAMBIO || null)
      .input('realizo', sql.Char(100), f.REALIZO)
      .input('flagoc', sql.TinyInt, f.FLAGOCULTAR ? 1 : 0)
      .input('km', sql.Decimal(7), f.KILOMETROS || null)
      .input('flagiva', sql.TinyInt, f.FLAGIVA ? 1 : 0)
      .input('flagret', sql.TinyInt, f.FLAGRET ? 1 : 0);
    if (f._mode === 'add') {
      await r.query(`INSERT INTO Empresa2.Tarifas(ID_TARIFA,COSTO,VENTA,REPCLIENTE,REPTRANS,ID_CIUDADORIGEN,ID_CIUDADDESTINO,CDORIGEN,CDDESTINO,DESFLETE,ID_TIPOFLETE,FLETE,ID_TRANSPORTISTA,NOMBRECOMUNTRANS,ID_CLIENTE,NOMBRECOMUNCLI,MONCOMPRA,MONVENTA,TIPOCAMBIO,REALIZO,FLAGOCULTAR,KILOMETROS,FLAGIVA,FLAGRET)
        VALUES(@id,@costo,@venta,@repcli,@reptrans,@idorig,@iddest,@cdorig,@cddest,@desflete,@idtipo,@flete,@idtrans,@ntrans,@idcli,@ncli,@moncom,@monven,@tc,@realizo,@flagoc,@km,@flagiva,@flagret)`);
    } else {
      await r.query(`UPDATE Empresa2.Tarifas SET COSTO=@costo,VENTA=@venta,REPCLIENTE=@repcli,REPTRANS=@reptrans,ID_CIUDADORIGEN=@idorig,ID_CIUDADDESTINO=@iddest,CDORIGEN=@cdorig,CDDESTINO=@cddest,DESFLETE=@desflete,ID_TIPOFLETE=@idtipo,FLETE=@flete,ID_TRANSPORTISTA=@idtrans,NOMBRECOMUNTRANS=@ntrans,ID_CLIENTE=@idcli,NOMBRECOMUNCLI=@ncli,MONCOMPRA=@moncom,MONVENTA=@monven,TIPOCAMBIO=@tc,REALIZO=@realizo,FLAGOCULTAR=@flagoc,KILOMETROS=@km,FLAGIVA=@flagiva,FLAGRET=@flagret WHERE ID_TARIFA=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Decimal(7), req.body.ID_TARIFA)
      .query(`DELETE FROM Empresa2.Tarifas WHERE ID_TARIFA=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
