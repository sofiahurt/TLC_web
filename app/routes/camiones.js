const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

router.get('/', (req, res) => res.render('camiones', { usuario: req.session.usuario, modulo: 'camiones' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'Empresa2.Camiones',
      columns: ['ID_CAMION','TIPO','MARCA','PLACA','OPERADOR','DESCRIPCION','ID_OPERADOR','FLAGRENTA','SUBTIPO'],
      searchableCols: ['ID_CAMION','MARCA','PLACA','TIPO','OPERADOR','DESCRIPCION'],
      req
    });
    const rows = data.rows.map(r =>
      `<tr data-id="${(r.ID_CAMION||'').trim()}">
        <td data-field="ID_CAMION" data-value="${(r.ID_CAMION||'').trim()}">${(r.ID_CAMION||'').trim()}</td>
        <td data-field="MARCA" data-value="${(r.MARCA||'').trim()}">${(r.MARCA||'').trim()}</td>
        <td data-field="PLACA" data-value="${(r.PLACA||'').trim()}">${(r.PLACA||'').trim()}</td>
        <td data-field="TIPO" data-value="${(r.TIPO||'').trim()}">${(r.TIPO||'').trim()}</td>
        <td data-field="OPERADOR" data-value="${(r.OPERADOR||'').trim()}">${(r.OPERADOR||'').trim()}</td>
        <td data-field="DESCRIPCION" data-value="${(r.DESCRIPCION||'').trim()}">${(r.DESCRIPCION||'').trim()}</td>
        <td data-field="ID_OPERADOR" data-value="${r.ID_OPERADOR||''}" style="display:none">${r.ID_OPERADOR||''}</td>
        <td data-field="FLAGRENTA" data-value="${r.FLAGRENTA||0}" style="display:none">${r.FLAGRENTA||0}</td>
        <td data-field="SUBTIPO" data-value="${(r.SUBTIPO||'').trim()}" style="display:none">${(r.SUBTIPO||'').trim()}</td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lookup/operadores', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pool = await getPool();
    const where = q ? `WHERE OPERADOR LIKE @q` : `WHERE STATUS IS NULL OR STATUS <> 'BAJA'`;
    const count = await pool.request().input('q', `%${q}%`).query(`SELECT COUNT(*) AS total FROM Empresa2.Operadores ${where}`);
    const total = count.recordset[0].total;
    const offset = (page - 1) * 10;
    const result = await pool.request().input('q', `%${q}%`)
      .query(`SELECT ID_OPERADOR,OPERADOR,RFC FROM Empresa2.Operadores ${where} ORDER BY OPERADOR OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`);
    res.json({ rows: result.recordset, total, totalPages: Math.ceil(total/10), page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { ID_CAMION, TIPO, C_SUBTIPO, SUBTIPO, MARCA, PLACA, ANIOMODELO, NOMASEG, NUMPOLIZA, DESCRIPCION, ID_OPERADOR, OPERADOR, NOCAJA, NOCAJA2, RENDIMIENTO, PAGOKILOMETRO, PAGOVIAJE, FLAGRENTA, SUBTIPOREM, CONFIGVEHICULAR, PERMSCT, NUMPERMISOSCT, PESOBRUTOVEHICULAR, _mode } = req.body;
  try {
    const pool = await getPool();
    const r = pool.request()
      .input('id', sql.Char(10), ID_CAMION)
      .input('tipo', sql.Char(20), TIPO)
      .input('csubtipo', sql.Char(7), C_SUBTIPO)
      .input('subtipo', sql.Char(100), SUBTIPO)
      .input('marca', sql.Char(20), MARCA)
      .input('placa', sql.Char(8), PLACA)
      .input('anio', sql.Char(10), ANIOMODELO)
      .input('nomaseg', sql.Char(100), NOMASEG)
      .input('poliza', sql.Char(40), NUMPOLIZA)
      .input('desc', sql.Char(40), DESCRIPCION)
      .input('idope', sql.Int, ID_OPERADOR || null)
      .input('ope', sql.Char(45), OPERADOR)
      .input('nocaja', sql.Char(8), NOCAJA)
      .input('nocaja2', sql.Char(8), NOCAJA2)
      .input('rend', sql.Decimal(5,2), RENDIMIENTO || null)
      .input('pagokm', sql.Decimal(7,2), PAGOKILOMETRO || null)
      .input('pagovj', sql.Decimal(7,2), PAGOVIAJE || null)
      .input('renta', sql.TinyInt, FLAGRENTA ? 1 : 0)
      .input('subrem', sql.Char(10), SUBTIPOREM)
      .input('config', sql.Char(10), CONFIGVEHICULAR)
      .input('permsct', sql.Char(10), PERMSCT)
      .input('npermsct', sql.Char(50), NUMPERMISOSCT)
      .input('peso', sql.Decimal(7,2), PESOBRUTOVEHICULAR || null);
    if (_mode === 'add') {
      await r.query(`INSERT INTO Empresa2.Camiones(ID_CAMION,TIPO,C_SUBTIPO,SUBTIPO,MARCA,PLACA,ANIOMODELO,NOMASEG,NUMPOLIZA,DESCRIPCION,ID_OPERADOR,OPERADOR,NOCAJA,NOCAJA2,RENDIMIENTO,PAGOKILOMETRO,PAGOVIAJE,FLAGRENTA,SUBTIPOREM,CONFIGVEHICULAR,PERMSCT,NUMPERMISOSCT,PESOBRUTOVEHICULAR)
        VALUES(@id,@tipo,@csubtipo,@subtipo,@marca,@placa,@anio,@nomaseg,@poliza,@desc,@idope,@ope,@nocaja,@nocaja2,@rend,@pagokm,@pagovj,@renta,@subrem,@config,@permsct,@npermsct,@peso)`);
    } else {
      await r.query(`UPDATE Empresa2.Camiones SET TIPO=@tipo,C_SUBTIPO=@csubtipo,SUBTIPO=@subtipo,MARCA=@marca,PLACA=@placa,ANIOMODELO=@anio,NOMASEG=@nomaseg,NUMPOLIZA=@poliza,DESCRIPCION=@desc,ID_OPERADOR=@idope,OPERADOR=@ope,NOCAJA=@nocaja,NOCAJA2=@nocaja2,RENDIMIENTO=@rend,PAGOKILOMETRO=@pagokm,PAGOVIAJE=@pagovj,FLAGRENTA=@renta,SUBTIPOREM=@subrem,CONFIGVEHICULAR=@config,PERMSCT=@permsct,NUMPERMISOSCT=@npermsct,PESOBRUTOVEHICULAR=@peso WHERE ID_CAMION=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Char(10), req.body.ID_CAMION)
      .query(`DELETE FROM Empresa2.Camiones WHERE ID_CAMION=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
