const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');
const { requierePermiso } = require('../middleware/permisos');
const { importeALetras } = require('../services/importe-letras');
const { ajustarSaldoFactura, ajustarSaldoNotaDebito } = require('../services/saldo-factura');

// La clave real de una Nota de Crédito/Débito es (Tipo, Serie, Id_NotaCredito)
// -- NC y ND llevan numeración INDEPENDIENTE aunque compartan la misma tabla
// física (confirmado con el usuario): un Id_NotaCredito=5 puede existir a la
// vez como NC y como ND. Toda consulta sobre NotaCred o NotaCredDeta debe ir
// scopeada por los tres campos, nunca solo por el ID -- mismo espíritu que el
// gotcha ya conocido de Factura.SerieFac.
const serieKey = v => { const t = (v == null ? '' : String(v)).trim(); return t || null; };
const trim = v => (v == null ? '' : String(v).trim());
const num = v => (v === '' || v == null || isNaN(parseFloat(v))) ? 0 : parseFloat(v);
const hoy = () => new Date().toISOString().slice(0, 10);

function reqNC(r, tipo, serie, id) {
  r.input('tipo', sql.VarChar(3), trim(tipo));
  r.input('serie', sql.VarChar(10), serieKey(serie));
  if (id !== undefined) r.input('id', sql.Decimal(7), id);
  return r;
}
const NC_EQ = `LTRIM(RTRIM(Tipo))=@tipo AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`;

// Defaults fiscales al elegir el tipo (confirmados con el usuario; NC=1/ND=2
// vienen del catálogo oficial sat_TipoRelacion, editable después vía lupa).
const DEFAULTS_TIPO = {
  NC: { c_FormaPago: '99', ClaveMP: 'PPD', c_UsoCFDI: 'G03', c_TipoRelacion: '1', c_ClaveProdServ: '78101802', c_ClaveUnidad: 'E48', Descripcion: 'SERVICIO DE TRASLADO DE MERCANCIA VIA TRANSPORTE' },
  ND: { c_FormaPago: '99', ClaveMP: 'PPD', c_UsoCFDI: 'G03', c_TipoRelacion: '2', c_ClaveProdServ: '78101802', c_ClaveUnidad: 'E48', Descripcion: 'SERVICIO DE TRASLADO DE MERCANCIA VIA TRANSPORTE' },
};

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

// ── Recalcula subtotal/IVA/retención/total de cabecera sumando las líneas ──
// Aplica solo en modo DETALLADO -- en RESUMEN el importe del CFDI (un solo
// concepto) se captura manualmente en cabecera vía /cabecera/importe-resumen,
// independiente de la suma operativa de las líneas (puede haber varias
// facturas/ND referenciadas cuyo saldo individual no coincide con el monto
// declarado en el concepto único). En resumen esta función solo re-lee y
// regresa los valores ya persistidos en NotaCred, sin tocarlos.
async function recalcularCabecera(tx, tipo, serie, id) {
  const cabRes = await reqNC(new sql.Request(tx), tipo, serie, id)
    .query(`SELECT FlagResNota, Subtotal, IVA, Retencion, ImporteTotal, ImporteLetras FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
  const cab = cabRes.recordset[0];
  if (!cab) throw Object.assign(new Error('Nota no encontrada.'), { status: 404 });
  if (Number(cab.FlagResNota) === 1) {
    return { Subtotal: num(cab.Subtotal), IVA: num(cab.IVA), Retencion: num(cab.Retencion), ImporteTotal: num(cab.ImporteTotal), ImporteLetras: trim(cab.ImporteLetras) };
  }
  const sumRes = await reqNC(new sql.Request(tx), tipo, serie, id).query(
    `SELECT ISNULL(SUM(SUBTOTAL),0) sub, ISNULL(SUM(IVA),0) iva, ISNULL(SUM(RETENCION),0) ret, ISNULL(SUM(IMPORTEAPLICA),0) tot
     FROM Empresa2.NotaCredDeta WHERE ID_NOTACREDITO=@id AND ${NC_EQ}`);
  const s = sumRes.recordset[0];
  const r2 = v => Math.round(v * 100) / 100;
  // NotaCred no tiene columna de moneda propia -- siempre pesos (mismo criterio
  // que TipoFactura='Pesos' fijo en el INSERT).
  const vals = { Subtotal: r2(s.sub), IVA: r2(s.iva), Retencion: r2(s.ret), ImporteTotal: r2(s.tot), ImporteLetras: importeALetras(r2(s.tot), 'MXN') };
  await reqNC(new sql.Request(tx), tipo, serie, id)
    .input('sub', sql.Decimal(9,2), vals.Subtotal).input('iva', sql.Decimal(10,2), vals.IVA)
    .input('ret', sql.Decimal(9,2), vals.Retencion).input('tot', sql.Decimal(12,2), vals.ImporteTotal)
    .input('letras', sql.VarChar(200), vals.ImporteLetras)
    .query(`UPDATE Empresa2.NotaCred SET Subtotal=@sub, IVA=@iva, Retencion=@ret, ImporteTotal=@tot, SumaPartidas=@tot, ImporteLetras=@letras WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
  return vals;
}

router.get('/', (req, res) => res.render('notacred', { usuario: req.session.usuario, modulo: 'notacred' }));

// ── BROWSE (2 pestañas NC/ND) ───────────────────────────────────────────────
router.get('/data', async (req, res) => {
  try {
    const tipo = req.query.tipo === 'ND' ? 'ND' : 'NC';
    const data = await browseQuery({
      table: 'Empresa2.NotaCred',
      columns: ['Serie', 'Id_NotaCredito', 'Fecha', 'Id_Cliente', 'NombreCom', 'Subtotal', 'IVA', 'Retencion', 'ImporteTotal', 'Status', 'FlagResNota', 'UUID'],
      searchableCols: ['Id_NotaCredito', 'NombreCom', 'Status'],
      req,
      baseWhere: `LTRIM(RTRIM(Tipo))=@tipoFiltro`,
      baseParams: { tipoFiltro: tipo },
    });
    const fmt = v => v == null ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());
    // Solo para texto visible -- data-value siempre lleva el número crudo, sin
    // formato, así que nada que lea esos atributos se ve afectado.
    const fmtN = v => {
      const n = v == null ? 0 : Number(v);
      const signo = n < 0 ? '-' : '';
      return signo + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    const rows = data.rows.map(r => {
      const canceladaConAcuse = fmt(r.Status).toUpperCase() === 'CANCELADO' && !!fmt(r.UUID);
      return `<tr data-id="${r.Id_NotaCredito}">
      <td data-field="Tipo" data-value="${tipo}"><span class="badge ${tipo==='NC'?'bg-success':'bg-info text-dark'}">${tipo}</span></td>
      <td data-field="Serie" data-value="${fmt(r.Serie)}">${fmt(r.Serie)}</td>
      <td data-field="Id_NotaCredito" data-value="${r.Id_NotaCredito}">${r.Id_NotaCredito}</td>
      <td data-field="Fecha" data-value="${fmt(r.Fecha)}">${fmt(r.Fecha)}</td>
      <td data-field="NombreCom" data-value="${fmt(r.NombreCom)}">${fmt(r.NombreCom)}</td>
      <td data-field="Subtotal" data-value="${r.Subtotal||0}" class="text-end">${fmtN(r.Subtotal)}</td>
      <td data-field="IVA" data-value="${r.IVA||0}" class="text-end">${fmtN(r.IVA)}</td>
      <td data-field="Retencion" data-value="${r.Retencion||0}" class="text-end">${fmtN(r.Retencion)}</td>
      <td data-field="ImporteTotal" data-value="${r.ImporteTotal||0}" class="text-end">${fmtN(r.ImporteTotal)}</td>
      <td data-field="Status" data-value="${fmt(r.Status)}">${fmt(r.Status)}</td>
      <td class="text-center">${fmt(r.UUID)
        ? `<a href="/cfdi/xml-notacredito?tipo=${tipo}&serie=${encodeURIComponent(fmt(r.Serie))}&idNotaCredito=${r.Id_NotaCredito}" class="btn btn-sm btn-primary py-0 px-1" title="Descargar XML" onclick="event.stopPropagation()"><i class="bi bi-file-earmark-code"></i></a>`
        : `<button class="btn btn-sm btn-outline-secondary py-0 px-1" disabled title="Solo disponible una vez timbrada"><i class="bi bi-file-earmark-code"></i></button>`}</td>
      <td class="text-center"><a href="/cfdi/pdf-notacredito?tipo=${tipo}&serie=${encodeURIComponent(fmt(r.Serie))}&idNotaCredito=${r.Id_NotaCredito}" target="_blank" class="btn btn-sm btn-success py-0 px-1" title="Ver/descargar PDF" onclick="event.stopPropagation()"><i class="bi bi-file-earmark-pdf"></i></a></td>
      <td class="text-center">${canceladaConAcuse
        ? `<a href="/cfdi/acuse-notacredito?tipo=${tipo}&serie=${encodeURIComponent(fmt(r.Serie))}&idNotaCredito=${r.Id_NotaCredito}" target="_blank" class="btn btn-sm btn-danger py-0 px-1" title="Ver/descargar Acuse de Cancelación" onclick="event.stopPropagation()"><i class="bi bi-file-earmark-x"></i></a>`
        : `<button class="btn btn-sm btn-outline-secondary py-0 px-1" disabled title="Solo disponible si se canceló ante el SAT"><i class="bi bi-file-earmark-x"></i></button>`}</td>
      <td data-field="UUID" data-value="${fmt(r.UUID)}" style="display:none"></td>
      <td data-field="Id_Cliente" data-value="${r.Id_Cliente||''}" style="display:none"></td>
      <td data-field="FlagResNota" data-value="${r.FlagResNota||0}" style="display:none"></td>
    </tr>`;
    }).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/get', async (req, res) => {
  try {
    const pool = await getPool();
    const tipo = req.query.tipo, serie = req.query.serie, id = parseInt(req.query.id);
    // Empresa2.NotaCred no tiene columna propia de RFC del cliente -- se
    // trae por join con Clientes (igual que se corrigió en Pagos).
    const cabRes = await reqNC(pool.request(), tipo, serie, id).query(`
      SELECT nc.*, cli.RFC
      FROM Empresa2.NotaCred nc
      LEFT JOIN Empresa2.Clientes cli ON cli.ID_CLIENTE=nc.Id_Cliente
      WHERE nc.Id_NotaCredito=@id AND LTRIM(RTRIM(nc.Tipo))=@tipo AND ISNULL(LTRIM(RTRIM(nc.Serie)),'')=ISNULL(@serie,'')`);
    if (!cabRes.recordset[0]) return res.status(404).json({ error: 'No encontrada' });
    const detRes = await reqNC(pool.request(), tipo, serie, id).query(`SELECT * FROM Empresa2.NotaCredDeta WHERE ID_NOTACREDITO=@id AND ${NC_EQ} ORDER BY ID_NOTASCREDDETA`);
    res.json({ cabecera: cabRes.recordset[0], lineas: detRes.recordset });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lookup/numero-consecutivo', async (req, res) => {
  try {
    const pool = await getPool();
    const tipo = req.query.tipo === 'ND' ? 'ND' : 'NC';
    const serie = req.query.serie;
    const r = await reqNC(pool.request(), tipo, serie).query(`SELECT ISNULL(MAX(Id_NotaCredito),0)+1 AS next FROM Empresa2.NotaCred WHERE ${NC_EQ}`);
    res.json({ next: r.recordset[0].next });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Buscar Facturas de un cliente para referenciar como línea ─────────────
// excluirTipo/excluirSerie/excluirId (opcionales): si vienen, se excluyen las
// facturas que YA son línea de esa nota -- evita agregar la misma factura dos
// veces (antes solo se detectaba al fallar el guardado, si acaso).
router.get('/lookup/facturas', async (req, res) => {
  try {
    const pool = await getPool();
    const idCliente = parseInt(req.query.idCliente) || 0;
    if (!idCliente) return res.json({ rows: [], total: 0, totalPages: 1, page: 1 });
    const q = trim(req.query.q);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const excluirId = parseInt(req.query.excluirId) || 0;
    let where = `WHERE Id_Cliente=@idCliente AND LTRIM(RTRIM(ISNULL(Status,'')))<>'CANCELADA' AND LTRIM(RTRIM(ISNULL(Status,'')))<>'PAGADA'`;
    if (excluirId) {
      where += ` AND NOT EXISTS (
        SELECT 1 FROM Empresa2.NotaCredDeta d
        WHERE d.ID_NOTACREDITO=@excId AND LTRIM(RTRIM(d.TIPO))=@excTipo AND ISNULL(LTRIM(RTRIM(d.SERIE)),'')=ISNULL(@excSerie,'')
          AND d.ID_NOFACTURA=Factura.Id_NoFactura AND ISNULL(LTRIM(RTRIM(d.SerieFac)),'')=ISNULL(LTRIM(RTRIM(Factura.SerieFac)),'')
      )`;
    }
    const cr = pool.request().input('idCliente', sql.Decimal(7), idCliente);
    if (excluirId) cr.input('excId', sql.Decimal(7), excluirId).input('excTipo', sql.VarChar(3), trim(req.query.excluirTipo)).input('excSerie', sql.VarChar(10), serieKey(req.query.excluirSerie));
    if (q) { where += ` AND (CAST(Id_NoFactura AS VARCHAR(20)) LIKE @q)`; cr.input('q', `%${q}%`); }
    const cnt = await cr.query(`SELECT COUNT(*) total FROM Empresa2.Factura ${where}`);
    const total = cnt.recordset[0].total;
    const offset = (page - 1) * 10;
    const dr = pool.request().input('idCliente', sql.Decimal(7), idCliente);
    if (excluirId) dr.input('excId', sql.Decimal(7), excluirId).input('excTipo', sql.VarChar(3), trim(req.query.excluirTipo)).input('excSerie', sql.VarChar(10), serieKey(req.query.excluirSerie));
    if (q) dr.input('q', `%${q}%`);
    const data = await dr.query(`SELECT Id_NoFactura, LTRIM(RTRIM(SerieFac)) SerieFac, FechaFactura, TOTAL, PagosReal, NotasCredito, Status, UUID
                                  FROM Empresa2.Factura ${where} ORDER BY Id_NoFactura DESC OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`);
    const fmtDate = v => { if (!v) return ''; const d = v instanceof Date ? v : new Date(v); return d.toISOString().slice(0, 10); };
    res.json({
      rows: data.recordset.map(r => ({
        Id_NoFactura: r.Id_NoFactura, SerieFac: r.SerieFac || '', FechaFactura: fmtDate(r.FechaFactura),
        TOTAL: r.TOTAL || 0, Saldo: Math.max(0, num(r.TOTAL) - num(r.PagosReal) - num(r.NotasCredito)),
        Status: trim(r.Status), UUID: trim(r.UUID),
      })),
      total, totalPages: Math.ceil(total / 10) || 1, page,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Buscar Notas de Débito previas de un cliente para referenciar ─────────
// excluirTipo/excluirSerie/excluirId: mismo criterio que /lookup/facturas.
router.get('/lookup/notasdebito', async (req, res) => {
  try {
    const pool = await getPool();
    const idCliente = parseInt(req.query.idCliente) || 0;
    if (!idCliente) return res.json({ rows: [], total: 0, totalPages: 1, page: 1 });
    const q = trim(req.query.q);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const excluirId = parseInt(req.query.excluirId) || 0;
    let where = `WHERE LTRIM(RTRIM(Tipo))='ND' AND Id_Cliente=@idCliente AND LTRIM(RTRIM(ISNULL(Status,'')))<>'CANCELADO' AND LTRIM(RTRIM(ISNULL(Status,'')))<>'PAGADA'`;
    if (excluirId) {
      where += ` AND NOT EXISTS (
        SELECT 1 FROM Empresa2.NotaCredDeta d
        WHERE d.ID_NOTACREDITO=@excId AND LTRIM(RTRIM(d.TIPO))=@excTipo AND ISNULL(LTRIM(RTRIM(d.SERIE)),'')=ISNULL(@excSerie,'')
          AND d.Id_NotaDebito=NotaCred.Id_NotaCredito AND ISNULL(LTRIM(RTRIM(d.SerieND)),'')=ISNULL(LTRIM(RTRIM(NotaCred.Serie)),'')
      )`;
    }
    const cr = pool.request().input('idCliente', sql.Decimal(7), idCliente);
    if (excluirId) cr.input('excId', sql.Decimal(7), excluirId).input('excTipo', sql.VarChar(3), trim(req.query.excluirTipo)).input('excSerie', sql.VarChar(10), serieKey(req.query.excluirSerie));
    if (q) { where += ` AND (CAST(Id_NotaCredito AS VARCHAR(20)) LIKE @q)`; cr.input('q', `%${q}%`); }
    const cnt = await cr.query(`SELECT COUNT(*) total FROM Empresa2.NotaCred ${where}`);
    const total = cnt.recordset[0].total;
    const offset = (page - 1) * 10;
    const dr = pool.request().input('idCliente', sql.Decimal(7), idCliente);
    if (excluirId) dr.input('excId', sql.Decimal(7), excluirId).input('excTipo', sql.VarChar(3), trim(req.query.excluirTipo)).input('excSerie', sql.VarChar(10), serieKey(req.query.excluirSerie));
    if (q) dr.input('q', `%${q}%`);
    const data = await dr.query(`SELECT Id_NotaCredito, LTRIM(RTRIM(Serie)) Serie, Fecha, ImporteTotal, Status, UUID
                                  FROM Empresa2.NotaCred ${where} ORDER BY Id_NotaCredito DESC OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`);
    const fmtDate = v => { if (!v) return ''; const d = v instanceof Date ? v : new Date(v); return d.toISOString().slice(0, 10); };
    res.json({
      rows: data.recordset.map(r => ({
        Id_NotaDebito: r.Id_NotaCredito, SerieND: r.Serie || '', Fecha: fmtDate(r.Fecha),
        ImporteTotal: r.ImporteTotal || 0, Status: trim(r.Status), UUID: trim(r.UUID),
      })),
      total, totalPages: Math.ceil(total / 10) || 1, page,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lookup/cliente-defaults', async (req, res) => {
  try {
    const pool = await getPool();
    const idCliente = parseInt(req.query.idCliente);
    const r = await pool.request().input('id', sql.Decimal(7), idCliente)
      .query(`SELECT ID_CLIENTE, NOMBRECOMUN, NOMBRECOM, RFC FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
    if (!r.recordset[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
    const c = r.recordset[0];
    res.json({ NOMBRECOMUN: trim(c.NOMBRECOMUN), NOMBRECOM: trim(c.NOMBRECOM), RFC: trim(c.RFC) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AGREGAR LÍNEA (contra Factura o Nota de Débito previa) ────────────────
router.post('/partida/agregar', requierePermiso('notacred.editar'), async (req, res) => {
  const f = req.body;
  try {
    const pool = await getPool();
    const result = await withTransaction(pool, async (tx) => {
      const tipo = f.tipo === 'ND' ? 'ND' : 'NC';
      const esFactura = !!f.idNoFactura;
      const esND = !!f.idNotaDebito;
      if (esFactura === esND) {
        throw Object.assign(new Error('La línea debe referenciar exactamente una Factura O una Nota de Débito previa.'), { status: 400 });
      }
      const idCliente = parseInt(f.idCliente);
      if (!idCliente) throw Object.assign(new Error('Debe seleccionar un cliente.'), { status: 400 });

      let origen; // { total, pagosReal, notasCredito, subtotal, iva, reten, uuid, idCliente, serieRef, idRef, anio }
      if (esFactura) {
        const idNoFactura = parseInt(f.idNoFactura);
        const serieFacRef = serieKey(f.serieFacRef);
        const facRes = await new sql.Request(tx)
          .input('id', sql.Decimal(9), idNoFactura).input('serieFac', sql.VarChar(20), serieFacRef)
          .query(`SELECT * FROM Empresa2.Factura WITH (UPDLOCK, ROWLOCK)
                  WHERE Id_NoFactura=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'')`);
        const fac = facRes.recordset[0];
        if (!fac) throw Object.assign(new Error('No existe esa Factura.'), { status: 400 });
        const st = trim(fac.Status).toUpperCase();
        if (st === 'PAGADA' || st === 'CANCELADA') {
          throw Object.assign(new Error('La factura ya está pagada o cancelada.'), { status: 400 });
        }
        if (Number(fac.Id_Cliente) !== idCliente) {
          throw Object.assign(new Error('El cliente de la Factura no coincide con el de la nota.'), { status: 400 });
        }
        // Pedido/CP: solo informativo (columna PEDIDO, char(30)) -- lista de
        // folios de Carta Porte que componen esta Factura (FacDeta.CARTAPORTE),
        // no afecta ningún cálculo. Se omite si la factura no trae ninguno.
        const cpRes = await new sql.Request(tx)
          .input('id', sql.Decimal(9), idNoFactura).input('serieFac', sql.VarChar(20), serieFacRef)
          .query(`SELECT DISTINCT LTRIM(RTRIM(CARTAPORTE)) AS CP FROM Empresa2.FacDeta
                  WHERE ID_NOFACTURA=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'') AND LTRIM(RTRIM(ISNULL(CARTAPORTE,'')))<>''`);
        const pedido = cpRes.recordset.map(r => r.CP).join(', ').slice(0, 30) || null;
        origen = {
          total: num(fac.TOTAL), pagosReal: num(fac.PagosReal), notasCredito: num(fac.NotasCredito),
          subtotal: num(fac.SubTotal), iva: num(fac.IVA), reten: num(fac.Retencion), moneda: trim(fac.MonFactura) || 'MXN',
          uuid: trim(fac.UUID), idPedido: 0, serieRef: serieFacRef, idRef: idNoFactura, anio: null,
          esFactura: true, pedido,
        };
      } else {
        const idNotaDebito = parseInt(f.idNotaDebito);
        const serieND = serieKey(f.serieND);
        const ndRes = await new sql.Request(tx)
          .input('id', sql.Decimal(7), idNotaDebito).input('serie', sql.VarChar(10), serieND)
          .query(`SELECT * FROM Empresa2.NotaCred WITH (UPDLOCK, ROWLOCK)
                  WHERE Id_NotaCredito=@id AND LTRIM(RTRIM(Tipo))='ND' AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`);
        const nd = ndRes.recordset[0];
        if (!nd) throw Object.assign(new Error('No existe esa Nota de Débito.'), { status: 400 });
        const st = trim(nd.Status).toUpperCase();
        if (st === 'PAGADA' || st === 'CANCELADO') {
          throw Object.assign(new Error('La Nota de Débito ya está pagada o cancelada.'), { status: 400 });
        }
        if (Number(nd.Id_Cliente) !== idCliente) {
          throw Object.assign(new Error('El cliente de la Nota de Débito no coincide con el de la nota.'), { status: 400 });
        }
        // Una ND no trae PagosReal/NotasCredito propios en este alcance -- su saldo es su propio ImporteTotal.
        origen = {
          total: num(nd.ImporteTotal), pagosReal: 0, notasCredito: 0,
          subtotal: num(nd.Subtotal), iva: num(nd.IVA), reten: num(nd.Retencion), moneda: 'MXN',
          uuid: trim(nd.UUID), serieRef: serieND, idRef: idNotaDebito, anio: null,
          esFactura: false, pedido: null, // una ND no compone Cartas Porte propias
        };
      }

      const saldo = Math.round(Math.max(origen.total - origen.pagosReal - origen.notasCredito, 0) * 100) / 100;
      if (saldo <= 0.005) {
        throw Object.assign(new Error('Ya no queda saldo pendiente sobre ese documento.'), { status: 400 });
      }

      // Cabecera: crear en borrador si es la primera línea.
      let idNotaCredito = parseInt(f.idNotaCredito) || 0;
      let serieCab = serieKey(f.serieCab);
      if (!idNotaCredito) {
        const nextRes = await reqNC(new sql.Request(tx), tipo, serieCab).query(`SELECT ISNULL(MAX(Id_NotaCredito),0)+1 AS next FROM Empresa2.NotaCred WITH (UPDLOCK, HOLDLOCK) WHERE ${NC_EQ}`);
        idNotaCredito = nextRes.recordset[0].next;
        const cli = await new sql.Request(tx).input('id', sql.Decimal(7), idCliente).query(`SELECT NOMBRECOMUN, NOMBRECOM FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
        const defaults = DEFAULTS_TIPO[tipo];
        const esResumen = f.esResumen ? 1 : 0;
        await reqNC(new sql.Request(tx), tipo, serieCab, idNotaCredito)
          .input('fecha', sql.Date, hoy()).input('hora', sql.VarChar(8), new Date().toTimeString().slice(0, 8))
          .input('idCli', sql.Decimal(7), idCliente).input('nombreCom', sql.VarChar(150), trim(cli.recordset[0]?.NOMBRECOMUN) || trim(cli.recordset[0]?.NOMBRECOM))
          // BORRADOR hasta que /cabecera/grabar la pase a EMITIDA -- si se queda
          // así, /cabecera/cancelar-sin-confirmar puede detectar que nunca se
          // grabó y borrarla. Antes se insertaba directo en 'EMITIDA', lo que
          // dejaba huérfana cualquier nota abandonada sin grabar (verificado en
          // vivo: cancelar-sin-confirmar nunca borraba nada).
          .input('status', sql.VarChar(20), 'BORRADOR')
          .input('cformapago', sql.VarChar(4), trim(f.c_FormaPago) || defaults.c_FormaPago)
          .input('clavemp', sql.VarChar(3), trim(f.ClaveMP) || defaults.ClaveMP)
          .input('cusocfdi', sql.VarChar(5), trim(f.c_UsoCFDI) || defaults.c_UsoCFDI)
          .input('ctiporel', sql.VarChar(3), trim(f.c_TipoRelacion) || defaults.c_TipoRelacion)
          .input('cclaveprodserv', sql.VarChar(20), trim(f.c_ClaveProdServ) || defaults.c_ClaveProdServ)
          .input('cclaveunidad', sql.VarChar(5), trim(f.c_ClaveUnidad) || defaults.c_ClaveUnidad)
          .input('descripcion', sql.VarChar(100), trim(f.Descripcion) || defaults.Descripcion)
          .input('flagres', sql.TinyInt, esResumen)
          .input('whois', sql.VarChar(80), [req.session.usuario.nombre, req.session.usuario.apellido].filter(Boolean).join(' '))
          .query(`INSERT INTO Empresa2.NotaCred(
            Serie, Id_NotaCredito, Fecha, Hora, Id_Cliente, NombreCom, TipoFactura, Status,
            c_FormaPago, ClaveMP, c_UsoCFDI, c_TipoRelacion, c_ClaveProdServ, c_ClaveUnidad, Descripcion,
            FlagResNota, Tipo, Subtotal, IVA, Retencion, ImporteTotal, SumaPartidas, WhoIs
          ) VALUES(
            ISNULL(@serie,''), @id, @fecha, @hora, @idCli, @nombreCom, 'Pesos', @status,
            @cformapago, @clavemp, @cusocfdi, @ctiporel, @cclaveprodserv, @cclaveunidad, @descripcion,
            @flagres, @tipo, 0, 0, 0, 0, 0, @whois
          )`);
      } else {
        const cabRes = await reqNC(new sql.Request(tx), tipo, serieCab, idNotaCredito).query(`SELECT Status FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
        if (!cabRes.recordset[0]) throw Object.assign(new Error('Nota no encontrada.'), { status: 400 });

        // Defensa por si el browse de selección quedó desactualizado (ej. dos
        // pestañas abiertas) -- el mismo documento no puede quedar dos veces
        // como línea de la misma nota.
        const dupReq = new sql.Request(tx).input('id', sql.Decimal(7), idNotaCredito);
        let dupWhere;
        if (origen.esFactura) {
          dupReq.input('idnofactura', sql.Decimal(7), origen.idRef).input('seriefac', sql.VarChar(20), origen.serieRef);
          dupWhere = `ID_NOFACTURA=@idnofactura AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@seriefac,'')`;
        } else {
          dupReq.input('idnd', sql.Decimal(7), origen.idRef).input('seriend', sql.VarChar(20), origen.serieRef);
          dupWhere = `Id_NotaDebito=@idnd AND ISNULL(LTRIM(RTRIM(SerieND)),'')=ISNULL(@seriend,'')`;
        }
        const dupRes = await reqNC(dupReq, tipo, serieCab).query(`SELECT TOP 1 1 AS x FROM Empresa2.NotaCredDeta WHERE ID_NOTACREDITO=@id AND ${NC_EQ} AND ${dupWhere}`);
        if (dupRes.recordset[0]) {
          throw Object.assign(new Error(origen.esFactura ? 'Esa Factura ya fue agregada a esta nota.' : 'Esa Nota de Débito ya fue agregada a esta nota.'), { status: 400 });
        }
      }

      // Importe a aplicar: todo el saldo disponible (el usuario puede ajustarlo
      // después con /linea/actualizar-importe si la nota es detallada). Esto
      // aplica igual en resumen -- ahí es el importe operativo que reduce el
      // saldo de ESE documento en /cabecera/grabar, independiente del importe
      // declarado en el concepto único de cabecera (ver /cabecera/importe-resumen).
      const importeAplica = saldo;
      const subtotalLinea = origen.subtotal;
      const ivaLinea = origen.iva;
      const retenLinea = origen.reten;
      const nextDetaRes = await reqNC(new sql.Request(tx), tipo, serieCab, idNotaCredito).query(`SELECT ISNULL(MAX(ID_NOTASCREDDETA),0)+1 AS next FROM Empresa2.NotaCredDeta WHERE ID_NOTACREDITO=@id AND ${NC_EQ}`);
      const idDeta = nextDetaRes.recordset[0].next;

      const req2 = new sql.Request(tx)
        .input('serie', sql.VarChar(10), serieKey(serieCab)).input('id', sql.Decimal(7), idNotaCredito).input('idd', sql.Decimal(7), idDeta)
        .input('idcli', sql.Decimal(7), idCliente).input('tipo', sql.VarChar(3), tipo)
        .input('totalfac', sql.Decimal(11,2), origen.total).input('pagosrealfac', sql.Decimal(11,2), origen.pagosReal)
        .input('notascreditofac', sql.Decimal(11,2), origen.notasCredito)
        .input('reten', sql.Decimal(9,2), retenLinea).input('sub', sql.Decimal(11,2), subtotalLinea)
        .input('iva', sql.Decimal(9,2), ivaLinea).input('importeaplica', sql.Decimal(11,2), importeAplica)
        .input('pedido', sql.VarChar(30), origen.pedido || null)
        .input('desc', sql.VarChar(1000), trim(f.descripcionLinea) || null);
      if (origen.esFactura) {
        req2.input('idnofactura', sql.Decimal(7), origen.idRef).input('seriefac', sql.VarChar(20), origen.serieRef)
          .input('uuidfac', sql.VarChar(60), origen.uuid || null).input('idnd', sql.Decimal(7), 0).input('seriend', sql.VarChar(20), null);
      } else {
        req2.input('idnofactura', sql.Decimal(7), 0).input('seriefac', sql.VarChar(20), null).input('uuidfac', sql.VarChar(60), origen.uuid || null)
          .input('idnd', sql.Decimal(7), origen.idRef).input('seriend', sql.VarChar(20), origen.serieRef);
      }
      await req2.query(`INSERT INTO Empresa2.NotaCredDeta(
        SERIE, ID_NOTACREDITO, ID_NOTASCREDDETA, ID_CLIENTE, TIPO,
        ID_NOFACTURA, SerieFac, UUIDFac, Id_NotaDebito, SerieND, PEDIDO,
        TOTALFAC, PAGOSREALFAC, NOTASCREDITOFAC, RETENCION, SUBTOTAL, IVA, IMPORTEAPLICA, DESNOTACREDITO
      ) VALUES(
        ISNULL(@serie,''), @id, @idd, @idcli, @tipo,
        @idnofactura, @seriefac, @uuidfac, @idnd, @seriend, @pedido,
        @totalfac, @pagosrealfac, @notascreditofac, @reten, @sub, @iva, @importeaplica, @desc
      )`);

      const totales = await recalcularCabecera(tx, tipo, serieCab, idNotaCredito);
      return { idNotaCredito, serie: serieCab || '', idDeta, totales };
    });
    res.json({ ok: true, ...result });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── AJUSTAR el importe de una línea a mano (topado al saldo disponible) ───
// IVA (16%)/Retención (4%) se recalculan sobre el nuevo subtotal SOLO si el
// documento original ya traía ese concepto (IVA>0 / Retención>0 respectivamente,
// consultado en vivo) -- no se inventa un impuesto donde el original no lo tenía.
router.post('/linea/actualizar-importe', requierePermiso('notacred.editar'), async (req, res) => {
  const { tipo, serie, idNotaCredito, idDeta, subtotal } = req.body;
  try {
    const pool = await getPool();
    const result = await withTransaction(pool, async (tx) => {
      const lineaRes = await reqNC(new sql.Request(tx), tipo, serie, parseInt(idNotaCredito))
        .input('idd', sql.Decimal(7), parseInt(idDeta))
        .query(`SELECT * FROM Empresa2.NotaCredDeta WITH (UPDLOCK, ROWLOCK) WHERE ID_NOTACREDITO=@id AND ID_NOTASCREDDETA=@idd AND ${NC_EQ}`);
      const linea = lineaRes.recordset[0];
      if (!linea) throw Object.assign(new Error('Línea no encontrada.'), { status: 404 });

      let ivaOriginal, retOriginal;
      if (Number(linea.ID_NOFACTURA) > 0) {
        const facRes = await new sql.Request(tx).input('id', sql.Decimal(9), linea.ID_NOFACTURA).input('serieFac', sql.VarChar(20), serieKey(linea.SerieFac))
          .query(`SELECT IVA, Retencion FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'')`);
        ivaOriginal = num(facRes.recordset[0]?.IVA); retOriginal = num(facRes.recordset[0]?.Retencion);
      } else {
        const ndRes = await new sql.Request(tx).input('id', sql.Decimal(7), linea.Id_NotaDebito).input('serie', sql.VarChar(10), serieKey(linea.SerieND))
          .query(`SELECT IVA, Retencion FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND LTRIM(RTRIM(Tipo))='ND' AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`);
        ivaOriginal = num(ndRes.recordset[0]?.IVA); retOriginal = num(ndRes.recordset[0]?.Retencion);
      }

      const saldoDisponible = Math.round(Math.max(num(linea.TOTALFAC) - num(linea.PAGOSREALFAC) - num(linea.NOTASCREDITOFAC), 0) * 100) / 100;
      let nuevoSubtotal = Math.max(0, num(subtotal));
      let limitado = false;
      // El tope debe aplicar sobre el IMPORTE FINAL (subtotal+IVA-retención), no
      // sobre el subtotal crudo -- de lo contrario, sumar IVA encima de un
      // subtotal ya topado al saldo produce un total que excede ese mismo saldo.
      const factorNeto = 1 + (ivaOriginal > 0.005 ? 0.16 : 0) - (retOriginal > 0.005 ? 0.04 : 0);
      const aplicaBruto = Math.round(nuevoSubtotal * factorNeto * 100) / 100;
      if (aplicaBruto > saldoDisponible) {
        nuevoSubtotal = Math.round((saldoDisponible / factorNeto) * 100) / 100;
        limitado = true;
      }
      const nuevoIVA = ivaOriginal > 0.005 ? Math.round(nuevoSubtotal * 0.16 * 100) / 100 : 0;
      const nuevoRet = retOriginal > 0.005 ? Math.round(nuevoSubtotal * 0.04 * 100) / 100 : 0;
      const nuevoAplica = Math.round((nuevoSubtotal + nuevoIVA - nuevoRet) * 100) / 100;

      await reqNC(new sql.Request(tx), tipo, serie, parseInt(idNotaCredito))
        .input('idd', sql.Decimal(7), parseInt(idDeta))
        .input('sub', sql.Decimal(11,2), nuevoSubtotal).input('iva', sql.Decimal(9,2), nuevoIVA)
        .input('ret', sql.Decimal(9,2), nuevoRet).input('apl', sql.Decimal(11,2), nuevoAplica)
        .query(`UPDATE Empresa2.NotaCredDeta SET SUBTOTAL=@sub, IVA=@iva, RETENCION=@ret, IMPORTEAPLICA=@apl WHERE ID_NOTACREDITO=@id AND ID_NOTASCREDDETA=@idd AND ${NC_EQ}`);

      const totales = await recalcularCabecera(tx, tipo, serie, parseInt(idNotaCredito));
      return { limitado, saldoDisponible, totales };
    });
    res.json({ ok: true, ...result });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── AJUSTAR la descripción propia de una línea (DESNOTACREDITO) ───────────
// Solo aplica su propia descripción en el CFDI cuando la nota es detallada
// (un <cfdi:Concepto> por línea) -- en resumen todas las líneas comparten
// el único concepto de cabecera, ver cfdi-notacredito.js.
router.post('/linea/actualizar-descripcion', requierePermiso('notacred.editar'), async (req, res) => {
  const { tipo, serie, idNotaCredito, idDeta, descripcion } = req.body;
  try {
    const pool = await getPool();
    await reqNC(pool.request(), tipo, serie, parseInt(idNotaCredito))
      .input('idd', sql.Decimal(7), parseInt(idDeta))
      .input('desc', sql.VarChar(1000), trim(descripcion) || null)
      .query(`UPDATE Empresa2.NotaCredDeta SET DESNOTACREDITO=@desc WHERE ID_NOTACREDITO=@id AND ID_NOTASCREDDETA=@idd AND ${NC_EQ}`);
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/partida/eliminar', requierePermiso('notacred.editar'), async (req, res) => {
  const { tipo, serie, idNotaCredito, idDeta } = req.body;
  try {
    const pool = await getPool();
    await withTransaction(pool, async (tx) => {
      await reqNC(new sql.Request(tx), tipo, serie, parseInt(idNotaCredito))
        .input('idd', sql.Decimal(7), parseInt(idDeta))
        .query(`DELETE FROM Empresa2.NotaCredDeta WHERE ID_NOTACREDITO=@id AND ID_NOTASCREDDETA=@idd AND ${NC_EQ}`);
      await recalcularCabecera(tx, tipo, serie, parseInt(idNotaCredito));
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── ACTUALIZAR CAMPOS DE CABECERA (resumen / catálogos fiscales) ──────────
router.post('/cabecera/actualizar', requierePermiso('notacred.editar'), async (req, res) => {
  const { tipo, serie, idNotaCredito } = req.body;
  const id = parseInt(idNotaCredito);
  if (!id) return res.status(400).json({ error: 'Nota inválida.' });
  try {
    const pool = await getPool();
    const result = await withTransaction(pool, async (tx) => {
      const cabRes = await reqNC(new sql.Request(tx), tipo, serie, id).query(`SELECT UUID FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
      if (!cabRes.recordset[0]) throw Object.assign(new Error('Nota no encontrada.'), { status: 404 });
      const yaTimbrada = !!trim(cabRes.recordset[0].UUID);

      const r2 = reqNC(new sql.Request(tx), tipo, serie, id)
        .input('flagres', sql.TinyInt, req.body.esResumen ? 1 : 0);
      let sets = ['FlagResNota=@flagres'];
      if (!yaTimbrada) {
        if (trim(req.body.fecha)) { r2.input('fecha', sql.Date, trim(req.body.fecha)); sets.push('Fecha=@fecha'); }
        if (trim(req.body.c_FormaPago)) { r2.input('cformapago', sql.VarChar(4), trim(req.body.c_FormaPago)); sets.push('c_FormaPago=@cformapago'); }
        if (trim(req.body.ClaveMP)) { r2.input('clavemp', sql.VarChar(3), trim(req.body.ClaveMP)); sets.push('ClaveMP=@clavemp'); }
        if (trim(req.body.c_UsoCFDI)) { r2.input('cusocfdi', sql.VarChar(5), trim(req.body.c_UsoCFDI)); sets.push('c_UsoCFDI=@cusocfdi'); }
        if (trim(req.body.c_TipoRelacion)) { r2.input('ctiporel', sql.VarChar(3), trim(req.body.c_TipoRelacion)); sets.push('c_TipoRelacion=@ctiporel'); }
        if (trim(req.body.c_ClaveProdServ)) { r2.input('cclaveprodserv', sql.VarChar(20), trim(req.body.c_ClaveProdServ)); sets.push('c_ClaveProdServ=@cclaveprodserv'); }
        if (trim(req.body.c_ClaveUnidad)) { r2.input('cclaveunidad', sql.VarChar(5), trim(req.body.c_ClaveUnidad)); sets.push('c_ClaveUnidad=@cclaveunidad'); }
        if (trim(req.body.descripcion) !== '') { r2.input('descripcion', sql.VarChar(100), trim(req.body.descripcion)); sets.push('Descripcion=@descripcion'); }
      }
      await r2.query(`UPDATE Empresa2.NotaCred SET ${sets.join(', ')} WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
      return await recalcularCabecera(tx, tipo, serie, id);
    });
    res.json({ ok: true, totales: result });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── IMPORTE DE CABECERA EN MODO RESUMEN ───────────────────────────────────
// En resumen puede haber varias líneas/documentos referenciados, pero el CFDI
// se timbra con UN SOLO concepto -- su importe se captura aquí directamente
// sobre NotaCred (no se suma desde NotaCredDeta, ver recalcularCabecera).
// Solo se recibe el Subtotal; IVA (16%) y Retención (4%) se calculan siempre
// en automático, Total = Subtotal+IVA-Retención.
router.post('/cabecera/importe-resumen', requierePermiso('notacred.editar'), async (req, res) => {
  const { tipo, serie, idNotaCredito, subtotal } = req.body;
  const id = parseInt(idNotaCredito);
  if (!id) return res.status(400).json({ error: 'Nota inválida.' });
  try {
    const pool = await getPool();
    const result = await withTransaction(pool, async (tx) => {
      const cabRes = await reqNC(new sql.Request(tx), tipo, serie, id)
        .query(`SELECT UUID, FlagResNota FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
      const cab = cabRes.recordset[0];
      if (!cab) throw Object.assign(new Error('Nota no encontrada.'), { status: 404 });
      if (Number(cab.FlagResNota) !== 1) throw Object.assign(new Error('Esta nota no está en modo resumen.'), { status: 400 });
      if (trim(cab.UUID)) throw Object.assign(new Error('La nota ya está timbrada; no se puede modificar el importe.'), { status: 400 });

      // Tope de seguridad: el concepto único declarado no debe exceder la suma
      // del saldo pendiente de TODOS los documentos referenciados por la nota
      // (no se exige que coincida exactamente, solo que no la exceda).
      const lineasRes = await reqNC(new sql.Request(tx), tipo, serie, id)
        .query(`SELECT TOTALFAC, PAGOSREALFAC, NOTASCREDITOFAC FROM Empresa2.NotaCredDeta WHERE ID_NOTACREDITO=@id AND ${NC_EQ}`);
      if (!lineasRes.recordset.length) throw Object.assign(new Error('Agregue primero al menos una Factura o Nota de Débito de referencia.'), { status: 400 });
      const saldoDisponible = Math.round(lineasRes.recordset.reduce((acc, r) =>
        acc + Math.max(num(r.TOTALFAC) - num(r.PAGOSREALFAC) - num(r.NOTASCREDITOFAC), 0), 0) * 100) / 100;

      const FACTOR_NETO = 1.12; // 1 + IVA(16%) - Retención(4%)
      let nuevoSub = Math.max(0, num(subtotal));
      let limitado = false;
      if (Math.round(nuevoSub * FACTOR_NETO * 100) / 100 > saldoDisponible) {
        nuevoSub = Math.round((saldoDisponible / FACTOR_NETO) * 100) / 100;
        limitado = true;
      }
      const nuevoIva = Math.round(nuevoSub * 0.16 * 100) / 100;
      const nuevoRet = Math.round(nuevoSub * 0.04 * 100) / 100;
      const total = Math.round((nuevoSub + nuevoIva - nuevoRet) * 100) / 100;
      const importeLetras = importeALetras(total, 'MXN');

      await reqNC(new sql.Request(tx), tipo, serie, id)
        .input('sub', sql.Decimal(9,2), nuevoSub).input('iva', sql.Decimal(10,2), nuevoIva)
        .input('ret', sql.Decimal(9,2), nuevoRet).input('tot', sql.Decimal(12,2), total)
        .input('letras', sql.VarChar(200), importeLetras)
        .query(`UPDATE Empresa2.NotaCred SET Subtotal=@sub, IVA=@iva, Retencion=@ret, ImporteTotal=@tot, SumaPartidas=@tot, ImporteLetras=@letras WHERE Id_NotaCredito=@id AND ${NC_EQ}`);

      return { limitado, saldoDisponible, totales: { Subtotal: nuevoSub, IVA: nuevoIva, Retencion: nuevoRet, ImporteTotal: total, ImporteLetras: importeLetras } };
    });
    res.json({ ok: true, ...result });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── GRABAR: aplica el efecto de la nota sobre el saldo de cada documento ──
router.post('/cabecera/grabar', requierePermiso('notacred.editar'), async (req, res) => {
  const { tipo, serie, idNotaCredito } = req.body;
  const id = parseInt(idNotaCredito);
  if (!id) return res.status(400).json({ error: 'Nota inválida.' });
  try {
    const pool = await getPool();
    await withTransaction(pool, async (tx) => {
      const detRes = await reqNC(new sql.Request(tx), tipo, serie, id).query(`SELECT * FROM Empresa2.NotaCredDeta WHERE ID_NOTACREDITO=@id AND ${NC_EQ}`);
      if (!detRes.recordset.length) throw Object.assign(new Error('La nota no tiene líneas.'), { status: 400 });
      const anio = new Date().getFullYear();

      for (const linea of detRes.recordset) {
        const importe = num(linea.IMPORTEAPLICA);
        if (importe <= 0.005) continue;
        if (Number(linea.ID_NOFACTURA) > 0) {
          await ajustarSaldoFactura(tx, 'nota_credito', {
            idNoFactura: linea.ID_NOFACTURA, serieFac: linea.SerieFac, importe, signo: 1, anio,
          });
        } else if (Number(linea.Id_NotaDebito) > 0) {
          await ajustarSaldoNotaDebito(tx, { idNotaDebito: linea.Id_NotaDebito, serieND: linea.SerieND, importeAplicado: importe });
        }
      }

      await reqNC(new sql.Request(tx), tipo, serie, id).query(`UPDATE Empresa2.NotaCred SET Status='EMITIDA' WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── Borra el borrador si el usuario cierra sin grabar (sin efecto aplicado) ─
router.post('/cabecera/cancelar-sin-confirmar', requierePermiso('notacred.editar'), async (req, res) => {
  const { tipo, serie, idNotaCredito } = req.body;
  const id = parseInt(idNotaCredito);
  if (!id) return res.json({ ok: true });
  try {
    const pool = await getPool();
    await withTransaction(pool, async (tx) => {
      const cabRes = await reqNC(new sql.Request(tx), tipo, serie, id).query(`SELECT Status, UUID FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
      const cab = cabRes.recordset[0];
      // Solo se borra si nunca se llegó a "grabar" (Status EMITIDA se pone justo
      // en /cabecera/grabar) y nunca se timbró -- de lo contrario no se toca.
      if (cab && trim(cab.Status).toUpperCase() !== 'EMITIDA' && !trim(cab.UUID)) {
        await reqNC(new sql.Request(tx), tipo, serie, id).query(`DELETE FROM Empresa2.NotaCredDeta WHERE ID_NOTACREDITO=@id AND ${NC_EQ}`);
        await reqNC(new sql.Request(tx), tipo, serie, id).query(`DELETE FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
      }
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── CANCELAR una nota ya emitida: revierte el efecto de saldo en cascada ──
// NOTA: la cancelación FISCAL ante el PAC (si la nota tiene UUID) se maneja
// en app/routes/cfdi.js (POST /cancelar-notacredito), que llama a esta misma
// reversión de saldo solo después de que el PAC confirma la cancelación.
async function revertirEfectoSaldo(tx, tipo, serie, id) {
  const detRes = await reqNC(new sql.Request(tx), tipo, serie, id).query(`SELECT * FROM Empresa2.NotaCredDeta WHERE ID_NOTACREDITO=@id AND ${NC_EQ}`);
  for (const linea of detRes.recordset) {
    const importe = num(linea.IMPORTEAPLICA);
    if (importe <= 0.005) continue;
    if (Number(linea.ID_NOFACTURA) > 0) {
      await ajustarSaldoFactura(tx, 'nota_credito', {
        idNoFactura: linea.ID_NOFACTURA, serieFac: linea.SerieFac, importe, signo: -1,
      });
    } else if (Number(linea.Id_NotaDebito) > 0) {
      await ajustarSaldoNotaDebito(tx, { idNotaDebito: linea.Id_NotaDebito, serieND: linea.SerieND, importeAplicado: 0 });
    }
  }
}

router.post('/cancelar', requierePermiso('notacred.btn_cancelar'), async (req, res) => {
  const { tipo, serie, idNotaCredito } = req.body;
  const id = parseInt(idNotaCredito);
  if (!id) return res.status(400).json({ error: 'Nota inválida.' });
  try {
    const pool = await getPool();
    const cabRes = await reqNC(pool.request(), tipo, serie, id).query(`SELECT Status, UUID FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
    const cab = cabRes.recordset[0];
    if (!cab) return res.status(404).json({ error: 'Nota no encontrada.' });
    if (trim(cab.Status).toUpperCase() === 'CANCELADO') return res.status(400).json({ error: 'Ya está cancelada.' });
    if (trim(cab.UUID)) {
      return res.status(409).json({ error: 'Esta nota ya está timbrada; debe cancelarse fiscalmente primero (usar el flujo de Cancelar con PAC).', requiereFiscal: true });
    }
    await withTransaction(pool, async (tx) => {
      await revertirEfectoSaldo(tx, tipo, serie, id);
      await reqNC(new sql.Request(tx), tipo, serie, id).query(`UPDATE Empresa2.NotaCred SET Status='CANCELADO' WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
// Reexpuesto para que app/routes/cfdi.js pueda revertir el efecto de saldo
// SOLO después de que el PAC confirme la cancelación fiscal (POST /cfdi/cancelar-notacredito).
module.exports.revertirEfectoSaldo = revertirEfectoSaldo;
