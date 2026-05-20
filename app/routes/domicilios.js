const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

router.get('/', (req, res) => res.render('domicilios', { usuario: req.session.usuario, modulo: 'domicilios' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'Empresa2.DomCarDes',
      columns: ['ID_CLIENTE','ID_DOMICILIO','DESCRIPCION','TIPO','NACINTER','CIUDAD','ESTADO','CALLE','NOEXT','NOINT','COLONIA','CP','MUNICIPIO','PAIS','TELEFONO','CONTACTO','OBSERVACIONES','ID_COLONIA'],
      searchableCols: ['ID_CLIENTE','DESCRIPCION','TIPO','CIUDAD','ESTADO'],
      req
    });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.ID_CLIENTE}-${r.ID_DOMICILIO}">
        <td data-field="ID_CLIENTE" data-value="${r.ID_CLIENTE}">${r.ID_CLIENTE}</td>
        <td data-field="ID_DOMICILIO" data-value="${r.ID_DOMICILIO}">${r.ID_DOMICILIO}</td>
        <td data-field="DESCRIPCION" data-value="${(r.DESCRIPCION||'').trim()}">${(r.DESCRIPCION||'').trim()}</td>
        <td data-field="TIPO" data-value="${(r.TIPO||'').trim()}">${(r.TIPO||'').trim()}</td>
        <td data-field="CIUDAD" data-value="${(r.CIUDAD||'').trim()}">${(r.CIUDAD||'').trim()}</td>
        <td data-field="ESTADO" data-value="${(r.ESTADO||'').trim()}">${(r.ESTADO||'').trim()}</td>
        <td data-field="CALLE" data-value="${(r.CALLE||'').trim()}" style="display:none"></td>
        <td data-field="NOEXT" data-value="${(r.NOEXT||'').trim()}" style="display:none"></td>
        <td data-field="NOINT" data-value="${(r.NOINT||'').trim()}" style="display:none"></td>
        <td data-field="COLONIA" data-value="${(r.COLONIA||'').trim()}" style="display:none"></td>
        <td data-field="CP" data-value="${(r.CP||'').trim()}" style="display:none"></td>
        <td data-field="MUNICIPIO" data-value="${(r.MUNICIPIO||'').trim()}" style="display:none"></td>
        <td data-field="PAIS" data-value="${(r.PAIS||'').trim()}" style="display:none"></td>
        <td data-field="NACINTER" data-value="${(r.NACINTER||'').trim()}" style="display:none"></td>
        <td data-field="TELEFONO" data-value="${(r.TELEFONO||'').trim()}" style="display:none"></td>
        <td data-field="CONTACTO" data-value="${(r.CONTACTO||'').trim()}" style="display:none"></td>
        <td data-field="OBSERVACIONES" data-value="${(r.OBSERVACIONES||'').trim()}" style="display:none"></td>
        <td data-field="ID_COLONIA" data-value="${r.ID_COLONIA||''}" style="display:none"></td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const f = req.body;
  try {
    const pool = await getPool();
    const r = pool.request()
      .input('idcli', sql.Decimal(7), f.ID_CLIENTE)
      .input('iddom', sql.Decimal(3), f.ID_DOMICILIO)
      .input('tipo', sql.Char(10), f.TIPO)
      .input('nacinter', sql.Char(15), f.NACINTER)
      .input('desc', sql.Char(80), f.DESCRIPCION)
      .input('calle', sql.Char(100), f.CALLE)
      .input('noext', sql.Char(20), f.NOEXT)
      .input('noint', sql.Char(20), f.NOINT)
      .input('idcol', sql.Decimal(7), f.ID_COLONIA || null)
      .input('col', sql.Char(80), f.COLONIA)
      .input('ciu', sql.Char(80), f.CIUDAD)
      .input('mun', sql.Char(40), f.MUNICIPIO)
      .input('est', sql.Char(30), f.ESTADO)
      .input('pais', sql.Char(20), f.PAIS)
      .input('cp', sql.Char(6), f.CP)
      .input('tel', sql.Char(15), f.TELEFONO)
      .input('con', sql.Char(150), f.CONTACTO)
      .input('obs', sql.Char(255), f.OBSERVACIONES);
    if (f._mode === 'add') {
      await r.query(`INSERT INTO Empresa2.DomCarDes(ID_CLIENTE,ID_DOMICILIO,TIPO,NACINTER,DESCRIPCION,CALLE,NOEXT,NOINT,ID_COLONIA,COLONIA,CIUDAD,MUNICIPIO,ESTADO,PAIS,CP,TELEFONO,CONTACTO,OBSERVACIONES)
        VALUES(@idcli,@iddom,@tipo,@nacinter,@desc,@calle,@noext,@noint,@idcol,@col,@ciu,@mun,@est,@pais,@cp,@tel,@con,@obs)`);
    } else {
      await r.query(`UPDATE Empresa2.DomCarDes SET TIPO=@tipo,NACINTER=@nacinter,DESCRIPCION=@desc,CALLE=@calle,NOEXT=@noext,NOINT=@noint,ID_COLONIA=@idcol,COLONIA=@col,CIUDAD=@ciu,MUNICIPIO=@mun,ESTADO=@est,PAIS=@pais,CP=@cp,TELEFONO=@tel,CONTACTO=@con,OBSERVACIONES=@obs WHERE ID_CLIENTE=@idcli AND ID_DOMICILIO=@iddom`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('idcli', sql.Decimal(7), req.body.ID_CLIENTE)
      .input('iddom', sql.Decimal(3), req.body.ID_DOMICILIO)
      .query(`DELETE FROM Empresa2.DomCarDes WHERE ID_CLIENTE=@idcli AND ID_DOMICILIO=@iddom`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
