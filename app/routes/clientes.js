const express = require('express');
const router = express.Router();
const path = require('path');
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');
const { requierePermiso } = require('../middleware/permisos');

// SAT SQLite catalog helpers (read-only, cached per table)
let _satDb = null;
const _satCache = {};

function getSatCatalog(table, claveCol, descCol) {
  const cacheKey = `${table}:${claveCol}:${descCol}`;
  if (!_satCache[cacheKey]) {
    if (!_satDb) {
      const Database = require('better-sqlite3');
      _satDb = new Database(
        path.join(__dirname, '../../storage/catalogos/sat_catalogos.sqlite'),
        { readonly: true }
      );
    }
    _satCache[cacheKey] = _satDb
      .prepare(`SELECT ${claveCol} AS clave, "${descCol}" AS descripcion FROM ${table} ORDER BY clave`)
      .all();
  }
  return _satCache[cacheKey];
}

function satLookupHandler(table, claveCol, descCol = 'descripcion') {
  return (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const all = getSatCatalog(table, claveCol, descCol);
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
      columns: ['ID_CLIENTE','TIPOCLIENTE','NOMBRECOM','NOMBRECOMUN','RFC','CIUDAD','ESTADO','COLONIA','CP','ID_COLONIA','DIASCREDITO','LOGISTICA','FLAGEXTRANJERO','C_REGIMENFISCAL','REGIMENFISCAL','C_FORMAPAGO','C_USOCFDI','CLAVEMP','METODOPAGO','C_CLAVEPRODSERV','DESCRIPCION_PRO'],
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
        <td data-field="C_CLAVEPRODSERV" data-value="${(r.C_CLAVEPRODSERV||'').trim()}" style="display:none"></td>
        <td data-field="DESCRIPCION_PRO" data-value="${(r.DESCRIPCION_PRO||'').trim()}" style="display:none"></td>
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
router.get('/lookup/sat/moneda',         satLookupHandler('SAT_Moneda',        'c_Moneda', 'Descripción'));
router.get('/lookup/sat/tipo-relacion',  satLookupHandler('sat_TipoRelacion',  'c_TipoRelacion', 'Descripción'));
router.get('/lookup/sat/unidad',         satLookupHandler('sat_Unidad',        'c_claveunidad',  'nombre'));
router.get('/lookup/sat/prodserv',       satLookupHandler('sat_ProdServ',      'c_claveprodserv','descripcion'));

router.post('/guardar', requierePermiso('clientes.editar'), async (req, res) => {
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
      .input('claveid', sql.Char(20), f.CLAVEIDFISCAL)
      .input('cveprod', sql.Char(20), f.C_CLAVEPRODSERV)
      .input('descprod', sql.Char(100), f.DESCRIPCION_PRO);
    if (f._mode === 'add') {
      await r.query(`INSERT INTO Empresa2.Clientes(ID_CLIENTE,TIPOCLIENTE,NOMBRECOM,NOMBRECOMUN,CALLENUM,NOEXT,NOINT,ID_COLONIA,COLONIA,CIUDAD,MUNICIPIO,ESTADO,PAIS,CP,RFC,C_REGIMENFISCAL,REGIMENFISCAL,EMAILFACTURAS,DIASCREDITO,REALIZO,LOGISTICA,CLAVEMP,METODOPAGO,C_FORMAPAGO,C_USOCFDI,FLAGEXTRANJERO,CLAVEIDFISCAL,C_CLAVEPRODSERV,DESCRIPCION_PRO)
        VALUES(@id,@tipo,@ncom,@ncomun,@calle,@noext,@noint,@idcol,@col,@ciu,@mun,@est,@pais,@cp,@rfc,@cregfis,@regfis,@email,@dias,@realizo,@logis,@cvemp,@metpago,@cforpago,@cusocfdi,@flagext,@claveid,@cveprod,@descprod)`);
    } else {
      await r.query(`UPDATE Empresa2.Clientes SET TIPOCLIENTE=@tipo,NOMBRECOM=@ncom,NOMBRECOMUN=@ncomun,CALLENUM=@calle,NOEXT=@noext,NOINT=@noint,ID_COLONIA=@idcol,COLONIA=@col,CIUDAD=@ciu,MUNICIPIO=@mun,ESTADO=@est,PAIS=@pais,CP=@cp,RFC=@rfc,C_REGIMENFISCAL=@cregfis,REGIMENFISCAL=@regfis,EMAILFACTURAS=@email,DIASCREDITO=@dias,REALIZO=@realizo,LOGISTICA=@logis,CLAVEMP=@cvemp,METODOPAGO=@metpago,C_FORMAPAGO=@cforpago,C_USOCFDI=@cusocfdi,FLAGEXTRANJERO=@flagext,CLAVEIDFISCAL=@claveid,C_CLAVEPRODSERV=@cveprod,DESCRIPCION_PRO=@descprod WHERE ID_CLIENTE=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/eliminar', requierePermiso('clientes.editar'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Decimal(7), req.body.ID_CLIENTE)
      .query(`DELETE FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TAB "DOMICILIOS" DEL FORMULARIO DE CLIENTE (DomCarDes, acotado al cliente) ──
router.get('/domicilios/data', async (req, res) => {
  try {
    const idCliente = parseInt(req.query.idCliente);
    if (!idCliente) return res.status(400).json({ error: 'Falta idCliente' });
    const data = await browseQuery({
      table: 'Empresa2.DomCarDes',
      columns: ['ID_CLIENTE','ID_DOMICILIO','DESCRIPCION','TIPO','NACINTER','CIUDAD','ESTADO','CALLE','NOEXT','NOINT','COLONIA','CP','MUNICIPIO','PAIS','TELEFONO','CONTACTO','OBSERVACIONES'],
      searchableCols: ['ID_DOMICILIO','DESCRIPCION','TIPO','CIUDAD','ESTADO'],
      baseWhere: 'ID_CLIENTE = @idCliente',
      baseParams: { idCliente },
      req
    });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.ID_CLIENTE}-${r.ID_DOMICILIO}">
        <td data-field="ID_DOMICILIO" data-value="${r.ID_DOMICILIO}">${r.ID_DOMICILIO}</td>
        <td data-field="DESCRIPCION" data-value="${(r.DESCRIPCION||'').trim()}">${(r.DESCRIPCION||'').trim()}</td>
        <td data-field="TIPO" data-value="${(r.TIPO||'').trim()}">${(r.TIPO||'').trim()}</td>
        <td data-field="CIUDAD" data-value="${(r.CIUDAD||'').trim()}">${(r.CIUDAD||'').trim()}</td>
        <td data-field="ESTADO" data-value="${(r.ESTADO||'').trim()}">${(r.ESTADO||'').trim()}</td>
        <td data-field="ID_CLIENTE" data-value="${r.ID_CLIENTE}" style="display:none"></td>
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
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-outline-primary py-0 px-1 me-1" onclick="domCliOpenEdit(this)"><i class="bi bi-pencil"></i></button>
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1" onclick="domCliEliminar(${r.ID_CLIENTE},${r.ID_DOMICILIO})"><i class="bi bi-trash"></i></button>
        </td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/domicilios/guardar', requierePermiso('clientes.editar'), async (req, res) => {
  const f = req.body;
  if (!f.ID_CLIENTE || !f.ID_DOMICILIO) return res.status(400).json({ error: 'Cliente e ID de domicilio son requeridos.' });
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
      await r.query(`INSERT INTO Empresa2.DomCarDes(ID_CLIENTE,ID_DOMICILIO,TIPO,NACINTER,DESCRIPCION,CALLE,NOEXT,NOINT,COLONIA,CIUDAD,MUNICIPIO,ESTADO,PAIS,CP,TELEFONO,CONTACTO,OBSERVACIONES)
        VALUES(@idcli,@iddom,@tipo,@nacinter,@desc,@calle,@noext,@noint,@col,@ciu,@mun,@est,@pais,@cp,@tel,@con,@obs)`);
    } else {
      await r.query(`UPDATE Empresa2.DomCarDes SET TIPO=@tipo,NACINTER=@nacinter,DESCRIPCION=@desc,CALLE=@calle,NOEXT=@noext,NOINT=@noint,COLONIA=@col,CIUDAD=@ciu,MUNICIPIO=@mun,ESTADO=@est,PAIS=@pais,CP=@cp,TELEFONO=@tel,CONTACTO=@con,OBSERVACIONES=@obs WHERE ID_CLIENTE=@idcli AND ID_DOMICILIO=@iddom`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/domicilios/eliminar', requierePermiso('clientes.editar'), async (req, res) => {
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
