'use strict';

// ── Representación impresa (PDF) de Notas de Crédito/Débito ────────────────
// Mismo patrón que factura-pdf.js: funciona con o sin timbre (lee el XML de
// disco si ya está timbrada, si no arma uno equivalente en memoria). Diseño
// visual deliberadamente simple por ahora -- se ajustará contra un PDF de
// referencia real cuando el usuario lo proporcione (ver plan del módulo),
// igual que se hizo con Facturas.

const fs   = require('fs');
const path = require('path');
const { sql } = require('../config/db');
const { RUTA_XML } = require('../config/storage');
const { buildCFDINotaCredito } = require('./cfdi-notacredito');
const { DOMParser } = require('@xmldom/xmldom');
const QRCode = require('qrcode');
const {
  fmt, numFmt, fechaCorta, horaCorta, resolverLogo, partirLargo,
  porLocalName, attr,
} = require('./pdf-utils');

const PdfPrinter  = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;
const vfs         = require('pdfmake/js/virtual-fs.js').default;

const FONTS = { Helvetica: require('pdfmake/standard-fonts/Helvetica.js').Helvetica };
const ROJO  = '#c00000';
const NOBORDER = { hLineWidth: () => 0, vLineWidth: () => 0 };

function extraerDatosXMLNotaCredito(xmlString) {
  const doc = new DOMParser({ errorHandler: () => {} }).parseFromString(xmlString, 'text/xml');
  const comprobante = doc.documentElement;
  const emisor   = porLocalName(doc, 'Emisor');
  const receptor = porLocalName(doc, 'Receptor');
  const tfd      = porLocalName(doc, 'TimbreFiscalDigital');
  return {
    noCertificado:    attr(comprobante, 'NoCertificado'),
    emisorRfc:        attr(emisor, 'Rfc'),
    receptorRfc:      attr(receptor, 'Rfc'),
    receptorCP:       attr(receptor, 'DomicilioFiscalReceptor'),
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

async function datosParaImpresionNotaCredito(tipo, serie, idNotaCredito, centralOperativo, pool) {
  const serieKey = (serie == null ? '' : String(serie)).trim() || null;
  const NC_EQ = `LTRIM(RTRIM(Tipo))=@tipo AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`;

  const cabRes = await pool.request()
    .input('tipo', sql.VarChar(3), tipo).input('serie', sql.VarChar(10), serieKey).input('id', sql.Decimal(7), idNotaCredito)
    .query(`SELECT * FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
  const nc = cabRes.recordset[0];
  if (!nc) throw new Error(`Nota ${idNotaCredito} no encontrada`);

  const detRes = await pool.request()
    .input('tipo', sql.VarChar(3), tipo).input('serie', sql.VarChar(10), serieKey).input('id', sql.Decimal(7), idNotaCredito)
    .query(`SELECT * FROM Empresa2.NotaCredDeta WHERE ID_NOTACREDITO=@id AND ${NC_EQ} ORDER BY ID_NOTASCREDDETA`);
  const lineas = detRes.recordset;

  const cliRes = await pool.request().input('id', sql.Decimal(18, 0), nc.Id_Cliente)
    .query(`SELECT CP, C_REGIMENFISCAL, REGIMENFISCAL FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
  const cliente = cliRes.recordset[0] || {};

  const { serieFiscal } = require('../config/empresa-serie');
  const empRes = await pool.request()
    .input('serie', sql.VarChar(10), serieFiscal(centralOperativo))
    .query(`SELECT * FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE)) = @serie`);
  const emp = empRes.recordset[0];
  if (!emp) throw new Error(`Empresa no encontrada para serie "${centralOperativo}"`);

  const uuid = fmt(nc.UUID);
  const timbrada = !!uuid;
  const nombreBase = `NC_${tipo}${serieKey || 'SF'}${idNotaCredito}`;

  let xmlString;
  if (timbrada) {
    const rutaTimbrada = path.join(RUTA_XML, `${nombreBase}_Timbrada.xml`);
    const rutaPrueba   = path.join(RUTA_XML, `${nombreBase}_Prueba.xml`);
    const rutaFinal = fs.existsSync(rutaTimbrada) ? rutaTimbrada : (fs.existsSync(rutaPrueba) ? rutaPrueba : null);
    if (!rutaFinal) throw new Error(`Esta Nota está marcada como timbrada pero no se encontró el XML en ${RUTA_XML}`);
    xmlString = fs.readFileSync(rutaFinal, 'utf8');
  } else {
    const built = await buildCFDINotaCredito(tipo, serieKey, idNotaCredito, centralOperativo, pool);
    xmlString = built.xml;
  }

  const datosXml = extraerDatosXMLNotaCredito(xmlString);

  return { nc, lineas, emp, cliente, logo: resolverLogo(emp.LOGOEMPRESA), ...datosXml };
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
  return {
    table: { widths: ['*'], body: [
      [{ border: [true,true,true,false], margin: [4,3,4,2], text: [{ text: 'CLIENTE: ', bold: true, fontSize: 8 }, { text: fmt(d.nc.NombreCom), bold: true, fontSize: 9 }] }],
      [{ border: [true,false,true,false], margin: [4,2,4,2], columns: [
        { text: [{ text: 'RFC: ', bold: true, fontSize: 8 }, { text: fmt(d.receptorRfc), bold: true, fontSize: 8 }], width: '*' },
        { text: [{ text: 'C.P. ', bold: true, fontSize: 8 }, { text: fmt(d.cliente.CP), fontSize: 8 }], width: 90 },
      ]}],
      [{ border: [true,false,true,false], margin: [4,2,4,2], text: [{ text: 'REG.FISCAL ', bold: true, fontSize: 8 }, { text: `${fmt(d.cliente.C_REGIMENFISCAL)}  ${fmt(d.cliente.REGIMENFISCAL)}`, fontSize: 8 }] }],
      [{ border: [true,false,true,true], margin: [4,2,4,3], text: [{ text: 'USO CFDI: ', bold: true, fontSize: 8 }, { text: fmt(d.nc.c_UsoCFDI), fontSize: 8 }] }],
    ]},
  };
}

function cajaFolio(d) {
  const tipoTxt = d.nc.Tipo === 'NC' ? 'N O T A   D E   C R É D I T O' : 'N O T A   D E   D É B I T O';
  const folioTxt = String(d.nc.Id_NotaCredito).padStart(6, ' ');
  const folioFmt = folioTxt.length > 3 ? `${folioTxt.slice(0, -3)} ${folioTxt.slice(-3)}` : folioTxt;
  return {
    table: { widths: ['*'], body: [
      [{ border: [true,true,true,false], margin: [4,3,4,2], columns: [
        { text: tipoTxt, bold: true, fontSize: 8, width: '*' },
        { text: folioFmt, bold: true, fontSize: 11, color: ROJO, width: 'auto' },
      ]}],
      [{ border: [true,false,true,false], margin: [4,2,4,2], columns: [
        { text: fechaCorta(d.nc.Fecha), fontSize: 8, bold: true, width: '*' },
        { text: horaCorta(d.nc.Hora), fontSize: 8, width: 'auto' },
      ]}],
      [{ border: [true,false,true,false], margin: [4,2,4,2], stack: [
        { text: 'Folio Fiscal:', bold: true, fontSize: 7 },
        { text: fmt(d.nc.UUID) || '(sin timbrar)', fontSize: 7 },
      ]}],
      [{ border: [true,false,true,true], margin: [4,2,4,3], columns: [
        { text: [{ text: 'Fecha Timbre: ', bold: true, fontSize: 7 }], width: 'auto' },
        { text: fmt(d.nc.FechaTimbrado), fontSize: 7, width: '*' },
      ]}],
    ]},
  };
}

function tablaConceptos(d) {
  const esResumen = parseInt(d.nc.FlagResNota) === 1;
  const filas = esResumen
    ? [[fmt(d.nc.c_ClaveProdServ), fmt(d.nc.Descripcion), `$${numFmt(d.nc.Subtotal, 2)}`]]
    : d.lineas.map(l => {
        const ref = Number(l.ID_NOFACTURA) > 0 ? `Factura #${l.ID_NOFACTURA}` : `ND #${l.Id_NotaDebito}`;
        return [fmt(d.nc.c_ClaveProdServ), `${ref} — ${fmt(l.DESNOTACREDITO)}`, `$${numFmt(l.SUBTOTAL, 2)}`];
      });
  return {
    margin: [0, 10, 0, 0],
    table: {
      widths: [65, '*', 75],
      body: [
        [{ text: 'Clave', fillColor: '#e0e0e0', bold: true, fontSize: 8 }, { text: 'Descripción', fillColor: '#e0e0e0', bold: true, fontSize: 8 }, { text: 'Importe', fillColor: '#e0e0e0', bold: true, fontSize: 8, alignment: 'right' }],
        ...filas.map(f => [{ text: f[0], fontSize: 8 }, { text: f[1], fontSize: 8 }, { text: f[2], fontSize: 8, alignment: 'right' }]),
      ],
    },
  };
}

function bloqueTotales(d) {
  return {
    margin: [0, 8, 0, 0],
    columns: [{ text: '', width: '*' }, {
      width: 190,
      table: { widths: ['*', 80], body: [
        [{ text: 'SUBTOTAL:', bold: true, fontSize: 8 }, { text: `$${numFmt(d.nc.Subtotal, 2)}`, fontSize: 8, alignment: 'right' }],
        [{ text: 'RETENCIÓN:', bold: true, fontSize: 8 }, { text: `$${numFmt(d.nc.Retencion, 2)}`, fontSize: 8, alignment: 'right' }],
        [{ text: 'IVA:', bold: true, fontSize: 8 }, { text: `$${numFmt(d.nc.IVA, 2)}`, fontSize: 8, alignment: 'right' }],
        [{ text: 'TOTAL:', bold: true, fontSize: 9 }, { text: `$${numFmt(d.nc.ImporteTotal, 2)}`, fontSize: 9, bold: true, alignment: 'right' }],
      ]},
      layout: NOBORDER,
    }],
  };
}

async function bloqueSellos(d) {
  if (!d.timbre) return [];
  let qrDataUrl = null;
  try {
    const totalStr = numFmt(d.nc.ImporteTotal, 6);
    const feUrl = (d.timbre.selloCFD || '').slice(-8);
    const qrTexto = `https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx?id=${d.timbre.uuid}&re=${d.emisorRfc}&rr=${d.receptorRfc}&tt=${totalStr}&fe=${feUrl}`;
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
  content.push(tablaConceptos(d));
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

async function generarPDFBufferNotaCredito(tipo, serie, idNotaCredito, centralOperativo, pool) {
  const d = await datosParaImpresionNotaCredito(tipo, serie, idNotaCredito, centralOperativo, pool);
  return renderPDFDesdeDatos(d);
}

module.exports = { datosParaImpresionNotaCredito, extraerDatosXMLNotaCredito, generarPDFBufferNotaCredito, renderPDFDesdeDatos };
