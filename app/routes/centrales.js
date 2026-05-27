const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

const TABLE = 'Empresa2.Centrales';
const COLS = ['SERIE', 'DESCRIPCION'];
const SEARCH_COLS = ['SERIE', 'DESCRIPCION'];

router.get('/', (req, res) => res.render('centrales', { usuario: req.session.usuario, modulo: 'centrales' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({ table: TABLE, columns: COLS, searchableCols: SEARCH_COLS, req });
    const rows = data.rows.map(r =>
      `<tr data-id="${(r.SERIE||'').trim()}">
        <td data-field="SERIE" data-value="${(r.SERIE||'').trim()}">${(r.SERIE||'').trim()}</td>
        <td data-field="DESCRIPCION" data-value="${(r.DESCRIPCION||'').trim()}">${(r.DESCRIPCION||'').trim()}</td>
      </tr>`
    ).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { SERIE, DESCRIPCION, _mode } = req.body;
  try {
    const pool = await getPool();
    if (_mode === 'add') {
      await pool.request()
        .input('serie', sql.Char(3), SERIE)
        .input('desc', sql.Char(80), DESCRIPCION)
        .query(`INSERT INTO Empresa2.Centrales (SERIE,DESCRIPCION) VALUES (@serie,@desc)`);
    } else {
      await pool.request()
        .input('serie', sql.Char(3), SERIE)
        .input('desc', sql.Char(80), DESCRIPCION)
        .query(`UPDATE Empresa2.Centrales SET DESCRIPCION=@desc WHERE SERIE=@serie`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('serie', sql.Char(3), req.body.SERIE)
      .query(`DELETE FROM Empresa2.Centrales WHERE SERIE=@serie`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
