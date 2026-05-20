const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

router.get('/', (req, res) => res.render('contacto', { usuario: req.session.usuario, modulo: 'contacto' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'Empresa2.Contacto',
      columns: ['ID_CLIENTE','ID_CONTACTO','CONTACTO','EMAIL','AREA','TELEFONO1','TIPOTEL1','TELEFONO2','TELEFONO3'],
      searchableCols: ['ID_CLIENTE','ID_CONTACTO','CONTACTO','EMAIL','AREA'],
      req
    });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.ID_CLIENTE}-${r.ID_CONTACTO}">
        <td data-field="ID_CLIENTE" data-value="${r.ID_CLIENTE}">${r.ID_CLIENTE}</td>
        <td data-field="ID_CONTACTO" data-value="${r.ID_CONTACTO}">${r.ID_CONTACTO}</td>
        <td data-field="CONTACTO" data-value="${(r.CONTACTO||'').trim()}">${(r.CONTACTO||'').trim()}</td>
        <td data-field="EMAIL" data-value="${(r.EMAIL||'').trim()}">${(r.EMAIL||'').trim()}</td>
        <td data-field="AREA" data-value="${(r.AREA||'').trim()}">${(r.AREA||'').trim()}</td>
        <td data-field="TELEFONO1" data-value="${(r.TELEFONO1||'').trim()}">${(r.TELEFONO1||'').trim()}</td>
        <td data-field="TIPOTEL1" data-value="${(r.TIPOTEL1||'').trim()}" style="display:none">${(r.TIPOTEL1||'').trim()}</td>
        <td data-field="TELEFONO2" data-value="${(r.TELEFONO2||'').trim()}" style="display:none">${(r.TELEFONO2||'').trim()}</td>
        <td data-field="TELEFONO3" data-value="${(r.TELEFONO3||'').trim()}" style="display:none">${(r.TELEFONO3||'').trim()}</td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { ID_CLIENTE, ID_CONTACTO, CONTACTO, EMAIL, AREA, TIPOTEL1, TELEFONO1, TIPOTEL2, TELEFONO2, TIPOTEL3, TELEFONO3, _mode } = req.body;
  try {
    const pool = await getPool();
    const r = pool.request()
      .input('idcli', sql.Decimal(7), ID_CLIENTE)
      .input('idcon', sql.Decimal(3), ID_CONTACTO)
      .input('con', sql.Char(60), CONTACTO)
      .input('email', sql.Char(64), EMAIL)
      .input('area', sql.Char(45), AREA)
      .input('tt1', sql.Char(10), TIPOTEL1)
      .input('tel1', sql.Char(20), TELEFONO1)
      .input('tt2', sql.Char(10), TIPOTEL2)
      .input('tel2', sql.Char(20), TELEFONO2)
      .input('tt3', sql.Char(10), TIPOTEL3)
      .input('tel3', sql.Char(20), TELEFONO3);
    if (_mode === 'add') {
      await r.query(`INSERT INTO Empresa2.Contacto(ID_CLIENTE,ID_CONTACTO,CONTACTO,EMAIL,AREA,TIPOTEL1,TELEFONO1,TIPOTEL2,TELEFONO2,TIPOTEL3,TELEFONO3)
        VALUES(@idcli,@idcon,@con,@email,@area,@tt1,@tel1,@tt2,@tel2,@tt3,@tel3)`);
    } else {
      await r.query(`UPDATE Empresa2.Contacto SET CONTACTO=@con,EMAIL=@email,AREA=@area,TIPOTEL1=@tt1,TELEFONO1=@tel1,TIPOTEL2=@tt2,TELEFONO2=@tel2,TIPOTEL3=@tt3,TELEFONO3=@tel3 WHERE ID_CLIENTE=@idcli AND ID_CONTACTO=@idcon`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('idcli', sql.Decimal(7), req.body.ID_CLIENTE)
      .input('idcon', sql.Decimal(3), req.body.ID_CONTACTO)
      .query(`DELETE FROM Empresa2.Contacto WHERE ID_CLIENTE=@idcli AND ID_CONTACTO=@idcon`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
