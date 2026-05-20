const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

const TABLE = 'Empresa2.Ciudades';
const COLS = ['ID_CIUDAD', 'CIUDAD'];
const SEARCH_COLS = ['ID_CIUDAD', 'CIUDAD'];

router.get('/', (req, res) => res.render('ciudades', { usuario: req.session.usuario, modulo: 'ciudades' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({ table: TABLE, columns: COLS, searchableCols: SEARCH_COLS, req });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.ID_CIUDAD}">
        <td data-field="ID_CIUDAD" data-value="${r.ID_CIUDAD}">${r.ID_CIUDAD}</td>
        <td data-field="CIUDAD" data-value="${(r.CIUDAD||'').trim()}">${(r.CIUDAD||'').trim()}</td>
      </tr>`
    ).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { ID_CIUDAD, CIUDAD, _mode } = req.body;
  try {
    const pool = await getPool();
    if (_mode === 'add') {
      await pool.request()
        .input('id', sql.Decimal(9), ID_CIUDAD)
        .input('ciudad', sql.Char(80), CIUDAD)
        .query(`INSERT INTO Empresa2.Ciudades (ID_CIUDAD,CIUDAD) VALUES (@id,@ciudad)`);
    } else {
      await pool.request()
        .input('id', sql.Decimal(9), ID_CIUDAD)
        .input('ciudad', sql.Char(80), CIUDAD)
        .query(`UPDATE Empresa2.Ciudades SET CIUDAD=@ciudad WHERE ID_CIUDAD=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Decimal(9), req.body.ID_CIUDAD)
      .query(`DELETE FROM Empresa2.Ciudades WHERE ID_CIUDAD=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
