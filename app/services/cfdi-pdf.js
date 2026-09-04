'use strict';

// ── Representación impresa (PDF) de la Carta Porte ─────────────────────────────
//
// Funciona con o sin timbre:
//   - Si la Carta Porte ya está timbrada (Status='TRASLADO' y hay UUID), se lee
//     el XML final ya guardado en disco (fuente de verdad legal) y se toman de
//     ahí los datos del complemento + el bloque de timbre.
//   - Si no está timbrada, se arma un XML equivalente en memoria con
//     buildCFDITraslado() (mismas consultas ya probadas) y se parsea igual,
//     simplemente sin bloque de timbre.
// Así el PDF timbrado es 100% fiel al XML real entregado al SAT, y el PDF de
// vista previa usa exactamente la misma lógica de armado de datos.

const fs   = require('fs');
const path = require('path');
const { sql } = require('../config/db');
const { RUTA_XML } = require('../config/storage');
const { serieFiscal } = require('../config/empresa-serie');
const { buildCFDITraslado } = require('./cfdi-traslado');
const { DOMParser } = require('@xmldom/xmldom');
const QRCode = require('qrcode');
const {
  fmt, numFmt, fechaCorta, fechaHora, partirLargo, resolverLogo,
  porLocalName, todosPorLocalName, attr,
} = require('./pdf-utils');

const PdfPrinter  = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;
const vfs         = require('pdfmake/js/virtual-fs.js').default;

const FONTS = { Helvetica: require('pdfmake/standard-fonts/Helvetica.js').Helvetica };
const AZUL  = '#1a3f6f';
// Padding vertical un poco más generoso que el default de pdfmake (2pt) para
// que las tablas no se vean tan apretadas.
const LAYOUT_ESPACIADO = { paddingTop: () => 5, paddingBottom: () => 5, paddingLeft: () => 4, paddingRight: () => 4 };

// ── extrae del XML (timbrado o preview) todo lo necesario para la plantilla ────
function extraerDatosXML(xmlString) {
  const doc = new DOMParser({ errorHandler: () => {} }).parseFromString(xmlString, 'text/xml');
  const comprobante = doc.documentElement;
  const emisor   = porLocalName(doc, 'Emisor');
  const receptor = porLocalName(doc, 'Receptor');
  const cpNode   = porLocalName(doc, 'CartaPorte');
  const ubicaciones = todosPorLocalName(doc, 'Ubicacion');
  const origen  = ubicaciones.find(u => attr(u, 'TipoUbicacion') === 'Origen');
  const destino = ubicaciones.find(u => attr(u, 'TipoUbicacion') === 'Destino');
  const domOrigen  = origen  ? porLocalName(origen, 'Domicilio')  : null;
  const domDestino = destino ? porLocalName(destino, 'Domicilio') : null;
  const mercanciasNode = porLocalName(doc, 'Mercancias');
  const mercancias = todosPorLocalName(doc, 'Mercancia').map(m => ({
    bienesTransp: attr(m, 'BienesTransp'),
    descripcion:  attr(m, 'Descripcion'),
    cantidad:     attr(m, 'Cantidad'),
    claveUnidad:  attr(m, 'ClaveUnidad'),
    unidad:       attr(m, 'Unidad'),
    materialPeligroso: attr(m, 'MaterialPeligroso'),
    cveMaterialPeligroso: attr(m, 'CveMaterialPeligroso'),
    embalaje:     attr(m, 'Embalaje'),
    pesoEnKg:     attr(m, 'PesoEnKg'),
    valorMercancia: attr(m, 'ValorMercancia'),
    moneda:       attr(m, 'Moneda'),
  }));
  const autoTrans = porLocalName(doc, 'Autotransporte');
  const identVeh  = porLocalName(doc, 'IdentificacionVehicular');
  const seguros   = porLocalName(doc, 'Seguros');
  const remolques = todosPorLocalName(doc, 'Remolque').map(r => ({
    subTipoRem: attr(r, 'SubTipoRem'),
    placa:      attr(r, 'Placa'),
  }));
  const figura = porLocalName(doc, 'TiposFigura');
  const tfd    = porLocalName(doc, 'TimbreFiscalDigital');

  return {
    fecha:            attr(comprobante, 'Fecha'),
    noCertificado:    attr(comprobante, 'NoCertificado'),
    emisorRfc:        attr(emisor, 'Rfc'),
    emisorNombre:     attr(emisor, 'Nombre'),
    receptorRfc:      attr(receptor, 'Rfc'),
    idCCP:            attr(cpNode, 'IdCCP'),
    totalDistRec:     attr(cpNode, 'TotalDistRec'),
    origen: origen ? {
      rfc: attr(origen, 'RFCRemitenteDestinatario'),
      nombre: attr(origen, 'NombreRemitenteDestinatario'),
      fechaHora: attr(origen, 'FechaHoraSalidaLlegada'),
      domicilio: domOrigen ? [attr(domOrigen,'Calle'), attr(domOrigen,'NumeroExterior')].filter(Boolean).join(' ') : '',
      domicilio2: domOrigen ? [attr(domOrigen,'CodigoPostal'), attr(domOrigen,'Estado'), attr(domOrigen,'Pais')].filter(Boolean).join(' ') : '',
    } : null,
    destino: destino ? {
      rfc: attr(destino, 'RFCRemitenteDestinatario'),
      nombre: attr(destino, 'NombreRemitenteDestinatario'),
      fechaHora: attr(destino, 'FechaHoraSalidaLlegada'),
      domicilio: domDestino ? [attr(domDestino,'Calle'), attr(domDestino,'NumeroExterior')].filter(Boolean).join(' ') : '',
      domicilio2: domDestino ? [attr(domDestino,'CodigoPostal'), attr(domDestino,'Estado'), attr(domDestino,'Pais')].filter(Boolean).join(' ') : '',
    } : null,
    pesoBrutoTotal: attr(mercanciasNode, 'PesoBrutoTotal'),
    unidadPeso:     attr(mercanciasNode, 'UnidadPeso'),
    mercancias,
    permSCT:        attr(autoTrans, 'PermSCT'),
    numPermisoSCT:  attr(autoTrans, 'NumPermisoSCT'),
    configVehicular: attr(identVeh, 'ConfigVehicular'),
    placaVM:        attr(identVeh, 'PlacaVM'),
    anioModeloVM:   attr(identVeh, 'AnioModeloVM'),
    aseguraRespCivil: attr(seguros, 'AseguraRespCivil'),
    polizaRespCivil:  attr(seguros, 'PolizaRespCivil'),
    remolques,
    operadorRfc:    attr(figura, 'RFCFigura'),
    operadorNombre: attr(figura, 'NombreFigura'),
    operadorLicencia: attr(figura, 'NumLicencia'),
    timbre: tfd ? {
      uuid: attr(tfd, 'UUID'),
      fechaTimbrado: attr(tfd, 'FechaTimbrado'),
      noCertificadoSAT: attr(tfd, 'NoCertificadoSAT'),
      selloCFD: attr(tfd, 'SelloCFD'),
      selloSAT: attr(tfd, 'SelloSAT'),
    } : null,
  };
}

async function datosParaImpresion(serie, cartaporte, pool) {
  const cpRes = await pool.request()
    .input('serie', sql.VarChar(3), serie)
    .input('cp', sql.VarChar(30), cartaporte)
    .query(`SELECT * FROM Empresa2.CartaPorte WHERE Serie=@serie AND CartaPorte=@cp`);
  const cp = cpRes.recordset[0];
  if (!cp) throw new Error(`Carta Porte ${cartaporte} no encontrada`);

  // Varios centrales comparten la misma razón social/CSD (ver config/empresa-serie.js).
  const empRes = await pool.request()
    .input('serie', sql.VarChar(10), serieFiscal(serie))
    .query(`SELECT * FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE)) = @serie`);
  const emp = empRes.recordset[0];
  if (!emp) throw new Error(`Empresa no encontrada para serie "${serie}"`);

  const status = fmt(cp.Status).toUpperCase();
  const uuid   = fmt(cp.UUID);
  const timbrado = status === 'TRASLADO' && !!uuid;

  let xmlString;
  if (timbrado) {
    const rutaTimbrada = path.join(RUTA_XML, `CP_${cartaporte}_Timbrada.xml`);
    const rutaPrueba   = path.join(RUTA_XML, `CP_${cartaporte}_Prueba.xml`);
    const rutaFinal = fs.existsSync(rutaTimbrada) ? rutaTimbrada : (fs.existsSync(rutaPrueba) ? rutaPrueba : null);
    if (!rutaFinal) throw new Error(`Esta Carta Porte está marcada como timbrada pero no se encontró el XML en ${RUTA_XML}`);
    xmlString = fs.readFileSync(rutaFinal, 'utf8');
  } else {
    const built = await buildCFDITraslado(serie, cartaporte, pool);
    xmlString = built.xml;
  }

  const datosXml = extraerDatosXML(xmlString);

  return {
    cp, emp,
    logo: resolverLogo(emp.LOGOEMPRESA),
    ...datosXml,
  };
}

// ── condiciones de prestación de servicios (texto fijo, página 2) ──────────────
const CLAUSULAS = [
  ['PRIMERA', 'Para los efectos del presente contrato de transporte se denomina "Transportista" al que realiza el servicio de transportación y "Expedidor", "Remitente" o "Usuario" al que contrate el servicio o remita la mercancía.'],
  ['SEGUNDA', 'El "Expedidor", "Remitente" o "Usuario" es responsable de que la información proporcionada al "Transportista" sea veraz y que la documentación que entregue para efectos del transporte sea la correcta.'],
  ['TERCERA', 'El "Expedidor", "Remitente" o "Usuario" debe declarar al "Transportista" el tipo de mercancía o efectos de que se trate, peso, medidas y/o número de la carga que entrega para su transporte y, en su caso, el valor de la misma. La carga que se entregue a granel podrá ser aforada en metros cúbicos con la conformidad del "Expedidor", "Remitente" o "Usuario".'],
  ['CUARTA', 'Para efectos del transporte, el "Expedidor", "Remitente" o "Usuario" deberá entregar al "Transportista" los documentos que las leyes y reglamentos exijan para llevar a cabo el servicio, en caso de no cumplirse con estos requisitos el "Transportista" está obligado a rehusar el transporte de las mercancías.'],
  ['QUINTA', 'Si por sospecha de falsedad en la declaración del contenido de un bulto el "Transportista" deseare proceder a su reconocimiento, podrá hacerlo ante testigos y con asistencia del "Expedidor", "Remitente" o "Usuario" o del consignatario. Si este último no concurriere, se solicitará la presencia de un inspector de la Secretaría de Comunicaciones y Transportes, y se levantará el acta correspondiente. El "Transportista" tendrá en todo caso, la obligación de dejar los bultos en el estado en que se encontraban antes del reconocimiento.'],
  ['SEXTA', 'El "Transportista" deberá recoger y entregar la carga precisamente en los domicilios que señale el "Expedidor", "Remitente" o "Usuario", ajustándose a los términos y condiciones convenidos. El "Transportista" sólo está obligado a llevar la carga al domicilio del consignatario para su entrega una sola vez. Si ésta no fuera recibida, se dejará aviso de que la mercancía queda a disposición del interesado en las bodegas que indique el "Transportista".'],
  ['SÉPTIMA', 'Si la carga no fuere retirada dentro de los 30 días hábiles siguientes a aquel en que hubiere sido puesta a disposición del consignatario, el "Transportista" podrá solicitar la venta en subasta pública con arreglo a lo que dispone el Código de Comercio.'],
  ['OCTAVA', 'El "Transportista" y el "Expedidor", "Remitente" o "Usuario" negociarán libremente el precio del servicio, tomando en cuenta su tipo, característica de la carga, volumen, regularidad, clase de carga y sistema de pago.'],
  ['NOVENA', 'Si el "Expedidor", "Remitente" o "Usuario" desea que el "Transportista" asuma la responsabilidad por el valor de las mercancías o efectos que él declare y que cubra toda clase de riesgos, inclusive los derivados de caso fortuito o de fuerza mayor, las partes deberán convenir un cargo adicional, equivalente al valor de la prima del seguro que se contrate, el cual se deberá expresar en un CFDI con Complemento Carta Porte.'],
  ['DÉCIMA', 'Cuando el importe del flete no incluya el cargo adicional, la responsabilidad del "Transportista" queda expresamente limitada a la cantidad equivalente a 15 Unidades de Medida y Actualización (UMAS) por tonelada o cuando se trate de embarques cuyo peso sea mayor 200 kg., pero menor de 1000 kg; y 4 UMAS por remesa cuando se trate de embarques con peso hasta de 200 kg.'],
  ['DÉCIMA PRIMERA', 'El precio del transporte deberá pagarse en origen, salvo convenio entre las partes de pago en destino. Cuando el transporte se hubiere concertado "Flete por Cobrar", la entrega de las mercancías o efectos se hará contra el pago del flete y el "Transportista" tendrá derecho a retenerlos mientras no se le cubra el precio convenido.'],
  ['DÉCIMA SEGUNDA', 'Si al momento de la entrega resultare algún faltante o avería, el consignatario podrá formular su reclamación por escrito al "Transportista", dentro de las 24 horas siguientes.'],
  ['DÉCIMA TERCERA', 'El "Transportista" queda eximido de la obligación de recibir mercancías o efectos para su transporte, en los siguientes casos: a) Cuando se trate de carga que por su naturaleza, peso, volumen, embalaje defectuoso o cualquier otra circunstancia no pueda transportarse sin destruirse o sin causar daño a los demás artículos o al material rodante, salvo que la empresa de que se trate tenga el equipo adecuado. b) Las mercancías cuyo transporte haya sido prohibido por disposiciones legales o reglamentarias. Cuando tales disposiciones no prohíban precisamente el transporte de determinadas mercancías, pero sí ordenen la presentación de ciertos documentos para que puedan ser transportadas, el "Expedidor", "Remitente" o "Usuario" estará obligado a entregar al "Transportista" los documentos correspondientes.'],
  ['DÉCIMA CUARTA', 'Los casos no previstos en las presentes condiciones y las quejas derivadas de su aplicación se someterán por la vía administrativa a la Secretaría de Comunicaciones y Transportes.'],
  ['DÉCIMA QUINTA', 'Para el caso de que el "Expedidor", "Remitente" o "Usuario" contrate carro por entero, éste aceptará la responsabilidad solidaria para con "Transportista" mediante la figura de la corresponsabilidad que contempla el artículo 10 del Reglamento Sobre el Peso, Dimensiones y Capacidad de los Vehículos de Autotransporte que Transitan en los Caminos y Puentes de Jurisdicción Federal, por lo que el "Expedidor", "Remitente" o "Usuario" queda obligado a verificar que la carga y el vehículo que la transporta, cumplan con el peso y dimensiones máximas establecidas en la NOM-012-SCT-2-2017, o la que la sustituya. Para el caso de incumplimiento e inobservancia a las disposiciones que regulan el peso y dimensiones, por parte del "Expedidor", "Remitente" o "Usuario", éste será corresponsable de las infracciones y multas que la Secretaría de Infraestructura, Comunicaciones y Transportes o la Guardia Nacional impongan al "Transportista", por cargar las unidades con exceso de peso.'],
];

function encabezadoEmpresa(emp, cartaporte, fechaTxt, logo) {
  const domicilioEmpresa = [fmt(emp.CALLE), fmt(emp.NOEXT), 'Col.', fmt(emp.COLONIA)].filter(Boolean).join(' ');
  const ciudadEmpresa = [fmt(emp.MUNICIPIO) || fmt(emp.CIUDAD), fmt(emp.ESTADO), 'CP', fmt(emp.CP)].filter(Boolean).join(' ');
  return {
    columns: [
      logo ? { image: logo, width: 55, height: 55 } : { text: '', width: 55 },
      {
        width: '*',
        stack: [
          { text: fmt(emp.NOMBRECORTO) || fmt(emp.EMPRESA), bold: true, fontSize: 12, alignment: 'center', margin: [0, 0, 0, 3] },
          { text: 'SERVICIO PUBLICO FEDERAL DE AUTO TRANSPORTE DE CARGA', fontSize: 7, alignment: 'center', margin: [0, 0, 0, 2] },
          { text: 'SERVICIO A TODA LA REPUBLICA', fontSize: 7, alignment: 'center', margin: [0, 0, 0, 2] },
          { text: 'Reg.CANCAR', fontSize: 7, alignment: 'center', margin: [0, 2, 0, 2] },
          { text: domicilioEmpresa, fontSize: 7, alignment: 'center', margin: [0, 0, 0, 2] },
          { text: ciudadEmpresa, fontSize: 7, alignment: 'center', margin: [0, 0, 0, 2] },
          { text: `RFC: ${fmt(emp.RFC)}   ${fmt(emp.REGIMENFISCAL)}`, fontSize: 7, alignment: 'center' },
        ],
      },
      {
        // fillColor SOLO pinta fondo dentro de celdas de tabla — en un `stack`
        // de texto suelto pdfmake lo ignora silenciosamente, por eso este
        // bloque va como tabla de una columna en vez de stack.
        width: 130,
        table: {
          widths: ['*'],
          body: [
            [{ text: 'CARTA PORTE - TRASLADO', fillColor: AZUL, color: 'white', fontSize: 8, bold: true, alignment: 'center' }],
            [{ text: cartaporte, fillColor: '#eeeeee', fontSize: 9, bold: true, alignment: 'center' }],
            [{ text: 'Fecha', fillColor: AZUL, color: 'white', fontSize: 7, alignment: 'center' }],
            [{ text: fechaTxt, fillColor: '#eeeeee', fontSize: 9, alignment: 'center' }],
          ],
        },
        layout: { paddingTop: () => 3, paddingBottom: () => 3, paddingLeft: () => 4, paddingRight: () => 4, hLineWidth: () => 0, vLineWidth: () => 0 },
      },
    ],
  };
}

function filaLabel(label, value) {
  return { margin: [0, 0, 0, 4], columns: [ { text: label, width: 80, bold: true, fontSize: 8 }, { text: value || '', fontSize: 8 } ] };
}

async function generarPDFBuffer(serie, cartaporte, pool) {
  const d = await datosParaImpresion(serie, cartaporte, pool);
  const fechaTxt = fechaCorta(d.fecha);

  const clienteTxt = `${fmt(d.cp.Id_Cliente)} ${fmt(d.cp.NombreComunCli)}`.trim();

  const mercTablaBody = [
    [
      { text: 'BIENES\nTRASNSPORTADOS', fillColor: AZUL, color: 'white', bold: true, fontSize: 7 },
      { text: 'DESCRIPCION', fillColor: AZUL, color: 'white', bold: true, fontSize: 7 },
      { text: 'CANTIDAD', fillColor: AZUL, color: 'white', bold: true, fontSize: 7 },
      { text: 'UNIDAD', fillColor: AZUL, color: 'white', bold: true, fontSize: 7 },
      { text: 'PESO', fillColor: AZUL, color: 'white', bold: true, fontSize: 7 },
      { text: 'VALOR DE LA\nMARCANCIA', fillColor: AZUL, color: 'white', bold: true, fontSize: 7 },
    ],
    ...d.mercancias.map(m => [
      { text: m.bienesTransp, fontSize: 8 },
      { text: m.descripcion, fontSize: 8 },
      { text: numFmt(m.cantidad, 6), fontSize: 8, alignment: 'right' },
      { text: `${m.claveUnidad} ${m.unidad}`, fontSize: 8 },
      { text: numFmt(m.pesoEnKg, 3), fontSize: 8, alignment: 'right' },
      { text: `$${numFmt(m.valorMercancia, 6)}`, fontSize: 8, alignment: 'right' },
    ]),
  ];

  const primeraMerc = d.mercancias[0] || {};

  const content = [];

  content.push(encabezadoEmpresa(d.emp, cartaporte, fechaTxt, d.logo));
  content.push({ text: '', margin: [0, 4, 0, 0] });

  content.push(filaLabel('EXPEDIDO EN:', [fmt(d.emp.CALLE), fmt(d.emp.NOEXT)].filter(Boolean).join(' ')));
  content.push(filaLabel('FACTURAR A:', clienteTxt));
  content.push(filaLabel('RFC:', d.receptorRfc));
  content.push(filaLabel('BOOKING:', fmt(d.cp.NoPedidoCliente)));
  content.push(filaLabel('RUTA:', fmt(d.cp.DesFlete)));

  // Origen / Destino
  content.push({
    margin: [0, 10, 0, 0],
    layout: LAYOUT_ESPACIADO,
    table: {
      widths: ['*', '*'],
      body: [
        [
          { text: 'ORIGEN', fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment: 'center' },
          { text: 'DESTINO', fillColor: AZUL, color: 'white', bold: true, fontSize: 8, alignment: 'center' },
        ],
        [
          { fontSize: 8, margin: [4, 6, 4, 6], stack: [
            { text: [{ text: 'FECHA SALIDA: ', bold: true }, fechaHora(d.origen?.fechaHora)], margin: [0, 0, 0, 4] },
            { text: [{ text: 'REMITENTE: ', bold: true }, d.origen?.nombre || ''], margin: [0, 0, 0, 4] },
            { text: [{ text: 'RFC: ', bold: true }, d.origen?.rfc || ''], margin: [0, 0, 0, 4] },
            { text: [{ text: 'DOMICILIO: ', bold: true }, d.origen?.domicilio || ''], margin: [0, 0, 0, 4] },
            { text: d.origen?.domicilio2 || '' },
          ]},
          { fontSize: 8, margin: [4, 6, 4, 6], stack: [
            { text: [{ text: 'FECHA LLEGADA: ', bold: true }, fechaHora(d.destino?.fechaHora)], margin: [0, 0, 0, 4] },
            { text: [{ text: 'DESTINATARIO: ', bold: true }, d.destino?.nombre || ''], margin: [0, 0, 0, 4] },
            { text: [{ text: 'RFC: ', bold: true }, d.destino?.rfc || ''], margin: [0, 0, 0, 4] },
            { text: [{ text: 'DOMICILIO: ', bold: true }, d.destino?.domicilio || ''], margin: [0, 0, 0, 4] },
            { text: d.destino?.domicilio2 || '' },
          ]},
        ],
      ],
    },
  });

  content.push({
    margin: [0, 10, 0, 0],
    columns: [
      { text: [{ text: 'TRANSPORTE INTERNACIONAL: ', bold: true, fontSize: 8 }, { text: 'NO', fontSize: 8 }] },
      { text: [{ text: 'TOTAL DISTANCIA RECORRIDA: ', bold: true, fontSize: 8 }, { text: `${d.totalDistRec} KM`, fontSize: 8 }], alignment: 'right' },
    ],
  });

  content.push({ margin: [0, 10, 0, 0], layout: LAYOUT_ESPACIADO, table: { widths: ['12%','38%','12%','16%','11%','11%'], body: mercTablaBody } });

  content.push({
    margin: [0, 8, 0, 0],
    columns: [
      { text: [{ text: 'MATERIAL PELIGROSO: ', bold: true, fontSize: 8 }, { text: primeraMerc.materialPeligroso || 'No', fontSize: 8 }] },
      { text: [{ text: 'CVE. MAT. PEL.: ', bold: true, fontSize: 8 }, { text: primeraMerc.cveMaterialPeligroso || '', fontSize: 8 }] },
      { text: [{ text: 'EMBALAJE: ', bold: true, fontSize: 8 }, { text: primeraMerc.embalaje || '', fontSize: 8 }] },
      { text: [{ text: 'MONEDA: ', bold: true, fontSize: 8 }, { text: primeraMerc.moneda || 'MXN', fontSize: 8 }] },
      { text: [{ text: 'TOTAL: ', bold: true, fontSize: 8 }, { text: `$${numFmt(d.cp.TOTALMX, 2)}`, fontSize: 8 }], alignment: 'right' },
    ],
  });

  const remolque = d.remolques[0] || {};
  content.push({
    margin: [0, 10, 0, 0],
    columns: [
      { fontSize: 8, stack: [
        filaLabel('CONFIGURACION\nVEHICULAR', d.configVehicular),
        filaLabel('NO. POLIZA:', d.polizaRespCivil),
        filaLabel('AÑO MODELO:', d.anioModeloVM),
        filaLabel('PLACA REMOLQUE:', remolque.placa),
      ]},
      { fontSize: 8, stack: [
        filaLabel('ASEGURADORA:', d.aseguraRespCivil),
        filaLabel('PLACA VEHICULO:', d.placaVM),
        filaLabel('PERMISO SCT:', `${d.permSCT} ${d.numPermisoSCT}`),
        filaLabel('SUB TIPO REM:', remolque.subTipoRem),
      ]},
    ],
  });

  content.push({
    margin: [0, 10, 0, 0],
    columns: [
      filaLabel('NOMBRE OPERADOR:', d.operadorNombre),
      filaLabel('RFC:', d.operadorRfc),
      filaLabel('NUMERO DE LICENCIA:', d.operadorLicencia),
    ],
  });

  if (d.timbre) {
    content.push({
      margin: [0, 12, 0, 0],
      layout: LAYOUT_ESPACIADO,
      table: { widths: ['*','*','*','*'], body: [
        [
          { text: 'FOLIO FISCAL', fontSize: 7, bold: true },
          { text: 'CERTIFICADO DIGITAL SAT', fontSize: 7, bold: true },
          { text: 'NO CERTIFICADO', fontSize: 7, bold: true },
          { text: 'FECHA DE CERTIFICACIÓN', fontSize: 7, bold: true },
        ],
        [
          { text: d.timbre.uuid, fontSize: 7 },
          { text: d.timbre.noCertificadoSAT, fontSize: 7 },
          { text: d.noCertificado, fontSize: 7 },
          { text: d.timbre.fechaTimbrado, fontSize: 7, bold: true },
        ],
      ]},
    });

    let qrDataUrl = null;
    try {
      // El comprobante "T" (traslado) siempre tiene Total="0" fiscal -- no
      // existe importe fiscal en una Carta Porte (era un bug usar TOTALMX,
      // que es el total operativo interno, casi nunca 0).
      const totalStr = numFmt(0, 6);
      const feUrl = (d.timbre.selloCFD || '').slice(-8);
      const qrTexto = `https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx?id=${d.timbre.uuid}&re=${d.emisorRfc}&rr=${d.receptorRfc}&tt=${totalStr}&fe=${feUrl}`;
      qrDataUrl = await QRCode.toDataURL(qrTexto, { margin: 1, width: 90 });
    } catch (e) { /* si falla el QR, se omite sin tronar el PDF */ }

    content.push({
      margin: [0, 8, 0, 0],
      columns: [
        { width: '*', stack: [
          { text: 'SELLO DIGITAL', fontSize: 7, bold: true, margin: [0,0,0,3] },
          { text: partirLargo(d.timbre.selloCFD), fontSize: 6, margin: [0,0,0,6] },
          { text: 'SELLO DEL SAT', fontSize: 7, bold: true, margin: [0,0,0,3] },
          { text: partirLargo(d.timbre.selloSAT), fontSize: 6 },
        ]},
        // fit (no solo width en el generador) asegura que pdfmake nunca la
        // dibuje más grande que la columna, aunque el PNG venga con otro tamaño.
        qrDataUrl ? { width: 90, image: qrDataUrl, fit: [90, 90] } : { width: 90, text: '' },
      ],
    });
  }

  content.push({
    margin: [0, 12, 0, 0],
    columns: [
      { width: '*', stack: [
        { text: 'OBSERVACIONES:', fontSize: 7, bold: true, margin: [0,0,0,3] },
        { text: 'MERCANCIA CARGADA POR EL REMITENTE, IGNORANDO SU ESTADO Y CONTENIDO, MANIOBRAS DE DESCARGA POR CUENTA Y RIESGO DEL DESTINATARIO', fontSize: 7 },
      ]},
      { width: 150, table: { widths: ['*'], body: [[{ text: 'RECIBÍ DE CONFORMIDAD', fontSize: 7, bold: true, alignment: 'center', margin: [0,20,0,20] }]] } },
    ],
  });

  // Página 2 — condiciones de prestación de servicios (texto fijo)
  content.push({ pageBreak: 'before', ...encabezadoEmpresa(d.emp, cartaporte, fechaTxt, d.logo) });
  content.push({ text: 'CONDICIONES DE PRESTACIÓN DE SERVICIOS QUE AMPARA EL COMPLEMENTO CARTA PORTE', bold: true, fontSize: 9, alignment: 'center', margin: [0, 10, 0, 8] });
  content.push(...CLAUSULAS.map(([num, texto]) => ({
    fontSize: 7.5, margin: [0, 0, 0, 6], alignment: 'justify',
    text: [{ text: `${num}.- `, bold: true }, texto],
  })));

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

module.exports = { generarPDFBuffer, datosParaImpresion, resolverLogo };
