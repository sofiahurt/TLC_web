const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

router.get('/', (req, res) => res.render('tarkilomts', { usuario: req.session.usuario, modulo: 'tarkilomts' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({ table: 'Empresa2.TarKilomts', columns: ['Id_TarKmts','Fecha','PrecioKmt'], searchableCols: ['Id_TarKmts','Fecha','PrecioKmt'], req });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.Id_TarKmts}">
        <td data-field="Id_TarKmts" data-value="${r.Id_TarKmts}">${r.Id_TarKmts}</td>
        <td data-field="Fecha" data-value="${r.Fecha ? r.Fecha.toISOString().slice(0,10) : ''}">${r.Fecha ? r.Fecha.toISOString().slice(0,10) : ''}</td>
        <td data-field="PrecioKmt" data-value="${r.PrecioKmt||''}">${r.PrecioKmt||''}</td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { Id_TarKmts, Fecha, PrecioKmt, _mode } = req.body;
  try {
    const pool = await getPool();
    if (_mode === 'add') {
      await pool.request()
        .input('id', sql.Decimal(3), Id_TarKmts)
        .input('fecha', sql.Date, Fecha)
        .input('precio', sql.Decimal(9,4), PrecioKmt)
        .query(`INSERT INTO Empresa2.TarKilomts(Id_TarKmts,Fecha,PrecioKmt) VALUES(@id,@fecha,@precio)`);
    } else {
      await pool.request()
        .input('id', sql.Decimal(3), Id_TarKmts)
        .input('fecha', sql.Date, Fecha)
        .input('precio', sql.Decimal(9,4), PrecioKmt)
        .query(`UPDATE Empresa2.TarKilomts SET Fecha=@fecha,PrecioKmt=@precio WHERE Id_TarKmts=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Decimal(3), req.body.Id_TarKmts)
      .query(`DELETE FROM Empresa2.TarKilomts WHERE Id_TarKmts=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
