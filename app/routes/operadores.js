const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');
const { requierePermiso } = require('../middleware/permisos');

router.get('/', (req, res) => res.render('operadores', { usuario: req.session.usuario, modulo: 'operadores' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'Empresa2.Operadores',
      columns: ['ID_OPERADOR','OPERADOR','RFC','CURP','NSS','NOLICENCIA','TELEFONO','CELULAR','STATUS',
        'CALLE','NOEXT','NOINT','COLONIA','CIUDAD','MUNICIPIO','ESTADO','PAIS','CP','NEXTEL','INFONAVIT','TIPODESINFONAVIT','FECHABAJA'],
      searchableCols: ['ID_OPERADOR','OPERADOR','RFC','CURP','NSS','NOLICENCIA','TELEFONO','STATUS'],
      req
    });
    const t = v => String(v == null ? '' : v).trim().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const td = (f, v, extra = '') => `<td data-field="${f}" data-value="${t(v)}"${extra}>${extra ? '' : t(v)}</td>`;
    const oculto = ' style="display:none"';
    const rows = data.rows.map(r => {
      const tels = [t(r.TELEFONO), t(r.CELULAR)].filter(Boolean).join(' / ');
      const fbaja = r.FECHABAJA ? r.FECHABAJA.toISOString().slice(0, 10) : '';
      return `<tr data-id="${r.ID_OPERADOR}">
        ${td('ID_OPERADOR', r.ID_OPERADOR)}${td('OPERADOR', r.OPERADOR)}${td('RFC', r.RFC)}${td('CURP', r.CURP)}${td('NSS', r.NSS)}${td('NOLICENCIA', r.NOLICENCIA)}
        <td data-field="TELEFONOS" data-value="${tels}">${tels}</td>${td('STATUS', r.STATUS)}
        ${['TELEFONO','CELULAR','CALLE','NOEXT','NOINT','COLONIA','CIUDAD','MUNICIPIO','ESTADO','PAIS','CP','NEXTEL','INFONAVIT','TIPODESINFONAVIT'].map(f => td(f, r[f], oculto)).join('')}
        ${td('FECHABAJA', fbaja, oculto)}
      </tr>`;
    }).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', requierePermiso('operadores.editar'), async (req, res) => {
  const { ID_OPERADOR, OPERADOR, RFC, NOLICENCIA, CALLE, NOEXT, NOINT, COLONIA, CIUDAD, MUNICIPIO, ESTADO, PAIS, CP, TELEFONO, NEXTEL, CELULAR, INFONAVIT, TIPODESINFONAVIT, FECHABAJA, STATUS, CURP, NSS, _mode } = req.body;
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
      .input('status', sql.Char(20), STATUS)
      .input('curp', sql.VarChar(20), (CURP || '').trim() || null)
      .input('nss', sql.VarChar(20), (NSS || '').trim() || null);
    if (_mode === 'add') {
      await r.query(`INSERT INTO Empresa2.Operadores(ID_OPERADOR,OPERADOR,RFC,NOLICENCIA,CALLE,NOEXT,NOINT,COLONIA,CIUDAD,MUNICIPIO,ESTADO,PAIS,CP,TELEFONO,NEXTEL,CELULAR,INFONAVIT,TIPODESINFONAVIT,FECHABAJA,STATUS,CURP,NSS)
        VALUES(@id,@ope,@rfc,@lic,@calle,@noext,@noint,@col,@ciu,@mun,@est,@pais,@cp,@tel,@nex,@cel,@info,@tinfo,@fbaja,@status,@curp,@nss)`);
    } else {
      await r.query(`UPDATE Empresa2.Operadores SET OPERADOR=@ope,RFC=@rfc,NOLICENCIA=@lic,CALLE=@calle,NOEXT=@noext,NOINT=@noint,COLONIA=@col,CIUDAD=@ciu,MUNICIPIO=@mun,ESTADO=@est,PAIS=@pais,CP=@cp,TELEFONO=@tel,NEXTEL=@nex,CELULAR=@cel,INFONAVIT=@info,TIPODESINFONAVIT=@tinfo,FECHABAJA=@fbaja,STATUS=@status,CURP=@curp,NSS=@nss WHERE ID_OPERADOR=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', requierePermiso('operadores.editar'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Int, req.body.ID_OPERADOR)
      .query(`DELETE FROM Empresa2.Operadores WHERE ID_OPERADOR=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
