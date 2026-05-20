const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

router.get('/', (req, res) => res.render('operadores', { usuario: req.session.usuario, modulo: 'operadores' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'Empresa2.Operadores',
      columns: ['ID_OPERADOR','OPERADOR','RFC','CIUDAD','STATUS','NOLICENCIA','TELEFONO','CELULAR','FECHABAJA'],
      searchableCols: ['ID_OPERADOR','OPERADOR','RFC','CIUDAD','STATUS'],
      req
    });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.ID_OPERADOR}">
        <td data-field="ID_OPERADOR" data-value="${r.ID_OPERADOR}">${r.ID_OPERADOR}</td>
        <td data-field="OPERADOR" data-value="${(r.OPERADOR||'').trim()}">${(r.OPERADOR||'').trim()}</td>
        <td data-field="RFC" data-value="${(r.RFC||'').trim()}">${(r.RFC||'').trim()}</td>
        <td data-field="CIUDAD" data-value="${(r.CIUDAD||'').trim()}">${(r.CIUDAD||'').trim()}</td>
        <td data-field="STATUS" data-value="${(r.STATUS||'').trim()}">${(r.STATUS||'').trim()}</td>
        <td data-field="NOLICENCIA" data-value="${(r.NOLICENCIA||'').trim()}">${(r.NOLICENCIA||'').trim()}</td>
        <td data-field="TELEFONO" data-value="${(r.TELEFONO||'').trim()}">${(r.TELEFONO||'').trim()}</td>
        <td data-field="CELULAR" data-value="${(r.CELULAR||'').trim()}">${(r.CELULAR||'').trim()}</td>
        <td data-field="FECHABAJA" data-value="${r.FECHABAJA ? r.FECHABAJA.toISOString().slice(0,10) : ''}">${r.FECHABAJA ? r.FECHABAJA.toISOString().slice(0,10) : ''}</td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { ID_OPERADOR, OPERADOR, RFC, NOLICENCIA, CALLE, NOEXT, NOINT, COLONIA, CIUDAD, MUNICIPIO, ESTADO, PAIS, CP, TELEFONO, NEXTEL, CELULAR, INFONAVIT, TIPODESINFONAVIT, FECHABAJA, STATUS, _mode } = req.body;
  try {
    const pool = await getPool();
    const r = pool.request()
      .input('id', sql.Int, ID_OPERADOR)
      .input('ope', sql.Char(254), OPERADOR)
      .input('rfc', sql.Char(18), RFC)
      .input('lic', sql.Char(16), NOLICENCIA)
      .input('calle', sql.Char(100), CALLE)
      .input('noext', sql.Char(20), NOEXT)
      .input('noint', sql.Char(20), NOINT)
      .input('col', sql.Char(150), COLONIA)
      .input('ciu', sql.Char(150), CIUDAD)
      .input('mun', sql.Char(40), MUNICIPIO)
      .input('est', sql.Char(30), ESTADO)
      .input('pais', sql.Char(20), PAIS)
      .input('cp', sql.Char(5), CP)
      .input('tel', sql.Char(15), TELEFONO)
      .input('nex', sql.Char(15), NEXTEL)
      .input('cel', sql.Char(15), CELULAR)
      .input('info', sql.Decimal(13,2), INFONAVIT || null)
      .input('tinfo', sql.Char(20), TIPODESINFONAVIT)
      .input('fbaja', sql.Date, FECHABAJA || null)
      .input('status', sql.Char(20), STATUS);
    if (_mode === 'add') {
      await r.query(`INSERT INTO Empresa2.Operadores(ID_OPERADOR,OPERADOR,RFC,NOLICENCIA,CALLE,NOEXT,NOINT,COLONIA,CIUDAD,MUNICIPIO,ESTADO,PAIS,CP,TELEFONO,NEXTEL,CELULAR,INFONAVIT,TIPODESINFONAVIT,FECHABAJA,STATUS)
        VALUES(@id,@ope,@rfc,@lic,@calle,@noext,@noint,@col,@ciu,@mun,@est,@pais,@cp,@tel,@nex,@cel,@info,@tinfo,@fbaja,@status)`);
    } else {
      await r.query(`UPDATE Empresa2.Operadores SET OPERADOR=@ope,RFC=@rfc,NOLICENCIA=@lic,CALLE=@calle,NOEXT=@noext,NOINT=@noint,COLONIA=@col,CIUDAD=@ciu,MUNICIPIO=@mun,ESTADO=@est,PAIS=@pais,CP=@cp,TELEFONO=@tel,NEXTEL=@nex,CELULAR=@cel,INFONAVIT=@info,TIPODESINFONAVIT=@tinfo,FECHABAJA=@fbaja,STATUS=@status WHERE ID_OPERADOR=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Int, req.body.ID_OPERADOR)
      .query(`DELETE FROM Empresa2.Operadores WHERE ID_OPERADOR=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
