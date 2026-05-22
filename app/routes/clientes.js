const express = require('express');
const router = express.Router();
const path = require('path');
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

// SAT SQLite catalog helpers (read-only, cached per table)
let _satDb = null;
const _satCache = {};

function getSatCatalog(table, claveCol) {
  if (!_satCache[table]) {
    if (!_satDb) {
      const Database = require('better-sqlite3');
      _satDb = new Database(
        path.join(__dirname, '../../storage/catalogos/sat_catalogos.sqlite'),
        { readonly: true }
      );
    }
    _satCache[table] = _satDb
      .prepare(`SELECT ${claveCol} AS clave, descripcion FROM ${table} ORDER BY clave`)
      .all();
  }
  return _satCache[table];
}

function satLookupHandler(table, claveCol) {
  return (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const all = getSatCatalog(table, claveCol);
    const filtered = q
      ? all.filter(r => r.clave.toLowerCase().includes(q) || r.descripcion.toLowerCase().includes(q))
      : all;
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / 10));
    const rows = filtered.slice((page - 1) * 10, page * 10);
    res.json({ rows, total, totalPages, page });
  };
}

router.get('/', (req, res) => res.render('clientes', { usuario: req.session.usuario, modulo: 'clientes' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'Empresa2.Clientes',
      columns: ['ID_CLIENTE','TIPOCLIENTE','NOMBRECOM','NOMBRECOMUN','RFC','CIUDAD','ESTADO','COLONIA','CP','ID_COLONIA','DIASCREDITO','LOGISTICA','FLAGEXTRANJERO','C_REGIMENFISCAL','REGIMENFISCAL','C_FORMAPAGO','C_USOCFDI','CLAVEMP','METODOPAGO'],
      searchableCols: ['ID_CLIENTE','NOMBRECOMUN','NOMBRECOM','RFC','CIUDAD','ESTADO','TIPOCLIENTE'],
      req
    });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.ID_CLIENTE}">
        <td data-field="ID_CLIENTE" data-value="${r.ID_CLIENTE}">${r.ID_CLIENTE}</td>
        <td data-field="NOMBRECOMUN" data-value="${(r.NOMBRECOMUN||'').trim()}">${(r.NOMBRECOMUN||'').trim()}</td>
        <td data-field="NOMBRECOM" data-value="${(r.NOMBRECOM||'').trim()}" style="display:none">${(r.NOMBRECOM||'').trim()}</td>
        <td data-field="RFC" data-value="${(r.RFC||'').trim()}">${(r.RFC||'').trim()}</td>
        <td data-field="CIUDAD" data-value="${(r.CIUDAD||'').trim()}">${(r.CIUDAD||'').trim()}</td>
        <td data-field="ESTADO" data-value="${(r.ESTADO||'').trim()}">${(r.ESTADO||'').trim()}</td>
        <td data-field="TIPOCLIENTE" data-value="${(r.TIPOCLIENTE||'').trim()}">${(r.TIPOCLIENTE||'').trim()}</td>
        <td data-field="COLONIA" data-value="${(r.COLONIA||'').trim()}" style="display:none">${(r.COLONIA||'').trim()}</td>
        <td data-field="CP" data-value="${(r.CP||'').trim()}" style="display:none">${(r.CP||'').trim()}</td>
        <td data-field="ID_COLONIA" data-value="${r.ID_COLONIA||''}" style="display:none">${r.ID_COLONIA||''}</td>
        <td data-field="DIASCREDITO" data-value="${r.DIASCREDITO||''}" style="display:none">${r.DIASCREDITO||''}</td>
        <td data-field="LOGISTICA" data-value="${r.LOGISTICA||0}" style="display:none">${r.LOGISTICA||0}</td>
        <td data-field="FLAGEXTRANJERO" data-value="${r.FLAGEXTRANJERO||0}" style="display:none">${r.FLAGEXTRANJERO||0}</td>
        <td data-field="C_REGIMENFISCAL" data-value="${(r.C_REGIMENFISCAL||'').trim()}" style="display:none"></td>
        <td data-field="REGIMENFISCAL" data-value="${(r.REGIMENFISCAL||'').trim()}" style="display:none"></td>
        <td data-field="C_FORMAPAGO" data-value="${(r.C_FORMAPAGO||'').trim()}" style="display:none"></td>
        <td data-field="C_USOCFDI" data-value="${(r.C_USOCFDI||'').trim()}" style="display:none"></td>
        <td data-field="CLAVEMP" data-value="${(r.CLAVEMP||'').trim()}" style="display:none"></td>
        <td data-field="METODOPAGO" data-value="${(r.METODOPAGO||'').trim()}" style="display:none"></td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lookup for other modules
router.get('/lookup', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pool = await getPool();
    const where = q ? `WHERE NOMBRECOMUN LIKE @q OR NOMBRECOM LIKE @q` : '';
    const count = await pool.request().input('q', `%${q}%`).query(`SELECT COUNT(*) AS total FROM Empresa2.Clientes ${where}`);
    const total = count.recordset[0].total;
    const offset = (page - 1) * 10;
    const result = await pool.request().input('q', `%${q}%`)
      .query(`SELECT ID_CLIENTE,NOMBRECOMUN,NOMBRECOM,RFC FROM Empresa2.Clientes ${where} ORDER BY NOMBRECOMUN OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`);
    res.json({ rows: result.recordset, total, totalPages: Math.ceil(total/10), page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lookup/colonias', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pool = await getPool();
    const where = q ? `WHERE COLONIA LIKE @q OR CP LIKE @q` : '';
    const count = await pool.request().input('q', `%${q}%`).query(`SELECT COUNT(*) AS total FROM Empresa2.ColCP ${where}`);
    const total = count.recordset[0].total;
    const offset = (page - 1) * 10;
    const result = await pool.request().input('q', `%${q}%`)
      .query(`SELECT ID_COLONIA,COLONIA,CP FROM Empresa2.ColCP ${where} ORDER BY COLONIA OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`);
    res.json({ rows: result.recordset, total, totalPages: Math.ceil(total/10), page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lookup/sat/regimen-fiscal', satLookupHandler('sat_regimenfiscal', 'c_regimenfiscal'));
router.get('/lookup/sat/forma-pago',     satLookupHandler('sat_formas_pago',   'c_FormaPago'));
router.get('/lookup/sat/uso-cfdi',       satLookupHandler('sat_usoCDFI',       'c_usocfdi'));
router.get('/lookup/sat/metodo-pago',    satLookupHandler('sat_metodo_pago',   'c_metodopago'));

router.post('/guardar', async (req, res) => {
  const f = req.body;
  try {
    const pool = await getPool();
    const r = pool.request()
      .input('id', sql.Decimal(7), f.ID_CLIENTE)
      .input('tipo', sql.Char(20), f.TIPOCLIENTE)
      .input('ncom', sql.Char(150), f.NOMBRECOM)
      .input('ncomun', sql.Char(80), f.NOMBRECOMUN)
      .input('calle', sql.Char(150), f.CALLENUM)
      .input('noext', sql.Char(20), f.NOEXT)
      .input('noint', sql.Char(20), f.NOINT)
      .input('idcol', sql.Decimal(7), f.ID_COLONIA || null)
      .input('col', sql.Char(80), f.COLONIA)
      .input('ciu', sql.Char(80), f.CIUDAD)
      .input('mun', sql.Char(40), f.MUNICIPIO)
      .input('est', sql.Char(40), f.ESTADO)
      .input('pais', sql.Char(40), f.PAIS)
      .input('cp', sql.Char(6), f.CP)
      .input('rfc', sql.Char(15), f.RFC)
      .input('cregfis', sql.Char(6), f.C_REGIMENFISCAL)
      .input('regfis', sql.VarChar(199), f.REGIMENFISCAL)
      .input('email', sql.Char(200), f.EMAILFACTURAS)
      .input('dias', sql.Decimal(3), f.DIASCREDITO || null)
      .input('realizo', sql.Char(60), f.REALIZO)
      .input('logis', sql.TinyInt, f.LOGISTICA ? 1 : 0)
      .input('cvemp', sql.Char(3), f.CLAVEMP)
      .input('metpago', sql.Char(60), f.METODOPAGO)
      .input('cforpago', sql.Char(4), f.C_FORMAPAGO)
      .input('cusocfdi', sql.Char(5), f.C_USOCFDI)
      .input('flagext', sql.TinyInt, f.FLAGEXTRANJERO ? 1 : 0)
      .input('claveid', sql.Char(20), f.CLAVEIDFISCAL);
    if (f._mode === 'add') {
      await r.query(`INSERT INTO Empresa2.Clientes(ID_CLIENTE,TIPOCLIENTE,NOMBRECOM,NOMBRECOMUN,CALLENUM,NOEXT,NOINT,ID_COLONIA,COLONIA,CIUDAD,MUNICIPIO,ESTADO,PAIS,CP,RFC,C_REGIMENFISCAL,REGIMENFISCAL,EMAILFACTURAS,DIASCREDITO,REALIZO,LOGISTICA,CLAVEMP,METODOPAGO,C_FORMAPAGO,C_USOCFDI,FLAGEXTRANJERO,CLAVEIDFISCAL)
        VALUES(@id,@tipo,@ncom,@ncomun,@calle,@noext,@noint,@idcol,@col,@ciu,@mun,@est,@pais,@cp,@rfc,@cregfis,@regfis,@email,@dias,@realizo,@logis,@cvemp,@metpago,@cforpago,@cusocfdi,@flagext,@claveid)`);
    } else {
      await r.query(`UPDATE Empresa2.Clientes SET TIPOCLIENTE=@tipo,NOMBRECOM=@ncom,NOMBRECOMUN=@ncomun,CALLENUM=@calle,NOEXT=@noext,NOINT=@noint,ID_COLONIA=@idcol,COLONIA=@col,CIUDAD=@ciu,MUNICIPIO=@mun,ESTADO=@est,PAIS=@pais,CP=@cp,RFC=@rfc,C_REGIMENFISCAL=@cregfis,REGIMENFISCAL=@regfis,EMAILFACTURAS=@email,DIASCREDITO=@dias,REALIZO=@realizo,LOGISTICA=@logis,CLAVEMP=@cvemp,METODOPAGO=@metpago,C_FORMAPAGO=@cforpago,C_USOCFDI=@cusocfdi,FLAGEXTRANJERO=@flagext,CLAVEIDFISCAL=@claveid WHERE ID_CLIENTE=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Decimal(7), req.body.ID_CLIENTE)
      .query(`DELETE FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
