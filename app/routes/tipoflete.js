const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

router.get('/', (req, res) => res.render('tipoflete', { usuario: req.session.usuario, modulo: 'tipoflete' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({ table: 'Empresa2.TipoFlete', columns: ['ID_TIPOFLETE','FLETE'], searchableCols: ['ID_TIPOFLETE','FLETE'], req });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.ID_TIPOFLETE}">
        <td data-field="ID_TIPOFLETE" data-value="${r.ID_TIPOFLETE}">${r.ID_TIPOFLETE}</td>
        <td data-field="FLETE" data-value="${(r.FLETE||'').trim()}">${(r.FLETE||'').trim()}</td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { ID_TIPOFLETE, FLETE, _mode } = req.body;
  try {
    const pool = await getPool();
    if (_mode === 'add') {
      await pool.request().input('id', sql.Decimal(7), ID_TIPOFLETE).input('flete', sql.Char(50), FLETE)
        .query(`INSERT INTO Empresa2.TipoFlete(ID_TIPOFLETE,FLETE) VALUES(@id,@flete)`);
    } else {
      await pool.request().input('id', sql.Decimal(7), ID_TIPOFLETE).input('flete', sql.Char(50), FLETE)
        .query(`UPDATE Empresa2.TipoFlete SET FLETE=@flete WHERE ID_TIPOFLETE=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Decimal(7), req.body.ID_TIPOFLETE)
      .query(`DELETE FROM Empresa2.TipoFlete WHERE ID_TIPOFLETE=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
