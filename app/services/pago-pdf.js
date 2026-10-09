'use strict';

// ── Representación impresa (PDF) de un Pago (Complemento de Pagos) ─────────
// Mismo patrón que notacred-pdf.js/factura-pdf.js: funciona con o sin
// timbre (lee el XML de disco si ya está timbrado, si no arma uno
// equivalente en memoria vía buildCFDIPago). La estructura sigue el formato
// de referencia real (datos del comprobante, Conceptos, Información del pago,
// CFDI Relacionados y bloque de sellos), con la paleta del resto de PDFs.

const fs   = require('fs');
const path = require('path');
const { sql } = require('../config/db');
const { RUTA_XML } = require('../config/storage');
const { serieFiscal } = require('../config/empresa-serie');
const { buildCFDIPago } = require('./cfdi-pago');
const { DOMParser } = require('@xmldom/xmldom');
const QRCode = require('qrcode');
const {
  fmt, numFmt, resolverLogo, partirLargo, porLocalName, todosPorLocalName, attr,
  descripcionCatalogo, formaPagoTxt,
} = require('./pdf-utils');

const PdfPrinter  = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;
const vfs         = require('pdfmake/js/virtual-fs.js').default;

const FONTS = { Helvetica: require('pdfmake/standard-fonts/Helvetica.js').Helvetica };
const AZUL  = '#1a3f6f';
const ROJO  = '#c00000';
const GRIS  = '#e0e0e0';
const NOBORDER = { hLineWidth: () => 0, vLineWidth: () => 0 };
const MONEDAS = { MXN: 'Pesos Mexicanos', USD: 'Dolar Americano' };
const TXT_SIN_MONEDA = 'Los códigos usados para las transacciones en que intervenga ninguna moneda';

function num(v) { return parseFloat(v) || 0; }

function extraerDatosXMLPago(xmlString) {
  const doc = new DOMParser({ errorHandler: () => {} }).parseFromString(xmlString, 'text/xml');
  const comprobante = doc.documentElement;
  const emisor   = porLocalName(doc, 'Emisor');
  const receptor = porLocalName(doc, 'Receptor');
  const tfd      = porLocalName(doc, 'TimbreFiscalDigital');
  // Un nodo pago20:Pago por forma de pago real; el de Compensación
  // (FormaDePagoP=17) trae aparte sus propios DoctoRelacionado.
  const pagos = todosPorLocalName(doc, 'Pago')
    .filter(n => n.getAttribute('FormaDePagoP'))
    .map(n => ({
      formaPago: attr(n, 'FormaDePagoP'), fechaPago: attr(n, 'FechaPago'), moneda: attr(n, 'MonedaP'),
      monto: attr(n, 'Monto'), numOperacion: attr(n, 'NumOperacion'),
      docs: todosPorLocalName(n, 'DoctoRelacionado').map(dr => ({
        uuid: attr(dr, 'IdDocumento'), serie: attr(dr, 'Serie'), folio: attr(dr, 'Folio'),
        saldoAnt: attr(dr, 'ImpSaldoAnt'), pagado: attr(dr, 'ImpPagado'), saldoInsoluto: attr(dr, 'ImpSaldoInsoluto'),
      })),
    }));
  return {
    fechaComprobante:  attr(comprobante, 'Fecha'),
    lugarExpedicion:   attr(comprobante, 'LugarExpedicion'),
    noCertificado:     attr(comprobante, 'NoCertificado'),
    emisorRfc:         attr(emisor, 'Rfc'),
    emisorNombre:      attr(emisor, 'Nombre'),
    emisorRegimen:     attr(emisor, 'RegimenFiscal'),
    receptorRfc:       attr(receptor, 'Rfc'),
    receptorNombre:    attr(receptor, 'Nombre'),
    receptorCP:        attr(receptor, 'DomicilioFiscalReceptor'),
    receptorRegFiscal: attr(receptor, 'RegimenFiscalReceptor'),
    usoCfdi:           attr(receptor, 'UsoCFDI'),
    pagos,
    timbre: tfd ? {
      uuid: attr(tfd, 'UUID'),
      version: attr(tfd, 'Version'),
      fechaTimbrado: attr(tfd, 'FechaTimbrado'),
      rfcProvCertif: attr(tfd, 'RfcProvCertif'),
      noCertificadoSAT: attr(tfd, 'NoCertificadoSAT'),
      selloCFD: attr(tfd, 'SelloCFD'),
      selloSAT: attr(tfd, 'SelloSAT'),
    } : null,
  };
}

async function datosParaImpresionPago(idNoPago, pool, centralOperativo = 'CUA') {
  const cabRes = await pool.request().input('id', sql.Decimal(9), idNoPago).query(`SELECT * FROM Empresa2.Pagos WHERE Id_NoPago=@id`);
  const pago = cabRes.recordset[0];
  if (!pago) throw new Error(`Cobro ${idNoPago} no encontrado`);

  const detRes = await pool.request().input('id', sql.Decimal(9), idNoPago).query(`SELECT * FROM Empresa2.PagFac WHERE ID_NOPAGO=@id ORDER BY ID_NOPAGFAC`);
  const lineas = detRes.recordset;

  const cliRes = await pool.request().input('id', sql.Decimal(18, 0), pago.Id_Cliente)
    .query(`SELECT CP, C_REGIMENFISCAL, REGIMENFISCAL, RFC FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
  const cliente = cliRes.recordset[0] || {};

  // El Pago no guarda su propio central operativo -- se toma de la sesión
  // activa al momento de imprimir (mismo criterio que notacredito, que
  // recibe centralOperativo como parámetro del llamador).
  const empRes = await pool.request().input('serie', sql.VarChar(10), serieFiscal(centralOperativo)).query(`SELECT * FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE)) = @serie`);
  const emp = empRes.recordset[0];
  if (!emp) throw new Error(`Empresa no encontrada para serie "${centralOperativo}"`);

  const uuid = fmt(pago.UUID);
  const timbrado = !!uuid;
  const nombreBase = `PAGO_${idNoPago}`;

  let xmlString;
  if (timbrado) {
    const rutaTimbrada = path.join(RUTA_XML, `${nombreBase}_TIMBRADO.xml`);
    const rutaPrueba   = path.join(RUTA_XML, `${nombreBase}_Prueba.xml`);
    const rutaFinal = fs.existsSync(rutaTimbrada) ? rutaTimbrada : (fs.existsSync(rutaPrueba) ? rutaPrueba : null);
    if (!rutaFinal) throw new Error(`Este Cobro está marcado como timbrado pero no se encontró el XML en ${RUTA_XML}`);
    xmlString = fs.readFileSync(rutaFinal, 'utf8');
  } else {
    const built = await buildCFDIPago(idNoPago, centralOperativo, pool);
    xmlString = built.xml;
  }

  const datosXml = extraerDatosXMLPago(xmlString);
  return { pago, lineas, emp, cliente, logo: resolverLogo(emp.LOGOEMPRESA), ...datosXml };
}

function encabezadoEmpresa(emp, logo) {
  const domicilio = [fmt(emp.CALLE), 'N°', fmt(emp.NOEXT)].filter(Boolean).join(' ');
  const ciudad = `${fmt(emp.COLONIA)}, C.P. ${fmt(emp.CP)}, ${fmt(emp.MUNICIPIO)}, ${fmt(emp.ESTADO) === 'CDMX' ? 'CDMX' : fmt(emp.CIUDAD)}.`;
  return {
    stack: [
      { columns: [
        logo ? { image: logo, width: 60, height: 60 } : { text: '', width: 60 },
        { text: fmt(emp.NOMBRECORTO), bold: true, fontSize: 13, alignment: 'center', width: '*', margin: [0, 18, 0, 0] },
        { text: '', width: 60 },
      ]},
      { text: `Registro Federal de Contribuyentes ${fmt(emp.RFC)}`, fontSize: 8, alignment: 'center', margin: [0, 2, 0, 0] },
      { text: domicilio, fontSize: 8, alignment: 'center' },
      { text: ciudad, fontSize: 8, alignment: 'center' },
    ],
  };
}

// Etiqueta en negrita + valor, como los pares del encabezado del formato.
function par(etiqueta, valor, extra = {}) {
  return { text: [{ text: `${etiqueta} `, bold: true }, { text: valor || '', ...extra }], fontSize: 8, margin: [0, 0, 0, 3] };
}

function barraSeccion(titulo) {
  return {
    margin: [0, 10, 0, 4], layout: NOBORDER,
    table: { widths: [150], body: [[{ text: titulo, bold: true, fontSize: 9, fillColor: GRIS, margin: [2, 3, 2, 3] }]] },
  };
}

function celdaEnc(texto, alignment = 'center') {
  return { text: texto, fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment };
}

function bloqueDatosComprobante(d) {
  const regimen = descripcionCatalogo('sat_regimenfiscal', 'c_regimenfiscal', d.emisorRegimen, '') || d.emisorRegimen;
  const uso = descripcionCatalogo('sat_usoCDFI', 'c_usocfdi', d.usoCfdi, '');
  return {
    margin: [0, 8, 0, 0],
    columns: [
      { width: '*', stack: [
        par('RFC emisor:', d.emisorRfc),
        par('Nombre emisor:', d.emisorNombre),
        par('Folio:', String(d.pago.Id_NoPago), { color: ROJO, bold: true }),
        par('RFC receptor:', d.receptorRfc || fmt(d.cliente.RFC)),
        par('Nombre receptor:', d.receptorNombre || fmt(d.pago.NombreCom)),
        par('Uso CFDI:', uso ? `${d.usoCfdi} - ${uso}` : d.usoCfdi),
      ]},
      { width: '*', stack: [
        par('Folio Fiscal:', fmt(d.pago.UUID) || '(sin timbrar)'),
        par('No. de Serie del CSD:', d.noCertificado),
        par('C.P., Fecha y Hora:', `${d.lugarExpedicion}   ${d.fechaComprobante}`),
        par('Efecto del comprobante:', 'Pago'),
        par('Régimen fiscal:', regimen),
      ]},
    ],
  };
}

function bloqueConceptos() {
  const cel = (t, alignment = 'center') => ({ text: t, fontSize: 8, alignment });
  return [
    barraSeccion('Conceptos'),
    { table: { widths: [60, 45, '*', 55, 70, 60], body: [
      [celdaEnc('Código'), celdaEnc('Cantidad'), celdaEnc('No. Identificación'), celdaEnc('Unidad Medida'), celdaEnc('Precio Unitario'), celdaEnc('Importe')],
      [cel('84111506'), cel('1'), cel(''), cel('ACT'), cel('$ 0.00', 'right'), cel('$ 0.00', 'right')],
      [celdaEnc('Descripción'), { text: 'Pago', fontSize: 8, colSpan: 5 }, {}, {}, {}, {}],
    ]}},
    { margin: [0, 8, 0, 0], columns: [
      { width: '*', text: [{ text: 'Moneda: ', bold: true }, TXT_SIN_MONEDA], fontSize: 8 },
      { width: 150, layout: NOBORDER, table: { widths: ['*', 70], body: [
        [{ text: 'Subtotal:', bold: true, alignment: 'right', fontSize: 8 }, { text: '$ 0.00', alignment: 'right', fontSize: 8 }],
        [{ text: 'Total:', bold: true, alignment: 'right', fontSize: 8 }, { text: '$ 0.00', alignment: 'right', fontSize: 8 }],
      ]}},
    ]},
  ];
}

function bloqueInfoPago(d) {
  // Dato principal: el nodo de pago real; el de Compensación (17) solo se
  // refleja en la columna "Compensación" de los CFDI relacionados.
  const real = d.pagos.find(p => p.formaPago !== '17') || d.pagos[0] || {};
  const forma = real.formaPago ? `${real.formaPago} - ${formaPagoTxt(real.formaPago, '')}` : '';
  return [
    barraSeccion('Información del pago'),
    { columns: [
      { width: '*', stack: [par('Forma de Pago:', forma), par('No. de Operación:', real.numOperacion || fmt(d.pago.NoCheuqe))] },
      { width: '*', stack: [
        par('Fecha de Pago:', real.fechaPago),
        par('Moneda de Pago:', MONEDAS[real.moneda] || real.moneda),
        par('Monto:', numFmt(real.monto, 2)),
      ]},
    ]},
  ];
}

function tablaRelacionados(d) {
  const real = d.pagos.find(p => p.formaPago !== '17');
  const comp = d.pagos.find(p => p.formaPago === '17');
  const clave = (x) => `${x.uuid}|${x.serie}|${x.folio}`;
  const filas = new Map();
  for (const x of (real ? real.docs : [])) filas.set(clave(x), { ...x, comp: 0 });
  for (const x of (comp ? comp.docs : [])) {
    const f = filas.get(clave(x));
    if (f) { f.comp += num(x.pagado); f.saldoInsoluto = x.saldoInsoluto; }
    else filas.set(clave(x), { ...x, pagado: '0', comp: num(x.pagado) });
  }
  const c = (t, alignment = 'right') => ({ text: t, fontSize: 7.5, alignment });
  const body = [[celdaEnc('UUID', 'left'), celdaEnc('Folio'), celdaEnc('Saldo Ant.'), celdaEnc('Importe Pagado'), celdaEnc('Saldo Insoluto'), celdaEnc('Compensación')]];
  for (const f of filas.values()) {
    const folio = [f.serie, f.folio].filter(Boolean).join(' ');
    body.push([c(f.uuid, 'left'), c(folio), c(`$${numFmt(f.saldoAnt, 2)}`), c(`$${numFmt(f.pagado, 2)}`), c(`$${numFmt(f.saldoInsoluto, 2)}`), c(`$${numFmt(f.comp, 2)}`)]);
  }
  return [
    { text: 'CFDI Relacionados', bold: true, italics: true, fontSize: 9, margin: [0, 8, 0, 3] },
    { table: { headerRows: 1, widths: [165, 50, 62, 70, 65, 65], body } },
  ];
}

async function bloqueSellos(d) {
  const t = d.timbre;
  if (!t) return [];
  let qrDataUrl = null;
  try {
    const feUrl = (t.selloCFD || '').slice(-8);
    const qrTexto = `https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx?id=${t.uuid}&re=${d.emisorRfc}&rr=${d.receptorRfc}&tt=0&fe=${feUrl}`;
    qrDataUrl = await QRCode.toDataURL(qrTexto, { margin: 1, width: 90 });
  } catch (e) { /* si falla el QR, se omite sin tronar el PDF */ }
  // Cadena original del complemento Timbre Fiscal Digital
  const cadena = `||${t.version || '1.1'}|${t.uuid}|${t.fechaTimbrado}|${t.rfcProvCertif}|${t.selloCFD}|${t.noCertificadoSAT}||`;
  const lbl = (txt) => ({ text: txt, bold: true, fontSize: 8, fillColor: GRIS });
  const val = (txt, extra = {}) => ({ text: txt, fontSize: 6.5, ...extra });
  return [
    { margin: [0, 14, 0, 0], unbreakable: true, columns: [
      { width: '*', table: { widths: [62, '*', 62, '*'], body: [
        [lbl('Cadena Original:'), val(partirLargo(cadena), { colSpan: 3 }), {}, {}],
        [lbl('Sello:'), val(partirLargo(t.selloCFD), { colSpan: 3 }), {}, {}],
        [lbl('SelloSAT:'), val(partirLargo(t.selloSAT), { colSpan: 3 }), {}, {}],
        [lbl('Fecha Timbrado:'), val(t.fechaTimbrado), lbl('Certificado SAT:'), val(t.noCertificadoSAT)],
        [lbl('Versión:'), val(t.version || '1.1', { colSpan: 3 }), {}, {}],
      ]}},
      qrDataUrl ? { width: 90, margin: [8, 0, 0, 0], image: qrDataUrl, fit: [90, 90] } : { width: 0, text: '' },
    ]},
  ];
}

async function renderPDFDesdeDatos(d) {
  const content = [
    bloqueDatosComprobante(d),
    ...bloqueConceptos(),
    ...bloqueInfoPago(d),
    ...tablaRelacionados(d),
    ...(await bloqueSellos(d)),
  ];

  const docDefinition = {
    pageMargins: [30, 30, 30, 30],
    defaultStyle: { font: 'Helvetica', fontSize: 8, lineHeight: 1.2 },
    content: [encabezadoEmpresa(d.emp, d.logo), { text: '', margin: [0, 6, 0, 0] }, ...content],
  };

  const printer = new PdfPrinter(FONTS, vfs, new URLResolver());
  const pdfDoc = await printer.createPdfKitDocument(docDefinition);
  return new Promise((resolve, reject) => {
    const chunks = [];
    pdfDoc.on('data', (c) => chunks.push(c));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
    pdfDoc.end();
  });
}

async function generarPDFBufferPago(idNoPago, pool, centralOperativo = 'CUA') {
  const d = await datosParaImpresionPago(idNoPago, pool, centralOperativo);
  return renderPDFDesdeDatos(d);
}

module.exports = { datosParaImpresionPago, extraerDatosXMLPago, generarPDFBufferPago, renderPDFDesdeDatos };
