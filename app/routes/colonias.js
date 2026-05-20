const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

router.get('/', (req, res) => res.render('colonias', { usuario: req.session.usuario, modulo: 'colonias' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({ table: 'Empresa2.ColCP', columns: ['ID_COLONIA','COLONIA','CP'], searchableCols: ['ID_COLONIA','COLONIA','CP'], req });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.ID_COLONIA}">
        <td data-field="ID_COLONIA" data-value="${r.ID_COLONIA}">${r.ID_COLONIA}</td>
        <td data-field="COLONIA" data-value="${(r.COLONIA||'').trim()}">${(r.COLONIA||'').trim()}</td>
        <td data-field="CP" data-value="${(r.CP||'').trim()}">${(r.CP||'').trim()}</td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { ID_COLONIA, COLONIA, CP, _mode } = req.body;
  try {
    const pool = await getPool();
    if (_mode === 'add') {
      await pool.request()
        .input('id', sql.Decimal(7), ID_COLONIA)
        .input('col', sql.Char(80), COLONIA)
        .input('cp', sql.Char(6), CP)
        .query(`INSERT INTO Empresa2.ColCP(ID_COLONIA,COLONIA,CP) VALUES(@id,@col,@cp)`);
    } else {
      await pool.request()
        .input('id', sql.Decimal(7), ID_COLONIA)
        .input('col', sql.Char(80), COLONIA)
        .input('cp', sql.Char(6), CP)
        .query(`UPDATE Empresa2.ColCP SET COLONIA=@col,CP=@cp WHERE ID_COLONIA=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Decimal(7), req.body.ID_COLONIA)
      .query(`DELETE FROM Empresa2.ColCP WHERE ID_COLONIA=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
