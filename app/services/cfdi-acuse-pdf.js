'use strict';

// ── Representación impresa (PDF) del Acuse de Cancelación ──────────────────
//
// El acuse real es el XML que el PAC/SAT firma al aceptar la cancelación
// (guardado en disco por app/routes/cfdi.js junto al XML timbrado, ver
// ejecutarCancelacionFiscal en cfdi-cancelacion.js). Este servicio SOLO lee
// ese XML ya guardado y lo presenta en un PDF -- no inventa ni recalcula
// nada del acuse en sí, igual que el PDF del CFDI es una representación
// impresa del XML timbrado, nunca la fuente de verdad legal.
//
// Compartido entre Carta Porte, Factura y Notas de Crédito/Débito
// (parametrizado por tipoDoc), igual que ejecutarCancelacionFiscal.

const fs   = require('fs');
const path = require('path');
const { sql } = require('../config/db');
const { RUTA_XML } = require('../config/storage');
const { serieFiscal } = require('../config/empresa-serie');
const { DOMParser } = require('@xmldom/xmldom');
const { fmt, fechaCorta, fechaHora, partirLargo, resolverLogo, porLocalName } = require('./pdf-utils');

const PdfPrinter  = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;
const vfs         = require('pdfmake/js/virtual-fs.js').default;

const FONTS = { Helvetica: require('pdfmake/standard-fonts/Helvetica.js').Helvetica };
const AZUL  = '#1a3f6f';
const LAYOUT_ESPACIADO = { paddingTop: () => 5, paddingBottom: () => 5, paddingLeft: () => 4, paddingRight: () => 4 };

// Catálogo de motivos de cancelación (SAT), mismo listado usado en los
// modales de cancelación de cartaporte.ejs/facturas.ejs/notacred.ejs.
const MOTIVO_DESC = {
  '01': 'Comprobante emitido con errores con relación',
  '02': 'Comprobante emitido con errores sin relación',
  '03': 'No se llevó a cabo la operación',
  '04': 'Operación nominativa relacionada en factura global',
};

// Catálogo de códigos EstatusUUID que devuelve el SAT en el acuse de
// cancelación (fuente: documentación pública de PACs autorizados). Si llega
// un código fuera de esta lista se muestra el código solo, sin inventar
// descripción.
const ESTATUS_UUID_DESC = {
  '201': 'Solicitud de cancelación exitosa',
  '202': 'Folio fiscal previamente cancelado (estatus cancelado ante el SAT)',
  '203': 'Folio fiscal no corresponde al emisor',
  '204': 'Folio fiscal no aplicable a cancelación',
  '205': 'Folio fiscal no existente',
  '206': 'UUID no corresponde a un CFDI del sector primario',
  '207': 'Motivo de cancelación inválido',
  '208': 'Folio de sustitución inválido',
  '209': 'Folio de sustitución no requerido',
  '210': 'Fecha de solicitud mayor a la fecha de declaración',
  '211': 'Fecha límite para factura global excedida',
  '212': 'Relación no válida o inexistente',
};

function textOf(node) { return node ? fmt(node.textContent) : ''; }

function extraerDatosAcuseXML(xmlString) {
  const doc = new DOMParser({ errorHandler: () => {} }).parseFromString(xmlString, 'text/xml');
  const root = doc.documentElement;
  const folios = porLocalName(doc, 'Folios');
  return {
    fechaSolicitud: fmt(root.getAttribute('Fecha')),
    rfcEmisor:      fmt(root.getAttribute('RfcEmisor')),
    uuid:           textOf(folios && porLocalName(folios, 'UUID')),
    estatusUUID:    textOf(folios && porLocalName(folios, 'EstatusUUID')),
    selloSAT:       textOf(porLocalName(doc, 'SignatureValue')),
    noCertificadoSAT: textOf(porLocalName(doc, 'KeyName')),
  };
}

// ── localiza y arma los datos según el tipo de documento cancelado ─────────
async function datosAcuse(tipoDoc, params, pool) {
  let docRow, nombreBaseAcuse, centralOperativo, tituloDoc, folioDoc;

  if (tipoDoc === 'cartaporte') {
    const { serie, cartaporte } = params;
    const r = await pool.request().input('s', sql.VarChar(3), serie).input('c', sql.VarChar(30), cartaporte)
      .query(`SELECT * FROM Empresa2.CartaPorte WHERE Serie=@s AND CartaPorte=@c`);
    docRow = r.recordset[0];
    if (!docRow) throw new Error(`Carta Porte ${cartaporte} no encontrada`);
    centralOperativo = serie;
    nombreBaseAcuse = `CP_${cartaporte}`;
    tituloDoc = 'CARTA PORTE';
    folioDoc = cartaporte;
  } else if (tipoDoc === 'factura') {
    const { idNoFactura, serieFac } = params;
    const serieFacKey = (serieFac || '').trim() || null;
    const r = await pool.request().input('id', sql.Decimal(9), idNoFactura).input('serieFac', sql.VarChar(20), serieFacKey)
      .query(`SELECT * FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'')`);
    docRow = r.recordset[0];
    if (!docRow) throw new Error(`Factura ${idNoFactura} no encontrada`);
    // La Factura no guarda su propio central operativo -- se toma de sus
    // líneas de Carta Porte, mismo criterio que factura-pdf.js.
    const lin = await pool.request().input('id', sql.Decimal(9), idNoFactura).input('serieFac', sql.VarChar(20), serieFacKey)
      .query(`SELECT TOP 1 LTRIM(RTRIM(SERIE)) SERIE FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'')`);
    centralOperativo = fmt(lin.recordset[0]?.SERIE) || 'CUA';
    nombreBaseAcuse = `FAC_${serieFacKey || 'SF'}${idNoFactura}`;
    tituloDoc = 'FACTURA';
    folioDoc = `${serieFacKey ? serieFacKey + '-' : ''}${idNoFactura}`;
  } else if (tipoDoc === 'notacredito') {
    const { tipo, serie, idNotaCredito, central } = params;
    const serieKey = (serie || '').trim() || null;
    const r = await pool.request().input('tipo', sql.VarChar(3), tipo).input('serie', sql.VarChar(10), serieKey).input('id', sql.Decimal(7), idNotaCredito)
      .query(`SELECT * FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND LTRIM(RTRIM(Tipo))=@tipo AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`);
    docRow = r.recordset[0];
    if (!docRow) throw new Error(`Nota ${idNotaCredito} no encontrada`);
    centralOperativo = central || 'CUA';
    nombreBaseAcuse = `NC_${tipo}${serieKey || 'SF'}${idNotaCredito}`;
    tituloDoc = tipo === 'ND' ? 'NOTA DE DÉBITO' : 'NOTA DE CRÉDITO';
    folioDoc = `${serieKey ? serieKey + '-' : ''}${idNotaCredito}`;
  } else {
    throw new Error(`tipoDoc desconocido: ${tipoDoc}`);
  }

  const status = fmt(docRow.Status).toUpperCase();
  if (status !== 'CANCELADO' && status !== 'CANCELAD0' && status !== 'CANCELADA') {
    throw new Error('Este documento no está cancelado.');
  }
  if (!fmt(docRow.UUID)) {
    throw new Error('Este documento se canceló internamente, sin folio fiscal -- no existe acuse del SAT.');
  }

  const rutaAcuse = path.join(RUTA_XML, `${nombreBaseAcuse}_Acuse.xml`);
  if (!fs.existsSync(rutaAcuse)) throw new Error(`No se encontró el acuse en ${RUTA_XML}`);
  const acuse = extraerDatosAcuseXML(fs.readFileSync(rutaAcuse, 'utf8'));

  const empRes = await pool.request().input('serie', sql.VarChar(10), serieFiscal(centralOperativo))
    .query(`SELECT * FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE)) = @serie`);
  const emp = empRes.recordset[0];
  if (!emp) throw new Error(`Empresa no encontrada para serie "${centralOperativo}"`);

  let rfcReceptor = '';
  if (docRow.Id_Cliente) {
    const cliRes = await pool.request().input('id', sql.Decimal(18, 0), docRow.Id_Cliente).query(`SELECT RFC FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
    rfcReceptor = fmt(cliRes.recordset[0]?.RFC);
  }

  return {
    emp, logo: resolverLogo(emp.LOGOEMPRESA),
    tituloDoc, folioDoc, docRow, rfcReceptor, acuse,
  };
}

function encabezadoEmpresa(emp, tituloDoc, folioDoc, logo) {
  const domicilioEmpresa = [fmt(emp.CALLE), fmt(emp.NOEXT), 'Col.', fmt(emp.COLONIA)].filter(Boolean).join(' ');
  const ciudadEmpresa = [fmt(emp.MUNICIPIO) || fmt(emp.CIUDAD), fmt(emp.ESTADO), 'CP', fmt(emp.CP)].filter(Boolean).join(' ');
  return {
    columns: [
      logo ? { image: logo, width: 55, height: 55 } : { text: '', width: 55 },
      {
        width: '*',
        stack: [
          { text: fmt(emp.NOMBRECORTO) || fmt(emp.EMPRESA), bold: true, fontSize: 12, alignment: 'center', margin: [0, 0, 0, 3] },
          { text: domicilioEmpresa, fontSize: 7, alignment: 'center', margin: [0, 0, 0, 2] },
          { text: ciudadEmpresa, fontSize: 7, alignment: 'center', margin: [0, 0, 0, 2] },
          { text: `RFC: ${fmt(emp.RFC)}`, fontSize: 7, alignment: 'center' },
        ],
      },
      {
        width: 150,
        table: {
          widths: ['*'],
          body: [
            [{ text: 'ACUSE DE CANCELACIÓN', fillColor: AZUL, color: 'white', fontSize: 8, bold: true, alignment: 'center' }],
            [{ text: `${tituloDoc} ${folioDoc}`, fillColor: '#eeeeee', fontSize: 9, bold: true, alignment: 'center' }],
          ],
        },
        layout: { paddingTop: () => 3, paddingBottom: () => 3, paddingLeft: () => 4, paddingRight: () => 4, hLineWidth: () => 0, vLineWidth: () => 0 },
      },
    ],
  };
}

function filaLabel(label, value) {
  return { margin: [0, 0, 0, 4], columns: [{ text: label, width: 140, bold: true, fontSize: 8 }, { text: value || '', fontSize: 8 }] };
}

async function generarPDFBufferAcuse(tipoDoc, params, pool) {
  const d = await datosAcuse(tipoDoc, params, pool);
  const { docRow, acuse } = d;

  const estatusDesc = ESTATUS_UUID_DESC[acuse.estatusUUID] || '';
  const motivo = fmt(docRow.c_MotCancela);
  const motivoDesc = MOTIVO_DESC[motivo] || '';

  const content = [];
  content.push(encabezadoEmpresa(d.emp, d.tituloDoc, d.folioDoc, d.logo));
  content.push({ text: '', margin: [0, 6, 0, 0] });

  content.push({
    margin: [0, 0, 0, 0],
    layout: LAYOUT_ESPACIADO,
    table: {
      widths: ['*', '*'],
      body: [[
        { text: 'DATOS DE LA SOLICITUD', fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment: 'center', colSpan: 2 }, {},
      ]],
    },
  });
  content.push({
    margin: [0, 8, 0, 0],
    stack: [
      filaLabel('RFC Emisor:', acuse.rfcEmisor || fmt(d.emp.RFC)),
      filaLabel('RFC Receptor:', d.rfcReceptor),
      filaLabel('Folio Fiscal (UUID):', acuse.uuid),
      filaLabel('Fecha de la solicitud:', fechaHora(acuse.fechaSolicitud)),
    ],
  });

  content.push({
    margin: [0, 10, 0, 0],
    layout: LAYOUT_ESPACIADO,
    table: {
      widths: ['20%', '80%'],
      body: [
        [
          { text: 'ESTATUS DEL FOLIO', fillColor: AZUL, color: 'white', bold: true, fontSize: 7, alignment: 'center' },
          { text: 'DESCRIPCIÓN', fillColor: AZUL, color: 'white', bold: true, fontSize: 7, alignment: 'center' },
        ],
        [
          { text: acuse.estatusUUID || '—', fontSize: 9, bold: true, alignment: 'center' },
          { text: estatusDesc || '(código no catalogado)', fontSize: 8 },
        ],
      ],
    },
  });

  content.push({
    margin: [0, 12, 0, 0],
    layout: LAYOUT_ESPACIADO,
    table: {
      widths: ['*', '*'],
      body: [[
        { text: 'DATOS DE LA CANCELACIÓN (registrados en el sistema)', fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment: 'center', colSpan: 2 }, {},
      ]],
    },
  });
  content.push({
    margin: [0, 8, 0, 0],
    stack: [
      filaLabel('Motivo de cancelación:', motivo ? `${motivo} - ${motivoDesc || 'N/A'}` : ''),
      filaLabel('Folio que sustituye:', fmt(docRow.UUIDRelCan)),
      filaLabel('Nota:', fmt(docRow.NotaCancelacion)),
      filaLabel('Cancelado por:', fmt(docRow.WhoCancela)),
      // FechaCancela es tipo DATE en el schema (sin hora) -- fechaCorta evita
      // mostrar una hora falsa tipo "12:00 a." que fechaHora() sí agregaría.
      filaLabel('Fecha de cancelación:', fechaCorta(docRow.FechaCancela)),
    ],
  });

  content.push({
    margin: [0, 14, 0, 0],
    stack: [
      { text: 'SELLO DIGITAL DEL SAT', fontSize: 7, bold: true, margin: [0, 0, 0, 3] },
      { text: partirLargo(acuse.selloSAT), fontSize: 6, margin: [0, 0, 0, 6] },
      { text: 'NO. DE CERTIFICADO SAT', fontSize: 7, bold: true, margin: [0, 0, 0, 3] },
      { text: acuse.noCertificadoSAT, fontSize: 8 },
    ],
  });

  content.push({
    margin: [0, 16, 0, 0],
    fontSize: 6.5, italics: true, color: '#666',
    text: 'Este documento es una representación impresa, generada por el sistema, del acuse de cancelación firmado digitalmente por el SAT. '
        + 'El archivo XML original firmado es la fuente de verdad legal y se conserva en el resguardo de comprobantes fiscales de la empresa.',
  });

  const docDefinition = {
    pageMargins: [30, 30, 30, 30],
    defaultStyle: { font: 'Helvetica', fontSize: 8, lineHeight: 1.3 },
    content,
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

module.exports = { generarPDFBufferAcuse, datosAcuse };
