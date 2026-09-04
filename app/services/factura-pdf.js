'use strict';

// ── Representación impresa (PDF) de la Factura ─────────────────────────────
//
// Funciona con o sin timbre, igual patrón que cfdi-pdf.js (Carta Porte):
//   - Si ya está timbrada (UUID no nulo), se lee el XML final ya guardado en
//     disco (fuente de verdad legal) y se toman de ahí los datos fiscales.
//   - Si no, se arma un XML equivalente en memoria con buildCFDIFactura().
// El desglose de conceptos (Maniobras/Demoras/Otros por línea) NO vive en el
// XML (el CFDI solo declara un Importe por concepto) -- se lee directo de
// Empresa2.Factura/FacDeta, igual que cfdi-pdf.js lee cp.NoPedidoCliente de
// la tabla en vez de solo del XML.
//
// El complemento Carta Porte (página 2, "COMPLEMENTO CARTAPORTE") solo se
// imprime cuando Factura.IncluirCP=1 -- se detecta directo de la tabla
// (no hace falta ni mirar el XML para saberlo).

const fs   = require('fs');
const path = require('path');
const { sql } = require('../config/db');
const { RUTA_XML } = require('../config/storage');
const { serieFiscal } = require('../config/empresa-serie');
const { buildCFDIFactura } = require('./cfdi-factura');
const { DOMParser } = require('@xmldom/xmldom');
const QRCode = require('qrcode');
const {
  fmt, numFmt, fechaCorta, horaCorta, partirLargo, resolverLogo,
  porLocalName, todosPorLocalName, attr, extraerComplementoCartaPorte,
} = require('./pdf-utils');

const PdfPrinter  = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;
const vfs         = require('pdfmake/js/virtual-fs.js').default;

const FONTS = { Helvetica: require('pdfmake/standard-fonts/Helvetica.js').Helvetica };
const AZUL  = '#1a3f6f';
const ROJO  = '#c00000';
const GRIS  = '#e0e0e0';
const NOBORDER = { hLineWidth: () => 0, vLineWidth: () => 0 };

// ── extrae del XML de Factura lo necesario para el timbre/QR ────────────────
function extraerDatosXMLFactura(xmlString) {
  const doc = new DOMParser({ errorHandler: () => {} }).parseFromString(xmlString, 'text/xml');
  const comprobante = doc.documentElement;
  const emisor   = porLocalName(doc, 'Emisor');
  const receptor = porLocalName(doc, 'Receptor');
  const tfd      = porLocalName(doc, 'TimbreFiscalDigital');
  const complementoCP = extraerComplementoCartaPorte(doc);

  return {
    fecha:            attr(comprobante, 'Fecha'),
    noCertificado:    attr(comprobante, 'NoCertificado'),
    emisorRfc:        attr(emisor, 'Rfc'),
    emisorNombre:     attr(emisor, 'Nombre'),
    receptorRfc:      attr(receptor, 'Rfc'),
    receptorCP:          attr(receptor, 'DomicilioFiscalReceptor'),
    receptorRegFiscal:   attr(receptor, 'RegimenFiscalReceptor'),
    complementoCP,
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

async function datosParaImpresionFactura(idNoFactura, serieFac, pool) {
  const serieFacKey = (serieFac == null ? '' : String(serieFac)).trim() || null;
  const SERIEFAC_EQ = `ISNULL(LTRIM(RTRIM(SerieFac)),'') = ISNULL(@serieFac,'')`;

  const facRes = await pool.request()
    .input('id', sql.Decimal(9), idNoFactura)
    .input('serieFac', sql.VarChar(20), serieFacKey)
    .query(`SELECT * FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);
  const fac = facRes.recordset[0];
  if (!fac) throw new Error(`Factura ${idNoFactura} no encontrada`);

  const detRes = await pool.request()
    .input('id', sql.Decimal(9), idNoFactura)
    .input('serieFac', sql.VarChar(20), serieFacKey)
    .query(`SELECT * FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND ${SERIEFAC_EQ} ORDER BY ID_NODETAFAC`);
  const lineas = detRes.recordset;

  // C.P./Régimen Fiscal (texto) del receptor no se guardan en la propia
  // Factura -- el XML solo trae la CLAVE de régimen, no la descripción.
  const cliRes = await pool.request().input('id', sql.Decimal(18,0), fac.Id_Cliente)
    .query(`SELECT CP, C_REGIMENFISCAL, REGIMENFISCAL FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
  const cliente = cliRes.recordset[0] || {};

  // La Factura no guarda su propio central operativo (a diferencia de
  // CartaPorte.Serie) -- para resolver el Emisor/CSD se usa el central de la
  // sesión activa, igual que hace /cfdi/timbrar-factura.
  const centralOperativo = fmt(lineas[0]?.SERIE) || 'CUA';
  const empRes = await pool.request()
    .input('serie', sql.VarChar(10), serieFiscal(centralOperativo))
    .query(`SELECT * FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE)) = @serie`);
  const emp = empRes.recordset[0];
  if (!emp) throw new Error(`Empresa no encontrada para serie "${centralOperativo}"`);

  const incluirCP = parseInt(fac.IncluirCP) === 1;
  const uuid = fmt(fac.UUID);
  const timbrada = !!uuid;

  let xmlString;
  if (timbrada) {
    const rutaTimbrada = path.join(RUTA_XML, `FAC_${serieFacKey || 'SF'}${idNoFactura}_Timbrada.xml`);
    const rutaPrueba   = path.join(RUTA_XML, `FAC_${serieFacKey || 'SF'}${idNoFactura}_Prueba.xml`);
    const rutaFinal = fs.existsSync(rutaTimbrada) ? rutaTimbrada : (fs.existsSync(rutaPrueba) ? rutaPrueba : null);
    if (!rutaFinal) throw new Error(`Esta Factura está marcada como timbrada pero no se encontró el XML en ${RUTA_XML}`);
    xmlString = fs.readFileSync(rutaFinal, 'utf8');
  } else {
    const built = await buildCFDIFactura(idNoFactura, serieFacKey, centralOperativo, pool);
    xmlString = built.xml;
  }

  const datosXml = extraerDatosXMLFactura(xmlString);

  return {
    fac, lineas, emp, cliente, incluirCP,
    logo: resolverLogo(emp.LOGOEMPRESA),
    ...datosXml,
  };
}

// ── encabezado de la empresa (logo + razón social + domicilio) ─────────────
function encabezadoEmpresa(emp, logo) {
  const domicilio = [fmt(emp.CALLE), 'N°', fmt(emp.NOEXT)].filter(Boolean).join(' ');
  const ciudad = `${fmt(emp.COLONIA)}, C.P. ${fmt(emp.CP)}, ${fmt(emp.MUNICIPIO)}, ${fmt(emp.ESTADO) === 'CDMX' ? 'CDMX' : fmt(emp.CIUDAD)}.`;
  return {
    stack: [
      {
        columns: [
          logo ? { image: logo, width: 60, height: 60 } : { text: '', width: 60 },
          { text: fmt(emp.NOMBRECORTO), bold: true, fontSize: 13, alignment: 'center', width: '*', margin: [0, 18, 0, 0] },
          { text: '', width: 60 },
        ],
      },
      { text: `Registro Federal de Contribuyentes ${fmt(emp.RFC)}`, fontSize: 8, alignment: 'center', margin: [0, 2, 0, 0] },
      // Texto fijo -- el sistema legado no lo deriva del catálogo de régimen
      // fiscal de la Empresa (esa columna trae datos obsoletos/inconsistentes
      // con C_REGIMENFISCAL); confirmado igual en ambos PDF de referencia.
      { text: 'Regimen Fiscal: Ley Genral de Personas Morales', fontSize: 8, alignment: 'center' },
      { text: domicilio, fontSize: 8, alignment: 'center' },
      { text: ciudad, fontSize: 8, alignment: 'center' },
      { text: 'Conmutador: 55.30.09.49 con 12 Lineas Ext. 109 y 110 Fax:55.19.07.54', fontSize: 8, alignment: 'center' },
    ],
  };
}

function celda(label, value, opts = {}) {
  return { text: [{ text: label + ' ', bold: true }, { text: value || '', bold: !!opts.boldValue }], fontSize: opts.fontSize || 8, margin: opts.margin || [0, 1, 0, 1] };
}

// ── caja izquierda: datos del cliente ────────────────────────────────────
function cajaCliente(d) {
  const l = d.lineas[0] || {};
  const refLineas = [fmt(d.fac.RefCliente)];
  if (d.incluirCP) refLineas.push(fmt(l.DESFLETE));
  return {
    table: {
      widths: ['*'],
      body: [
        [{ border: [true,true,true,false], margin: [4,3,4,2], text: [{ text: 'CLIENTE: ', bold: true, fontSize: 8 }, { text: fmt(d.fac.NombreCom), bold: true, fontSize: 9 }] }],
        [{ border: [true,false,true,false], margin: [4,2,4,2], columns: [
          { text: [{ text: 'RFC: ', bold: true, fontSize: 8 }, { text: fmt(d.fac.RFC), bold: true, fontSize: 8 }], width: '*' },
          { text: [{ text: 'C.P. ', bold: true, fontSize: 8 }, { text: fmt(d.cliente.CP), fontSize: 8 }], width: 90 },
        ]}],
        [{ border: [true,false,true,false], margin: [4,2,4,2], text: [{ text: 'REG.FISCAL ', bold: true, fontSize: 8 }, { text: `${fmt(d.cliente.C_REGIMENFISCAL)}  ${fmt(d.cliente.REGIMENFISCAL)}`, fontSize: 8 }] }],
        [{ border: [true,false,true,false], margin: [4,2,4,2], text: [{ text: 'USO CFDI: ', bold: true, fontSize: 8 }, { text: fmt(d.fac.c_UsoCFDI), fontSize: 8 }] }],
        [{ border: [true,false,true,true], margin: [4,2,4,3], text: [{ text: 'REF.CLI: ', bold: true, fontSize: 8 }, { text: refLineas.filter(Boolean).join('\n'), fontSize: 8 }] }],
      ],
    },
  };
}

// ── caja derecha: folio, lugar/fecha de expedición, timbre ─────────────────
function cajaFolio(d) {
  const folioTxt = String(d.fac.Id_NoFactura).padStart(6, ' ');
  const folioFmt = folioTxt.length > 3 ? `${folioTxt.slice(0, -3)} ${folioTxt.slice(-3)}` : folioTxt;
  return {
    table: {
      widths: ['*'],
      body: [
        [{ border: [true,true,true,false], margin: [4,3,4,2], columns: [
          { text: 'N° F A C T U R A', bold: true, fontSize: 9, width: '*' },
          { text: folioFmt, bold: true, fontSize: 11, color: ROJO, width: 'auto' },
        ]}],
        [{ border: [true,false,true,false], margin: [4,2,4,2], stack: [
          { text: [{ text: 'Lugar Expedición: ', bold: true, fontSize: 7 }, { text: lugarExpedicionTxt(d.emp), fontSize: 7 }] },
          { columns: [
            { text: fechaCorta(d.fac.FechaFactura), fontSize: 8, bold: true, width: '*' },
            { text: horaCorta(d.fac.Hora), fontSize: 8, width: 'auto' },
          ]},
        ]}],
        [{ border: [true,false,true,false], margin: [4,2,4,2], stack: [
          { text: 'Folio Fiscal:', bold: true, fontSize: 7 },
          { text: fmt(d.fac.UUID) || '(sin timbrar)', fontSize: 7 },
        ]}],
        [{ border: [true,false,true,false], margin: [4,2,4,2], columns: [
          { text: [{ text: 'Fecha Timbre: ', bold: true, fontSize: 7 }], width: 'auto' },
          { text: fmt(d.fac.FechaTimbrado), fontSize: 7, width: '*' },
        ]}],
        [{ border: [true,false,true,false], margin: [4,2,4,2], columns: [
          { text: 'Exportacion:', bold: true, fontSize: 7, width: 70 },
          { text: '01 - No Aplica', fontSize: 7, width: '*' },
        ]}],
        [{ border: [true,false,true,true], margin: [4,2,4,3], columns: [
          { text: 'Obj. Impuesto', bold: true, fontSize: 7, width: 70 },
          { text: '02- Si objeto de impuesto', fontSize: 7, width: '*' },
        ]}],
      ],
    },
  };
}
function lugarExpedicionTxt(emp) {
  return `${fmt(emp.ESTADO) === 'CDMX' ? 'CDMX' : fmt(emp.ESTADO)}, A`;
}

// ── tabla "Un Concepto" (FlagResFac=1) ──────────────────────────────────────
function tablaUnConcepto(d) {
  return {
    margin: [0, 10, 0, 0],
    table: {
      widths: [50, 45, '*', 75, 75],
      body: [
        [
          { text: 'CÓDIGO', fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment: 'center' },
          { text: 'CANTIDAD', fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment: 'center' },
          { text: 'DESCRIPCIÓN', fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment: 'center' },
          { text: 'PRECIO', fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment: 'center' },
          { text: 'IMPORTE', fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment: 'center' },
        ],
        [
          { text: 'E48', fontSize: 8 },
          { text: '1', fontSize: 8, alignment: 'center' },
          { text: fmt(d.fac.Descripcion), fontSize: 8 },
          { text: `$${numFmt(d.fac.SubTotal, 2)}`, fontSize: 8, alignment: 'right' },
          { text: `$${numFmt(d.fac.TOTAL, 2)}`, fontSize: 8, alignment: 'right' },
        ],
      ],
    },
  };
}

// ── tabla "por línea" (FlagResFac=0) ────────────────────────────────────────
// El "núcleo" (Flete o Renta) se muestra en Importe/Demoras; Maniobras en su
// propia columna; todo lo demás (Casetas, Pensión, Estadías, Otros, Km) se
// agrupa en "Otros" -- confirmado con el usuario que no hace falta una
// columna dedicada para cada uno de esos.
function tablaPorLinea(d) {
  const body = d.lineas.map(l => {
    const flete   = num(l.COSTOFLETE);
    const demoras = num(l.COSTODEMORAS);
    const maniobras = num(l.COSTOMANIOBRAS);
    const otros = num(l.COSTOAUTOPISTAS) + num(l.CostoPension) + num(l.CostoEstadias) + num(l.COSTOSOTROS) + num(l.KILOMETROS);
    const prefijo = flete > 0 ? 'FLETE' : (demoras > 0 ? 'RENTA' : '');
    const descripcion = [prefijo, fmt(l.DESFLETE)].filter(Boolean).join(' ');
    return [
      { text: fmt(l.C_CLAVEPRODSERV), fontSize: 8 },
      { text: descripcion, fontSize: 8 },
      { text: `$${numFmt(flete, 2)}`, fontSize: 8, alignment: 'right' },
      { text: `$${numFmt(maniobras, 2)}`, fontSize: 8, alignment: 'right' },
      { text: `$${numFmt(demoras, 2)}`, fontSize: 8, alignment: 'right' },
      { text: `$${numFmt(otros, 2)}`, fontSize: 8, alignment: 'right' },
    ];
  });
  return {
    margin: [0, 10, 0, 0],
    table: {
      widths: [55, '*', 65, 65, 65, 65],
      body: [
        [
          { text: 'Clave', fillColor: GRIS, bold: true, fontSize: 8 },
          { text: 'Descripción', fillColor: GRIS, bold: true, fontSize: 8 },
          { text: 'Importe', fillColor: GRIS, bold: true, fontSize: 8, alignment: 'right' },
          { text: 'Maniobras', fillColor: GRIS, bold: true, fontSize: 8, alignment: 'right' },
          { text: 'Demoras', fillColor: GRIS, bold: true, fontSize: 8, alignment: 'right' },
          { text: 'Otros', fillColor: GRIS, bold: true, fontSize: 8, alignment: 'right' },
        ],
        ...body,
      ],
    },
  };
}
function num(v) { return parseFloat(v) || 0; }

// ── caja de totales + forma/método de pago (solo modo "por línea") ─────────
function bloqueTotales(d) {
  const totalesBox = {
    width: 190,
    table: {
      widths: ['*', 80],
      body: [
        [{ text: 'SUBTOTAL:', bold: true, fontSize: 8 }, { text: `$${numFmt(d.fac.SubTotal, 2)}`, fontSize: 8, alignment: 'right' }],
        [{ text: 'RETENCIÓN:', bold: true, fontSize: 8 }, { text: `$${numFmt(d.fac.Retencion, 2)}`, fontSize: 8, alignment: 'right' }],
        [{ text: 'IVA:', bold: true, fontSize: 8 }, { text: `$${numFmt(d.fac.IVA, 2)}`, fontSize: 8, alignment: 'right' }],
        [{ text: 'TOTAL:', bold: true, fontSize: 9 }, { text: `$${numFmt(d.fac.TOTAL, 2)}`, fontSize: 9, bold: true, alignment: 'right' }],
      ],
    },
    layout: NOBORDER,
  };

  if (parseInt(d.fac.FlagResFac) === 1) {
    return { margin: [0, 8, 0, 0], columns: [{ text: '', width: '*' }, totalesBox] };
  }

  return {
    margin: [0, 8, 0, 0],
    columns: [
      { width: '*', fontSize: 8, stack: [
        { text: [{ text: 'MONEDA: ', bold: true }, `${fmt(d.fac.MonFactura)} ${fmt(d.fac.MonFactura) === 'MXN' ? 'Peso Mexicano' : ''}`], margin: [0,0,0,3] },
        { text: [{ text: 'FORMA PAGO: ', bold: true }, `${fmt(d.fac.c_FormaPago)} ${fmt(d.fac.FormaPago)}`], margin: [0,0,0,3] },
        { text: [{ text: 'METODO PAGO: ', bold: true }, `${fmt(d.fac.ClaveMP)} ${fmt(d.fac.MetodoPago)}`] },
      ]},
      totalesBox,
    ],
  };
}

// ── página 1 (cola): resumen del complemento Carta Porte ────────────────────
function seccionCartaPorteResumen(d) {
  const c = d.complementoCP;
  if (!c) return [];
  const l = d.lineas[0] || {};

  return [
    { margin: [0, 10, 0, 0], table: { widths: ['*', '*'], body: [[
      { text: 'COMPLEMENTO CARTAPORTE', fillColor: AZUL, color: 'white', bold: true, fontSize: 8 },
      { text: `${fmt(l.SERIE)} ${fmt(l.CARTAPORTE)}`, fillColor: GRIS, bold: true, fontSize: 8 },
    ]] } },
    { table: { widths: ['*', '*'], body: [
      [{ text: 'TRANSPORTE INTERNACIONAL', fillColor: GRIS, bold: true, fontSize: 7 }, { text: 'TOTAL DISTANCIA', fillColor: GRIS, bold: true, fontSize: 7, alignment: 'right' }],
      [{ text: 'NO', fontSize: 8 }, { text: fmt(c.totalDistRec), fontSize: 8, alignment: 'right' }],
    ] } },

    { margin: [0, 6, 0, 0], table: { widths: ['*'], body: [[{ text: 'UBICACIONES', fillColor: GRIS, bold: true, fontSize: 7, alignment: 'center' }]] } },
    { table: { widths: [55, 80, '*', 90, 70], body: [
      [
        { text: 'TIPO', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'RFC REMITENTE', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'REMITENTE', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'FECHA HORA SALIDA', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'DISTANCIA RECORRIDA', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
      ],
      [
        { text: 'ORIGEN', fontSize: 7 }, { text: fmt(c.origen?.rfc), fontSize: 7 }, { text: fmt(c.origen?.nombre), fontSize: 7 },
        { text: fmt(c.origen?.fechaHora), fontSize: 7 }, { text: '', fontSize: 7 },
      ],
    ] } },
    { table: { widths: [55, 80, '*', 90, 70], body: [
      [
        { text: 'DOMICILIO', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'PAIS', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'CODIGO POSTAL', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'ESTADO', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'MUNICIPIO / LOCALIDAD', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
      ],
      [
        { text: '', fontSize: 7 }, { text: fmt(c.origen?.pais), fontSize: 7 }, { text: fmt(c.origen?.cp), fontSize: 7 },
        { text: fmt(c.origen?.estado), fontSize: 7 }, { text: [fmt(c.origen?.municipio), fmt(c.origen?.localidad)].filter(Boolean).join(' / '), fontSize: 7 },
      ],
    ] } },
    { table: { widths: [55, 80, '*', 90, 70], body: [
      [
        { text: 'TIPO', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'RFC DESTINO', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'DESTINATARIO', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'FECHA HORA LLEGADA', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'DISTANCIA RECORRIDA', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
      ],
      [
        { text: 'DESTINO', fontSize: 7 }, { text: fmt(c.destino?.rfc), fontSize: 7 }, { text: fmt(c.destino?.nombre), fontSize: 7 },
        { text: fmt(c.destino?.fechaHora), fontSize: 7 }, { text: fmt(c.destino?.distanciaRecorrida), fontSize: 7 },
      ],
    ] } },
    { margin: [0, 0, 0, 6], table: { widths: [55, 80, '*', 90, 70], body: [
      [
        { text: 'DOMICILIO', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'PAIS', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'CODIGO POSTAL', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'ESTADO', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'MUNICIPIO / LOCALIDAD', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
      ],
      [
        { text: '', fontSize: 7 }, { text: fmt(c.destino?.pais), fontSize: 7 }, { text: fmt(c.destino?.cp), fontSize: 7 },
        { text: fmt(c.destino?.estado), fontSize: 7 }, { text: [fmt(c.destino?.municipio), fmt(c.destino?.localidad)].filter(Boolean).join(' / '), fontSize: 7 },
      ],
    ] } },

    { table: { widths: ['*'], body: [[{ text: 'MERCANCIAS', fillColor: GRIS, bold: true, fontSize: 7, alignment: 'center' }]] } },
    { table: { widths: ['*', '*', '*'], body: [
      [
        { text: 'PESO BRUTO TOTAL', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'UNIDAD PESO', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'N° TOTAL MERCANCIAS', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
      ],
      [{ text: fmt(c.pesoBrutoTotal), fontSize: 7 }, { text: fmt(c.unidadPeso), fontSize: 7 }, { text: fmt(c.numTotalMercancias), fontSize: 7 }],
    ] } },
    { table: { widths: [70, '*', 60, 70, 70], body: [
      [
        { text: 'c_BIEN TRASNS', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'DESCRIPCIÓN', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'UNIDAD', fillColor: '#f2f2f2', bold: true, fontSize: 6.5 },
        { text: 'CANTIDAD', fillColor: '#f2f2f2', bold: true, fontSize: 6.5, alignment: 'right' },
        { text: 'PESO', fillColor: '#f2f2f2', bold: true, fontSize: 6.5, alignment: 'right' },
      ],
      ...c.mercancias.map(m => [
        { text: m.bienesTransp, fontSize: 7 }, { text: m.descripcion, fontSize: 7 }, { text: m.unidad, fontSize: 7 },
        { text: numFmt(m.cantidad, 6), fontSize: 7, alignment: 'right' }, { text: numFmt(m.pesoEnKg, 2), fontSize: 7, alignment: 'right' },
      ]),
    ] } },
  ];
}

// ── página 2: autotransporte + figura de transporte ─────────────────────────
function paginaAutotransporte(d) {
  const c = d.complementoCP;
  const remolque = c.remolques[0] || {};
  return [
    { pageBreak: 'before', table: { widths: ['*'], body: [[{ text: 'AUTOTRANSPORTE', fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment: 'center' }]] } },
    { table: { widths: ['*', '*'], body: [
      [{ text: 'TIPO PERMISO SCT', fillColor: '#f2f2f2', bold: true, fontSize: 7 }, { text: 'NUMERO PERMISO SCT', fillColor: '#f2f2f2', bold: true, fontSize: 7 }],
      [{ text: fmt(c.permSCT), fontSize: 8 }, { text: fmt(c.numPermisoSCT), fontSize: 8 }],
    ] } },
    { table: { widths: [110, '*', 80, 80], body: [
      [{ text: 'IDENTIFICADOR VEHICULAR', fillColor: '#f2f2f2', bold: true, fontSize: 7 }, { text: 'CONFIG. VEHICULAR', fillColor: '#f2f2f2', bold: true, fontSize: 7 }, { text: 'PLACA VM', fillColor: '#f2f2f2', bold: true, fontSize: 7 }, { text: 'AÑO MODELO VM', fillColor: '#f2f2f2', bold: true, fontSize: 7 }],
      [{ text: '', fontSize: 8 }, { text: fmt(c.configVehicular), fontSize: 8 }, { text: fmt(c.placaVM), fontSize: 8 }, { text: fmt(c.anioModeloVM), fontSize: 8 }],
    ] } },
    { table: { widths: [70, '*', 100], body: [
      [{ text: 'SEGURO', fillColor: '#f2f2f2', bold: true, fontSize: 7 }, { text: 'ASEGURADORA', fillColor: '#f2f2f2', bold: true, fontSize: 7 }, { text: 'No, POLIZA', fillColor: '#f2f2f2', bold: true, fontSize: 7 }],
      [{ text: '', fontSize: 8 }, { text: fmt(c.aseguraRespCivil), fontSize: 8 }, { text: fmt(c.polizaRespCivil), fontSize: 8 }],
    ] } },
    remolque.placa ? { table: { widths: ['*', '*'], body: [
      [{ text: 'SUBTIPO REMOLQUE', fillColor: '#f2f2f2', bold: true, fontSize: 7 }, { text: 'PLACA REMOLQUE', fillColor: '#f2f2f2', bold: true, fontSize: 7 }],
      [{ text: fmt(remolque.subTipoRem), fontSize: 8 }, { text: fmt(remolque.placa), fontSize: 8 }],
    ] } } : null,

    { margin: [0, 6, 0, 0], table: { widths: ['*'], body: [[{ text: 'FIGURA TRANSPORTE', fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment: 'center' }]] } },
    { table: { widths: [70, 90, 90, '*'], body: [
      [{ text: 'TIPO', fillColor: '#f2f2f2', bold: true, fontSize: 7 }, { text: 'RFC', fillColor: '#f2f2f2', bold: true, fontSize: 7 }, { text: 'No. LICENCIA', fillColor: '#f2f2f2', bold: true, fontSize: 7 }, { text: 'NOMBRE', fillColor: '#f2f2f2', bold: true, fontSize: 7 }],
      [{ text: 'OPERADOR', fontSize: 8 }, { text: fmt(c.operadorRfc), fontSize: 8 }, { text: fmt(c.operadorLicencia), fontSize: 8 }, { text: fmt(c.operadorNombre), fontSize: 8 }],
    ] } },
  ].filter(Boolean);
}

// ── bloque de sellos + QR (igual patrón que cfdi-pdf.js) ────────────────────
async function bloqueSellos(d) {
  if (!d.timbre) return [];
  let qrDataUrl = null;
  try {
    const totalStr = numFmt(d.fac.TOTAL, 6); // en Factura sí hay importe fiscal real (a diferencia de Carta Porte)
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

// Separado de generarPDFBufferFactura() para poder probarse con datos ya
// resueltos a mano (sin depender del XML timbrado en disco) -- ver el script
// de prueba usado para validar contra las facturas de referencia reales.
async function renderPDFDesdeDatos(d) {
  const esUnConcepto = parseInt(d.fac.FlagResFac) === 1;

  const content = [];
  content.push({ columns: [cajaCliente(d), { width: 8, text: '' }, { width: 200, ...cajaFolio(d) }] });
  content.push(esUnConcepto ? tablaUnConcepto(d) : tablaPorLinea(d));
  content.push(bloqueTotales(d));

  if (d.incluirCP && d.complementoCP) {
    content.push(...seccionCartaPorteResumen(d));
    content.push(...paginaAutotransporte(d));
  }

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

async function generarPDFBufferFactura(idNoFactura, serieFac, pool) {
  const d = await datosParaImpresionFactura(idNoFactura, serieFac, pool);
  return renderPDFDesdeDatos(d);
}

module.exports = { datosParaImpresionFactura, extraerDatosXMLFactura, generarPDFBufferFactura, renderPDFDesdeDatos };
