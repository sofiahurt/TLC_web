const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');

const SEARCH_COLS = new Set(['CartaPorte','NombreComunCli','Status','DesFlete','RealizoPedido']);
const SORT_COLS   = new Set(['CartaPorte','FechaPedido','FehcaCarga','NombreComunCli','DesFlete','Status','RealizoPedido']);

router.get('/', (req, res) => res.render('cartaporte', { usuario: req.session.usuario, modulo: 'cartaporte' }));

// ── BROWSE ──────────────────────────────────────────────────────────────────
router.get('/data', async (req, res) => {
  try {
    const pool   = await getPool();
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const q      = (req.query.q || '').trim();
    const col    = req.query.col || '';
    const sort   = SORT_COLS.has(req.query.sort) ? req.query.sort : 'FechaPedido';
    const dir    = req.query.dir === 'asc' ? 'ASC' : 'DESC';
    const serie  = req.session.usuario.serie;
    const anio   = req.session.anio;

    let where = 'WHERE Serie = @serie';
    const r = pool.request().input('serie', sql.VarChar(3), serie);
    if (q && SEARCH_COLS.has(col)) {
      where += ` AND ${col} LIKE @q COLLATE Modern_Spanish_CI_AS`;
      r.input('q', `%${q}%`);
    }

    const cr = pool.request().input('serie', sql.VarChar(3), serie);
    if (q && SEARCH_COLS.has(col)) cr.input('q', `%${q}%`);
    const cntRes = await cr.query(`SELECT COUNT(*) AS total FROM Empresa2.CartaPorte ${where}`);
    const total = cntRes.recordset[0].total;
    const totalPages = Math.max(1, Math.ceil(total / 20));
    const safePage   = Math.min(page, totalPages);
    const offset     = (safePage - 1) * 20;

    const dr = pool.request().input('serie', sql.VarChar(3), serie);
    if (q && SEARCH_COLS.has(col)) dr.input('q', `%${q}%`);
    const dataRes = await dr.query(
      `SELECT Serie,CartaPorte,Id_Pedido,FechaPedido,FehcaCarga,NombreComunCli,DesFlete,Status,RealizoPedido
       FROM Empresa2.CartaPorte ${where}
       ORDER BY ${sort} ${dir}
       OFFSET ${offset} ROWS FETCH NEXT 20 ROWS ONLY`
    );

    const fmt = v => v ? (v instanceof Date ? v.toISOString().slice(0,10) : String(v).trim()) : '';
    const rows = dataRes.recordset.map(r =>
      `<tr data-id="${r.CartaPorte}">
        <td data-field="Serie"         data-value="${fmt(r.Serie)}">${fmt(r.Serie)}</td>
        <td data-field="CartaPorte"    data-value="${fmt(r.CartaPorte)}">${fmt(r.CartaPorte)}</td>
        <td data-field="FechaPedido"   data-value="${fmt(r.FechaPedido)}">${fmt(r.FechaPedido)}</td>
        <td data-field="FehcaCarga"    data-value="${fmt(r.FehcaCarga)}">${fmt(r.FehcaCarga)}</td>
        <td data-field="NombreComunCli" data-value="${fmt(r.NombreComunCli)}">${fmt(r.NombreComunCli)}</td>
        <td data-field="DesFlete"      data-value="${fmt(r.DesFlete)}">${fmt(r.DesFlete)}</td>
        <td data-field="Status"        data-value="${fmt(r.Status)}">${fmt(r.Status)}</td>
        <td data-field="RealizoPedido" data-value="${fmt(r.RealizoPedido)}">${fmt(r.RealizoPedido)}</td>
        <td data-field="Id_Pedido"     data-value="${r.Id_Pedido||''}" style="display:none"></td>
      </tr>`
    ).join('');
    res.json({ rows, page: safePage, totalPages, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SINGLE RECORD (for edit load) ────────────────────────────────────────────
router.get('/get', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('serie', sql.VarChar(3), req.query.serie)
      .input('cp', sql.VarChar(30), req.query.cartaporte)
      .query(`SELECT * FROM Empresa2.CartaPorte WHERE Serie=@serie AND CartaPorte=@cp`);
    if (!result.recordset[0]) return res.status(404).json({ error: 'No encontrado' });
    const r = result.recordset[0];
    const fmt = v => v instanceof Date ? v.toISOString().slice(0,10) : (v == null ? '' : String(v).trim());
    const fmtDT = v => { if (!v) return ''; const d = new Date(v); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
    res.json({
      Serie: fmt(r.Serie), CartaPorte: fmt(r.CartaPorte), Id_Pedido: r.Id_Pedido||'',
      FechaPedido: fmt(r.FechaPedido), FehcaCarga: fmt(r.FehcaCarga),
      HoraCarga: fmtDT(r.HoraCarga), FechaDesCarta: fmt(r.FechaDesCarta),
      HorarioDesCarta: fmtDT(r.HorarioDesCarta),
      Id_Cliente: r.Id_Cliente||'', NombreComunCli: fmt(r.NombreComunCli),
      Id_ClienteEnt: r.Id_ClienteEnt||'', ClienteEnt: fmt(r.ClienteEnt),
      Id_ClienteCarga: r.Id_ClienteCarga||'', ClienteCarga: fmt(r.ClienteCarga),
      NoPedidoCliente: fmt(r.NoPedidoCliente), NoRainde: fmt(r.NoRainde),
      Id_Tarifa: r.Id_Tarifa||'', DesFlete: fmt(r.DesFlete),
      Id_Camion: fmt(r.Id_Camion), NoCamion: fmt(r.NoCamion), NoPlacas: fmt(r.NoPlacas),
      NoCaja: fmt(r.NoCaja), NoCaja2: fmt(r.NoCaja2),
      Id_Operador: r.Id_Operador||'', Operador: fmt(r.Operador),
      Id_DomCarga: r.Id_DomCarga||'', DomCarga: fmt(r.DomCarga),
      Id_DomDescarga1: r.Id_DomDescarga1||'', DomDescarga: fmt(r.DomDescarga),
      CostoFlete: r.CostoFlete||0, CostoManiobras: r.CostoManiobras||0,
      CostoDemoras: r.CostoDemoras||0, CostoAutopistas: r.CostoAutopistas||0,
      CostoDobOpe: r.CostoDobOpe||0, CostoDisel: r.CostoDisel||0,
      NoParadas: r.NoParadas||0, CostoParada: r.CostoParada||0,
      CostosOtros: r.CostosOtros||0, DesOtrosCostos: fmt(r.DesOtrosCostos),
      CargoExtraTrans: r.CargoExtraTrans||0, Kilometros: r.Kilometros||0,
      KilometrosTar: r.KilometrosTar||0, RetenKilo: r.RetenKilo||0,
      c_Moneda: fmt(r.c_Moneda), TipoCambio: r.TipoCambio||0,
      FlagCobMan: r.FlagCobMan||0, FlagCobDem: r.FlagCobDem||0,
      FlagCobAuto: r.FlagCobAuto||0, FlagCobDO: r.FlagCobDO||0,
      FlagConDis: r.FlagConDis||0, FlagCobParada: r.FlagCobParada||0,
      FlagCobOtros: r.FlagCobOtros||0, FlagCobCE: r.FlagCobCE||0,
      FlagIVA: r.FlagIVA||0, FlagRet: r.FlagRet||0,
      SubTotalMX: r.SubTotalMX||0, PorIVAMX: r.PorIVAMX||16,
      IVAMX: r.IVAMX||0, RetenMX: r.RetenMX||0, TOTALMX: r.TOTALMX||0,
      SubTotalUSD: r.SubTotalUSD||0, PorIVAUSD: r.PorIVAUSD||16,
      IVAUSD: r.IVAUSD||0, RetenUSD: r.RetenUSD||0, TOTALUSD: r.TOTALUSD||0,
      CostoPrestamo: r.CostoPrestamo||0, CostoTalacha: r.CostoTalacha||0,
      CostoCompllanta: r.CostoCompllanta||0, CostoDiesel: r.CostoDiesel||0,
      CostoCasetas: r.CostoCasetas||0, CostoComidas: r.CostoComidas||0,
      CostoManiobrasExt: r.CostoManiobrasExt||0, CostoBascula: r.CostoBascula||0,
      CostoPension: r.CostoPension||0, CostoRefacciones: r.CostoRefacciones||0,
      CostoOtros: r.CostoOtros||0,
      Status: fmt(r.Status), Observaciones: fmt(r.Observaciones),
      Booking: fmt(r.Booking), Contenedor: fmt(r.Contenedor),
      RealizoPedido: fmt(r.RealizoPedido)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LOOKUPS ───────────────────────────────────────────────────────────────────
router.get('/lookup/clientes', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pool = await getPool();
    const isNum = q && /^\d+$/.test(q);
    const where = q ? `WHERE NOMBRECOMUN LIKE @q OR NOMBRECOM LIKE @q${isNum ? ' OR CAST(ID_CLIENTE AS NVARCHAR) = @qexact' : ''}` : '';
    const crReq = pool.request(); if (q) crReq.input('q', `%${q}%`); if (isNum) crReq.input('qexact', q);
    const cr = await crReq.query(`SELECT COUNT(*) AS total FROM Empresa2.Clientes ${where}`);
    const total = cr.recordset[0].total;
    const offset = (page - 1) * 10;
    const drReq = pool.request(); if (q) drReq.input('q', `%${q}%`); if (isNum) drReq.input('qexact', q);
    const dr = await drReq.query(`SELECT ID_CLIENTE,NOMBRECOMUN,RFC FROM Empresa2.Clientes ${where} ORDER BY NOMBRECOMUN OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`);
    res.json({ rows: dr.recordset, total, totalPages: Math.ceil(total/10)||1, page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lookup/tarifas', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const idCliente = parseInt(req.query.idCliente) || 0;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pool = await getPool();
    let where = idCliente ? `WHERE ID_CLIENTE = @idCli` : `WHERE 1=1`;
    if (q) where += ` AND (DESFLETE LIKE @q OR CAST(ID_TARIFA AS NVARCHAR) LIKE @q)`;
    const cr = pool.request().input('idCli', sql.Decimal(7), idCliente || null);
    if (q) cr.input('q', `%${q}%`);
    const cntRes = await cr.query(`SELECT COUNT(*) AS total FROM Empresa2.Tarifas ${where}`);
    const total = cntRes.recordset[0].total;
    const offset = (page - 1) * 10;
    const dr = pool.request().input('idCli', sql.Decimal(7), idCliente || null);
    if (q) dr.input('q', `%${q}%`);
    const dataRes = await dr.query(
      `SELECT ID_TARIFA,DESFLETE,FLETE,VENTA,MONVENTA,TIPOCAMBIO,KILOMETROS,RENTA,COSTOKILOMTS,COSTOAUTOPISTAS,FLAGIVA,FLAGRET
       FROM Empresa2.Tarifas ${where} ORDER BY DESFLETE
       OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`
    );
    res.json({ rows: dataRes.recordset, total, totalPages: Math.ceil(total/10)||1, page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lookup/camiones', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pool = await getPool();
    const where = `WHERE (TIPO IS NULL OR TIPO <> 'Remolque')` + (q ? ` AND (ID_CAMION LIKE @q OR DESCRIPCION LIKE @q OR PLACA LIKE @q)` : '');
    const cr = pool.request(); if (q) cr.input('q', `%${q}%`);
    const cnt = await cr.query(`SELECT COUNT(*) AS total FROM Empresa2.Camiones ${where}`);
    const total = cnt.recordset[0].total;
    const offset = (page - 1) * 10;
    const dr = pool.request(); if (q) dr.input('q', `%${q}%`);
    const data = await dr.query(
      `SELECT ID_CAMION,DESCRIPCION,PLACA,ID_OPERADOR,OPERADOR FROM Empresa2.Camiones ${where}
       ORDER BY ID_CAMION OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`
    );
    res.json({ rows: data.recordset, total, totalPages: Math.ceil(total/10)||1, page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lookup/remolques', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pool = await getPool();
    const where = `WHERE TIPO = 'Remolque'` + (q ? ` AND (ID_CAMION LIKE @q OR DESCRIPCION LIKE @q)` : '');
    const cr = pool.request(); if (q) cr.input('q', `%${q}%`);
    const cnt = await cr.query(`SELECT COUNT(*) AS total FROM Empresa2.Camiones ${where}`);
    const total = cnt.recordset[0].total;
    const offset = (page - 1) * 10;
    const dr = pool.request(); if (q) dr.input('q', `%${q}%`);
    const data = await dr.query(
      `SELECT ID_CAMION,DESCRIPCION FROM Empresa2.Camiones ${where}
       ORDER BY ID_CAMION OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`
    );
    res.json({ rows: data.recordset, total, totalPages: Math.ceil(total/10)||1, page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lookup/operadores', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pool = await getPool();
    const isNum = q && /^\d+$/.test(q);
    const where = q ? `WHERE OPERADOR LIKE @q OR RFC LIKE @q${isNum ? ' OR CAST(ID_OPERADOR AS NVARCHAR) = @qexact' : ''}` : '';
    const cr = pool.request(); if (q) cr.input('q', `%${q}%`); if (isNum) cr.input('qexact', q);
    const cnt = await cr.query(`SELECT COUNT(*) AS total FROM Empresa2.Operadores ${where}`);
    const total = cnt.recordset[0].total;
    const offset = (page - 1) * 10;
    const dr = pool.request(); if (q) dr.input('q', `%${q}%`); if (isNum) dr.input('qexact', q);
    const data = await dr.query(
      `SELECT ID_OPERADOR,OPERADOR,RFC,NOLICENCIA,STATUS FROM Empresa2.Operadores ${where}
       ORDER BY OPERADOR OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`
    );
    res.json({ rows: data.recordset, total, totalPages: Math.ceil(total/10)||1, page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lookup/domcarga', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const idCliente = parseInt(req.query.idCliente) || 0;
    const tipo = (req.query.tipo || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pool = await getPool();
    let where = `WHERE ID_CLIENTE = @idCli`;
    if (tipo) where += ` AND TIPO = @tipo`;
    if (q)    where += ` AND (DESCRIPCION LIKE @q OR CIUDAD LIKE @q)`;
    const cr = pool.request().input('idCli', sql.Decimal(7), idCliente);
    if (tipo) cr.input('tipo', sql.Char(10), tipo);
    if (q)    cr.input('q', `%${q}%`);
    const cnt = await cr.query(`SELECT COUNT(*) AS total FROM Empresa2.DomCarDes ${where}`);
    const total = cnt.recordset[0].total;
    const offset = (page - 1) * 10;
    const dr = pool.request().input('idCli', sql.Decimal(7), idCliente);
    if (tipo) dr.input('tipo', sql.Char(10), tipo);
    if (q)    dr.input('q', `%${q}%`);
    const data = await dr.query(
      `SELECT ID_DOMICILIO,DESCRIPCION,CIUDAD FROM Empresa2.DomCarDes ${where}
       ORDER BY DESCRIPCION OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`
    );
    res.json({ rows: data.recordset, total, totalPages: Math.ceil(total/10)||1, page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MERCANCIAS ────────────────────────────────────────────────────────────────
router.get('/mercancias', async (req, res) => {
  try {
    const pool = await getPool();
    const data = await pool.request()
      .input('serie', sql.VarChar(3), req.query.serie)
      .input('cp', sql.VarChar(30), req.query.cartaporte)
      .query(`SELECT * FROM Empresa2.PedMercancias WHERE Serie=@serie AND CartaPorte=@cp ORDER BY Id_Mercancia`);
    res.json(data.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/mercancias/guardar', async (req, res) => {
  const f = req.body;
  try {
    const pool = await getPool();
    if (f._mode === 'add') {
      const maxRes = await pool.request()
        .input('serie', sql.VarChar(3), f.Serie)
        .input('cp', sql.VarChar(30), f.CartaPorte)
        .query(`SELECT ISNULL(MAX(Id_Mercancia),0)+1 AS next FROM Empresa2.PedMercancias WHERE Serie=@serie AND CartaPorte=@cp`);
      const nextId = maxRes.recordset[0].next;
      await pool.request()
        .input('serie', sql.VarChar(3), f.Serie)
        .input('cp', sql.VarChar(30), f.CartaPorte)
        .input('id', sql.Decimal(3), nextId)
        .input('sku', sql.VarChar(25), f.SKU||null)
        .input('bt', sql.VarChar(20), f.BienesTransp||null)
        .input('desc', sql.VarChar(199), f.Descripcion||null)
        .input('desm', sql.VarChar(200), f.DesManual||null)
        .input('cant', sql.Decimal(14,6), f.Cantidad||null)
        .input('cu', sql.VarChar(20), f.ClaveUnidad||null)
        .input('uni', sql.VarChar(20), f.Unidad||null)
        .input('pu', sql.Decimal(7,2), f.PesoUnidad||null)
        .input('mp', sql.VarChar(3), f.MaterialPeligroso||'No')
        .input('cmp', sql.VarChar(20), f.CveMaterialPeligroso||null)
        .input('cem', sql.VarChar(10), f.cve_Embalaje||null)
        .input('dem', sql.VarChar(100), f.DescripEmbalaje||null)
        .input('pek', sql.Decimal(9,3), f.PesoEnKg||null)
        .input('vm', sql.Decimal(13,6), f.ValorMercancia||null)
        .input('mon', sql.VarChar(4), f.Moneda||null)
        .query(`INSERT INTO Empresa2.PedMercancias(Serie,CartaPorte,Id_Mercancia,SKU,BienesTransp,Descripcion,DesManual,Cantidad,ClaveUnidad,Unidad,PesoUnidad,MaterialPeligroso,CveMaterialPeligroso,cve_Embalaje,DescripEmbalaje,PesoEnKg,ValorMercancia,Moneda)
          VALUES(@serie,@cp,@id,@sku,@bt,@desc,@desm,@cant,@cu,@uni,@pu,@mp,@cmp,@cem,@dem,@pek,@vm,@mon)`);
    } else {
      await pool.request()
        .input('serie', sql.VarChar(3), f.Serie)
        .input('cp', sql.VarChar(30), f.CartaPorte)
        .input('id', sql.Decimal(3), f.Id_Mercancia)
        .input('sku', sql.VarChar(25), f.SKU||null)
        .input('bt', sql.VarChar(20), f.BienesTransp||null)
        .input('desc', sql.VarChar(199), f.Descripcion||null)
        .input('desm', sql.VarChar(200), f.DesManual||null)
        .input('cant', sql.Decimal(14,6), f.Cantidad||null)
        .input('cu', sql.VarChar(20), f.ClaveUnidad||null)
        .input('uni', sql.VarChar(20), f.Unidad||null)
        .input('pu', sql.Decimal(7,2), f.PesoUnidad||null)
        .input('mp', sql.VarChar(3), f.MaterialPeligroso||'No')
        .input('cmp', sql.VarChar(20), f.CveMaterialPeligroso||null)
        .input('cem', sql.VarChar(10), f.cve_Embalaje||null)
        .input('dem', sql.VarChar(100), f.DescripEmbalaje||null)
        .input('pek', sql.Decimal(9,3), f.PesoEnKg||null)
        .input('vm', sql.Decimal(13,6), f.ValorMercancia||null)
        .input('mon', sql.VarChar(4), f.Moneda||null)
        .query(`UPDATE Empresa2.PedMercancias SET SKU=@sku,BienesTransp=@bt,Descripcion=@desc,DesManual=@desm,Cantidad=@cant,ClaveUnidad=@cu,Unidad=@uni,PesoUnidad=@pu,MaterialPeligroso=@mp,CveMaterialPeligroso=@cmp,cve_Embalaje=@cem,DescripEmbalaje=@dem,PesoEnKg=@pek,ValorMercancia=@vm,Moneda=@mon
          WHERE Serie=@serie AND CartaPorte=@cp AND Id_Mercancia=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/mercancias/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('serie', sql.VarChar(3), req.body.Serie)
      .input('cp', sql.VarChar(30), req.body.CartaPorte)
      .input('id', sql.Decimal(3), req.body.Id_Mercancia)
      .query(`DELETE FROM Empresa2.PedMercancias WHERE Serie=@serie AND CartaPorte=@cp AND Id_Mercancia=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DEPÓSITOS ─────────────────────────────────────────────────────────────────
router.get('/depositos', async (req, res) => {
  try {
    const pool = await getPool();
    const data = await pool.request()
      .input('serie', sql.VarChar(3), req.query.serie)
      .input('cp', sql.VarChar(30), req.query.cartaporte)
      .query(`SELECT * FROM Empresa2.DepoSolicitud WHERE Serie=@serie AND CartaPorte=@cp ORDER BY Id_DepoSol`);
    res.json(data.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/depositos/guardar', async (req, res) => {
  const f = req.body;
  try {
    const pool = await getPool();
    const hoy = new Date().toISOString().slice(0,10);
    const num = v => (v === '' || v == null) ? null : parseFloat(v);
    if (f._mode === 'add') {
      const maxRes = await pool.request()
        .query(`SELECT ISNULL(MAX(Id_DepoSol),0)+1 AS next FROM Empresa2.DepoSolicitud`);
      const nextId = maxRes.recordset[0].next;
      await pool.request()
        .input('id',      sql.Decimal(9),   nextId)
        .input('fecha',   sql.Date,          f.Fecha||hoy)
        .input('turno',   sql.VarChar(20),   f.Turno||null)
        .input('idOp',    sql.Decimal(7),    f.ID_OPERADOR||null)
        .input('operador',sql.VarChar(45),   f.OPERADOR||null)
        .input('serie',   sql.VarChar(3),    f.Serie)
        .input('cp',      sql.VarChar(30),   f.CartaPorte)
        .input('origen',  sql.VarChar(50),   f.Origen||null)
        .input('destino', sql.VarChar(50),   f.Destino||null)
        .input('folio',   sql.VarChar(20),   f.Folio||null)
        .input('prestamo',sql.Decimal(8,2),  num(f.Prestamo))
        .input('tal',     sql.Decimal(8,2),  num(f.Talachas))
        .input('lla',     sql.Decimal(8,2),  num(f.Llantas))
        .input('die',     sql.Decimal(8,2),  num(f.Diesel))
        .input('cas',     sql.Decimal(8,2),  num(f.Casetas))
        .input('com',     sql.Decimal(8,2),  num(f.Comidas))
        .input('man',     sql.Decimal(8,2),  num(f.Maniobra))
        .input('bas',     sql.Decimal(8,2),  num(f.Bascula))
        .input('pen',     sql.Decimal(8,1),  num(f.Pension))
        .input('ref',     sql.Decimal(8,2),  num(f.Refacciones))
        .input('otros',   sql.Decimal(8,2),  num(f.Otros))
        .input('desOtros',sql.VarChar(255),  f.DesOtros||null)
        .input('monto',   sql.Decimal(10,2), num(f.Monto))
        .input('obs',     sql.VarChar(499),  f.Observaciones||null)
        .input('who',     sql.VarChar(79),   f.WhoCaptura||null)
        .input('fechaCap',sql.Date,          hoy)
        .input('aut',     sql.Int,           num(f.Autorizado))
        .query(`INSERT INTO Empresa2.DepoSolicitud(Id_DepoSol,Fecha,Turno,ID_OPERADOR,OPERADOR,Serie,CartaPorte,Origen,Destino,Folio,Prestamo,Talachas,Llantas,Diesel,Casetas,Comidas,Maniobra,Bascula,Pension,Refacciones,Otros,DesOtros,Monto,Observaciones,WhoCaptura,FechaCaptura,Autorizado)
          VALUES(@id,@fecha,@turno,@idOp,@operador,@serie,@cp,@origen,@destino,@folio,@prestamo,@tal,@lla,@die,@cas,@com,@man,@bas,@pen,@ref,@otros,@desOtros,@monto,@obs,@who,@fechaCap,@aut)`);
    } else {
      await pool.request()
        .input('id',      sql.Decimal(9),   f.Id_DepoSol)
        .input('fecha',   sql.Date,          f.Fecha||hoy)
        .input('turno',   sql.VarChar(20),   f.Turno||null)
        .input('idOp',    sql.Decimal(7),    f.ID_OPERADOR||null)
        .input('operador',sql.VarChar(45),   f.OPERADOR||null)
        .input('origen',  sql.VarChar(50),   f.Origen||null)
        .input('destino', sql.VarChar(50),   f.Destino||null)
        .input('folio',   sql.VarChar(20),   f.Folio||null)
        .input('prestamo',sql.Decimal(8,2),  num(f.Prestamo))
        .input('tal',     sql.Decimal(8,2),  num(f.Talachas))
        .input('lla',     sql.Decimal(8,2),  num(f.Llantas))
        .input('die',     sql.Decimal(8,2),  num(f.Diesel))
        .input('cas',     sql.Decimal(8,2),  num(f.Casetas))
        .input('com',     sql.Decimal(8,2),  num(f.Comidas))
        .input('man',     sql.Decimal(8,2),  num(f.Maniobra))
        .input('bas',     sql.Decimal(8,2),  num(f.Bascula))
        .input('pen',     sql.Decimal(8,1),  num(f.Pension))
        .input('ref',     sql.Decimal(8,2),  num(f.Refacciones))
        .input('otros',   sql.Decimal(8,2),  num(f.Otros))
        .input('desOtros',sql.VarChar(255),  f.DesOtros||null)
        .input('monto',   sql.Decimal(10,2), num(f.Monto))
        .input('obs',     sql.VarChar(499),  f.Observaciones||null)
        .input('whoMod',  sql.VarChar(79),   f.WhoModifica||null)
        .input('aut',     sql.Int,           num(f.Autorizado))
        .query(`UPDATE Empresa2.DepoSolicitud SET Fecha=@fecha,Turno=@turno,ID_OPERADOR=@idOp,OPERADOR=@operador,Origen=@origen,Destino=@destino,Folio=@folio,Prestamo=@prestamo,Talachas=@tal,Llantas=@lla,Diesel=@die,Casetas=@cas,Comidas=@com,Maniobra=@man,Bascula=@bas,Pension=@pen,Refacciones=@ref,Otros=@otros,DesOtros=@desOtros,Monto=@monto,Observaciones=@obs,WhoModifica=@whoMod,Autorizado=@aut WHERE Id_DepoSol=@id`);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/depositos/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Decimal(9), req.body.Id_DepoSol)
      .query(`DELETE FROM Empresa2.DepoSolicitud WHERE Id_DepoSol=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GUARDAR CartaPorte ────────────────────────────────────────────────────────
router.post('/guardar', async (req, res) => {
  const f = req.body;
  const hoy = new Date().toISOString().slice(0,10);
  const num  = v => (v === '' || v == null) ? null : parseFloat(v);
  const flag = v => (v === true || v === 'true' || v === 1 || v === '1') ? 1 : 0;
  try {
    const pool = await getPool();
    const serie = req.session.usuario.serie;

    if (f._mode === 'add') {
      const maxRes = await pool.request()
        .input('serie', sql.VarChar(3), serie)
        .query(`SELECT ISNULL(MAX(Id_Pedido),0)+1 AS next FROM Empresa2.CartaPorte WHERE Serie=@serie`);
      const idPedido = maxRes.recordset[0].next;
      const cartaPorte = serie.trim() + String(idPedido).padStart(7, '0');

      await pool.request()
        .input('serie',    sql.VarChar(3),   serie)
        .input('idPed',    sql.Decimal(9),   idPedido)
        .input('cp',       sql.VarChar(30),  cartaPorte)
        .input('fechaPed', sql.Date,         f.FechaPedido || hoy)
        .input('fechaCap', sql.Date,         hoy)
        .input('realizo',  sql.VarChar(60),  req.session.usuario.nombre)
        .input('anio',     sql.Decimal(4),   req.session.anio)
        .input('fehcaCar', sql.Date,         f.FehcaCarga||null)
        .input('horaCar',  sql.DateTime,     f.HoraCarga ? new Date(`${f.FehcaCarga}T${f.HoraCarga}`) : null)
        .input('fechaDes', sql.Date,         f.FechaDesCarta||null)
        .input('horaDes',  sql.DateTime,     f.FechaDesCarta && f.HorarioDesCarta ? new Date(`${f.FechaDesCarta}T${f.HorarioDesCarta}`) : null)
        .input('idCli',    sql.Decimal(7),   num(f.Id_Cliente))
        .input('nCli',     sql.VarChar(80),  f.NombreComunCli||null)
        .input('idCliEnt', sql.Decimal(7),   num(f.Id_ClienteEnt))
        .input('cliEnt',   sql.VarChar(80),  f.ClienteEnt||null)
        .input('idCliCar', sql.Decimal(7),   num(f.Id_ClienteCarga))
        .input('cliCar',   sql.VarChar(80),  f.ClienteCarga||null)
        .input('booking',  sql.VarChar(20),  f.Booking||null)
        .input('noRainde', sql.VarChar(20),  f.NoRainde||null)
        .input('idTar',    sql.Decimal(7),   num(f.Id_Tarifa))
        .input('desFlete', sql.VarChar(80),  f.DesFlete||null)
        .input('idCam',    sql.VarChar(10),  f.Id_Camion||null)
        .input('noCam',    sql.VarChar(25),  f.NoCamion||null)
        .input('placa',    sql.VarChar(20),  f.NoPlacas||null)
        .input('noCaja',   sql.VarChar(10),  f.NoCaja||null)
        .input('noCaja2',  sql.VarChar(10),  f.NoCaja2||null)
        .input('idOp',     sql.Int,          num(f.Id_Operador))
        .input('oper',     sql.VarChar(80),  f.Operador||null)
        .input('idDomC',   sql.Decimal(3),   num(f.Id_DomCarga))
        .input('domC',     sql.VarChar(80),  f.DomCarga||null)
        .input('idDomD',   sql.Decimal(3),   num(f.Id_DomDescarga1))
        .input('domD',     sql.VarChar(80),  f.DomDescarga||null)
        .input('cFlete',   sql.Decimal(9,2), num(f.CostoFlete))
        .input('cMan',     sql.Decimal(9,2), num(f.CostoManiobras))
        .input('cDem',     sql.Decimal(9,2), num(f.CostoDemoras))
        .input('cAuto',    sql.Decimal(9,2), num(f.CostoAutopistas))
        .input('cDob',     sql.Decimal(9,2), num(f.CostoDobOpe))
        .input('cDis',     sql.Decimal(9,2), num(f.CostoDisel))
        .input('noPar',    sql.Decimal(3),   num(f.NoParadas))
        .input('cPar',     sql.Decimal(9,2), num(f.CostoParada))
        .input('cOtros',   sql.Decimal(9,2), num(f.CostosOtros))
        .input('desOtros', sql.VarChar(255), f.DesOtrosCostos||null)
        .input('cExtra',   sql.Decimal(9,2), num(f.CargoExtraTrans))
        .input('km',       sql.Decimal(10,2),num(f.Kilometros))
        .input('kmTar',    sql.Decimal(7),   num(f.KilometrosTar))
        .input('retenK',   sql.Decimal(7,2), num(f.RetenKilo))
        .input('moneda',   sql.VarChar(10),  f.c_Moneda||null)
        .input('tc',       sql.Decimal(7,2), num(f.TipoCambio))
        .input('fCobMan',  sql.TinyInt,      flag(f.FlagCobMan))
        .input('fCobDem',  sql.TinyInt,      flag(f.FlagCobDem))
        .input('fCobAut',  sql.TinyInt,      flag(f.FlagCobAuto))
        .input('fCobDO',   sql.TinyInt,      flag(f.FlagCobDO))
        .input('fConDis',  sql.TinyInt,      flag(f.FlagConDis))
        .input('fCobPar',  sql.TinyInt,      flag(f.FlagCobParada))
        .input('fCobOtr',  sql.TinyInt,      flag(f.FlagCobOtros))
        .input('fCobCE',   sql.TinyInt,      flag(f.FlagCobCE))
        .input('fIVA',     sql.TinyInt,      flag(f.FlagIVA))
        .input('fRet',     sql.TinyInt,      flag(f.FlagRet))
        .input('subMX',    sql.Decimal(9,2), num(f.SubTotalMX))
        .input('porIVA',   sql.Decimal(3),   num(f.PorIVAMX)||16)
        .input('ivaMX',    sql.Decimal(9,2), num(f.IVAMX))
        .input('retenMX',  sql.Decimal(9,2), num(f.RetenMX))
        .input('totMX',    sql.Decimal(9,2), num(f.TOTALMX))
        .input('subUSD',   sql.Decimal(9,2), num(f.SubTotalUSD))
        .input('porIVAU',  sql.Decimal(3),   num(f.PorIVAUSD)||16)
        .input('ivaUSD',   sql.Decimal(9,2), num(f.IVAUSD))
        .input('retenUSD', sql.Decimal(9,2), num(f.RetenUSD))
        .input('totUSD',   sql.Decimal(9,2), num(f.TOTALUSD))
        .input('cPrest',   sql.Decimal(9,2), num(f.CostoPrestamo))
        .input('cTal',     sql.Decimal(9,2), num(f.CostoTalacha))
        .input('cLla',     sql.Decimal(9,2), num(f.CostoCompllanta))
        .input('cDiesel',  sql.Decimal(9,2), num(f.CostoDiesel))
        .input('cCas',     sql.Decimal(9,2), num(f.CostoCasetas))
        .input('cCom',     sql.Decimal(9,2), num(f.CostoComidas))
        .input('cManExt',  sql.Decimal(9,2), num(f.CostoManiobrasExt))
        .input('cBas',     sql.Decimal(9,2), num(f.CostoBascula))
        .input('cPen',     sql.Decimal(9,2), num(f.CostoPension))
        .input('cRef',     sql.Decimal(9,2), num(f.CostoRefacciones))
        .input('cOtrosOp', sql.Decimal(9,2), num(f.CostoOtros))
        .input('status',   sql.VarChar(20),  f.Status||null)
        .input('obs',      sql.VarChar(255), f.Observaciones||null)
        .input('booking2', sql.VarChar(20),  f.Booking||null)
        .input('cont',     sql.VarChar(20),  f.Contenedor||null)
        .query(`INSERT INTO Empresa2.CartaPorte(
          Serie,Id_Pedido,CartaPorte,FechaPedido,FechaCaptura,RealizoPedido,AnioFactura,
          FehcaCarga,HoraCarga,FechaDesCarta,HorarioDesCarta,
          Id_Cliente,NombreComunCli,Id_ClienteEnt,ClienteEnt,Id_ClienteCarga,ClienteCarga,
          NoPedidoCliente,NoRainde,Id_Tarifa,DesFlete,
          Id_Camion,NoCamion,NoPlacas,NoCaja,NoCaja2,Id_Operador,Operador,
          Id_DomCarga,DomCarga,Id_DomDescarga1,DomDescarga,
          CostoFlete,CostoManiobras,CostoDemoras,CostoAutopistas,CostoDobOpe,CostoDisel,
          NoParadas,CostoParada,CostosOtros,DesOtrosCostos,CargoExtraTrans,
          Kilometros,KilometrosTar,RetenKilo,c_Moneda,TipoCambio,
          FlagCobMan,FlagCobDem,FlagCobAuto,FlagCobDO,FlagConDis,FlagCobParada,FlagCobOtros,FlagCobCE,
          FlagIVA,FlagRet,SubTotalMX,PorIVAMX,IVAMX,RetenMX,TOTALMX,
          SubTotalUSD,PorIVAUSD,IVAUSD,RetenUSD,TOTALUSD,
          CostoPrestamo,CostoTalacha,CostoCompllanta,CostoDiesel,CostoCasetas,CostoComidas,
          CostoManiobrasExt,CostoBascula,CostoPension,CostoRefacciones,CostoOtros,
          Status,Observaciones,Booking,Contenedor
        ) VALUES(
          @serie,@idPed,@cp,@fechaPed,@fechaCap,@realizo,@anio,
          @fehcaCar,@horaCar,@fechaDes,@horaDes,
          @idCli,@nCli,@idCliEnt,@cliEnt,@idCliCar,@cliCar,
          @booking,@noRainde,@idTar,@desFlete,
          @idCam,@noCam,@placa,@noCaja,@noCaja2,@idOp,@oper,
          @idDomC,@domC,@idDomD,@domD,
          @cFlete,@cMan,@cDem,@cAuto,@cDob,@cDis,
          @noPar,@cPar,@cOtros,@desOtros,@cExtra,
          @km,@kmTar,@retenK,@moneda,@tc,
          @fCobMan,@fCobDem,@fCobAut,@fCobDO,@fConDis,@fCobPar,@fCobOtr,@fCobCE,
          @fIVA,@fRet,@subMX,@porIVA,@ivaMX,@retenMX,@totMX,
          @subUSD,@porIVAU,@ivaUSD,@retenUSD,@totUSD,
          @cPrest,@cTal,@cLla,@cDiesel,@cCas,@cCom,@cManExt,@cBas,@cPen,@cRef,@cOtrosOp,
          @status,@obs,@booking2,@cont
        )`);
      res.json({ ok: true, CartaPorte: cartaPorte, Serie: serie });
    } else {
      await pool.request()
        .input('serie',    sql.VarChar(3),   f.Serie||serie)
        .input('cp',       sql.VarChar(30),  f.CartaPorte)
        .input('fehcaCar', sql.Date,         f.FehcaCarga||null)
        .input('horaCar',  sql.DateTime,     f.FehcaCarga && f.HoraCarga ? new Date(`${f.FehcaCarga}T${f.HoraCarga}`) : null)
        .input('fechaDes', sql.Date,         f.FechaDesCarta||null)
        .input('horaDes',  sql.DateTime,     f.FechaDesCarta && f.HorarioDesCarta ? new Date(`${f.FechaDesCarta}T${f.HorarioDesCarta}`) : null)
        .input('idCli',    sql.Decimal(7),   num(f.Id_Cliente))
        .input('nCli',     sql.VarChar(80),  f.NombreComunCli||null)
        .input('idCliEnt', sql.Decimal(7),   num(f.Id_ClienteEnt))
        .input('cliEnt',   sql.VarChar(80),  f.ClienteEnt||null)
        .input('idCliCar', sql.Decimal(7),   num(f.Id_ClienteCarga))
        .input('cliCar',   sql.VarChar(80),  f.ClienteCarga||null)
        .input('booking',  sql.VarChar(20),  f.Booking||null)
        .input('noRainde', sql.VarChar(20),  f.NoRainde||null)
        .input('idTar',    sql.Decimal(7),   num(f.Id_Tarifa))
        .input('desFlete', sql.VarChar(80),  f.DesFlete||null)
        .input('idCam',    sql.VarChar(10),  f.Id_Camion||null)
        .input('noCam',    sql.VarChar(25),  f.NoCamion||null)
        .input('placa',    sql.VarChar(20),  f.NoPlacas||null)
        .input('noCaja',   sql.VarChar(10),  f.NoCaja||null)
        .input('noCaja2',  sql.VarChar(10),  f.NoCaja2||null)
        .input('idOp',     sql.Int,          num(f.Id_Operador))
        .input('oper',     sql.VarChar(80),  f.Operador||null)
        .input('idDomC',   sql.Decimal(3),   num(f.Id_DomCarga))
        .input('domC',     sql.VarChar(80),  f.DomCarga||null)
        .input('idDomD',   sql.Decimal(3),   num(f.Id_DomDescarga1))
        .input('domD',     sql.VarChar(80),  f.DomDescarga||null)
        .input('cFlete',   sql.Decimal(9,2), num(f.CostoFlete))
        .input('cMan',     sql.Decimal(9,2), num(f.CostoManiobras))
        .input('cDem',     sql.Decimal(9,2), num(f.CostoDemoras))
        .input('cAuto',    sql.Decimal(9,2), num(f.CostoAutopistas))
        .input('cDob',     sql.Decimal(9,2), num(f.CostoDobOpe))
        .input('cDis',     sql.Decimal(9,2), num(f.CostoDisel))
        .input('noPar',    sql.Decimal(3),   num(f.NoParadas))
        .input('cPar',     sql.Decimal(9,2), num(f.CostoParada))
        .input('cOtros',   sql.Decimal(9,2), num(f.CostosOtros))
        .input('desOtros', sql.VarChar(255), f.DesOtrosCostos||null)
        .input('cExtra',   sql.Decimal(9,2), num(f.CargoExtraTrans))
        .input('km',       sql.Decimal(10,2),num(f.Kilometros))
        .input('kmTar',    sql.Decimal(7),   num(f.KilometrosTar))
        .input('retenK',   sql.Decimal(7,2), num(f.RetenKilo))
        .input('moneda',   sql.VarChar(10),  f.c_Moneda||null)
        .input('tc',       sql.Decimal(7,2), num(f.TipoCambio))
        .input('fCobMan',  sql.TinyInt,      flag(f.FlagCobMan))
        .input('fCobDem',  sql.TinyInt,      flag(f.FlagCobDem))
        .input('fCobAut',  sql.TinyInt,      flag(f.FlagCobAuto))
        .input('fCobDO',   sql.TinyInt,      flag(f.FlagCobDO))
        .input('fConDis',  sql.TinyInt,      flag(f.FlagConDis))
        .input('fCobPar',  sql.TinyInt,      flag(f.FlagCobParada))
        .input('fCobOtr',  sql.TinyInt,      flag(f.FlagCobOtros))
        .input('fCobCE',   sql.TinyInt,      flag(f.FlagCobCE))
        .input('fIVA',     sql.TinyInt,      flag(f.FlagIVA))
        .input('fRet',     sql.TinyInt,      flag(f.FlagRet))
        .input('subMX',    sql.Decimal(9,2), num(f.SubTotalMX))
        .input('porIVA',   sql.Decimal(3),   num(f.PorIVAMX)||16)
        .input('ivaMX',    sql.Decimal(9,2), num(f.IVAMX))
        .input('retenMX',  sql.Decimal(9,2), num(f.RetenMX))
        .input('totMX',    sql.Decimal(9,2), num(f.TOTALMX))
        .input('subUSD',   sql.Decimal(9,2), num(f.SubTotalUSD))
        .input('porIVAU',  sql.Decimal(3),   num(f.PorIVAUSD)||16)
        .input('ivaUSD',   sql.Decimal(9,2), num(f.IVAUSD))
        .input('retenUSD', sql.Decimal(9,2), num(f.RetenUSD))
        .input('totUSD',   sql.Decimal(9,2), num(f.TOTALUSD))
        .input('cPrest',   sql.Decimal(9,2), num(f.CostoPrestamo))
        .input('cTal',     sql.Decimal(9,2), num(f.CostoTalacha))
        .input('cLla',     sql.Decimal(9,2), num(f.CostoCompllanta))
        .input('cDiesel',  sql.Decimal(9,2), num(f.CostoDiesel))
        .input('cCas',     sql.Decimal(9,2), num(f.CostoCasetas))
        .input('cCom',     sql.Decimal(9,2), num(f.CostoComidas))
        .input('cManExt',  sql.Decimal(9,2), num(f.CostoManiobrasExt))
        .input('cBas',     sql.Decimal(9,2), num(f.CostoBascula))
        .input('cPen',     sql.Decimal(9,2), num(f.CostoPension))
        .input('cRef',     sql.Decimal(9,2), num(f.CostoRefacciones))
        .input('cOtrosOp', sql.Decimal(9,2), num(f.CostoOtros))
        .input('status',   sql.VarChar(20),  f.Status||null)
        .input('obs',      sql.VarChar(255), f.Observaciones||null)
        .input('booking2', sql.VarChar(20),  f.Booking||null)
        .input('cont',     sql.VarChar(20),  f.Contenedor||null)
        .input('whoMod',   sql.VarChar(60),  req.session.usuario.nombre)
        .query(`UPDATE Empresa2.CartaPorte SET
          FehcaCarga=@fehcaCar,HoraCarga=@horaCar,FechaDesCarta=@fechaDes,HorarioDesCarta=@horaDes,
          Id_Cliente=@idCli,NombreComunCli=@nCli,Id_ClienteEnt=@idCliEnt,ClienteEnt=@cliEnt,
          Id_ClienteCarga=@idCliCar,ClienteCarga=@cliCar,
          NoPedidoCliente=@booking,NoRainde=@noRainde,Id_Tarifa=@idTar,DesFlete=@desFlete,
          Id_Camion=@idCam,NoCamion=@noCam,NoPlacas=@placa,NoCaja=@noCaja,NoCaja2=@noCaja2,
          Id_Operador=@idOp,Operador=@oper,Id_DomCarga=@idDomC,DomCarga=@domC,
          Id_DomDescarga1=@idDomD,DomDescarga=@domD,
          CostoFlete=@cFlete,CostoManiobras=@cMan,CostoDemoras=@cDem,CostoAutopistas=@cAuto,
          CostoDobOpe=@cDob,CostoDisel=@cDis,NoParadas=@noPar,CostoParada=@cPar,
          CostosOtros=@cOtros,DesOtrosCostos=@desOtros,CargoExtraTrans=@cExtra,
          Kilometros=@km,KilometrosTar=@kmTar,RetenKilo=@retenK,c_Moneda=@moneda,TipoCambio=@tc,
          FlagCobMan=@fCobMan,FlagCobDem=@fCobDem,FlagCobAuto=@fCobAut,FlagCobDO=@fCobDO,
          FlagConDis=@fConDis,FlagCobParada=@fCobPar,FlagCobOtros=@fCobOtr,FlagCobCE=@fCobCE,
          FlagIVA=@fIVA,FlagRet=@fRet,SubTotalMX=@subMX,PorIVAMX=@porIVA,IVAMX=@ivaMX,
          RetenMX=@retenMX,TOTALMX=@totMX,SubTotalUSD=@subUSD,PorIVAUSD=@porIVAU,IVAUSD=@ivaUSD,
          RetenUSD=@retenUSD,TOTALUSD=@totUSD,
          CostoPrestamo=@cPrest,CostoTalacha=@cTal,CostoCompllanta=@cLla,CostoDiesel=@cDiesel,
          CostoCasetas=@cCas,CostoComidas=@cCom,CostoManiobrasExt=@cManExt,CostoBascula=@cBas,
          CostoPension=@cPen,CostoRefacciones=@cRef,CostoOtros=@cOtrosOp,
          Status=@status,Observaciones=@obs,Booking=@booking2,Contenedor=@cont,WhoModifica=@whoMod
          WHERE Serie=@serie AND CartaPorte=@cp`);
      res.json({ ok: true });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ELIMINAR CartaPorte ───────────────────────────────────────────────────────
router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('serie', sql.VarChar(3), req.body.Serie)
      .input('cp',    sql.VarChar(30), req.body.CartaPorte)
      .query(`DELETE FROM Empresa2.CartaPorte WHERE Serie=@serie AND CartaPorte=@cp`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
