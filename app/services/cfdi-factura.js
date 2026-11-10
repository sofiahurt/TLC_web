'use strict';

const { create } = require('xmlbuilder2');
const { sql } = require('../config/db');
const { serieFiscal } = require('../config/empresa-serie');
const { buildComplementoCartaPorte } = require('./cfdi-traslado');
const { fmt, fmtDec, isoFechaHora, agregarConcepto, IVA_TASA } = require('./cfdi-utils');
const { CLAVE_PRODSERV_APOYO, DESCRIPCION_APOYO, esMultipartidaConCP, esPartidaDeApoyo } = require('./factura-conceptos');

// Base de la retención de una partida (como el sistema Clarion: flete + kilómetros + paradas; aquí también la renta,
// que es el núcleo alternativo al flete). Los demás conceptos (casetas, maniobras, otros...) solo llevan IVA.
// La base debe cuadrar con la retención guardada (4%); si no cuadra al centavo se deriva de ella (retención / 4%).
const TASA_RETENCION = 0.04;
function baseRetencionLinea(l) {
  const reten = parseFloat(l.RETEN) || 0;
  if (reten <= 0.005) return 0;
  const n = v => parseFloat(v) || 0;
  const base = Math.round((n(l.COSTOFLETE) + n(l.CostoRenta) + n(l.KILOMETROS) + n(l.COSTOPARADA)) * 100) / 100;
  if (base > 0.005 && Math.abs(Math.round(base * TASA_RETENCION * 100) / 100 - reten) <= 0.015) return base;
  return Math.round(reten / TASA_RETENCION * 100) / 100;
}

/**
 * Arma el CFDI 4.0 (TipoDeComprobante="I") de una Factura. Reutiliza el mismo
 * armador de complemento Carta Porte que usa buildCFDITraslado
 * (buildComplementoCartaPorte) cuando Factura.IncluirCP=1.
 *
 * @param {number} idNoFactura
 * @param {string} serieFac Puede venir vacía -- misma clave compuesta que usa app/routes/facturas.js
 * @param {string} centralOperativo Central activo (req.session.central) -- Factura no
 *   guarda su propio central operativo (solo SerieFac, que es otra cosa), así que
 *   el llamador debe indicar de qué Empresa/CSD timbrar, igual que hace Carta Porte.
 * @param {object} pool Conexión mssql
 * @returns {Promise<{xml: string, idCCP: string|null}>}
 */
async function buildCFDIFactura(idNoFactura, serieFac, centralOperativo, pool) {
  const serieFacKey = (serieFac == null ? '' : String(serieFac)).trim() || null;
  const SERIEFAC_EQ = `ISNULL(LTRIM(RTRIM(SerieFac)),'') = ISNULL(@serieFac,'')`;

  // 1. Factura
  const facRes = await pool.request()
    .input('id', sql.Decimal(9), idNoFactura)
    .input('serieFac', sql.VarChar(20), serieFacKey)
    .query(`SELECT * FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);
  if (!facRes.recordset.length) throw new Error(`Factura ${idNoFactura} no encontrada`);
  const fac = facRes.recordset[0];

  // 2. Líneas
  const detRes = await pool.request()
    .input('id', sql.Decimal(9), idNoFactura)
    .input('serieFac', sql.VarChar(20), serieFacKey)
    .query(`SELECT * FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND ${SERIEFAC_EQ} ORDER BY ID_NODETAFAC`);
  const lineas = detRes.recordset;
  if (!lineas.length) throw new Error(`La Factura ${idNoFactura} no tiene partidas`);

  const incluirCP = parseInt(fac.IncluirCP) === 1;
  // Incluir CP con varias partidas: la 1 es el flete (y arma el complemento); las demás van como conceptos de apoyo
  // (ver factura-conceptos.js). Eso solo se puede armar partida por partida, no en modo "Un Concepto".
  if (esMultipartidaConCP(fac, lineas) && parseInt(fac.FlagResFac) === 1) {
    throw new Error('Con "Incluir CP" y varias partidas la factura debe armarse por partida: desmarque "Un Concepto".');
  }

  // 3. Empresa emisora — misma consulta/patrón que buildCFDITraslado.
  const empRes = await pool.request()
    .input('serie', sql.VarChar(10), serieFiscal(centralOperativo))
    .query(`SELECT * FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE)) = @serie`);
  if (!empRes.recordset.length) throw new Error(`Empresa para serie ${centralOperativo} no encontrada`);
  const emp = empRes.recordset[0];

  // 4. Receptor
  const cliRes = await pool.request()
    .input('id', sql.Decimal(18,0), fac.Id_Cliente)
    .query(`SELECT * FROM Empresa2.Clientes WHERE Id_Cliente = @id`);
  const cli = cliRes.recordset[0];
  if (!cli) throw new Error(`Cliente ${fac.Id_Cliente} de la Factura ${idNoFactura} no encontrado`);

  // ── build XML ───────────────────────────────────────────────────────────

  const emisorRFC    = fmt(emp.RFC);
  const emisorNombre = fmt(emp.NOMBRECORTO);
  const emisorRegFis = fmt(emp.C_REGIMENFISCAL);
  const lugarExp     = fmt(emp.LUGAREXPEDICION) || fmt(emp.CP);

  const moneda = fmt(fac.MonFactura) || 'MXN';
  const esExtranjero = moneda !== 'MXN';

  const comprobanteAttrs = {
    'xmlns:cfdi':  'http://www.sat.gob.mx/cfd/4',
    'xmlns:xsi':   'http://www.w3.org/2001/XMLSchema-instance',
    'xsi:schemaLocation': [
      'http://www.sat.gob.mx/cfd/4',
      'http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd',
    ].join(' '),
    'Version':          '4.0',
    'Fecha':            isoFechaHora(fac.FechaFactura, fac.Hora),
    'NoCertificado':    '',
    'Certificado':      '',
    'Sello':            '',
    'FormaPago':        fmt(fac.c_FormaPago) || undefined,
    'CondicionesDePago': fmt(fac.CondicionesPago) || undefined,
    'SubTotal':         fmtDec(fac.SubTotal, 2),
    'Descuento':        parseFloat(fac.Descuento) > 0 ? fmtDec(fac.Descuento, 2) : undefined,
    'Moneda':           moneda,
    'TipoCambio':       esExtranjero ? fmtDec(fac.TipoCambio, 4) : undefined,
    'Total':            fmtDec(fac.TOTAL, 2),
    'TipoDeComprobante': 'I',
    'Exportacion':      '01',
    'MetodoPago':       fmt(fac.ClaveMP) || undefined,
    'LugarExpedicion':  lugarExp,
  };
  if (fmt(fac.SerieFac)) comprobanteAttrs.Serie = fmt(fac.SerieFac);
  comprobanteAttrs.Folio = String(fac.Id_NoFactura);
  if (incluirCP) {
    comprobanteAttrs['xmlns:cartaporte31'] = 'http://www.sat.gob.mx/CartaPorte31';
    comprobanteAttrs['xsi:schemaLocation'] += ' http://www.sat.gob.mx/CartaPorte31 http://www.sat.gob.mx/sitio_internet/cfd/CartaPorte/CartaPorte31.xsd';
  }

  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('cfdi:Comprobante', comprobanteAttrs);

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
    UsoCFDI:                 fmt(fac.c_UsoCFDI) || 'P01',
  }).up();

  // ── Conceptos ──────────────────────────────────────────────────────────
  const conceptosNode = doc.ele('cfdi:Conceptos');
  let totalIVA = 0, totalRET = 0, totalBaseIVA = 0;

  if (parseInt(fac.FlagResFac) === 1) {
    // Un solo concepto agregado -- cabecera
    const r = agregarConcepto(conceptosNode, {
      claveProdServ: '78141500',
      claveUnidad:   'E48',
      descripcion:   fac.Descripcion,
      subtotal:      fac.SubTotal,
      iva:           parseFloat(fac.IVA) || 0,
      reten:         parseFloat(fac.Retencion) || 0,
      baseRetencion: (() => {   // suma de las bases de retención de las partidas; si no cuadra con la cabecera, Retención / 4%
        const reten = parseFloat(fac.Retencion) || 0;
        const suma = lineas.reduce((a, l) => a + baseRetencionLinea(l), 0);
        return Math.abs(suma * TASA_RETENCION - reten) <= 0.02 * lineas.length ? suma : reten / TASA_RETENCION;
      })(),
    });
    totalIVA += r.iva; totalRET += r.reten;
    if (r.iva > 0.005) totalBaseIVA += r.subtotal;
  } else {
    // Un concepto por cada línea de FacDeta
    for (const [idx, l] of lineas.entries()) {
      const apoyo = esPartidaDeApoyo(fac, lineas, idx);
      const r = agregarConcepto(conceptosNode, {
        claveProdServ: apoyo ? CLAVE_PRODSERV_APOYO : l.C_CLAVEPRODSERV,
        claveUnidad:   (apoyo && !fmt(l.C_CLAVEUNIDAD)) ? 'E48' : l.C_CLAVEUNIDAD,
        descripcion:   apoyo ? DESCRIPCION_APOYO : (l.DESCRIPCION || `CARTA PORTE ${fmt(l.CARTAPORTE)}`),
        subtotal:      l.SUBTOTAL,
        iva:           parseFloat(l.IVA) || 0,
        reten:         parseFloat(l.RETEN) || 0,
        baseRetencion: baseRetencionLinea(l),
      });
      totalIVA += r.iva; totalRET += r.reten;
      if (r.iva > 0.005) totalBaseIVA += r.subtotal;
    }
  }
  conceptosNode.up();

  // ── Impuestos (nivel comprobante) ─────────────────────────────────────────
  // Nota: a este nivel, cfdi:Traslados/cfdi:Traslado SÍ requiere Base (atributo
  // obligatorio del XSD, aunque la cadena original oficial no lo incluya en el
  // hash) -- cfdi:Retenciones/cfdi:Retencion, en cambio, NO lleva Base a este
  // nivel (solo Impuesto+Importe), confirmado contra el XSD oficial del SAT.
  if (totalIVA > 0.005 || totalRET > 0.005) {
    const impuestosNode = doc.ele('cfdi:Impuestos', {
      TotalImpuestosRetenidos:   totalRET > 0.005 ? fmtDec(totalRET, 2) : undefined,
      TotalImpuestosTrasladados: totalIVA > 0.005 ? fmtDec(totalIVA, 2) : undefined,
    });
    if (totalRET > 0.005) {
      impuestosNode.ele('cfdi:Retenciones').ele('cfdi:Retencion', {
        Impuesto: '002', Importe: fmtDec(totalRET, 2),
      }).up().up();
    }
    if (totalIVA > 0.005) {
      impuestosNode.ele('cfdi:Traslados').ele('cfdi:Traslado', {
        Base: fmtDec(totalBaseIVA, 2), Impuesto: '002', TipoFactor: 'Tasa', TasaOCuota: IVA_TASA, Importe: fmtDec(totalIVA, 2),
      }).up().up();
    }
    impuestosNode.up();
  }

  // ── Complemento Carta Porte (solo si IncluirCP=1) ─────────────────────────
  let idCCP = null;
  if (incluirCP) {
    const complemento = doc.ele('cfdi:Complemento');
    const cpLinea = lineas[0];
    const r = await buildComplementoCartaPorte(complemento, fmt(cpLinea.SERIE), fmt(cpLinea.CARTAPORTE), emp, pool);
    idCCP = r.idCCP;
    complemento.up();
  }

  return { xml: doc.end({ prettyPrint: true }), idCCP };
}

module.exports = { buildCFDIFactura };
