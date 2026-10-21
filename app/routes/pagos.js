const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');
const { requierePermiso } = require('../middleware/permisos');
const { ajustarSaldoFactura, ajustarSaldoNotaDebito, aplicadoND, recalcularStatusND } = require('../services/saldo-factura');
const conciliacion = require('../services/conciliacion-saldos');
const { quienAplica } = require('../services/docs-aplicados');

// Empresa2.Pagos/PagFac NO están particionadas por año a diferencia del
// legado (Pagos19..Pagos25, PagFac19..PagFac25 son archivos históricos que no
// se tocan) -- este módulo usa únicamente las tablas base, igual que Factura.
// Id_NoPago no es IDENTITY (mismo patrón MAX+1 que el resto del proyecto).
const trim = v => (v == null ? '' : String(v).trim());
const num = v => (v === '' || v == null || isNaN(parseFloat(v))) ? 0 : parseFloat(v);
const serieKey = v => { const t = trim(v); return t || null; };
const hoy = () => new Date().toISOString().slice(0, 10);
// HH:MM o HH:MM:SS -> HH:MM:SS; vacío/ inválido -> null
const horaValida = v => { const m = /^(d{2}):(d{2})(?::(d{2}))?$/.exec(trim(v)); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1]}:${m[2]}:${m[3] || '00'}` : null; };

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

router.get('/', (req, res) => res.render('pagos', { usuario: req.session.usuario, modulo: 'pagos' }));

// ── BROWSE ──────────────────────────────────────────────────────────────────
router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'Empresa2.Pagos',
      columns: ['Id_NoPago', 'Fecha', 'FechaPago', 'Id_Cliente', 'NombreCom', 'NomClientePago', 'SumaPartidas', 'TotalImporte', 'Status', 'FlagCompensacion', 'UUID'],
      searchableCols: ['Id_NoPago', 'NombreCom', 'NomClientePago', 'Status'],
      req,
    });
    const fmt = v => v == null ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());
    // Fecha visible dd/mm/aaaa (data-value conserva ISO aaaa-mm-dd).
    const fmtF = v => { const t = fmt(v); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); return m ? `${m[3]}/${m[2]}/${m[1]}` : t; };
    const fmtN = v => {
      const n = v == null ? 0 : Number(v);
      const signo = n < 0 ? '-' : '';
      return signo + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    const rows = data.rows.map(r => {
      const canceladoConAcuse = fmt(r.Status).toUpperCase() === 'CANCELADO' && !!fmt(r.UUID);
      return `<tr data-id="${r.Id_NoPago}">
      <td data-field="Id_NoPago" data-value="${r.Id_NoPago}">${r.Id_NoPago}</td>
      <td data-field="Fecha" data-value="${fmt(r.Fecha)}">${fmtF(r.Fecha)}</td>
      <td data-field="FechaPago" data-value="${fmt(r.FechaPago)}">${fmtF(r.FechaPago)}</td>
      <td data-field="NombreCom" data-value="${fmt(r.NombreCom)}">${fmt(r.NombreCom)}</td>
      <td data-field="NomClientePago" data-value="${fmt(r.NomClientePago)}">${fmt(r.NomClientePago)}</td>
      <td data-field="TotalImporte" data-value="${r.TotalImporte||0}" class="text-end">${fmtN(r.TotalImporte)}</td>
      <td data-field="Status" data-value="${fmt(r.Status)}">${fmt(r.Status)}</td>
      <td class="text-center">${fmt(r.UUID)
        ? `<a href="/cfdi/xml-pago?idNoPago=${r.Id_NoPago}" class="btn btn-sm btn-primary py-0 px-1" title="Descargar XML" onclick="event.stopPropagation()"><i class="bi bi-file-earmark-code"></i></a>`
        : `<button class="btn btn-sm btn-outline-secondary py-0 px-1" disabled title="Solo disponible una vez timbrado"><i class="bi bi-file-earmark-code"></i></button>`}</td>
      <td class="text-center"><a href="/cfdi/pdf-pago?idNoPago=${r.Id_NoPago}" target="_blank" class="btn btn-sm btn-success py-0 px-1" title="Ver/descargar PDF" onclick="event.stopPropagation()"><i class="bi bi-file-earmark-pdf"></i></a></td>
      <td class="text-center">${canceladoConAcuse
        ? `<a href="/cfdi/acuse-pago?idNoPago=${r.Id_NoPago}" target="_blank" class="btn btn-sm btn-danger py-0 px-1" title="Ver/descargar Acuse de Cancelación" onclick="event.stopPropagation()"><i class="bi bi-file-earmark-x"></i></a>`
        : `<button class="btn btn-sm btn-outline-secondary py-0 px-1" disabled title="Solo disponible si se canceló ante el SAT"><i class="bi bi-file-earmark-x"></i></button>`}</td>
      <td data-field="UUID" data-value="${fmt(r.UUID)}" style="display:none"></td>
      <td data-field="Id_Cliente" data-value="${r.Id_Cliente||''}" style="display:none"></td>
      <td data-field="FlagCompensacion" data-value="${r.FlagCompensacion||0}" style="display:none"></td>
    </tr>`;
    }).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/get', async (req, res) => {
  try {
    const pool = await getPool();
    const id = parseInt(req.query.id);
    const cabRes = await pool.request().input('id', sql.Decimal(9), id).query(`
      SELECT p.*, cli.RFC
      FROM Empresa2.Pagos p
      LEFT JOIN Empresa2.Clientes cli ON cli.ID_CLIENTE=p.Id_Cliente
      WHERE p.Id_NoPago=@id`);
    if (!cabRes.recordset[0]) return res.status(404).json({ error: 'No encontrado' });
    // TOTALDOC = total original de la Factura/ND referenciada -- junto con
    // SALDOANT (saldo ya congelado al momento de agregar la línea) permite
    // mostrar "Pagos realizados" = TOTALDOC - SALDOANT en el detalle.
    const detRes = await pool.request().input('id', sql.Decimal(9), id).query(`
      SELECT pf.*, ISNULL(fac.TOTAL, nd.ImporteTotal) AS TOTALDOC
      FROM Empresa2.PagFac pf
      LEFT JOIN Empresa2.Factura fac ON pf.NOFACTURA>0 AND fac.Id_NoFactura=pf.NOFACTURA
        AND ISNULL(LTRIM(RTRIM(fac.SerieFac)),'')=ISNULL(LTRIM(RTRIM(pf.SERIEFAC)),'')
      LEFT JOIN Empresa2.NotaCred nd ON pf.ID_NOTACREDITO>0 AND nd.Id_NotaCredito=pf.ID_NOTACREDITO
        AND LTRIM(RTRIM(nd.Tipo))='ND' AND ISNULL(LTRIM(RTRIM(nd.Serie)),'')=ISNULL(LTRIM(RTRIM(pf.SERIEND)),'')
      WHERE pf.ID_NOPAGO=@id ORDER BY pf.ID_NOPAGFAC`);
    res.json({ cabecera: cabRes.recordset[0], lineas: detRes.recordset });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lookup/numero-consecutivo', async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT ISNULL(MAX(Id_NoPago),0)+1 AS next FROM Empresa2.Pagos`);
    res.json({ next: r.recordset[0].next });
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

// ── Buscar Facturas de un cliente para referenciar como línea ─────────────
// Saldo disponible = TOTAL - PagosReal - NotasCredito (mismo criterio que
// Notas de Crédito). excluirId: folio del pago actual, para no listar
// facturas que ya son línea de ESTE pago (mismo criterio anti-duplicados).
router.get('/lookup/facturas', async (req, res) => {
  try {
    const pool = await getPool();
    const idCliente = parseInt(req.query.idCliente) || 0;
    if (!idCliente) return res.json({ rows: [], total: 0, totalPages: 1, page: 1 });
    const q = trim(req.query.q);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const excluirId = parseInt(req.query.excluirId) || 0;
    // El saldo disponible se calcula (TOTAL - PagosReal - NotasCredito) en vez
    // de confiar en el texto de Status: hay facturas legado marcadas 'VENCIDA'
    // (no 'PAGADA') que ya están cubiertas por completo -- filtrarlas por
    // Status las dejaba aparecer en el buscador con saldo $0.00.
    let where = `WHERE Id_Cliente=@idCliente AND LTRIM(RTRIM(ISNULL(Status,'')))<>'CANCELADA'
                 AND (TOTAL - ISNULL(PagosReal,0) - ISNULL(NotasCredito,0)) > 0.005`;
    if (excluirId) {
      where += ` AND NOT EXISTS (
        SELECT 1 FROM Empresa2.PagFac pf
        WHERE pf.ID_NOPAGO=@excId AND pf.NOFACTURA=Factura.Id_NoFactura
          AND ISNULL(LTRIM(RTRIM(pf.SERIEFAC)),'')=ISNULL(LTRIM(RTRIM(Factura.SerieFac)),'')
      )`;
    }
    const cr = pool.request().input('idCliente', sql.Decimal(7), idCliente);
    if (excluirId) cr.input('excId', sql.Decimal(9), excluirId);
    if (q) { where += ` AND (CAST(Id_NoFactura AS VARCHAR(20)) LIKE @q)`; cr.input('q', `%${q}%`); }
    const cnt = await cr.query(`SELECT COUNT(*) total FROM Empresa2.Factura ${where}`);
    const total = cnt.recordset[0].total;
    const offset = (page - 1) * 10;
    const dr = pool.request().input('idCliente', sql.Decimal(7), idCliente);
    if (excluirId) dr.input('excId', sql.Decimal(9), excluirId);
    if (q) dr.input('q', `%${q}%`);
    const data = await dr.query(`SELECT Id_NoFactura, LTRIM(RTRIM(SerieFac)) SerieFac, FechaFactura, TOTAL, PagosReal, NotasCredito, Status, ClaveMP
                                  FROM Empresa2.Factura ${where} ORDER BY Id_NoFactura DESC OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`);
    const fmtDate = v => { if (!v) return ''; const d = v instanceof Date ? v : new Date(v); return d.toISOString().slice(0, 10); };
    res.json({
      rows: data.recordset.map(r => ({
        Id_NoFactura: r.Id_NoFactura, SerieFac: r.SerieFac || '', FechaFactura: fmtDate(r.FechaFactura),
        TOTAL: r.TOTAL || 0, PagosRealizados: num(r.PagosReal) + num(r.NotasCredito),
        Saldo: Math.max(0, num(r.TOTAL) - num(r.PagosReal) - num(r.NotasCredito)),
        Status: trim(r.Status), ClaveMP: trim(r.ClaveMP),
      })),
      total, totalPages: Math.ceil(total / 10) || 1, page,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Buscar Notas de Débito previas de un cliente para referenciar ─────────
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
        SELECT 1 FROM Empresa2.PagFac pf
        WHERE pf.ID_NOPAGO=@excId AND pf.ID_NOTACREDITO=NotaCred.Id_NotaCredito
          AND ISNULL(LTRIM(RTRIM(pf.SERIEND)),'')=ISNULL(LTRIM(RTRIM(NotaCred.Serie)),'')
      )`;
    }
    const cr = pool.request().input('idCliente', sql.Decimal(7), idCliente);
    if (excluirId) cr.input('excId', sql.Decimal(9), excluirId);
    if (q) { where += ` AND (CAST(Id_NotaCredito AS VARCHAR(20)) LIKE @q)`; cr.input('q', `%${q}%`); }
    const cnt = await cr.query(`SELECT COUNT(*) total FROM Empresa2.NotaCred ${where}`);
    const total = cnt.recordset[0].total;
    const offset = (page - 1) * 10;
    const dr = pool.request().input('idCliente', sql.Decimal(7), idCliente);
    if (excluirId) dr.input('excId', sql.Decimal(9), excluirId);
    if (q) dr.input('q', `%${q}%`);
    const data = await dr.query(`SELECT Id_NotaCredito, LTRIM(RTRIM(Serie)) Serie, Fecha, ImporteTotal, Status
                                  FROM Empresa2.NotaCred ${where} ORDER BY Id_NotaCredito DESC OFFSET ${offset} ROWS FETCH NEXT 10 ROWS ONLY`);
    const fmtDate = v => { if (!v) return ''; const d = v instanceof Date ? v : new Date(v); return d.toISOString().slice(0, 10); };
    res.json({
      rows: data.recordset.map(r => ({
        Id_NotaDebito: r.Id_NotaCredito, SerieND: r.Serie || '', Fecha: fmtDate(r.Fecha),
        ImporteTotal: r.ImporteTotal || 0, Status: trim(r.Status),
      })),
      total, totalPages: Math.ceil(total / 10) || 1, page,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Un cobro puede capturarse por partes: BORRADOR (aún no aplica saldo) o
// REALIZADO (ya aplicó el saldo de sus líneas a las facturas). Mientras esté
// REALIZADO, cada cambio de líneas aplica SOLO su diferencia al saldo (alta suma,
// ajuste suma/resta la diferencia, baja resta) y Grabar no vuelve a aplicar nada.
// CANCELADO o timbrado ya no se modifican. Devuelve el status vigente.
async function estadoCobroEditable(tx, idNoPago) {
  const r = await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago)
    .query(`SELECT Status, UUID FROM Empresa2.Pagos WITH (UPDLOCK, ROWLOCK) WHERE Id_NoPago=@id`);
  if (!r.recordset[0]) throw Object.assign(new Error('Cobro no encontrado.'), { status: 404 });
  const st = trim(r.recordset[0].Status).toUpperCase();
  if (st === 'CANCELADO') throw Object.assign(new Error('El cobro está cancelado y no se puede modificar.'), { status: 409 });
  if (trim(r.recordset[0].UUID)) throw Object.assign(new Error('El cobro ya está timbrado y no se puede modificar; cancélalo fiscalmente y captura uno nuevo.'), { status: 409 });
  return st;
}

// Aplica (signo=+1) o revierte (signo=-1) el efecto de una línea sobre su Factura / ND.
async function aplicarEfectoLinea(tx, linea, signo, anio) {
  const importe = num(linea.TOTALPAGO); // pagado + compensado
  if (importe <= 0.005) return;
  if (Number(linea.NOFACTURA) > 0) {
    await ajustarSaldoFactura(tx, 'pago', { idNoFactura: linea.NOFACTURA, serieFac: linea.SERIEFAC, importe, signo, anio: signo > 0 ? anio : undefined });
  } else if (Number(linea.ID_NOTACREDITO) > 0) {
    await recalcularStatusND(tx, { idNotaDebito: linea.ID_NOTACREDITO, serieND: linea.SERIEND, extra: signo > 0 ? num(linea.IMPRTE) + num(linea.COMPESACION) : 0, excluirPago: linea.ID_NOPAGO });
  }
}

// ── AGREGAR LÍNEA (contra Factura o Nota de Débito previa) ────────────────
router.post('/partida/agregar', requierePermiso('pagos.editar'), async (req, res) => {
  const f = req.body;
  try {
    const pool = await getPool();
    const result = await withTransaction(pool, async (tx) => {
      const esFactura = !!f.idNoFactura;
      const esND = !!f.idNotaDebito;
      if (esFactura === esND) {
        throw Object.assign(new Error('La línea debe referenciar exactamente una Factura O una Nota de Débito previa.'), { status: 400 });
      }
      const idCliente = parseInt(f.idCliente);
      if (!idCliente) throw Object.assign(new Error('Debe seleccionar el cliente facturado.'), { status: 400 });

      let idNoPago = parseInt(f.idNoPago) || 0;
      let estadoCobro = 'BORRADOR';

      // Cabecera: crear en borrador si es la primera línea.
      if (!idNoPago) {
        const nextRes = await new sql.Request(tx).query(`SELECT ISNULL(MAX(Id_NoPago),0)+1 AS next FROM Empresa2.Pagos WITH (UPDLOCK, HOLDLOCK)`);
        idNoPago = nextRes.recordset[0].next;
        const cli = await new sql.Request(tx).input('id', sql.Decimal(7), idCliente).query(`SELECT NOMBRECOMUN, NOMBRECOM FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
        const idRealPago = parseInt(f.idRealPago) || idCliente;
        const cliPago = idRealPago === idCliente ? cli : await new sql.Request(tx).input('id', sql.Decimal(7), idRealPago).query(`SELECT NOMBRECOMUN, NOMBRECOM FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
        await new sql.Request(tx)
          .input('id', sql.Decimal(9), idNoPago)
          .input('fecha', sql.Date, trim(f.fecha) || hoy()).input('hora', sql.VarChar(8), new Date().toTimeString().slice(0, 8))
          .input('idCli', sql.Decimal(7), idCliente).input('nombreCom', sql.VarChar(150), trim(cli.recordset[0]?.NOMBRECOMUN) || trim(cli.recordset[0]?.NOMBRECOM))
          .input('idRealPago', sql.Decimal(7), idRealPago).input('nomClientePago', sql.VarChar(150), trim(cliPago.recordset[0]?.NOMBRECOMUN) || trim(cliPago.recordset[0]?.NOMBRECOM))
          .input('fechaPago', sql.Date, trim(f.fechaPago) || hoy())
          .input('horaPago', sql.VarChar(8), horaValida(f.horaPago) || new Date().toTimeString().slice(0, 8))
          // BORRADOR hasta /cabecera/grabar -- mismo criterio ya corregido en
          // Notas de Crédito para que "Cerrar sin grabar" pueda limpiar el
          // borrador abandonado (Status REALIZADO es el análogo de EMITIDA ahí).
          .input('status', sql.VarChar(20), 'BORRADOR')
          .input('cformapago', sql.VarChar(4), trim(f.c_FormaPago) || '03')
          .input('formapago', sql.VarChar(45), trim(f.FormaPago) || null)
          .input('tipoCambio', sql.VarChar(20), trim(f.tipoCambio) || null)
          .input('tipoFacturas', sql.VarChar(20), trim(f.moneda) === 'USD' ? 'Dolares' : 'Pesos')
          .input('flagComp', sql.TinyInt, f.flagCompensacion ? 1 : 0)
          .input('bancoDeposito', sql.VarChar(60), trim(f.bancoDeposito) || null)
          .input('tipoDeposito', sql.VarChar(20), trim(f.tipoDeposito) || null)
          .input('noCheque', sql.VarChar(20), trim(f.noCheque) || null)
          .input('bancoEmisor', sql.VarChar(60), trim(f.bancoEmisor) || null)
          .input('realizo', sql.VarChar(80), [req.session.usuario.nombre, req.session.usuario.apellido].filter(Boolean).join(' '))
          .query(`INSERT INTO Empresa2.Pagos(
            Id_NoPago, Fecha, Hora, Id_Cliente, NombreCom, Id_RealPago, NomClientePago, FechaPago, HoraPago, Status,
            c_FormaPago, FormaPago, TipoCambio, TipoFacturas, FlagCompensacion,
            BancoDeposito, TipoDeposito, NoCheuqe, BancoEmisor, ImporteCheque, Realizo,
            SumaPartidas, TotalComp, TotalIVA, TotalRet, BaseIVA, BaseRet, TotalIVA_C, TotalRet_C, BaseIVA_C, BaseRet_C, TotalImporte
          ) VALUES(
            @id, @fecha, @hora, @idCli, @nombreCom, @idRealPago, @nomClientePago, @fechaPago, @horaPago, @status,
            @cformapago, @formapago, @tipoCambio, @tipoFacturas, @flagComp,
            @bancoDeposito, @tipoDeposito, @noCheque, @bancoEmisor, 0, @realizo,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
          )`);
      } else {
        estadoCobro = await estadoCobroEditable(tx, idNoPago);
      }

      const nextDetaRes = await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`SELECT ISNULL(MAX(ID_NOPAGFAC),0)+1 AS next FROM Empresa2.PagFac WHERE ID_NOPAGO=@id`);
      const idNoPagFac = nextDetaRes.recordset[0].next;

      let origen; // { idCliente, total, subtotal, iva, reten, saldoAnt, anio, refCampos... }
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
        if (st === 'CANCELADA') throw Object.assign(new Error('La factura ya está cancelada.'), { status: 400 });

        // Defensa por si el browse de selección quedó desactualizado.
        const dupRes = await new sql.Request(tx)
          .input('idpago', sql.Decimal(9), idNoPago).input('idnofactura', sql.Decimal(9), idNoFactura).input('seriefac', sql.VarChar(20), serieFacRef)
          .query(`SELECT TOP 1 1 AS x FROM Empresa2.PagFac WHERE ID_NOPAGO=@idpago AND NOFACTURA=@idnofactura AND ISNULL(LTRIM(RTRIM(SERIEFAC)),'')=ISNULL(@seriefac,'')`);
        if (dupRes.recordset[0]) throw Object.assign(new Error('Esa Factura ya fue agregada a este cobro.'), { status: 400 });

        const saldoAnt = Math.round(Math.max(num(fac.TOTAL) - num(fac.PagosReal) - num(fac.NotasCredito), 0) * 100) / 100;
        if (saldoAnt <= 0.005) throw Object.assign(new Error('Esa factura ya está pagada.'), { status: 400 });

        origen = {
          idCliente: Number(fac.Id_Cliente), total: num(fac.TOTAL), subtotal: num(fac.SubTotal), iva: num(fac.IVA), reten: num(fac.Retencion),
          saldoAnt, anio: fac.FechaFactura ? new Date(fac.FechaFactura).getFullYear() : new Date().getFullYear(),
          idRef: idNoFactura, serieRef: serieFacRef, esFactura: true,
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
        if (st === 'PAGADA' || st === 'CANCELADO') throw Object.assign(new Error('La Nota de Débito ya está pagada o cancelada.'), { status: 400 });

        const dupRes = await new sql.Request(tx)
          .input('idpago', sql.Decimal(9), idNoPago).input('idnd', sql.Decimal(7), idNotaDebito).input('seriend', sql.VarChar(20), serieND)
          .query(`SELECT TOP 1 1 AS x FROM Empresa2.PagFac WHERE ID_NOPAGO=@idpago AND ID_NOTACREDITO=@idnd AND ISNULL(LTRIM(RTRIM(SERIEND)),'')=ISNULL(@seriend,'')`);
        if (dupRes.recordset[0]) throw Object.assign(new Error('Esa Nota de Débito ya fue agregada a este cobro.'), { status: 400 });

        // La ND admite pago parcial: su saldo es el total menos lo ya aplicado por otros cobros/notas.
        const aplicadoPrevio = await aplicadoND(tx, { idNotaDebito, serieND, excluirPago: idNoPago });
        const saldoND = Math.round(Math.max(num(nd.ImporteTotal) - aplicadoPrevio, 0) * 100) / 100;
        if (saldoND <= 0.005) throw Object.assign(new Error('Esa Nota de Débito ya está pagada.'), { status: 400 });
        origen = {
          idCliente: Number(nd.Id_Cliente), total: num(nd.ImporteTotal), subtotal: num(nd.Subtotal), iva: num(nd.IVA), reten: num(nd.Retencion),
          saldoAnt: saldoND, anio: nd.Fecha ? new Date(nd.Fecha).getFullYear() : new Date().getFullYear(),
          idRef: idNotaDebito, serieRef: serieND, esFactura: false,
        };
      }

      // Importe a aplicar por defecto: todo el saldo disponible (el usuario
      // puede ajustarlo después con /linea/actualizar-importe si es Factura;
      // si es ND queda fijo, todo-o-nada).
      const imprte = origen.saldoAnt;
      const compensacion = 0;
      const totalPago = imprte + compensacion;
      const factorProp = origen.total > 0.005 ? (imprte / origen.total) : 0;
      const factorPropComp = origen.total > 0.005 ? (compensacion / origen.total) : 0;
      const r2 = v => Math.round(v * 100) / 100;

      const req2 = new sql.Request(tx)
        .input('idpago', sql.Decimal(9), idNoPago).input('idnopagfac', sql.Decimal(7), idNoPagFac)
        .input('idcli', sql.Decimal(7), origen.idCliente)
        .input('imprte', sql.Decimal(11,2), r2(imprte)).input('saldoant', sql.Decimal(11,2), r2(origen.saldoAnt))
        .input('aniofac', sql.Decimal(5), origen.anio).input('compensacion', sql.Decimal(11,2), compensacion)
        .input('subtotal', sql.Decimal(11,2), r2(origen.subtotal * factorProp)).input('retencion', sql.Decimal(9,2), r2(origen.reten * factorProp))
        .input('iva', sql.Decimal(10,2), r2(origen.iva * factorProp))
        .input('subtotalcomp', sql.Decimal(11,2), r2(origen.subtotal * factorPropComp)).input('ivacomp', sql.Decimal(10,2), r2(origen.iva * factorPropComp))
        .input('retencioncomp', sql.Decimal(9,2), r2(origen.reten * factorPropComp))
        .input('porpago', sql.Decimal(6,4), totalPago > 0.005 ? r2(imprte / totalPago) : 0)
        .input('porpagocomp', sql.Decimal(6,4), totalPago > 0.005 ? r2(compensacion / totalPago) : 0)
        .input('totalpago', sql.Decimal(11,2), r2(totalPago));
      if (origen.esFactura) {
        req2.input('nofactura', sql.Decimal(9), origen.idRef).input('seriefac', sql.VarChar(20), origen.serieRef)
          .input('seriend', sql.VarChar(20), null).input('idnc', sql.Decimal(7), 0);
      } else {
        req2.input('nofactura', sql.Decimal(9), 0).input('seriefac', sql.VarChar(20), null)
          .input('seriend', sql.VarChar(20), origen.serieRef).input('idnc', sql.Decimal(7), origen.idRef);
      }
      await req2.query(`INSERT INTO Empresa2.PagFac(
        ID_NOPAGO, ID_NOPAGFAC, ID_CLIENTE, NOFACTURA, IMPRTE, SALDOANT, ANIOFAC, COMPESACION,
        SUBTOTAL, RETENCION, IVA, SUBTOTALCOMP, IVACOMP, RETENCIONCOMP, PORPAGO, PORPAGOCOMP, TOTALPAGO,
        SERIEFAC, SERIEND, ID_NOTACREDITO
      ) VALUES(
        @idpago, @idnopagfac, @idcli, @nofactura, @imprte, @saldoant, @aniofac, @compensacion,
        @subtotal, @retencion, @iva, @subtotalcomp, @ivacomp, @retencioncomp, @porpago, @porpagocomp, @totalpago,
        @seriefac, @seriend, @idnc
      )`);

      // Cobro ya REALIZADO: la línea nueva aplica su saldo en el momento.
      if (estadoCobro === 'REALIZADO') {
        await aplicarEfectoLinea(tx, { ID_NOPAGO: idNoPago, NOFACTURA: origen.esFactura ? origen.idRef : 0, SERIEFAC: origen.serieRef, ID_NOTACREDITO: origen.esFactura ? 0 : origen.idRef,
          SERIEND: origen.serieRef, IMPRTE: imprte, COMPESACION: compensacion, TOTALPAGO: totalPago }, 1, new Date().getFullYear());
      }

      const totales = await recalcularSumaPartidas(tx, idNoPago);
      return { idNoPago, idNoPagFac, totales };
    });
    res.json({ ok: true, ...result });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── Recalcula SumaPartidas/TotalComp de cabecera sumando las líneas ───────
// ImporteCheque/TotalImporte se mantienen siempre = SumaPartidas (ya no se
// captura a mano ni se valida contra las líneas -- esa validación se quitó
// por pedido del usuario; el importe real del pago es, por definición, la
// suma de sus líneas).
async function recalcularSumaPartidas(tx, idNoPago) {
  const sumRes = await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago)
    .query(`SELECT ISNULL(SUM(IMPRTE),0) imprte, ISNULL(SUM(COMPESACION),0) comp, ISNULL(SUM(TOTALPAGO),0) tot
            FROM Empresa2.PagFac WHERE ID_NOPAGO=@id`);
  const s = sumRes.recordset[0];
  const r2 = v => Math.round(v * 100) / 100;
  const vals = { SumaPartidas: r2(s.tot), TotalComp: r2(s.comp), Imprte: r2(s.imprte) };
  await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago)
    .input('suma', sql.Decimal(12,2), vals.SumaPartidas).input('comp', sql.Decimal(12,2), vals.TotalComp)
    .query(`UPDATE Empresa2.Pagos SET SumaPartidas=@suma, TotalComp=@comp, ImporteCheque=@suma, TotalImporte=@suma WHERE Id_NoPago=@id`);
  return vals;
}

// ── AJUSTAR el importe de una línea (Factura) a mano, con compensación ────
// Fija importe/compensación de una línea de Factura (topado al SALDOANT) y, si el
// cobro ya está REALIZADO, aplica a la factura solo la diferencia.
async function fijarImporteLinea(tx, idNoPago, idNoPagFac, imprte, compensacion, estadoCobro) {
  {
    {
      const cabRes = await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`SELECT FlagCompensacion FROM Empresa2.Pagos WHERE Id_NoPago=@id`);
      const flagCompensacion = Number(cabRes.recordset[0].FlagCompensacion) === 1;

      const lineaRes = await new sql.Request(tx)
        .input('idpago', sql.Decimal(9), idNoPago).input('idd', sql.Decimal(7), idNoPagFac)
        .query(`SELECT * FROM Empresa2.PagFac WITH (UPDLOCK, ROWLOCK) WHERE ID_NOPAGO=@idpago AND ID_NOPAGFAC=@idd`);
      const linea = lineaRes.recordset[0];
      if (!linea) throw Object.assign(new Error('Línea no encontrada.'), { status: 404 });
      const esND = Number(linea.NOFACTURA) <= 0;
      if (esND && !(Number(linea.ID_NOTACREDITO) > 0)) throw Object.assign(new Error('Línea inválida.'), { status: 400 });

      let facTotal, facSubtotal, facIva, facReten;
      if (esND) {
        const nd = (await new sql.Request(tx).input('id', sql.Decimal(7), linea.ID_NOTACREDITO).input('serie', sql.VarChar(10), serieKey(linea.SERIEND))
          .query(`SELECT ImporteTotal, Subtotal, IVA, Retencion FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND LTRIM(RTRIM(Tipo))='ND' AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`)).recordset[0];
        facTotal = num(nd?.ImporteTotal); facSubtotal = num(nd?.Subtotal); facIva = num(nd?.IVA); facReten = num(nd?.Retencion);
      } else {
        const facRes = await new sql.Request(tx).input('id', sql.Decimal(9), linea.NOFACTURA).input('serieFac', sql.VarChar(20), serieKey(linea.SERIEFAC))
          .query(`SELECT TOTAL, SubTotal, IVA, Retencion FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'')`);
        const fac = facRes.recordset[0];
        facTotal = num(fac?.TOTAL); facSubtotal = num(fac?.SubTotal); facIva = num(fac?.IVA); facReten = num(fac?.Retencion);
      }

      const saldoAnt = num(linea.SALDOANT);
      let nuevoImprte = Math.max(0, num(imprte));
      let nuevoComp = flagCompensacion ? Math.max(0, num(compensacion)) : 0;
      let limitado = false;
      if (nuevoImprte + nuevoComp > saldoAnt + 0.005) {
        // Topa manteniendo la proporción entre lo pagado y lo compensado que
        // el usuario capturó, igual que el tope de saldo ya usado en Notas de
        // Crédito (ajustar sin exceder, avisando).
        const factor = (nuevoImprte + nuevoComp) > 0 ? saldoAnt / (nuevoImprte + nuevoComp) : 0;
        nuevoImprte = Math.round(nuevoImprte * factor * 100) / 100;
        nuevoComp = Math.round(nuevoComp * factor * 100) / 100;
        limitado = true;
      }
      const totalPago = Math.round((nuevoImprte + nuevoComp) * 100) / 100;
      const factorProp = facTotal > 0.005 ? (nuevoImprte / facTotal) : 0;
      const factorPropComp = facTotal > 0.005 ? (nuevoComp / facTotal) : 0;
      const r2 = v => Math.round(v * 100) / 100;

      await new sql.Request(tx)
        .input('idpago', sql.Decimal(9), idNoPago).input('idd', sql.Decimal(7), idNoPagFac)
        .input('imprte', sql.Decimal(11,2), nuevoImprte).input('comp', sql.Decimal(11,2), nuevoComp).input('totalpago', sql.Decimal(11,2), totalPago)
        .input('subtotal', sql.Decimal(11,2), r2(facSubtotal * factorProp)).input('retencion', sql.Decimal(9,2), r2(facReten * factorProp))
        .input('iva', sql.Decimal(10,2), r2(facIva * factorProp))
        .input('subtotalcomp', sql.Decimal(11,2), r2(facSubtotal * factorPropComp)).input('ivacomp', sql.Decimal(10,2), r2(facIva * factorPropComp))
        .input('retencioncomp', sql.Decimal(9,2), r2(facReten * factorPropComp))
        .input('porpago', sql.Decimal(6,4), totalPago > 0.005 ? r2(nuevoImprte / totalPago) : 0)
        .input('porpagocomp', sql.Decimal(6,4), totalPago > 0.005 ? r2(nuevoComp / totalPago) : 0)
        .query(`UPDATE Empresa2.PagFac SET IMPRTE=@imprte, COMPESACION=@comp, TOTALPAGO=@totalpago,
                  SUBTOTAL=@subtotal, RETENCION=@retencion, IVA=@iva, SUBTOTALCOMP=@subtotalcomp, IVACOMP=@ivacomp, RETENCIONCOMP=@retencioncomp,
                  PORPAGO=@porpago, PORPAGOCOMP=@porpagocomp
                WHERE ID_NOPAGO=@idpago AND ID_NOPAGFAC=@idd`);

      // Cobro ya REALIZADO: solo se aplica la diferencia contra lo ya aplicado.
      const diferencia = Math.round((totalPago - num(linea.TOTALPAGO)) * 100) / 100;
      if (estadoCobro === 'REALIZADO' && Math.abs(diferencia) > 0.005) {
        if (esND) await recalcularStatusND(tx, { idNotaDebito: linea.ID_NOTACREDITO, serieND: linea.SERIEND, extra: totalPago, excluirPago: idNoPago });
        else await ajustarSaldoFactura(tx, 'pago', { idNoFactura: linea.NOFACTURA, serieFac: linea.SERIEFAC, importe: diferencia, signo: 1 });
      }

      const totales = await recalcularSumaPartidas(tx, idNoPago);
      return { limitado, saldoDisponible: saldoAnt, totales };
    }
  }
}

router.post('/linea/actualizar-importe', requierePermiso('pagos.editar'), async (req, res) => {
  const { idNoPago, idNoPagFac, imprte, compensacion } = req.body;
  try {
    const pool = await getPool();
    const result = await withTransaction(pool, async (tx) => {
      const estadoCobro = await estadoCobroEditable(tx, idNoPago);
      return fijarImporteLinea(tx, idNoPago, idNoPagFac, imprte, compensacion, estadoCobro);
    });
    res.json({ ok: true, ...result });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── AJUSTAR SALDOS del cobro: revisa cada línea contra el estado ACTUAL de su
// factura (p. ej. se canceló otro cobro después de capturar este), corrige
// Factura.PagosReal/Status desde los cobros y notas vigentes, y reajusta en la
// línea los pagos realizados / saldo disponible (SALDOANT) y lo pagado. ──────
router.post('/ajustar-saldos', requierePermiso('pagos.editar'), requierePermiso('pagos.btn_ajustar_saldos'), async (req, res) => {
  const idNoPago = parseInt(req.body.idNoPago);
  if (!idNoPago) return res.status(400).json({ error: 'Cobro inválido.' });
  try {
    const pool = await getPool();
    const cambios = [];
    await withTransaction(pool, async (tx) => {
      const estado = await estadoCobroEditable(tx, idNoPago);
      const cab = (await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`SELECT FlagCompensacion FROM Empresa2.Pagos WHERE Id_NoPago=@id`)).recordset[0];
      const flagComp = Number(cab.FlagCompensacion) === 1;
      const lineas = (await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago)
        .query(`SELECT * FROM Empresa2.PagFac WHERE ID_NOPAGO=@id AND NOFACTURA>0 ORDER BY ID_NOPAGFAC`)).recordset;

      // En REALIZADO, primero se corrige la factura desde los documentos vigentes.
      if (estado === 'REALIZADO') {
        const vistos = new Set(), items = [];
        for (const l of lineas) {
          const k = l.NOFACTURA + '|' + trim(l.SERIEFAC);
          if (!vistos.has(k)) { vistos.add(k); items.push({ id: l.NOFACTURA, serie: trim(l.SERIEFAC) }); }
        }
        const res1 = await conciliacion.ajustarFacturas(tx, items, { incluirSinRespaldo: true });
        res1.filter(r => r.ok).forEach(r => cambios.push({ folio: r.id, campo: 'Factura: pagos realizados', antes: r.antes.PagosReal, despues: r.despues.PagosReal, status: r.despues.Status }));
      }

      for (const l of lineas) {
        const fac = (await new sql.Request(tx).input('id', sql.Decimal(9), l.NOFACTURA).input('s', sql.VarChar(20), serieKey(l.SERIEFAC))
          .query(`SELECT TOTAL, PagosReal, NotasCredito FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@s,'')`)).recordset[0];
        if (!fac) continue;
        const cubiertoPorOtros = estado === 'REALIZADO'
          ? Math.max(0, num(fac.PagosReal) + num(fac.NotasCredito) - num(l.TOTALPAGO))
          : num(fac.PagosReal) + num(fac.NotasCredito);
        const saldoNuevo = Math.round(Math.max(0, num(fac.TOTAL) - cubiertoPorOtros) * 100) / 100;
        if (Math.abs(saldoNuevo - num(l.SALDOANT)) > 0.005) {
          await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).input('idd', sql.Decimal(7), l.ID_NOPAGFAC).input('s', sql.Decimal(11, 2), saldoNuevo)
            .query(`UPDATE Empresa2.PagFac SET SALDOANT=@s WHERE ID_NOPAGO=@id AND ID_NOPAGFAC=@idd`);
          cambios.push({ folio: l.NOFACTURA, campo: 'Saldo disponible', antes: num(l.SALDOANT), despues: saldoNuevo });
        }
        // Sin pagos previos ni compensación: el pago es el saldo disponible completo.
        // En cualquier caso, lo pagado no puede exceder el saldo disponible real.
        const comp = flagComp ? num(l.COMPESACION) : 0;
        const sinPagosPrevios = cubiertoPorOtros < 0.005 && comp < 0.005;
        const imprteObjetivo = sinPagosPrevios ? saldoNuevo : num(l.IMPRTE);
        if (Math.abs(imprteObjetivo - num(l.IMPRTE)) > 0.005 || num(l.IMPRTE) + comp > saldoNuevo + 0.005) {
          const r = await fijarImporteLinea(tx, idNoPago, l.ID_NOPAGFAC, imprteObjetivo, comp, estado);
          cambios.push({ folio: l.NOFACTURA, campo: 'Pago', antes: num(l.IMPRTE), despues: Math.min(imprteObjetivo, saldoNuevo), limitado: r.limitado });
        }
      }
      // Factura.PagosReal debe quedar igual a lo que respaldan los cobros vigentes (incluye este).
      if (estado === 'REALIZADO') {
        const vistos2 = new Set(), items2 = [];
        for (const l of lineas) {
          const k = l.NOFACTURA + '|' + trim(l.SERIEFAC);
          if (!vistos2.has(k)) { vistos2.add(k); items2.push({ id: l.NOFACTURA, serie: trim(l.SERIEFAC) }); }
        }
        await conciliacion.ajustarFacturas(tx, items2, { incluirSinRespaldo: true });
      }
      await recalcularSumaPartidas(tx, idNoPago);
    });
    res.json({ ok: true, cambios });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/partida/eliminar', requierePermiso('pagos.editar'), async (req, res) => {
  const { idNoPago, idNoPagFac } = req.body;
  try {
    const pool = await getPool();
    await withTransaction(pool, async (tx) => {
      const estadoCobro = await estadoCobroEditable(tx, idNoPago);
      const lin = (await new sql.Request(tx).input('idpago', sql.Decimal(9), idNoPago).input('idd', sql.Decimal(7), idNoPagFac)
        .query(`SELECT * FROM Empresa2.PagFac WITH (UPDLOCK, ROWLOCK) WHERE ID_NOPAGO=@idpago AND ID_NOPAGFAC=@idd`)).recordset[0];
      if (!lin) throw Object.assign(new Error('Línea no encontrada.'), { status: 404 });
      // Cobro ya REALIZADO: al quitar la línea se devuelve su saldo a la factura.
      if (estadoCobro === 'REALIZADO') await aplicarEfectoLinea(tx, lin, -1);
      await new sql.Request(tx).input('idpago', sql.Decimal(9), idNoPago).input('idd', sql.Decimal(7), idNoPagFac)
        .query(`DELETE FROM Empresa2.PagFac WHERE ID_NOPAGO=@idpago AND ID_NOPAGFAC=@idd`);
      await recalcularSumaPartidas(tx, idNoPago);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── ACTUALIZAR CAMPOS DE CABECERA ─────────────────────────────────────────
router.post('/cabecera/actualizar', requierePermiso('pagos.editar'), async (req, res) => {
  const idNoPago = parseInt(req.body.idNoPago);
  if (!idNoPago) return res.status(400).json({ error: 'Cobro inválido.' });
  try {
    const pool = await getPool();
    await withTransaction(pool, async (tx) => {
      const cabRes = await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`SELECT UUID FROM Empresa2.Pagos WHERE Id_NoPago=@id`);
      if (!cabRes.recordset[0]) throw Object.assign(new Error('Cobro no encontrado.'), { status: 404 });
      const yaTimbrado = !!trim(cabRes.recordset[0].UUID);
      if (yaTimbrado) throw Object.assign(new Error('El cobro ya está timbrado; no se puede modificar.'), { status: 400 });

      const r2 = new sql.Request(tx).input('id', sql.Decimal(9), idNoPago)
        .input('flagComp', sql.TinyInt, req.body.flagCompensacion ? 1 : 0);
      let sets = ['FlagCompensacion=@flagComp'];
      if (trim(req.body.fecha)) { r2.input('fecha', sql.Date, trim(req.body.fecha)); sets.push('Fecha=@fecha'); }
      if (trim(req.body.fechaPago)) { r2.input('fechaPago', sql.Date, trim(req.body.fechaPago)); sets.push('FechaPago=@fechaPago'); }
      if (horaValida(req.body.horaPago)) { r2.input('horaPago', sql.VarChar(8), horaValida(req.body.horaPago)); sets.push('HoraPago=@horaPago'); }
      if (trim(req.body.c_FormaPago)) { r2.input('cformapago', sql.VarChar(4), trim(req.body.c_FormaPago)); sets.push('c_FormaPago=@cformapago'); }
      if (trim(req.body.FormaPago)) { r2.input('formapago', sql.VarChar(45), trim(req.body.FormaPago)); sets.push('FormaPago=@formapago'); }
      if (trim(req.body.tipoCambio) !== '') { r2.input('tipoCambio', sql.VarChar(20), trim(req.body.tipoCambio)); sets.push('TipoCambio=@tipoCambio'); }
      if (trim(req.body.bancoDeposito) !== '') { r2.input('bancoDeposito', sql.VarChar(60), trim(req.body.bancoDeposito)); sets.push('BancoDeposito=@bancoDeposito'); }
      if (trim(req.body.tipoDeposito) !== '') { r2.input('tipoDeposito', sql.VarChar(20), trim(req.body.tipoDeposito)); sets.push('TipoDeposito=@tipoDeposito'); }
      if (trim(req.body.noCheque) !== '') { r2.input('noCheque', sql.VarChar(20), trim(req.body.noCheque)); sets.push('NoCheuqe=@noCheque'); }
      if (trim(req.body.bancoEmisor) !== '') { r2.input('bancoEmisor', sql.VarChar(60), trim(req.body.bancoEmisor)); sets.push('BancoEmisor=@bancoEmisor'); }
      if (trim(req.body.observaciones) !== '') { r2.input('observaciones', sql.VarChar(500), trim(req.body.observaciones)); sets.push('Observaciones=@observaciones'); }
      await r2.query(`UPDATE Empresa2.Pagos SET ${sets.join(', ')} WHERE Id_NoPago=@id`);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── GRABAR: valida que el importe total capture la suma de líneas y aplica
// el efecto sobre el saldo de cada Factura/ND relacionada ─────────────────
router.post('/cabecera/grabar', requierePermiso('pagos.editar'), async (req, res) => {
  const idNoPago = parseInt(req.body.idNoPago);
  if (!idNoPago) return res.status(400).json({ error: 'Cobro inválido.' });
  try {
    const pool = await getPool();
    await withTransaction(pool, async (tx) => {
      // Con el candado de fila, un doble clic o un segundo Grabar no aplica el saldo dos veces:
      // si ya está REALIZADO, sus líneas ya aplicaron su saldo (y los cambios posteriores lo
      // aplican al momento), así que no hay nada más que hacer.
      if (await estadoCobroEditable(tx, idNoPago) === 'REALIZADO') return;

      const detRes = await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`SELECT * FROM Empresa2.PagFac WHERE ID_NOPAGO=@id`);
      if (!detRes.recordset.length) throw Object.assign(new Error('El cobro no tiene líneas.'), { status: 400 });

      const anio = new Date().getFullYear();
      for (const linea of detRes.recordset) {
        const importeTotalLinea = num(linea.TOTALPAGO); // incluye pagado + compensado, ambos saldan la factura por igual
        if (importeTotalLinea <= 0.005) continue;
        if (Number(linea.NOFACTURA) > 0) {
          await ajustarSaldoFactura(tx, 'pago', {
            idNoFactura: linea.NOFACTURA, serieFac: linea.SERIEFAC, importe: importeTotalLinea, signo: 1, anio,
          });
        } else if (Number(linea.ID_NOTACREDITO) > 0) {
          await recalcularStatusND(tx, { idNotaDebito: linea.ID_NOTACREDITO, serieND: linea.SERIEND, extra: num(linea.IMPRTE) + num(linea.COMPESACION), excluirPago: idNoPago });
        }
      }

      await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`UPDATE Empresa2.Pagos SET Status='REALIZADO' WHERE Id_NoPago=@id`);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── Borra el borrador si el usuario cierra sin grabar ─────────────────────
router.post('/cabecera/cancelar-sin-confirmar', requierePermiso('pagos.editar'), async (req, res) => {
  const idNoPago = parseInt(req.body.idNoPago);
  if (!idNoPago) return res.json({ ok: true });
  try {
    const pool = await getPool();
    await withTransaction(pool, async (tx) => {
      const cabRes = await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`SELECT Status, UUID FROM Empresa2.Pagos WHERE Id_NoPago=@id`);
      const cab = cabRes.recordset[0];
      if (cab && trim(cab.Status).toUpperCase() !== 'REALIZADO' && !trim(cab.UUID)) {
        await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`DELETE FROM Empresa2.PagFac WHERE ID_NOPAGO=@id`);
        await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`DELETE FROM Empresa2.Pagos WHERE Id_NoPago=@id`);
      }
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── CANCELAR un pago ya realizado: revierte el efecto de saldo en cascada ─
// NOTA: la cancelación FISCAL ante el PAC (si el pago tiene UUID) se maneja
// en app/routes/cfdi.js (POST /cancelar-pago), que llama a esta misma
// reversión de saldo solo después de que el PAC confirma la cancelación.
async function revertirEfectoSaldoPago(tx, idNoPago) {
  // Solo un cobro REALIZADO aplicó saldo a las facturas; un borrador nunca lo
  // aplicó, así que revertirlo restaría de más a pagos de otros cobros.
  const stRes = await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`SELECT Status FROM Empresa2.Pagos WHERE Id_NoPago=@id`);
  if (trim(stRes.recordset[0]?.Status).toUpperCase() !== 'REALIZADO') return;
  const detRes = await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`SELECT * FROM Empresa2.PagFac WHERE ID_NOPAGO=@id`);
  for (const linea of detRes.recordset) {
    const importeTotalLinea = num(linea.TOTALPAGO);
    if (importeTotalLinea <= 0.005) continue;
    if (Number(linea.NOFACTURA) > 0) {
      await ajustarSaldoFactura(tx, 'pago', { idNoFactura: linea.NOFACTURA, serieFac: linea.SERIEFAC, importe: importeTotalLinea, signo: -1 });
    } else if (Number(linea.ID_NOTACREDITO) > 0) {
      await recalcularStatusND(tx, { idNotaDebito: linea.ID_NOTACREDITO, serieND: linea.SERIEND, extra: 0, excluirPago: idNoPago });
    }
  }
}

router.post('/cancelar', requierePermiso('pagos.btn_cancelar'), async (req, res) => {
  const idNoPago = parseInt(req.body.idNoPago);
  if (!idNoPago) return res.status(400).json({ error: 'Cobro inválido.' });
  try {
    const pool = await getPool();
    const cabRes = await pool.request().input('id', sql.Decimal(9), idNoPago).query(`SELECT Status, UUID FROM Empresa2.Pagos WHERE Id_NoPago=@id`);
    const cab = cabRes.recordset[0];
    if (!cab) return res.status(404).json({ error: 'Cobro no encontrado.' });
    if (trim(cab.Status).toUpperCase() === 'CANCELADO') return res.status(400).json({ error: 'Ya está cancelado.' });
    if (trim(cab.UUID)) {
      return res.status(409).json({ error: 'Este cobro ya está timbrado; debe cancelarse fiscalmente primero (usar el flujo de Cancelar con PAC).', requiereFiscal: true });
    }
    await withTransaction(pool, async (tx) => {
      await revertirEfectoSaldoPago(tx, idNoPago);
      await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago).query(`UPDATE Empresa2.Pagos SET Status='CANCELADO' WHERE Id_NoPago=@id`);
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── COPIAR un cobro CANCELADO en uno nuevo (BORRADOR) con sus mismas líneas ──
// Las líneas se reajustan al saldo ACTUAL de cada factura/ND (el original ya
// revirtió su efecto): se omiten las ya pagadas/canceladas y el importe se topa
// al saldo disponible. El efecto sobre saldos se aplica hasta Grabar.
// Texto de por qué se omite una línea: si ya está saldada, indica en qué cobro/nota.
async function motivoOmision(tx, esFactura, id, serie, saldada) {
  if (!saldada) return 'cancelada o inexistente';
  const docs = await quienAplica(tx, { esFactura, id, serie });
  return docs.length ? 'ya está en ' + docs.join(', ') : 'sin saldo pendiente';
}

router.post('/copiar', requierePermiso('pagos.editar'), requierePermiso('pagos.btn_copiar'), async (req, res) => {
  const idNoPago = parseInt(req.body.idNoPago);
  if (!idNoPago) return res.status(400).json({ error: 'Cobro inválido.' });
  try {
    const pool = await getPool();
    const result = await withTransaction(pool, async (tx) => {
      const orig = (await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago)
        .query(`SELECT Status FROM Empresa2.Pagos WITH (UPDLOCK, ROWLOCK) WHERE Id_NoPago=@id`)).recordset[0];
      if (!orig) throw Object.assign(new Error('Cobro no encontrado.'), { status: 404 });
      if (trim(orig.Status).toUpperCase() !== 'CANCELADO') throw Object.assign(new Error('Solo se puede copiar un cobro cancelado.'), { status: 400 });
      const lineas = (await new sql.Request(tx).input('id', sql.Decimal(9), idNoPago)
        .query(`SELECT * FROM Empresa2.PagFac WHERE ID_NOPAGO=@id ORDER BY ID_NOPAGFAC`)).recordset;
      if (!lineas.length) throw Object.assign(new Error('El cobro no tiene líneas que copiar.'), { status: 400 });

      const r2 = v => Math.round(v * 100) / 100;
      const nuevasLineas = [], omitidas = [];
      for (const l of lineas) {
        const esFactura = Number(l.NOFACTURA) > 0;
        const etiqueta = esFactura
          ? `Factura ${trim(l.SERIEFAC)}${trim(l.SERIEFAC) ? '-' : ''}${l.NOFACTURA}`
          : `Nota de Débito ${trim(l.SERIEND)}${trim(l.SERIEND) ? '-' : ''}${l.ID_NOTACREDITO}`;
        let saldo;
        if (esFactura) {
          const fac = (await new sql.Request(tx).input('id', sql.Decimal(9), l.NOFACTURA).input('serieFac', sql.VarChar(20), serieKey(l.SERIEFAC))
            .query(`SELECT TOTAL, PagosReal, NotasCredito, Status FROM Empresa2.Factura WITH (UPDLOCK, ROWLOCK) WHERE Id_NoFactura=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'')`)).recordset[0];
          if (!fac || trim(fac.Status).toUpperCase() === 'CANCELADA') { omitidas.push(etiqueta + ': cancelada o inexistente'); continue; }
          saldo = r2(Math.max(num(fac.TOTAL) - num(fac.PagosReal) - num(fac.NotasCredito), 0));
        } else {
          const nd = (await new sql.Request(tx).input('id', sql.Decimal(7), l.ID_NOTACREDITO).input('serie', sql.VarChar(10), serieKey(l.SERIEND))
            .query(`SELECT ImporteTotal, Status FROM Empresa2.NotaCred WITH (UPDLOCK, ROWLOCK) WHERE Id_NotaCredito=@id AND LTRIM(RTRIM(Tipo))='ND' AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`)).recordset[0];
          const st = trim(nd && nd.Status).toUpperCase();
          if (!nd || st === 'CANCELADO' || st === 'PAGADA') { omitidas.push(etiqueta + ': ' + (await motivoOmision(tx, false, l.ID_NOTACREDITO, l.SERIEND, !!nd && st === 'PAGADA'))); continue; }
          saldo = r2(Math.max(num(nd.ImporteTotal) - await aplicadoND(tx, { idNotaDebito: l.ID_NOTACREDITO, serieND: l.SERIEND, excluirPago: idNoPago }), 0));
        }
        if (saldo <= 0.005) { omitidas.push(etiqueta + ': ' + (await motivoOmision(tx, esFactura, esFactura ? l.NOFACTURA : l.ID_NOTACREDITO, esFactura ? l.SERIEFAC : l.SERIEND, true))); continue; }
        const totalOrig = num(l.TOTALPAGO);
        const total = r2(Math.min(totalOrig, saldo));
        if (total <= 0.005) { omitidas.push(etiqueta + ': sin importe a pagar'); continue; }
        nuevasLineas.push({ l, saldo, total, f: totalOrig > 0.005 ? total / totalOrig : 0 });
      }
      if (!nuevasLineas.length) {
        throw Object.assign(new Error('Ninguna línea del cobro se puede copiar (ya están pagadas, canceladas o sin saldo): ' + omitidas.join('; ')), { status: 400 });
      }

      const nuevo = (await new sql.Request(tx).query(`SELECT ISNULL(MAX(Id_NoPago),0)+1 AS next FROM Empresa2.Pagos WITH (UPDLOCK, HOLDLOCK)`)).recordset[0].next;
      const usuario = [req.session.usuario.nombre, req.session.usuario.apellido].filter(Boolean).join(' ').trim();
      await new sql.Request(tx)
        .input('id', sql.Decimal(9), idNoPago).input('nuevo', sql.Decimal(9), nuevo)
        .input('hoy', sql.Date, hoy()).input('hora', sql.VarChar(8), new Date().toTimeString().slice(0, 8)).input('usr', sql.VarChar(80), usuario)
        .query(`SELECT * INTO #p FROM Empresa2.Pagos WHERE Id_NoPago=@id;
          UPDATE #p SET Id_NoPago=@nuevo, Fecha=@hoy, Hora=@hora, FechaPago=@hoy, HoraPago=@hora, Status='BORRADOR', ObsCancela=NULL, Realizo=@usr,
            SelloDigital=NULL, SelloSAT=NULL, NoCertificadoSAT=NULL, SelloCFD=NULL, FechaTimbrado=NULL, UUID=NULL, ProvTim=NULL, CadenaTimbre=NULL, CodBarBin=NULL,
            ImporteCheque=0, SumaPartidas=0, TotalComp=0, TotalIVA=0, TotalRet=0, BaseIVA=0, BaseRet=0, TotalIVA_C=0, TotalRet_C=0, BaseIVA_C=0, BaseRet_C=0, TotalImporte=0;
          INSERT INTO Empresa2.Pagos SELECT * FROM #p;
          DROP TABLE #p;`);

      let idd = 0;
      for (const { l, saldo, total, f } of nuevasLineas) {
        idd++;
        const imprte = Math.min(r2(num(l.IMPRTE) * f), total);
        await new sql.Request(tx)
          .input('old', sql.Decimal(9), idNoPago).input('oldd', sql.Decimal(7), l.ID_NOPAGFAC)
          .input('nuevo', sql.Decimal(9), nuevo).input('idd', sql.Decimal(7), idd)
          .input('saldo', sql.Decimal(11, 2), saldo).input('imprte', sql.Decimal(11, 2), imprte).input('total', sql.Decimal(11, 2), total)
          .input('f', sql.Float, f)
          .query(`SELECT * INTO #l FROM Empresa2.PagFac WHERE ID_NOPAGO=@old AND ID_NOPAGFAC=@oldd;
            UPDATE #l SET ID_NOPAGO=@nuevo, ID_NOPAGFAC=@idd, SALDOANT=@saldo, IMPRTE=@imprte, COMPESACION=@total-@imprte, TOTALPAGO=@total,
              SUBTOTAL=ROUND(SUBTOTAL*@f,2), RETENCION=ROUND(RETENCION*@f,2), IVA=ROUND(IVA*@f,2),
              SUBTOTALCOMP=ROUND(SUBTOTALCOMP*@f,2), IVACOMP=ROUND(IVACOMP*@f,2), RETENCIONCOMP=ROUND(RETENCIONCOMP*@f,2);
            INSERT INTO Empresa2.PagFac SELECT * FROM #l;
            DROP TABLE #l;`);
      }
      const totales = await recalcularSumaPartidas(tx, nuevo);
      return { idNoPago: nuevo, totales, omitidas };
    });
    res.json({ ok: true, ...result });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
// Reexpuesto para que app/routes/cfdi.js pueda revertir el efecto de saldo
// SOLO después de que el PAC confirme la cancelación fiscal (POST /cfdi/cancelar-pago).
module.exports.revertirEfectoSaldoPago = revertirEfectoSaldoPago;
module.exports.estadoCobroEditable = estadoCobroEditable;
