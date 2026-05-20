const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

router.get('/', (req, res) => res.render('transport', { usuario: req.session.usuario, modulo: 'transport' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'Empresa2.Transport',
      columns: ['ID_TRANSPORTISTA','NOMBRECOM','NOMBRECOMUN','RFC','CIUDAD','CP','COLONIA'],
      searchableCols: ['ID_TRANSPORTISTA','NOMBRECOM','NOMBRECOMUN','RFC','CIUDAD'],
      req
    });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.ID_TRANSPORTISTA}">
        <td data-field="ID_TRANSPORTISTA" data-value="${r.ID_TRANSPORTISTA}">${r.ID_TRANSPORTISTA}</td>
        <td data-field="NOMBRECOMUN" data-value="${(r.NOMBRECOMUN||'').trim()}">${(r.NOMBRECOMUN||'').trim()}</td>
        <td data-field="NOMBRECOM" data-value="${(r.NOMBRECOM||'').trim()}">${(r.NOMBRECOM||'').trim()}</td>
        <td data-field="RFC" data-value="${(r.RFC||'').trim()}">${(r.RFC||'').trim()}</td>
        <td data-field="CIUDAD" data-value="${(r.CIUDAD||'').trim()}">${(r.CIUDAD||'').trim()}</td>
        <td data-field="CP" data-value="${(r.CP||'').trim()}">${(r.CP||'').trim()}</td>
        <td data-field="COLONIA" data-value="${(r.COLONIA||'').trim()}" style="display:none">${(r.COLONIA||'').trim()}</td>
        <td data-field="ID_COLONIA" data-value="" style="display:none"></td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lookup data for Colonias
router.get('/lookup/colonias', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pool = await getPool();
    const where = q ? `WHERE COLONIA LIKE @q OR CP LIKE @q` : '';
    const count = await pool.request().input('q', `%${q}%`).query(`SELECT COUNT(*) AS total FROM Empresa2.ColCP ${where}`);
    const total = count.recordset[0].total;
    const offset = (page - 1) * 10;
    const result = await pool.request().input('q', `%${q}%`)
      .query(`SELECT ID_COLONIA,COLONIA,CP FROM Empresa2.ColCP ${where} ORDER BY COLONIA OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`);
    res.json({ rows: result.recordset, total, totalPages: Math.ceil(total/10), page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { ID_TRANSPORTISTA, NOMBRECOM, NOMBRECOMUN, CALLENUM, ID_COLONIA, COLONIA, CP, CIUDAD, RFC, REALIZO, _mode } = req.body;
  try {
    const pool = await getPool();
    const r = pool.request()
      .input('id', sql.Decimal(7), ID_TRANSPORTISTA)
      .input('ncom', sql.Char(150), NOMBRECOM)
      .input('ncomun', sql.Char(80), NOMBRECOMUN)
      .input('calle', sql.Char(150), CALLENUM)
      .input('idcol', sql.Decimal(7), ID_COLONIA || null)
      .input('col', sql.Char(80), COLONIA)
      .input('cp', sql.Char(6), CP)
      .input('ciu', sql.Char(80), CIUDAD)
      .input('rfc', sql.Char(15), RFC)
      .input('realizo', sql.Char(60), REALIZO);
    if (_mode === 'add') {
      await r.query(`INSERT INTO Empresa2.Transport(ID_TRANSPORTISTA,NOMBRECOM,NOMBRECOMUN,CALLENUM,ID_COLONIA,COLONIA,CP,CIUDAD,RFC,REALIZO)
        VALUES(@id,@ncom,@ncomun,@calle,@idcol,@col,@cp,@ciu,@rfc,@realizo)`);
    } else {
      await r.query(`UPDATE Empresa2.Transport SET NOMBRECOM=@ncom,NOMBRECOMUN=@ncomun,CALLENUM=@calle,ID_COLONIA=@idcol,COLONIA=@col,CP=@cp,CIUDAD=@ciu,RFC=@rfc,REALIZO=@realizo WHERE ID_TRANSPORTISTA=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Decimal(7), req.body.ID_TRANSPORTISTA)
      .query(`DELETE FROM Empresa2.Transport WHERE ID_TRANSPORTISTA=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
