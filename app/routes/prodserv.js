const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

router.get('/', (req, res) => res.render('prodserv', { usuario: req.session.usuario, modulo: 'prodserv' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({ table: 'Empresa2.ProdServ', columns: ['Clave','ProdServ','Descripcion_SAT','c_Unidad','Unidad','Precio'], searchableCols: ['Clave','ProdServ','Descripcion_SAT','Unidad'], req });
    const rows = data.rows.map(r =>
      `<tr data-id="${(r.Clave||'').trim()}">
        <td data-field="Clave" data-value="${(r.Clave||'').trim()}">${(r.Clave||'').trim()}</td>
        <td data-field="ProdServ" data-value="${(r.ProdServ||'').trim()}">${(r.ProdServ||'').trim()}</td>
        <td data-field="Descripcion_SAT" data-value="${(r.Descripcion_SAT||'').trim()}">${(r.Descripcion_SAT||'').trim()}</td>
        <td data-field="Unidad" data-value="${(r.Unidad||'').trim()}">${(r.Unidad||'').trim()}</td>
        <td data-field="Precio" data-value="${r.Precio||''}">${r.Precio||''}</td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { Clave, ProdServ, c_ProdServ, Descripcion_SAT, c_Unidad, Unidad, Precio, _mode } = req.body;
  try {
    const pool = await getPool();
    if (_mode === 'add') {
      await pool.request()
        .input('clave', sql.VarChar(30), Clave)
        .input('ps', sql.VarChar(100), ProdServ)
        .input('cps', sql.VarChar(20), c_ProdServ)
        .input('desc', sql.VarChar(100), Descripcion_SAT)
        .input('cu', sql.VarChar(5), c_Unidad)
        .input('uni', sql.VarChar(100), Unidad)
        .input('precio', sql.Decimal(9,2), Precio)
        .query(`INSERT INTO Empresa2.ProdServ(Clave,ProdServ,c_ProdServ,Descripcion_SAT,c_Unidad,Unidad,Precio) VALUES(@clave,@ps,@cps,@desc,@cu,@uni,@precio)`);
    } else {
      await pool.request()
        .input('clave', sql.VarChar(30), Clave)
        .input('ps', sql.VarChar(100), ProdServ)
        .input('cps', sql.VarChar(20), c_ProdServ)
        .input('desc', sql.VarChar(100), Descripcion_SAT)
        .input('cu', sql.VarChar(5), c_Unidad)
        .input('uni', sql.VarChar(100), Unidad)
        .input('precio', sql.Decimal(9,2), Precio)
        .query(`UPDATE Empresa2.ProdServ SET ProdServ=@ps,c_ProdServ=@cps,Descripcion_SAT=@desc,c_Unidad=@cu,Unidad=@uni,Precio=@precio WHERE Clave=@clave`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('clave', sql.VarChar(30), req.body.Clave)
      .query(`DELETE FROM Empresa2.ProdServ WHERE Clave=@clave`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
