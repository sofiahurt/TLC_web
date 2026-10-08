'use strict';

// ── Utilidades compartidas entre las representaciones impresas (PDF) de
// Carta Porte y Factura ────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { getSatDb } = require('../config/sat-db');

function fmt(v) { return v ? String(v).trim() : ''; }

function numFmt(v, dec) {
  const n = parseFloat(v) || 0;
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

// ── formato de fecha/hora estilo "9 JUL 2026" / "9/07/2026 - 08:19 p." ─────────
const MESES = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
function fechaCorta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function fechaHora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'p.' : 'a.';
  h = h % 12; if (h === 0) h = 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()} - ${h}:${mm} ${ampm}`;
}
// Solo la hora, "08:19"
function horaCorta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}

// Sellos/certificados en base64 no traen espacios; pdfmake NO hace salto de
// línea dentro de una "palabra" sin espacios y el texto se sale de la página.
// Se inserta un espacio cada N caracteres para que sí pueda partirse (mismo
// truco visual que usa el PDF de referencia del sistema legado).
function partirLargo(str, cada = 90) {
  const s = fmt(str);
  if (!s) return '';
  return (s.match(new RegExp(`.{1,${cada}}`, 'g')) || []).join(' ');
}

// La ruta guardada en dbo.Empresas viene del sistema legado con su propia letra
// de unidad (ej. "D:\..."); se sustituye por la unidad real de esta máquina,
// igual que RUTA_XML en config/storage.js.
// Logo empaquetado dentro del propio proyecto (imagenes/LogoTLC.jpg) — funciona
// igual en desarrollo y en el VPS sin depender de rutas absolutas del sistema
// legado. Se prioriza sobre dbo.Empresas.LOGOEMPRESA, que solo queda como
// respaldo (esa ruta trae la unidad de disco de la máquina legada, ej. "D:\...",
// y hay que sustituirla por la unidad real de esta máquina para que sirva).
const LOGO_PROYECTO = path.join(__dirname, '..', '..', 'imagenes', 'LogoTLC.jpg');

function resolverLogo(rutaGuardada) {
  if (fs.existsSync(LOGO_PROYECTO)) return LOGO_PROYECTO;

  const ruta = fmt(rutaGuardada);
  if (!ruta) return null;
  const unidadActual = path.parse(__dirname).root;
  const rutaLocal = ruta.replace(/^[A-Za-z]:\\/, unidadActual);
  if (fs.existsSync(rutaLocal)) return rutaLocal;
  if (fs.existsSync(ruta)) return ruta;
  return null;
}

// ── helpers de lectura de XML (namespaces con prefijo fijo cartaporte31:) ──────
function porLocalName(node, name) {
  const nameLower = name.toLowerCase();
  const all = node.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if ((all[i].localName || all[i].nodeName).toLowerCase() === nameLower) return all[i];
  }
  return null;
}
function todosPorLocalName(node, name) {
  const nameLower = name.toLowerCase();
  const all = node.getElementsByTagName('*');
  const out = [];
  for (let i = 0; i < all.length; i++) {
    if ((all[i].localName || all[i].nodeName).toLowerCase() === nameLower) out.push(all[i]);
  }
  return out;
}
function attr(el, name) { return el ? fmt(el.getAttribute(name)) : ''; }

// Extrae el complemento cartaporte31:CartaPorte de un documento XML ya
// parseado (DOMParser). Reutilizado tanto por el PDF de Carta Porte como por
// el de Factura cuando Factura.IncluirCP=1 -- es el mismo nodo, mismo XSD,
// sin importar si el comprobante es "T" (traslado) o "I" (ingreso).
function extraerComplementoCartaPorte(doc) {
  const cpNode = porLocalName(doc, 'CartaPorte');
  if (!cpNode) return null;

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

  return {
    idCCP:            attr(cpNode, 'IdCCP'),
    totalDistRec:     attr(cpNode, 'TotalDistRec'),
    origen: origen ? {
      rfc: attr(origen, 'RFCRemitenteDestinatario'),
      nombre: attr(origen, 'NombreRemitenteDestinatario'),
      fechaHora: attr(origen, 'FechaHoraSalidaLlegada'),
      domicilio: domOrigen ? [attr(domOrigen,'Calle'), attr(domOrigen,'NumeroExterior')].filter(Boolean).join(' ') : '',
      cp: domOrigen ? attr(domOrigen,'CodigoPostal') : '',
      pais: domOrigen ? attr(domOrigen,'Pais') : '',
      estado: domOrigen ? attr(domOrigen,'Estado') : '',
      municipio: domOrigen ? attr(domOrigen,'Municipio') : '',
      localidad: domOrigen ? attr(domOrigen,'Localidad') : '',
      domicilio2: domOrigen ? [attr(domOrigen,'CodigoPostal'), attr(domOrigen,'Estado'), attr(domOrigen,'Pais')].filter(Boolean).join(' ') : '',
    } : null,
    destino: destino ? {
      rfc: attr(destino, 'RFCRemitenteDestinatario'),
      nombre: attr(destino, 'NombreRemitenteDestinatario'),
      fechaHora: attr(destino, 'FechaHoraSalidaLlegada'),
      distanciaRecorrida: attr(destino, 'DistanciaRecorrida'),
      domicilio: domDestino ? [attr(domDestino,'Calle'), attr(domDestino,'NumeroExterior')].filter(Boolean).join(' ') : '',
      cp: domDestino ? attr(domDestino,'CodigoPostal') : '',
      pais: domDestino ? attr(domDestino,'Pais') : '',
      estado: domDestino ? attr(domDestino,'Estado') : '',
      municipio: domDestino ? attr(domDestino,'Municipio') : '',
      localidad: domDestino ? attr(domDestino,'Localidad') : '',
      domicilio2: domDestino ? [attr(domDestino,'CodigoPostal'), attr(domDestino,'Estado'), attr(domDestino,'Pais')].filter(Boolean).join(' ') : '',
    } : null,
    pesoBrutoTotal: attr(mercanciasNode, 'PesoBrutoTotal'),
    unidadPeso:     attr(mercanciasNode, 'UnidadPeso'),
    numTotalMercancias: attr(mercanciasNode, 'NumTotalMercancias'),
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
  };
}

// Código Postal del domicilio fiscal del emisor -- usado solo como respaldo
// cuando el documento no trae su propio campo LugarExpedicion, para que el
// resultado siempre sea un Código Postal (nunca texto).
function lugarExpedicionTxt(emp) {
  return fmt(emp.CP);
}

// Texto "Lugar Expedición" real del documento: el campo LugarExpedicion de
// Factura/NotaCred es un Código Postal -- se muestra tal cual (solo el
// código, sin nada más), sin resolverlo contra ningún catálogo. Si el
// documento no lo trae capturado, cae al Código Postal del emisor.
function lugarExpedicionDesdeCP(cp, emp) {
  const codigo = fmt(cp);
  if (codigo) return codigo;
  return lugarExpedicionTxt(emp);
}

// Texto de moneda para el bloque de totales (Factura/NotaCred).
function monedaTxt(mon) {
  const m = fmt(mon) || 'MXN';
  if (m === 'USD') return 'USD Dolar';
  if (m === 'MXN') return 'MXN Pesos Mexicanos';
  return m;
}

// Descripción de una clave de catálogo SAT (Forma de Pago / Método de Pago),
// buscando primero en la columna de texto ya capturada en la tabla y, si
// viene vacía (hay Facturas/Notas con la clave pero sin su descripción),
// cayendo al catálogo del SAT correspondiente.
function descripcionCatalogo(tabla, columnaClave, claveBuscada, descripcionCapturada) {
  const desc = fmt(descripcionCapturada);
  if (desc) return desc;
  const clave = fmt(claveBuscada);
  if (!clave) return '';
  try {
    const db = getSatDb();
    const row = db.prepare(`SELECT descripcion FROM ${tabla} WHERE ${columnaClave} = ?`).get(clave);
    return row ? fmt(row.descripcion) : '';
  } catch (e) { return ''; }
}
function formaPagoTxt(clave, descripcion) {
  return descripcionCatalogo('sat_formas_pago', 'c_FormaPago', clave, descripcion);
}
function metodoPagoTxt(clave, descripcion) {
  return descripcionCatalogo('sat_metodo_pago', 'c_metodopago', clave, descripcion);
}

// Encabezado de empresa compartido por Factura y Notas de Crédito/Débito:
// logo + nombre, RFC, régimen fiscal (texto fijo -- el sistema legado no lo
// deriva del catálogo de régimen fiscal de la Empresa, esa columna trae
// datos obsoletos/inconsistentes con C_REGIMENFISCAL; confirmado igual en
// ambos PDF de referencia), domicilio y conmutador.
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
      { text: 'Regimen Fiscal: Ley Genral de Personas Morales', fontSize: 8, alignment: 'center' },
      { text: domicilio, fontSize: 8, alignment: 'center' },
      { text: ciudad, fontSize: 8, alignment: 'center' },
      { text: 'Conmutador: 55.30.09.49 con 12 Lineas Ext. 109 y 110 Fax:55.19.07.54', fontSize: 8, alignment: 'center' },
    ],
  };
}

module.exports = {
  fmt, numFmt, fechaCorta, fechaHora, horaCorta, partirLargo,
  resolverLogo, LOGO_PROYECTO,
  porLocalName, todosPorLocalName, attr,
  extraerComplementoCartaPorte,
  lugarExpedicionTxt, lugarExpedicionDesdeCP, monedaTxt, encabezadoEmpresa,
  formaPagoTxt, metodoPagoTxt,
};
