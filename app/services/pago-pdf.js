'use strict';

// ── Representación impresa (PDF) de un Pago (Complemento de Pagos) ─────────
// Mismo patrón que notacred-pdf.js/factura-pdf.js: funciona con o sin
// timbre (lee el XML de disco si ya está timbrado, si no arma uno
// equivalente en memoria vía buildCFDIPago). Diseño visual deliberadamente
// simple por ahora, igual que los demás -- se ajusta contra un PDF de
// referencia real si el usuario lo proporciona.

const fs   = require('fs');
const path = require('path');
const { sql } = require('../config/db');
const { RUTA_XML } = require('../config/storage');
const { serieFiscal } = require('../config/empresa-serie');
const { buildCFDIPago } = require('./cfdi-pago');
const { DOMParser } = require('@xmldom/xmldom');
const QRCode = require('qrcode');
const { fmt, numFmt, fechaCorta, horaCorta, resolverLogo, partirLargo, porLocalName, attr } = require('./pdf-utils');

const PdfPrinter  = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;
const vfs         = require('pdfmake/js/virtual-fs.js').default;

const FONTS = { Helvetica: require('pdfmake/standard-fonts/Helvetica.js').Helvetica };
const ROJO  = '#c00000';
const NOBORDER = { hLineWidth: () => 0, vLineWidth: () => 0 };

function num(v) { return parseFloat(v) || 0; }

function extraerDatosXMLPago(xmlString) {
  const doc = new DOMParser({ errorHandler: () => {} }).parseFromString(xmlString, 'text/xml');
  const comprobante = doc.documentElement;
  const emisor   = porLocalName(doc, 'Emisor');
  const receptor = porLocalName(doc, 'Receptor');
  const tfd      = porLocalName(doc, 'TimbreFiscalDigital');
  return {
    noCertificado:     attr(comprobante, 'NoCertificado'),
    emisorRfc:         attr(emisor, 'Rfc'),
    receptorRfc:       attr(receptor, 'Rfc'),
    receptorCP:        attr(receptor, 'DomicilioFiscalReceptor'),
    receptorRegFiscal: attr(receptor, 'RegimenFiscalReceptor'),
    timbre: tfd ? {
      uuid: attr(tfd, 'UUID'),
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
    const rutaTimbrada = path.join(RUTA_XML, `${nombreBase}_Timbrada.xml`);
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

function cajaCliente(d) {
  const clientePagaDistinto = Number(d.pago.Id_RealPago) !== Number(d.pago.Id_Cliente) && fmt(d.pago.NomClientePago);
  return {
    table: { widths: ['*'], body: [
      [{ border: [true,true,true,false], margin: [4,3,4,2], text: [{ text: 'CLIENTE: ', bold: true, fontSize: 8 }, { text: fmt(d.pago.NombreCom), bold: true, fontSize: 9 }] }],
      [{ border: [true,false,true,clientePagaDistinto ? false : true], margin: [4,2,4,2], columns: [
        { text: [{ text: 'RFC: ', bold: true, fontSize: 8 }, { text: fmt(d.receptorRfc || d.cliente.RFC), bold: true, fontSize: 8 }], width: '*' },
        { text: [{ text: 'C.P. ', bold: true, fontSize: 8 }, { text: fmt(d.cliente.CP), fontSize: 8 }], width: 90 },
      ]}],
      ...(clientePagaDistinto ? [[{ border: [true,false,true,true], margin: [4,2,4,3], text: [{ text: 'PAGA: ', bold: true, fontSize: 8 }, { text: fmt(d.pago.NomClientePago), fontSize: 8 }] }]] : []),
    ]},
  };
}

function cajaFolio(d) {
  const folioTxt = String(d.pago.Id_NoPago).padStart(6, ' ');
  const folioFmt = folioTxt.length > 3 ? `${folioTxt.slice(0, -3)} ${folioTxt.slice(-3)}` : folioTxt;
  return {
    table: { widths: ['*'], body: [
      [{ border: [true,true,true,false], margin: [4,3,4,2], columns: [
        { text: 'C O M P R O B A N T E   D E   P A G O', bold: true, fontSize: 7, width: '*' },
        { text: folioFmt, bold: true, fontSize: 11, color: ROJO, width: 'auto' },
      ]}],
      [{ border: [true,false,true,false], margin: [4,2,4,2], columns: [
        { text: fechaCorta(d.pago.FechaPago || d.pago.Fecha), fontSize: 8, bold: true, width: '*' },
        { text: horaCorta(d.pago.Hora), fontSize: 8, width: 'auto' },
      ]}],
      [{ border: [true,false,true,false], margin: [4,2,4,2], stack: [
        { text: 'Folio Fiscal:', bold: true, fontSize: 7 },
        { text: fmt(d.pago.UUID) || '(sin timbrar)', fontSize: 7 },
      ]}],
      [{ border: [true,false,true,true], margin: [4,2,4,3], columns: [
        { text: [{ text: 'Fecha Timbre: ', bold: true, fontSize: 7 }], width: 'auto' },
        { text: fmt(d.pago.FechaTimbrado), fontSize: 7, width: '*' },
      ]}],
    ]},
  };
}

function cajaDatosPago(d) {
  return {
    margin: [0, 8, 0, 0],
    table: { widths: ['*', '*', '*'], body: [[
      { border: [true,true,true,true], margin: [4,3,4,3], text: [{ text: 'Forma de pago: ', bold: true, fontSize: 7 }, { text: fmt(d.pago.FormaPago) || fmt(d.pago.c_FormaPago), fontSize: 7 }] },
      { border: [true,true,true,true], margin: [4,3,4,3], text: [{ text: 'Banco: ', bold: true, fontSize: 7 }, { text: fmt(d.pago.BancoEmisor) || fmt(d.pago.BancoDeposito), fontSize: 7 }] },
      { border: [true,true,true,true], margin: [4,3,4,3], text: [{ text: 'Referencia: ', bold: true, fontSize: 7 }, { text: fmt(d.pago.NoCheuqe), fontSize: 7 }] },
    ]]},
  };
}

function tablaDocumentos(d) {
  const filas = d.lineas.map(l => {
    const ref = Number(l.NOFACTURA) > 0 ? `Factura #${l.NOFACTURA}` : `ND #${l.ID_NOTACREDITO}`;
    return [ref, `$${numFmt(l.IMPRTE, 2)}`, num(l.COMPESACION) > 0.005 ? `$${numFmt(l.COMPESACION, 2)}` : '', `$${numFmt(l.TOTALPAGO, 2)}`];
  });
  return {
    margin: [0, 10, 0, 0],
    table: {
      widths: ['*', 85, 85, 85],
      body: [
        [
          { text: 'Documento', fillColor: '#e0e0e0', bold: true, fontSize: 8 },
          { text: 'Pagado', fillColor: '#e0e0e0', bold: true, fontSize: 8, alignment: 'right' },
          { text: 'Compensado', fillColor: '#e0e0e0', bold: true, fontSize: 8, alignment: 'right' },
          { text: 'Total', fillColor: '#e0e0e0', bold: true, fontSize: 8, alignment: 'right' },
        ],
        ...filas.map(f => [
          { text: f[0], fontSize: 8 }, { text: f[1], fontSize: 8, alignment: 'right' },
          { text: f[2], fontSize: 8, alignment: 'right' }, { text: f[3], fontSize: 8, alignment: 'right' },
        ]),
      ],
    },
  };
}

function bloqueTotales(d) {
  const filas = [
    [{ text: 'IMPORTE PAGADO:', bold: true, fontSize: 8 }, { text: `$${numFmt(num(d.pago.SumaPartidas) - num(d.pago.TotalComp), 2)}`, fontSize: 8, alignment: 'right' }],
  ];
  if (num(d.pago.TotalComp) > 0.005) {
    filas.push([{ text: 'COMPENSADO:', bold: true, fontSize: 8 }, { text: `$${numFmt(d.pago.TotalComp, 2)}`, fontSize: 8, alignment: 'right' }]);
  }
  filas.push([{ text: 'TOTAL:', bold: true, fontSize: 9 }, { text: `$${numFmt(d.pago.SumaPartidas, 2)}`, fontSize: 9, bold: true, alignment: 'right' }]);
  return {
    margin: [0, 8, 0, 0],
    columns: [{ text: '', width: '*' }, { width: 190, table: { widths: ['*', 80], body: filas }, layout: NOBORDER }],
  };
}

async function bloqueSellos(d) {
  if (!d.timbre) return [];
  let qrDataUrl = null;
  try {
    const feUrl = (d.timbre.selloCFD || '').slice(-8);
    const qrTexto = `https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx?id=${d.timbre.uuid}&re=${d.emisorRfc}&rr=${d.receptorRfc}&tt=0&fe=${feUrl}`;
    qrDataUrl = await QRCode.toDataURL(qrTexto, { margin: 1, width: 90 });
  } catch (e) { /* si falla el QR, se omite sin tronar el PDF */ }
  return [
    { margin: [0, 10, 0, 0], text: 'SELLO CSD:', bold: true, fontSize: 7 },
    { text: partirLargo(d.timbre.selloCFD), fontSize: 6, margin: [0, 2, 0, 6] },
    { text: 'SELLO SAT:', bold: true, fontSize: 7 },
    { text: partirLargo(d.timbre.selloSAT), fontSize: 6, margin: [0, 2, 0, 6] },
    { columns: [
      qrDataUrl ? { width: 90, image: qrDataUrl, fit: [90, 90] } : { width: 90, text: '' },
      { width: '*', margin: [10, 0, 0, 0], stack: [
        { text: [{ text: 'No Certificado CSD: ', bold: true, fontSize: 7 }, { text: fmt(d.noCertificado), fontSize: 7 }], margin: [0,0,0,3] },
        { text: [{ text: 'No Certificado SAT: ', bold: true, fontSize: 7 }, { text: fmt(d.timbre.noCertificadoSAT), fontSize: 7 }] },
      ]},
    ]},
  ];
}

async function renderPDFDesdeDatos(d) {
  const content = [];
  content.push({ columns: [cajaCliente(d), { width: 8, text: '' }, { width: 200, ...cajaFolio(d) }] });
  content.push(cajaDatosPago(d));
  content.push(tablaDocumentos(d));
  content.push(bloqueTotales(d));
  content.push(...(await bloqueSellos(d)));

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
