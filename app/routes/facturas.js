const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');

// La clave real de una factura es el par (SerieFac, Id_NoFactura) — la tabla
// Empresa2.Factura NO tiene ningún índice/PK, y SerieFac normalmente viene
// vacía, así que Id_NoFactura por sí solo SE REPITE entre distintas series
// (confirmado contra datos reales: existían dos filas con Id_NoFactura=1,
// una con SerieFac NULL y otra con una serie distinta). Toda consulta sobre
// Factura o FacDeta debe ir scopeada por ambos campos, nunca solo por el ID.
const serieKey = v => { const t = (v == null ? '' : String(v)).trim(); return t || null; };

const hoy = () => new Date().toISOString().slice(0, 10);
const num = v => (v === '' || v == null || isNaN(parseFloat(v))) ? 0 : parseFloat(v);
const trim = v => (v == null ? '' : String(v).trim());

function reqSerieFac(r, serieFac) {
  return r.input('serieFac', sql.VarChar(20), serieKey(serieFac));
}
const SERIEFAC_EQ = `ISNULL(LTRIM(RTRIM(SerieFac)),'') = ISNULL(@serieFac,'')`;

// ── Transacciones ─────────────────────────────────────────────────────────────
async function withTransaction(pool, fn) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch (_) { /* la tx ya pudo cerrarse */ }
    throw err;
  }
}

// ── Recalcular totales de cabecera a partir de las líneas (punto 5) ────────────
async function recalcularCabecera(tx, idNoFactura, serieFac) {
  const cabRes = await reqSerieFac(new sql.Request(tx), serieFac)
    .input('id', sql.Decimal(9), idNoFactura)
    .query(`SELECT FlagResFac FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);
  if (!cabRes.recordset[0]) throw new Error('Factura no encontrada al recalcular.');
  const flagResFac = cabRes.recordset[0].FlagResFac === 1;

  const sumRes = await reqSerieFac(new sql.Request(tx), serieFac)
    .input('id', sql.Decimal(9), idNoFactura)
    .query(`SELECT ISNULL(SUM(SUBTOTAL),0) subtotal, ISNULL(SUM(IVA),0) ivaL, ISNULL(SUM(RETEN),0) retenL, ISNULL(SUM(TOTAL),0) totalL
            FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND ${SERIEFAC_EQ}`);
  const s = sumRes.recordset[0];
  const subtotal = Math.round(s.subtotal * 100) / 100;
  let iva, reten, total;
  if (flagResFac) {
    iva   = Math.round(subtotal * 0.16 * 100) / 100;
    reten = Math.round(subtotal * 0.04 * 100) / 100;
    total = Math.round((subtotal + iva - reten) * 100) / 100;
  } else {
    iva   = Math.round(s.ivaL * 100) / 100;
    reten = Math.round(s.retenL * 100) / 100;
    total = Math.round(s.totalL * 100) / 100;
  }

  await reqSerieFac(new sql.Request(tx), serieFac)
    .input('id', sql.Decimal(9), idNoFactura)
    .input('sub', sql.Decimal(11,2), subtotal)
    .input('iva', sql.Decimal(11,2), iva)
    .input('ret', sql.Decimal(11,2), reten)
    .input('tot', sql.Decimal(11,2), total)
    .query(`UPDATE Empresa2.Factura SET SubTotal=@sub, IVA=@iva, Retencion=@ret, TOTAL=@tot WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);

  return { SubTotal: subtotal, IVA: iva, Retencion: reten, TOTAL: total };
}

// ── Recalcular ImporteFac acumulado de una Carta Porte (líneas activas no canceladas) ─
async function recalcularImporteFacCP(tx, serie, cartaporte) {
  const r = await new sql.Request(tx)
    .input('serie', sql.VarChar(3), serie)
    .input('cp', sql.VarChar(30), cartaporte)
    .query(`SELECT ISNULL(SUM(fd.TOTAL),0) importe, COUNT(*) lineas
            FROM Empresa2.FacDeta fd
            JOIN Empresa2.Factura f
              ON f.Id_NoFactura = fd.ID_NOFACTURA
             AND ISNULL(LTRIM(RTRIM(f.SerieFac)),'') = ISNULL(LTRIM(RTRIM(fd.SerieFac)),'')
            WHERE LTRIM(RTRIM(fd.SERIE))=@serie AND LTRIM(RTRIM(fd.CARTAPORTE))=@cp AND f.Status <> 'CANCELADA'`);
  const { importe, lineas } = r.recordset[0];
  if (lineas === 0) {
    await new sql.Request(tx)
      .input('serie', sql.VarChar(3), serie).input('cp', sql.VarChar(30), cartaporte)
      .query(`UPDATE Empresa2.CartaPorte SET Status='EMITIDO', NoFactura=NULL, AnioFactura=NULL, ImporteFac=0 WHERE Serie=@serie AND CartaPorte=@cp`);
  } else {
    await new sql.Request(tx)
      .input('serie', sql.VarChar(3), serie).input('cp', sql.VarChar(30), cartaporte)
      .input('imp', sql.Decimal(11,2), Math.round(importe * 100) / 100)
      .query(`UPDATE Empresa2.CartaPorte SET ImporteFac=@imp WHERE Serie=@serie AND CartaPorte=@cp`);
  }
}

// ── Montos "cobrables" ya facturados en líneas previas no canceladas de esa CP ─
const CONCEPTOS = {
  flete:     { montoCol: 'COSTOFLETE',      flagCol: 'FlagCobFlete' },
  demoras:   { montoCol: 'COSTODEMORAS',    flagCol: 'FLAGCOBDEM' },
  kilometros:{ montoCol: 'KILOMETROS',      flagCol: 'FLAGKILOMETROS' },
  casetas:   { montoCol: 'COSTOAUTOPISTAS', flagCol: 'FLAGCOBAUTO' },
  maniobras: { montoCol: 'COSTOMANIOBRAS',  flagCol: 'FLAGCOBMAN' },
  pension:   { montoCol: 'CostoPension',    flagCol: 'FlagCostoPension' },
  estadias:  { montoCol: 'CostoEstadias',   flagCol: 'FlagCostoEstadias' },
  otros:     { montoCol: 'COSTOSOTROS',     flagCol: 'FLAGCOBOTROS' },
};

async function yaFacturadoPorConcepto(tx, serie, cartaporte, excluir) {
  const partes = Object.entries(CONCEPTOS).map(([k, c]) =>
    `ISNULL(SUM(CASE WHEN ISNULL(fd.${c.flagCol},0)=1 THEN fd.${c.montoCol} ELSE 0 END),0) AS ${k}`
  ).join(', ');
  const req = new sql.Request(tx)
    .input('serie', sql.VarChar(3), serie)
    .input('cp', sql.VarChar(30), cartaporte);
  let excl = '';
  if (excluir != null) {
    req.input('exclF', sql.Decimal(9), excluir.idNoFactura)
       .input('exclD', sql.Decimal(6), excluir.idNoDetaFac)
       .input('exclS', sql.VarChar(20), serieKey(excluir.serieFac));
    excl = ` AND NOT (fd.ID_NOFACTURA=@exclF AND fd.ID_NODETAFAC=@exclD AND ISNULL(LTRIM(RTRIM(fd.SerieFac)),'')=ISNULL(@exclS,''))`;
  }
  const r = await req.query(`
    SELECT ${partes}
    FROM Empresa2.FacDeta fd
    JOIN Empresa2.Factura f
      ON f.Id_NoFactura = fd.ID_NOFACTURA
     AND ISNULL(LTRIM(RTRIM(f.SerieFac)),'') = ISNULL(LTRIM(RTRIM(fd.SerieFac)),'')
    WHERE LTRIM(RTRIM(fd.SERIE))=@serie AND LTRIM(RTRIM(fd.CARTAPORTE))=@cp AND f.Status <> 'CANCELADA'${excl}`);
  return r.recordset[0];
}

// ── Montos cobrables reportados en Solicitudes de Depósito del viaje (punto 3/6) ─
async function cobrableDepositos(tx, serie, cartaporte) {
  const r = await new sql.Request(tx)
    .input('serie', sql.VarChar(3), serie)
    .input('cp', sql.VarChar(30), cartaporte)
    .query(`SELECT
        ISNULL(SUM(CASE WHEN FlagCobCaseta=1 THEN Casetas  ELSE 0 END),0) AS casetas,
        ISNULL(SUM(CASE WHEN FlagCobMan=1    THEN Maniobra ELSE 0 END),0) AS maniobras,
        ISNULL(SUM(CASE WHEN FlagCobPen=1    THEN Pension  ELSE 0 END),0) AS pension,
        ISNULL(SUM(CASE WHEN FlagCobEsta=1   THEN Estadias ELSE 0 END),0) AS estadias,
        ISNULL(SUM(CASE WHEN FlagCobOtros=1  THEN Otros    ELSE 0 END),0) AS otros
      FROM Empresa2.DepoSolicitud WHERE Serie=@serie AND CartaPorte=@cp`);
  const d = r.recordset[0];
  return {
    casetas:   Math.round((d.casetas   / 1.16) * 100) / 100,
    maniobras: Math.round((d.maniobras / 1.16) * 100) / 100,
    pension:   Math.round((d.pension   / 1.16) * 100) / 100,
    estadias:  Math.round((d.estadias  / 1.16) * 100) / 100,
    otros:     Math.round((d.otros     / 1.16) * 100) / 100,
  };
}

// ── VISTA ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT Central, Descripcion FROM Empresa2.Centrales ORDER BY Descripcion`);
    res.render('facturas', { usuario: req.session.usuario, modulo: 'facturas', centrales: r.recordset });
  } catch (err) {
    res.render('facturas', { usuario: req.session.usuario, modulo: 'facturas', centrales: [] });
  }
});

// ── NÚMERO CONSECUTIVO (preview, según la SerieFac tecleada) ─────────────────
router.get('/lookup/numero-consecutivo', async (req, res) => {
  try {
    const pool = await getPool();
    const r = await reqSerieFac(pool.request(), req.query.serieFac)
      .query(`SELECT ISNULL(MAX(Id_NoFactura),0)+1 AS next FROM Empresa2.Factura WHERE ${SERIEFAC_EQ}`);
    res.json({ next: r.recordset[0].next });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LOOKUP DE CARTA PORTE por cliente + status (Emitidas / Facturadas), central del usuario ─
router.get('/lookup/cartaporte', async (req, res) => {
  try {
    const pool = await getPool();
    const idCliente = parseInt(req.query.idCliente) || 0;
    if (!idCliente) return res.json({ rows: [], total: 0, totalPages: 1, page: 1 });
    const status = req.query.status === 'FACTURADO' ? 'FACTURADO' : 'EMITIDO';
    const serie = trim(req.session.central);
    const q = trim(req.query.q);
    const page = Math.max(1, parseInt(req.query.page) || 1);

    let where = `WHERE Serie=@serie AND Id_Cliente=@idCliente AND Status=@status`;
    const cr = pool.request().input('serie', sql.VarChar(3), serie).input('idCliente', sql.Decimal(7), idCliente).input('status', sql.VarChar(20), status);
    if (q) { where += ` AND (CartaPorte LIKE @q OR DesFlete LIKE @q)`; cr.input('q', `%${q}%`); }
    const cnt = await cr.query(`SELECT COUNT(*) AS total FROM Empresa2.CartaPorte ${where}`);
    const total = cnt.recordset[0].total;
    const offset = (page - 1) * 10;
    const dr = pool.request().input('serie', sql.VarChar(3), serie).input('idCliente', sql.Decimal(7), idCliente).input('status', sql.VarChar(20), status);
    if (q) dr.input('q', `%${q}%`);
    const data = await dr.query(
      `SELECT CartaPorte,FechaPedido,DesFlete,CostoFlete,CostoDemoras,NoFactura,AnioFactura,Status
       FROM Empresa2.CartaPorte ${where} ORDER BY CartaPorte DESC OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`
    );
    const fmtDate = v => { if (!v) return ''; const d = v instanceof Date ? v : new Date(v); return d.toISOString().slice(0,10); };
    const rows = data.recordset.map(r => ({
      CartaPorte: trim(r.CartaPorte), FechaPedido: fmtDate(r.FechaPedido), DesFlete: trim(r.DesFlete),
      CostoFlete: r.CostoFlete||0, CostoDemoras: r.CostoDemoras||0, NoFactura: r.NoFactura||'', AnioFactura: r.AnioFactura||'',
      Status: trim(r.Status),
    }));
    res.json({ rows, total, totalPages: Math.ceil(total/10)||1, page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BROWSE ──────────────────────────────────────────────────────────────────
router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'Empresa2.Factura',
      columns: ['Id_NoFactura','FechaFactura','Id_Cliente','NombreCom','RFC','MonFactura','SubTotal','IVA','Retencion','TOTAL','Status','SerieFac','Facturo'],
      searchableCols: ['Id_NoFactura','NombreCom','RFC','Status','SerieFac','Facturo'],
      req
    });
    const fmt = v => v == null ? '' : (v instanceof Date ? v.toISOString().slice(0,10) : String(v).trim());
    const fmtN = v => v == null ? '0.00' : Number(v).toFixed(2);
    const rows = data.rows.map(r => `<tr data-id="${r.Id_NoFactura}">
      <td data-field="SerieFac" data-value="${fmt(r.SerieFac)}">${fmt(r.SerieFac)}</td>
      <td data-field="Id_NoFactura" data-value="${r.Id_NoFactura}">${r.Id_NoFactura}</td>
      <td data-field="FechaFactura" data-value="${fmt(r.FechaFactura)}">${fmt(r.FechaFactura)}</td>
      <td data-field="NombreCom" data-value="${fmt(r.NombreCom)}">${fmt(r.NombreCom)}</td>
      <td data-field="RFC" data-value="${fmt(r.RFC)}">${fmt(r.RFC)}</td>
      <td data-field="MonFactura" data-value="${fmt(r.MonFactura)}">${fmt(r.MonFactura)}</td>
      <td data-field="SubTotal" data-value="${r.SubTotal||0}" class="text-end">${fmtN(r.SubTotal)}</td>
      <td data-field="TOTAL" data-value="${r.TOTAL||0}" class="text-end">${fmtN(r.TOTAL)}</td>
      <td data-field="Status" data-value="${fmt(r.Status)}">${fmt(r.Status)}</td>
      <td data-field="Facturo" data-value="${fmt(r.Facturo)}">${fmt(r.Facturo)}</td>
      <td data-field="Id_Cliente" data-value="${r.Id_Cliente||''}" style="display:none"></td>
    </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CABECERA + LÍNEAS ─────────────────────────────────────────────────────────
router.get('/get', async (req, res) => {
  try {
    const pool = await getPool();
    const id = parseInt(req.query.idNoFactura);
    const serieFac = req.query.serieFac;
    const cabRes = await reqSerieFac(pool.request(), serieFac).input('id', sql.Decimal(9), id)
      .query(`SELECT * FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);
    if (!cabRes.recordset[0]) return res.status(404).json({ error: 'No encontrada' });
    const detRes = await reqSerieFac(pool.request(), serieFac).input('id', sql.Decimal(9), id)
      .query(`SELECT * FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND ${SERIEFAC_EQ} ORDER BY ID_NODETAFAC`);
    res.json({ cabecera: cabRes.recordset[0], lineas: detRes.recordset });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DEFAULTS DE CLIENTE (punto 2) ─────────────────────────────────────────────
router.get('/lookup/cliente-defaults', async (req, res) => {
  try {
    const pool = await getPool();
    const idCliente = parseInt(req.query.idCliente);
    const r = await pool.request().input('id', sql.Decimal(7), idCliente)
      .query(`SELECT ID_CLIENTE,NOMBRECOMUN,NOMBRECOM,RFC,C_FORMAPAGO,CLAVEMP,METODOPAGO,C_USOCFDI,C_CLAVEPRODSERV,DESCRIPCION_PRO
              FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
    if (!r.recordset[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
    const c = r.recordset[0];
    res.json({
      NOMBRECOMUN: trim(c.NOMBRECOMUN), NOMBRECOM: trim(c.NOMBRECOM), RFC: trim(c.RFC),
      c_FormaPago: trim(c.C_FORMAPAGO) || '99',
      ClaveMP: trim(c.CLAVEMP) || 'PPD',
      MetodoPago: trim(c.METODOPAGO) || 'Pago en parcialidades o diferido',
      c_UsoCFDI: trim(c.C_USOCFDI) || 'P01',
      C_CLAVEPRODSERV: trim(c.C_CLAVEPRODSERV),
      DESCRIPCION_PRO: trim(c.DESCRIPCION_PRO),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── VALIDAR CARTA PORTE A FACTURAR (punto 2) ──────────────────────────────────
router.get('/lookup/cartaporte-validar', async (req, res) => {
  try {
    const pool = await getPool();
    const serie = trim(req.query.serie);
    const cp = trim(req.query.cartaporte);
    const idCliente = parseInt(req.query.idCliente) || 0;
    const r = await pool.request().input('serie', sql.VarChar(3), serie).input('cp', sql.VarChar(30), cp)
      .query(`SELECT * FROM Empresa2.CartaPorte WHERE Serie=@serie AND CartaPorte=@cp`);
    const cpRow = r.recordset[0];
    if (!cpRow) return res.status(404).json({ error: 'No existe esa Carta Porte.' });
    const status = trim(cpRow.Status).toUpperCase();
    if (status === 'CANCELADO' || status === 'CANCELAD0') {
      return res.status(400).json({ error: 'Esa Carta Porte está cancelada, no puede facturarse.' });
    }
    if (idCliente && Number(cpRow.Id_Cliente) !== idCliente) {
      return res.status(400).json({ error: 'El cliente de la Carta Porte no coincide con el de la factura.', clear: true });
    }
    const warning = status === 'FACTURADO' ? 'La Carta Porte ya está facturada, proceda con cuidado.' : null;
    res.json({
      ok: true, warning,
      Serie: trim(cpRow.Serie), CartaPorte: trim(cpRow.CartaPorte), Id_Pedido: cpRow.Id_Pedido,
      Id_Cliente: cpRow.Id_Cliente, NombreComunCli: trim(cpRow.NombreComunCli),
      DesFlete: trim(cpRow.DesFlete), TipoPedido: trim(cpRow.TipoPedido), NoCaja: trim(cpRow.NoCaja),
      FechaPedido: cpRow.FechaPedido, Status: status,
      CostoFlete: cpRow.CostoFlete||0, CostoDemoras: cpRow.CostoDemoras||0,
      Kilometros: cpRow.Kilometros||0, KilometrosTar: cpRow.KilometrosTar||0, RetenKilo: cpRow.RetenKilo||0,
      c_Moneda: trim(cpRow.c_Moneda) || 'MXN', TipoCambio: cpRow.TipoCambio||0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AGREGAR CARTA PORTE COMO PARTIDA (punto 3) ────────────────────────────────
router.post('/partida/agregar', async (req, res) => {
  const f = req.body;
  const serie = trim(f.serie), cp = trim(f.cartaporte);
  if (!serie || !cp) return res.status(400).json({ error: 'Debe indicar Serie y Carta Porte.' });

  try {
    const pool = await getPool();
    const result = await withTransaction(pool, async (tx) => {
      const cpRes = await new sql.Request(tx)
        .input('serie', sql.VarChar(3), serie).input('cp', sql.VarChar(30), cp)
        .query(`SELECT * FROM Empresa2.CartaPorte WITH (UPDLOCK, ROWLOCK) WHERE Serie=@serie AND CartaPorte=@cp`);
      const cpRow = cpRes.recordset[0];
      if (!cpRow) throw Object.assign(new Error('No existe esa Carta Porte.'), { status: 400 });
      const cpStatus = trim(cpRow.Status).toUpperCase();
      if (cpStatus === 'CANCELADO' || cpStatus === 'CANCELAD0') {
        throw Object.assign(new Error('Esa Carta Porte está cancelada, no puede facturarse.'), { status: 400 });
      }
      const idCliente = parseInt(f.idCliente);
      if (!idCliente || Number(cpRow.Id_Cliente) !== idCliente) {
        throw Object.assign(new Error('El cliente de la Carta Porte no coincide con el de la factura.'), { status: 400 });
      }

      // Conceptos brutos de la CP + depósitos
      const bruto = { flete: 0, demoras: 0, kilometros: num(cpRow.Kilometros) };
      if (num(cpRow.CostoFlete) > 0) bruto.flete = num(cpRow.CostoFlete);
      else if (num(cpRow.CostoDemoras) > 0) bruto.demoras = num(cpRow.CostoDemoras);
      const depo = await cobrableDepositos(tx, serie, cp);
      Object.assign(bruto, depo); // casetas, maniobras, pension, estadias, otros

      const previo = await yaFacturadoPorConcepto(tx, serie, cp, null);

      const activos = {};
      let subtotal = 0;
      for (const k of Object.keys(CONCEPTOS)) {
        const netoRaw = num(bruto[k]) - num(previo[k]);
        const neto = Math.round(netoRaw * 100) / 100;
        if (neto > 0.005) { activos[k] = neto; subtotal += neto; }
      }
      subtotal = Math.round(subtotal * 100) / 100;

      if (subtotal <= 0) {
        throw Object.assign(new Error('La Carta Porte ya fue facturada en su totalidad, seleccione otra.'), { status: 400 });
      }

      const iva   = Math.round(subtotal * 0.16 * 100) / 100;
      const reten = Math.round(subtotal * 0.04 * 100) / 100;
      const total = Math.round((subtotal + iva - reten) * 100) / 100;

      // ── Cabecera: crear si es la primera partida de una factura nueva ──────
      let idNoFactura = parseInt(f.idNoFactura) || 0;
      let serieFac = serieKey(f.serieFac);
      if (!idNoFactura) {
        if (!idCliente) throw Object.assign(new Error('Debe seleccionar un cliente.'), { status: 400 });
        const cliRes = await new sql.Request(tx).input('id', sql.Decimal(7), idCliente)
          .query(`SELECT NOMBRECOMUN,NOMBRECOM,RFC,C_FORMAPAGO,CLAVEMP,METODOPAGO,C_USOCFDI FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
        const cli = cliRes.recordset[0];
        if (!cli) throw Object.assign(new Error('Cliente no encontrado.'), { status: 400 });

        const monedaCP = trim(cpRow.c_Moneda) || 'MXN';
        const esExtranjero = monedaCP && monedaCP !== 'MXN';
        const moneda = esExtranjero ? monedaCP : 'MXN';
        const tipoCambio = esExtranjero ? num(cpRow.TipoCambio) : 0;
        const usoCFDI = esExtranjero ? 'S01' : (trim(f.c_UsoCFDI) || trim(cli.C_USOCFDI) || 'P01');
        const formaPago = trim(f.c_FormaPago) || trim(cli.C_FORMAPAGO) || '99';
        const claveMP = trim(f.ClaveMP) || trim(cli.CLAVEMP) || 'PPD';
        const metodoPago = trim(f.MetodoPago) || trim(cli.METODOPAGO) || 'Pago en parcialidades o diferido';
        const flagResFac = f.flagResFac ? 1 : 0;

        const nextRes = await reqSerieFac(new sql.Request(tx), serieFac)
          .query(`SELECT ISNULL(MAX(Id_NoFactura),0)+1 AS next FROM Empresa2.Factura WITH (UPDLOCK, HOLDLOCK) WHERE ${SERIEFAC_EQ}`);
        idNoFactura = nextRes.recordset[0].next;

        await reqSerieFac(new sql.Request(tx), serieFac)
          .input('id', sql.Decimal(9), idNoFactura)
          .input('fecha', sql.Date, hoy())
          .input('hora', sql.VarChar(8), new Date().toTimeString().slice(0,8))
          .input('idCli', sql.Decimal(7), idCliente)
          .input('nombreCom', sql.VarChar(150), trim(cli.NOMBRECOMUN) || trim(cli.NOMBRECOM))
          .input('rfc', sql.VarChar(15), trim(cli.RFC))
          .input('mon', sql.VarChar(4), moneda)
          .input('tc', sql.Decimal(9,4), tipoCambio)
          .input('status', sql.VarChar(20), 'EMITIDA')
          .input('cformapago', sql.VarChar(4), formaPago)
          .input('clavemp', sql.VarChar(3), claveMP)
          .input('metodopago', sql.VarChar(60), metodoPago)
          .input('cusocfdi', sql.VarChar(5), usoCFDI)
          .input('flagres', sql.Int, flagResFac)
          .input('realizo', sql.VarChar(60), [req.session.usuario.nombre, req.session.usuario.apellido].filter(Boolean).join(' '))
          .query(`INSERT INTO Empresa2.Factura(
            Id_NoFactura,FechaFactura,Hora,Id_Cliente,NombreCom,RFC,MonFactura,TipoCambio,Status,
            c_FormaPago,ClaveMP,MetodoPago,c_UsoCFDI,FlagResFac,SerieFac,Facturo,SubTotal,IVA,Retencion,TOTAL
          ) VALUES(
            @id,@fecha,@hora,@idCli,@nombreCom,@rfc,@mon,@tc,@status,
            @cformapago,@clavemp,@metodopago,@cusocfdi,@flagres,@serieFac,@realizo,0,0,0,0
          )`);
      } else {
        const facRes = await reqSerieFac(new sql.Request(tx), serieFac).input('id', sql.Decimal(9), idNoFactura)
          .query(`SELECT Status FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);
        if (!facRes.recordset[0]) throw Object.assign(new Error('Factura no encontrada.'), { status: 400 });
        if (trim(facRes.recordset[0].Status).toUpperCase() === 'CANCELADA') {
          throw Object.assign(new Error('No se pueden agregar partidas a una factura cancelada.'), { status: 400 });
        }
      }

      // Clave de producto/servicio: de los defaults del cliente si vinieron en el body
      const claveProdServ = trim(f.claveProdServ);
      const descProdServ = trim(f.descripcionProdServ);

      const nextDetaRes = await reqSerieFac(new sql.Request(tx), serieFac).input('id', sql.Decimal(9), idNoFactura)
        .query(`SELECT ISNULL(MAX(ID_NODETAFAC),0)+1 AS next FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND ${SERIEFAC_EQ}`);
      const idNoDetaFac = nextDetaRes.recordset[0].next;

      const anioPedido = cpRow.FechaPedido ? new Date(cpRow.FechaPedido).getFullYear() : null;

      await new sql.Request(tx)
        .input('idf', sql.Decimal(9), idNoFactura)
        .input('idd', sql.Decimal(6), idNoDetaFac)
        .input('seriefac', sql.VarChar(20), serieFac)
        .input('idcli', sql.Decimal(7), idCliente)
        .input('serie', sql.VarChar(3), serie)
        .input('idped', sql.Decimal(9), cpRow.Id_Pedido || 0)
        .input('cp', sql.VarChar(30), cp)
        .input('tipoped', sql.VarChar(20), trim(cpRow.TipoPedido))
        .input('aniop', sql.Decimal(4), anioPedido)
        .input('desflete', sql.VarChar(80), trim(cpRow.DesFlete))
        .input('nocaja', sql.VarChar(10), trim(cpRow.NoCaja))
        .input('cflete', sql.Decimal(9,2), activos.flete || 0)
        .input('fflete', sql.TinyInt, activos.flete ? 1 : 0)
        .input('cdem', sql.Decimal(9,2), activos.demoras || 0)
        .input('fdem', sql.TinyInt, activos.demoras ? 1 : 0)
        .input('cauto', sql.Decimal(9,2), activos.casetas || 0)
        .input('fauto', sql.TinyInt, activos.casetas ? 1 : 0)
        .input('cman', sql.Decimal(9,2), activos.maniobras || 0)
        .input('fman', sql.TinyInt, activos.maniobras ? 1 : 0)
        .input('cpen', sql.Decimal(9,2), activos.pension || 0)
        .input('fpen', sql.TinyInt, activos.pension ? 1 : 0)
        .input('cest', sql.Decimal(9,2), activos.estadias || 0)
        .input('fest', sql.TinyInt, activos.estadias ? 1 : 0)
        .input('cotros', sql.Decimal(9,2), activos.otros || 0)
        .input('fotros', sql.TinyInt, activos.otros ? 1 : 0)
        .input('km', sql.Decimal(10,2), activos.kilometros || 0)
        .input('kmtar', sql.Decimal(7), cpRow.KilometrosTar || 0)
        .input('retenkm', sql.Decimal(7,2), cpRow.RetenKilo || 0)
        .input('fkm', sql.TinyInt, activos.kilometros ? 1 : 0)
        .input('reten', sql.Decimal(9,2), reten)
        .input('sub', sql.Decimal(9,2), subtotal)
        .input('iva', sql.Decimal(9,2), iva)
        .input('tot', sql.Decimal(9,2), total)
        .input('cprodserv', sql.VarChar(20), claveProdServ || null)
        .input('descprodserv', sql.VarChar(100), descProdServ || null)
        .input('flagsinret', sql.TinyInt, 0)
        .input('flagiva', sql.TinyInt, 0)
        .query(`INSERT INTO Empresa2.FacDeta(
          ID_NOFACTURA,ID_NODETAFAC,SerieFac,ID_CLIENTE,SERIE,ID_PEDIDO,CARTAPORTE,TIPOPEDIDO,ANIOPEDIDO,DESFLETE,NOCAJA,
          COSTOFLETE,FlagCobFlete,COSTODEMORAS,FLAGCOBDEM,COSTOAUTOPISTAS,FLAGCOBAUTO,COSTOMANIOBRAS,FLAGCOBMAN,
          CostoPension,FlagCostoPension,CostoEstadias,FlagCostoEstadias,COSTOSOTROS,FLAGCOBOTROS,
          KILOMETROS,KILOMETROSTAR,RETENKILO,FLAGKILOMETROS,
          RETEN,SUBTOTAL,IVA,TOTAL,C_CLAVEPRODSERV,DESCRIPCION,FLAGSINRET,FLAGIVA
        ) VALUES(
          @idf,@idd,@seriefac,@idcli,@serie,@idped,@cp,@tipoped,@aniop,@desflete,@nocaja,
          @cflete,@fflete,@cdem,@fdem,@cauto,@fauto,@cman,@fman,
          @cpen,@fpen,@cest,@fest,@cotros,@fotros,
          @km,@kmtar,@retenkm,@fkm,
          @reten,@sub,@iva,@tot,@cprodserv,@descprodserv,@flagsinret,@flagiva
        )`);

      // Marcar la Carta Porte como facturada (punto 3)
      const anioFactura = new Date(hoy()).getFullYear();
      await new sql.Request(tx)
        .input('serie', sql.VarChar(3), serie).input('cp', sql.VarChar(30), cp)
        .input('nofac', sql.Decimal(9), idNoFactura).input('anio', sql.Decimal(4), anioFactura)
        .query(`UPDATE Empresa2.CartaPorte SET Status='FACTURADO', NoFactura=@nofac, AnioFactura=@anio WHERE Serie=@serie AND CartaPorte=@cp`);
      await recalcularImporteFacCP(tx, serie, cp);

      const totales = await recalcularCabecera(tx, idNoFactura, serieFac);
      return { idNoFactura, serieFac: serieFac || '', idNoDetaFac, activos, totales };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── ELIMINAR LÍNEA (punto 7) ──────────────────────────────────────────────────
router.post('/partida/eliminar', async (req, res) => {
  const idNoFactura = parseInt(req.body.idNoFactura);
  const idNoDetaFac = parseInt(req.body.idNoDetaFac);
  const serieFac = req.body.serieFac;
  try {
    const pool = await getPool();
    await withTransaction(pool, async (tx) => {
      const lineaRes = await reqSerieFac(new sql.Request(tx), serieFac)
        .input('idf', sql.Decimal(9), idNoFactura).input('idd', sql.Decimal(6), idNoDetaFac)
        .query(`SELECT SERIE, CARTAPORTE FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@idf AND ID_NODETAFAC=@idd AND ${SERIEFAC_EQ}`);
      const linea = lineaRes.recordset[0];
      if (!linea) throw Object.assign(new Error('Línea no encontrada.'), { status: 404 });
      const serie = trim(linea.SERIE), cp = trim(linea.CARTAPORTE);

      await reqSerieFac(new sql.Request(tx), serieFac)
        .input('idf', sql.Decimal(9), idNoFactura).input('idd', sql.Decimal(6), idNoDetaFac)
        .query(`DELETE FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@idf AND ID_NODETAFAC=@idd AND ${SERIEFAC_EQ}`);

      await recalcularImporteFacCP(tx, serie, cp);
      await recalcularCabecera(tx, idNoFactura, serieFac);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── TOGGLE FLAG COBRABLE POR LÍNEA (punto 6) ──────────────────────────────────
router.post('/detalle/toggle-flag', async (req, res) => {
  const idNoFactura = parseInt(req.body.idNoFactura);
  const idNoDetaFac = parseInt(req.body.idNoDetaFac);
  const serieFac = req.body.serieFac;
  const concepto = req.body.concepto;
  if (!CONCEPTOS[concepto]) return res.status(400).json({ error: 'Concepto inválido.' });

  try {
    const pool = await getPool();
    const result = await withTransaction(pool, async (tx) => {
      const { montoCol, flagCol } = CONCEPTOS[concepto];
      const lineaRes = await reqSerieFac(new sql.Request(tx), serieFac)
        .input('idf', sql.Decimal(9), idNoFactura).input('idd', sql.Decimal(6), idNoDetaFac)
        .query(`SELECT * FROM Empresa2.FacDeta WITH (UPDLOCK, ROWLOCK) WHERE ID_NOFACTURA=@idf AND ID_NODETAFAC=@idd AND ${SERIEFAC_EQ}`);
      const linea = lineaRes.recordset[0];
      if (!linea) throw Object.assign(new Error('Línea no encontrada.'), { status: 404 });
      const serie = trim(linea.SERIE), cp = trim(linea.CARTAPORTE);
      const activoActual = ISNULLtoBool(linea[flagCol]);
      let nuevoMonto = 0, nuevoFlag = 0;

      if (!activoActual) {
        // Se está marcando: recalcular el monto realmente cobrable (punto 6)
        let bruto = 0;
        if (['casetas','maniobras','pension','estadias','otros'].includes(concepto)) {
          const depo = await cobrableDepositos(tx, serie, cp);
          bruto = depo[concepto];
        } else if (concepto === 'kilometros') {
          const cpRes = await new sql.Request(tx).input('serie', sql.VarChar(3), serie).input('cp', sql.VarChar(30), cp)
            .query(`SELECT Kilometros FROM Empresa2.CartaPorte WHERE Serie=@serie AND CartaPorte=@cp`);
          bruto = num(cpRes.recordset[0]?.Kilometros);
        } else {
          const col = concepto === 'flete' ? 'CostoFlete' : 'CostoDemoras';
          const cpRes = await new sql.Request(tx).input('serie', sql.VarChar(3), serie).input('cp', sql.VarChar(30), cp)
            .query(`SELECT ${col} AS v FROM Empresa2.CartaPorte WHERE Serie=@serie AND CartaPorte=@cp`);
          bruto = num(cpRes.recordset[0]?.v);
        }
        const previo = await yaFacturadoPorConcepto(tx, serie, cp, { idNoFactura, idNoDetaFac, serieFac });
        const neto = Math.round((bruto - num(previo[concepto])) * 100) / 100;
        if (neto <= 0.005) {
          throw Object.assign(new Error('Ese concepto ya está facturado en su totalidad para esta Carta Porte.'), { status: 400 });
        }
        nuevoMonto = neto; nuevoFlag = 1;
      } else {
        nuevoMonto = 0; nuevoFlag = 0;
      }

      await reqSerieFac(new sql.Request(tx), serieFac)
        .input('idf', sql.Decimal(9), idNoFactura).input('idd', sql.Decimal(6), idNoDetaFac)
        .input('monto', sql.Decimal(9,2), nuevoMonto).input('flag', sql.TinyInt, nuevoFlag)
        .query(`UPDATE Empresa2.FacDeta SET ${montoCol}=@monto, ${flagCol}=@flag WHERE ID_NOFACTURA=@idf AND ID_NODETAFAC=@idd AND ${SERIEFAC_EQ}`);

      // Recalcular subtotal/IVA/retención/total de la línea sumando todos sus conceptos vigentes
      const actRes = await reqSerieFac(new sql.Request(tx), serieFac)
        .input('idf', sql.Decimal(9), idNoFactura).input('idd', sql.Decimal(6), idNoDetaFac)
        .query(`SELECT * FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@idf AND ID_NODETAFAC=@idd AND ${SERIEFAC_EQ}`);
      const l = actRes.recordset[0];
      let subtotal = 0;
      for (const [, c] of Object.entries(CONCEPTOS)) if (ISNULLtoBool(l[c.flagCol])) subtotal += num(l[c.montoCol]);
      subtotal = Math.round(subtotal * 100) / 100;
      const flagIVA = ISNULLtoBool(l.FLAGIVA), flagSinRet = ISNULLtoBool(l.FLAGSINRET);
      const iva = flagIVA ? 0 : Math.round(subtotal * 0.16 * 100) / 100;
      const reten = flagSinRet ? 0 : Math.round(subtotal * 0.04 * 100) / 100;
      const total = Math.round((subtotal + iva - reten) * 100) / 100;

      await reqSerieFac(new sql.Request(tx), serieFac)
        .input('idf', sql.Decimal(9), idNoFactura).input('idd', sql.Decimal(6), idNoDetaFac)
        .input('sub', sql.Decimal(9,2), subtotal).input('iva', sql.Decimal(9,2), iva)
        .input('ret', sql.Decimal(9,2), reten).input('tot', sql.Decimal(9,2), total)
        .query(`UPDATE Empresa2.FacDeta SET SUBTOTAL=@sub, IVA=@iva, RETEN=@ret, TOTAL=@tot WHERE ID_NOFACTURA=@idf AND ID_NODETAFAC=@idd AND ${SERIEFAC_EQ}`);

      await recalcularImporteFacCP(tx, serie, cp);
      const totales = await recalcularCabecera(tx, idNoFactura, serieFac);
      return { linea: { SUBTOTAL: subtotal, IVA: iva, RETEN: reten, TOTAL: total, [flagCol]: nuevoFlag, [montoCol]: nuevoMonto }, totales };
    });
    res.json({ ok: true, ...result });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

function ISNULLtoBool(v) { return v === 1 || v === true; }

// ── CANCELAR FACTURA RECIÉN CREADA SIN CONFIRMAR (punto 4) ───────────────────
router.post('/cabecera/cancelar-sin-confirmar', async (req, res) => {
  const idNoFactura = parseInt(req.body.idNoFactura);
  const serieFac = req.body.serieFac;
  if (!idNoFactura) return res.json({ ok: true }); // nada que revertir (no se había insertado cabecera)
  try {
    const pool = await getPool();
    await withTransaction(pool, async (tx) => {
      const facRes = await reqSerieFac(new sql.Request(tx), serieFac).input('id', sql.Decimal(9), idNoFactura)
        .query(`SELECT Id_NoFactura FROM Empresa2.Factura WITH (UPDLOCK, ROWLOCK) WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);
      if (!facRes.recordset[0]) return; // ya no existe, nada que hacer

      const lineasRes = await reqSerieFac(new sql.Request(tx), serieFac).input('id', sql.Decimal(9), idNoFactura)
        .query(`SELECT DISTINCT SERIE, CARTAPORTE FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND ${SERIEFAC_EQ}`);

      await reqSerieFac(new sql.Request(tx), serieFac).input('id', sql.Decimal(9), idNoFactura)
        .query(`DELETE FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND ${SERIEFAC_EQ}`);
      await reqSerieFac(new sql.Request(tx), serieFac).input('id', sql.Decimal(9), idNoFactura)
        .query(`DELETE FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);

      for (const l of lineasRes.recordset) {
        await recalcularImporteFacCP(tx, trim(l.SERIE), trim(l.CARTAPORTE));
      }
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
