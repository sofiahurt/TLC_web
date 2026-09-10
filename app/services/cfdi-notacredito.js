'use strict';

const { create } = require('xmlbuilder2');
const { sql } = require('../config/db');
const { serieFiscal } = require('../config/empresa-serie');
const { fmt, fmtDec, isoFechaHora, agregarConcepto, IVA_TASA } = require('./cfdi-utils');

// c_TipoRelacion en el catálogo sat_TipoRelacion (y como se captura en la app)
// no lleva cero a la izquierda ('1','2'...) pero el XSD del SAT exige 2
// dígitos ('01','02'...) para este atributo -- se rellena solo aquí, al
// momento de emitir el XML (ver [[project_notacred_modulo]]).
function tipoRelacion2d(v) {
  const t = fmt(v);
  if (!t) return '';
  return t.length >= 2 ? t : `0${t}`;
}

/**
 * Arma el CFDI 4.0 de una Nota de Crédito (TipoDeComprobante="E") o Nota de
 * Débito (TipoDeComprobante="I") -- confirmado con el usuario. Relaciona el
 * CFDI con cada Factura/Nota de Débito única aplicada en las líneas vía
 * cfdi:CfdiRelacionados. Reutiliza agregarConcepto/cfdi-utils.js, igual que
 * cfdi-factura.js (misma lógica de Impuestos por concepto, incluido el Base
 * obligatorio a nivel comprobante).
 *
 * @param {string} tipo 'NC' o 'ND'
 * @param {string} serie Puede venir vacía -- misma clave compuesta (Tipo+Serie+Id) que app/routes/notacred.js
 * @param {number} idNotaCredito
 * @param {string} centralOperativo Central activo (req.session.central) -- de qué Empresa/CSD timbrar.
 * @param {object} pool Conexión mssql
 * @returns {Promise<{xml: string}>}
 */
async function buildCFDINotaCredito(tipo, serie, idNotaCredito, centralOperativo, pool) {
  const serieKey = (serie == null ? '' : String(serie)).trim() || null;
  const NC_EQ = `LTRIM(RTRIM(Tipo))=@tipo AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`;

  // 1. Cabecera
  const cabRes = await pool.request()
    .input('tipo', sql.VarChar(3), tipo).input('serie', sql.VarChar(10), serieKey).input('id', sql.Decimal(7), idNotaCredito)
    .query(`SELECT * FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
  if (!cabRes.recordset.length) throw new Error(`Nota ${idNotaCredito} no encontrada`);
  const cab = cabRes.recordset[0];

  // 2. Líneas
  const detRes = await pool.request()
    .input('tipo', sql.VarChar(3), tipo).input('serie', sql.VarChar(10), serieKey).input('id', sql.Decimal(7), idNotaCredito)
    .query(`SELECT * FROM Empresa2.NotaCredDeta WHERE ID_NOTACREDITO=@id AND ${NC_EQ} ORDER BY ID_NOTASCREDDETA`);
  const lineas = detRes.recordset;
  if (!lineas.length) throw new Error(`La Nota ${idNotaCredito} no tiene líneas`);

  // 3. Empresa emisora
  const empRes = await pool.request()
    .input('serie', sql.VarChar(10), serieFiscal(centralOperativo))
    .query(`SELECT * FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE)) = @serie`);
  if (!empRes.recordset.length) throw new Error(`Empresa para serie ${centralOperativo} no encontrada`);
  const emp = empRes.recordset[0];

  // 4. Receptor
  const cliRes = await pool.request()
    .input('id', sql.Decimal(18, 0), cab.Id_Cliente)
    .query(`SELECT * FROM Empresa2.Clientes WHERE Id_Cliente = @id`);
  const cli = cliRes.recordset[0];
  if (!cli) throw new Error(`Cliente ${cab.Id_Cliente} de la Nota ${idNotaCredito} no encontrado`);

  // 5. UUIDs relacionados -- de Factura (UUIDFac ya viene en la línea) o, si la
  // línea referencia una ND previa, se busca el UUID de esa ND.
  const uuids = new Set();
  for (const l of lineas) {
    if (Number(l.ID_NOFACTURA) > 0 && fmt(l.UUIDFac)) uuids.add(fmt(l.UUIDFac));
    else if (Number(l.Id_NotaDebito) > 0) {
      const ndRes = await pool.request()
        .input('id', sql.Decimal(7), l.Id_NotaDebito).input('serie', sql.VarChar(10), (fmt(l.SerieND) || null))
        .query(`SELECT UUID FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND LTRIM(RTRIM(Tipo))='ND' AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`);
      const u = fmt(ndRes.recordset[0]?.UUID);
      if (u) uuids.add(u);
    }
  }

  // ── build XML ───────────────────────────────────────────────────────────
  const emisorRFC    = fmt(emp.RFC);
  const emisorNombre = fmt(emp.NOMBRECORTO);
  const emisorRegFis = fmt(emp.C_REGIMENFISCAL);
  const lugarExp     = fmt(emp.LUGAREXPEDICION) || fmt(emp.CP);
  const tipoComprobante = tipo === 'NC' ? 'E' : 'I';

  const comprobanteAttrs = {
    'xmlns:cfdi':  'http://www.sat.gob.mx/cfd/4',
    'xmlns:xsi':   'http://www.w3.org/2001/XMLSchema-instance',
    'xsi:schemaLocation': [
      'http://www.sat.gob.mx/cfd/4',
      'http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd',
    ].join(' '),
    'Version':          '4.0',
    'Fecha':            isoFechaHora(cab.Fecha, cab.Hora),
    'NoCertificado':    '',
    'Certificado':      '',
    'Sello':            '',
    'FormaPago':        fmt(cab.c_FormaPago) || undefined,
    'SubTotal':         fmtDec(cab.Subtotal, 2),
    'Moneda':           'MXN',
    'Total':            fmtDec(cab.ImporteTotal, 2),
    'TipoDeComprobante': tipoComprobante,
    'Exportacion':      '01',
    'MetodoPago':       fmt(cab.ClaveMP) || undefined,
    'LugarExpedicion':  lugarExp,
  };
  if (fmt(cab.Serie)) comprobanteAttrs.Serie = fmt(cab.Serie);
  comprobanteAttrs.Folio = String(cab.Id_NotaCredito);

  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('cfdi:Comprobante', comprobanteAttrs);

  if (uuids.size) {
    const relNode = doc.ele('cfdi:CfdiRelacionados', { TipoRelacion: tipoRelacion2d(cab.c_TipoRelacion) });
    for (const u of uuids) relNode.ele('cfdi:CfdiRelacionado', { UUID: u }).up();
    relNode.up();
  }

  doc.ele('cfdi:Emisor', {
    Rfc:           emisorRFC,
    Nombre:        emisorNombre,
    RegimenFiscal: emisorRegFis,
  }).up();

  doc.ele('cfdi:Receptor', {
    Rfc:                     fmt(cli.RFC),
    Nombre:                  fmt(cli.NOMBRECOMUN) || fmt(cli.NOMBRECOM),
    DomicilioFiscalReceptor: fmt(cli.CP) || lugarExp,
    RegimenFiscalReceptor:   fmt(cli.C_REGIMENFISCAL),
    UsoCFDI:                 fmt(cab.c_UsoCFDI) || 'G03',
  }).up();

  // ── Conceptos ──────────────────────────────────────────────────────────
  const conceptosNode = doc.ele('cfdi:Conceptos');
  let totalIVA = 0, totalRET = 0, totalBaseIVA = 0;

  if (parseInt(cab.FlagResNota) === 1) {
    const r = agregarConcepto(conceptosNode, {
      claveProdServ: cab.c_ClaveProdServ, claveUnidad: cab.c_ClaveUnidad, descripcion: cab.Descripcion,
      subtotal: cab.Subtotal, iva: parseFloat(cab.IVA) || 0, reten: parseFloat(cab.Retencion) || 0,
    });
    totalIVA += r.iva; totalRET += r.reten;
    if (r.iva > 0.005) totalBaseIVA += r.subtotal;
  } else {
    for (const l of lineas) {
      const r = agregarConcepto(conceptosNode, {
        claveProdServ: cab.c_ClaveProdServ, claveUnidad: cab.c_ClaveUnidad,
        descripcion: fmt(l.DESNOTACREDITO) || fmt(cab.Descripcion),
        subtotal: l.SUBTOTAL, iva: parseFloat(l.IVA) || 0, reten: parseFloat(l.RETENCION) || 0,
      });
      totalIVA += r.iva; totalRET += r.reten;
      if (r.iva > 0.005) totalBaseIVA += r.subtotal;
    }
  }
  conceptosNode.up();

  // ── Impuestos (nivel comprobante) -- mismo criterio verificado en Facturas ─
  if (totalIVA > 0.005 || totalRET > 0.005) {
    const impuestosNode = doc.ele('cfdi:Impuestos', {
      TotalImpuestosRetenidos:   totalRET > 0.005 ? fmtDec(totalRET, 2) : undefined,
      TotalImpuestosTrasladados: totalIVA > 0.005 ? fmtDec(totalIVA, 2) : undefined,
    });
    if (totalRET > 0.005) {
      impuestosNode.ele('cfdi:Retenciones').ele('cfdi:Retencion', {
        Impuesto: '001', Importe: fmtDec(totalRET, 2),
      }).up().up();
    }
    if (totalIVA > 0.005) {
      impuestosNode.ele('cfdi:Traslados').ele('cfdi:Traslado', {
        Base: fmtDec(totalBaseIVA, 2), Impuesto: '002', TipoFactor: 'Tasa', TasaOCuota: IVA_TASA, Importe: fmtDec(totalIVA, 2),
      }).up().up();
    }
    impuestosNode.up();
  }

  return { xml: doc.end({ prettyPrint: true }) };
}

module.exports = { buildCFDINotaCredito };
