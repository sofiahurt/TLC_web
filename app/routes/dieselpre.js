const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

router.get('/', (req, res) => res.render('dieselpre', { usuario: req.session.usuario, modulo: 'dieselpre' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({ table: 'Empresa2.DieselPre', columns: ['ID_DIESELPRECIO','FECHA','PRECIOLITRO','IEPS'], searchableCols: ['ID_DIESELPRECIO','FECHA','PRECIOLITRO'], req });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.ID_DIESELPRECIO}">
        <td data-field="ID_DIESELPRECIO" data-value="${r.ID_DIESELPRECIO}">${r.ID_DIESELPRECIO}</td>
        <td data-field="FECHA" data-value="${r.FECHA ? r.FECHA.toISOString().slice(0,10) : ''}">${r.FECHA ? r.FECHA.toISOString().slice(0,10) : ''}</td>
        <td data-field="PRECIOLITRO" data-value="${r.PRECIOLITRO||''}">${r.PRECIOLITRO||''}</td>
        <td data-field="IEPS" data-value="${r.IEPS||''}">${r.IEPS||''}</td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { ID_DIESELPRECIO, FECHA, PRECIOLITRO, IEPS, _mode } = req.body;
  try {
    const pool = await getPool();
    if (_mode === 'add') {
      await pool.request()
        .input('id', sql.Decimal(9), ID_DIESELPRECIO)
        .input('fecha', sql.Date, FECHA)
        .input('precio', sql.Decimal(7,2), PRECIOLITRO)
        .input('ieps', sql.Decimal(9,4), IEPS)
        .query(`INSERT INTO Empresa2.DieselPre(ID_DIESELPRECIO,FECHA,PRECIOLITRO,IEPS) VALUES(@id,@fecha,@precio,@ieps)`);
    } else {
      await pool.request()
        .input('id', sql.Decimal(9), ID_DIESELPRECIO)
        .input('fecha', sql.Date, FECHA)
        .input('precio', sql.Decimal(7,2), PRECIOLITRO)
        .input('ieps', sql.Decimal(9,4), IEPS)
        .query(`UPDATE Empresa2.DieselPre SET FECHA=@fecha,PRECIOLITRO=@precio,IEPS=@ieps WHERE ID_DIESELPRECIO=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Decimal(9), req.body.ID_DIESELPRECIO)
      .query(`DELETE FROM Empresa2.DieselPre WHERE ID_DIESELPRECIO=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
