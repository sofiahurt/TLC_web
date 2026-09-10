'use strict';

// ── Cliente SOAP para timbrado ante el PAC ─────────────────────────────────────
//
// Responsabilidad ÚNICA de este módulo: armar el sobre SOAP 1.1, enviarlo al
// PAC, interpretar la respuesta y devolver un resultado estructurado (incluido
// el XML timbrado final). NO descuenta timbres contratados, NO genera el QR,
// NO actualiza el estatus del pedido ni escribe nada en base de datos — eso lo
// hace el llamador (ruta /cfdi/timbrar), que sí tiene el contexto de folio/BD.
//
// Contrato REAL verificado en vivo contra el WSDL de Timbrador Xpress / PAC
// "Facturalo" (dev.timbradorxpress.mx/ws/servicio.do?wsdl), confirmado con dos
// llamadas de prueba: consultarCreditosDisponibles (éxito) y timbrar con un
// CFDI basura (el servidor sí llegó a invocar Operaciones\Timbrado\Timbrar):
//
//   Endpoint:    https://<host>/ws/servicio.do   (SIN "?wsdl" — ese sufijo solo
//                sirve para descargar la definición, no para invocar el servicio)
//   SOAPAction:  urn:ServicioTimbradoWS#timbrar
//   Namespace:   urn:ws_api
//   Parámetros:  apikey (xsd:string), xmlCFDI (xsd:string, el XML firmado tal cual)
//   Respuesta:   <return xsi:type="tns:RespuestaTimbrado">
//                  <code>...</code><message>...</message><data>...</data>
//                </return>
//   (code/message/data es el mismo patrón para TODAS las operaciones del WSDL,
//    incluida consultarCreditosDisponibles, que fue con la que se validó.)
//
// El WSDL no documenta qué trae "data" en un timbrado exitoso — por eso este
// módulo acepta AMBAS variantes sin asumir una sola:
//   (a) el CFDI completo ya timbrado (con su propio TimbreFiscalDigital adentro)
//   (b) solo el nodo/fragmento TimbreFiscalDigital, que este módulo inserta
//       entonces dentro del XML sellado que se le mandó al PAC.
//
// El PAC es el mismo para todas las Empresas/series (URL de prueba/producción
// en .env), la única credencial que varía por Empresa es la de producción
// (dbo.Empresas.USUARIO) — no existe un usuario de prueba ahí. Este módulo no
// resuelve nada de eso, solo recibe {url, usuario} ya decididos por el
// llamador (ruta /cfdi/timbrar) — ver la firma de timbrarConPAC más abajo.
//
// Ajustable por entorno sin tocar código (ver .env.example):
//   PAC_URL_PRUEBA, PAC_URL_PRODUCCION, PAC_USUARIO_PRUEBA,
//   PAC_OPERACION (default "timbrar" — cambiar a "timbrar3" si el PAC lo requiere
//   para CFDI 4.0), PAC_SOAP_NAMESPACE, PAC_SOAP_ACTION, timeouts.

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const { URL } = require('url');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { sql } = require('../config/db');
const { serieFiscal } = require('../config/empresa-serie');

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const OPERACION       = process.env.PAC_OPERACION || 'timbrar';
const SOAP_NAMESPACE  = process.env.PAC_SOAP_NAMESPACE || 'urn:ws_api';
const SOAP_ACTION     = process.env.PAC_SOAP_ACTION || `urn:ServicioTimbradoWS#${OPERACION}`;
const CONNECT_TIMEOUT_MS  = parseInt(process.env.PAC_CONNECT_TIMEOUT_MS)  || 15000;
const RESPONSE_TIMEOUT_MS = parseInt(process.env.PAC_RESPONSE_TIMEOUT_MS) || 90000;

const NS_TFD = 'http://www.sat.gob.mx/TimbreFiscalDigital';

// Escapa el cierre de CDATA por si el contenido lo trajera (no debería, pero es gratis)
function cdata(str) {
  return String(str || '').split(']]>').join(']]]]><![CDATA[>');
}

// Sobre RPC/encoded — así lo espera el WSDL real (SOAP-ENC, style="rpc",
// use="encoded", namespace del body = urn:ws_api). El nombre del elemento raíz
// del Body y los nombres de parámetro (apikey/xmlCFDI) vienen del <message>
// "timbrarRequest" del WSDL, no son inventados.
function armarSobreSOAP(xmlFirmado, usuario) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <SOAP-ENV:Body>
    <ns1:${OPERACION} xmlns:ns1="${SOAP_NAMESPACE}">
      <apikey xsi:type="xsd:string">${usuario}</apikey>
      <xmlCFDI xsi:type="xsd:string"><![CDATA[${cdata(xmlFirmado)}]]></xmlCFDI>
    </ns1:${OPERACION}>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

// ── Transporte HTTP con timeouts de conexión y de respuesta separados ──────────
// TLS SIEMPRE validado (rejectUnauthorized: true) — el sistema legado del que
// viene este flujo lo tenía deshabilitado; no se repite ese error aquí.
function postSOAP(urlStr, xmlBody, soapAction) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error(`URL del PAC inválida: ${urlStr}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    const bodyBuffer = Buffer.from(xmlBody, 'utf8');

    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(connectTimer); fn(arg); };

    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      method: 'POST',
      rejectUnauthorized: true,
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        'SOAPAction': `"${soapAction}"`,
        'Content-Length': bodyBuffer.length,
      },
    }, (res) => {
      clearTimeout(connectTimer);
      let data = '';
      res.setEncoding('utf8');
      const responseTimer = setTimeout(() => {
        req.destroy(new Error(`Tiempo de espera agotado esperando respuesta del PAC (${RESPONSE_TIMEOUT_MS}ms)`));
      }, RESPONSE_TIMEOUT_MS);
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { clearTimeout(responseTimer); finish(resolve, { statusCode: res.statusCode, body: data }); });
      res.on('error', (err) => { clearTimeout(responseTimer); finish(reject, err); });
    });

    const connectTimer = setTimeout(() => {
      req.destroy(new Error(`Tiempo de espera agotado conectando al PAC (${CONNECT_TIMEOUT_MS}ms)`));
    }, CONNECT_TIMEOUT_MS);

    req.on('socket', (socket) => {
      if (socket.connecting === false) { clearTimeout(connectTimer); return; }
      socket.once('connect', () => clearTimeout(connectTimer));
      socket.once('secureConnect', () => clearTimeout(connectTimer));
    });

    req.on('error', (err) => finish(reject, err));
    req.write(bodyBuffer);
    req.end();
  });
}

// ── Parseo de la respuesta SOAP ─────────────────────────────────────────────────
// Se busca por localName (ignorando prefijo/namespace) para no depender del
// WSDL exacto del PAC. Cubre tanto el contrato real confirmado (code/message/
// data dentro de <return>) como el patrón genérico de PACs viejos (código
// embebido como texto, o TimbreFiscalDigital como atributos directos).

function porLocalName(doc, name) {
  const nameLower = name.toLowerCase();
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if ((el.localName || el.nodeName).toLowerCase() === nameLower) return el;
  }
  return null;
}

function attrCI(el, name) {
  if (!el || !el.attributes) return null;
  const nameLower = name.toLowerCase();
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if ((a.localName || a.name).toLowerCase() === nameLower) return a.value;
  }
  return null;
}

function textDe(doc, name) {
  const el = porLocalName(doc, name);
  return el ? (el.textContent || '').trim() : null;
}

// Intenta reparsear como XML el texto de un nodo, por si trae XML embebido
// (ya sea escapado con entidades — el parser ya las decodifica al leer
// textContent — o crudo). Devuelve un Document nuevo o null.
function reparsearSiEsXML(texto) {
  if (!texto) return null;
  const idx = texto.indexOf('<');
  if (idx === -1) return null;
  const candidato = texto.slice(idx).trim();
  if (!candidato.startsWith('<')) return null;
  try {
    const sub = new DOMParser({ errorHandler: () => {} }).parseFromString(candidato, 'text/xml');
    if (sub && sub.documentElement) return sub;
  } catch (e) { /* no era XML válido, se ignora */ }
  return null;
}

function extraerTFD(doc) {
  const tfd = porLocalName(doc, 'TimbreFiscalDigital');
  if (!tfd) return null;
  return {
    uuid:             attrCI(tfd, 'UUID'),
    fechaTimbrado:    attrCI(tfd, 'FechaTimbrado'),
    rfcProvCertif:    attrCI(tfd, 'RfcProvCertif'),
    selloCFD:         attrCI(tfd, 'SelloCFD'),
    noCertificadoSAT: attrCI(tfd, 'NoCertificadoSAT') || attrCI(tfd, 'NumeroCertificadoSAT'),
    selloSAT:         attrCI(tfd, 'SelloSAT'),
  };
}

// `data` en el contrato real puede ser: (a) el CFDI completo ya timbrado, o
// (b) solo el fragmento TimbreFiscalDigital. Se distingue viendo si el root
// del XML reparseado es el propio TFD o un documento más grande que lo contiene.
function interpretarData(dataTexto) {
  const sub = reparsearSiEsXML(dataTexto);
  if (!sub) return { tfd: null, xmlCompleto: null };
  const tfd = extraerTFD(sub);
  if (!tfd) return { tfd: null, xmlCompleto: null };
  const rootEsTFD = (sub.documentElement.localName || sub.documentElement.nodeName) === 'TimbreFiscalDigital';
  return { tfd, xmlCompleto: rootEsTFD ? null : dataTexto.trim() };
}

function interpretarRespuesta(bodyXml) {
  let doc;
  try {
    doc = new DOMParser({ errorHandler: (level, msg) => { if (level === 'error') throw new Error(msg); } })
      .parseFromString(bodyXml, 'text/xml');
  } catch (err) {
    // El backend del PAC es PHP y ante un CFDI muy malformado puede regresar
    // un volcado de error HTML (HTTP 200) en vez de un SOAP Fault. Se extrae
    // lo que se pueda para no perder la pista.
    const m = /<b>Fatal error<\/b>:\s*([^<]+)/i.exec(bodyXml);
    throw new Error(m ? `El PAC devolvió un error interno: ${m[1].trim()}` : `Respuesta del PAC no es XML válido: ${err.message}`);
  }

  // 1er intento (contrato real confirmado): code/message/data dentro de <return>.
  let code    = textDe(doc, 'code')    || textDe(doc, 'Code');
  let subCode = textDe(doc, 'subCode') || textDe(doc, 'SubCode');
  let message = textDe(doc, 'message') || textDe(doc, 'Message');
  const data  = textDe(doc, 'data')    || textDe(doc, 'Data');

  let tfd = null;
  let xmlCompleto = null;
  if (data) {
    const r = interpretarData(data);
    tfd = r.tfd;
    xmlCompleto = r.xmlCompleto;
  }

  // 2do intento (patrón genérico de otros PACs): TimbreFiscalDigital como
  // atributos directos en la respuesta, sin pasar por "data".
  if (!tfd) tfd = extraerTFD(doc);

  // 3er intento: el código/mensaje viene embebido como texto dentro de algún
  // contenedor tipo <return>, ya sea "código|subcódigo|mensaje" o XML escapado.
  if (!code) {
    const posiblesContenedores = ['return', 'timbrarResult', 'TimbrarResult', 'Result', 'result'];
    for (const nombre of posiblesContenedores) {
      const el = porLocalName(doc, nombre);
      if (!el) continue;
      const plano = (el.textContent || '').trim();
      const partes = plano.split('|');
      if (partes.length >= 2 && /^\d+$/.test(partes[0].trim())) {
        code    = partes[0].trim();
        subCode = subCode || (partes[1] ? partes[1].trim() : null);
        message = message || (partes[2] ? partes.slice(2).join('|').trim() : null);
      }
      if (code) break;
    }
  }

  return { code: code ? String(code).trim() : null, subCode, message, tfd, xmlCompleto };
}

// ── Inserta el TimbreFiscalDigital dentro del cfdi:Complemento del XML sellado ──
// Solo se usa cuando el PAC regresó el TFD suelto (no el CFDI completo ya armado).
function insertarTFDEnXML(xmlSellado, tfd) {
  const doc = new DOMParser({ errorHandler: (level, msg) => { if (level === 'error') throw new Error(msg); } })
    .parseFromString(xmlSellado, 'text/xml');
  const complemento = porLocalName(doc, 'Complemento');
  if (!complemento) throw new Error('El XML sellado no tiene nodo cfdi:Complemento donde insertar el TimbreFiscalDigital');

  const tfdEl = doc.createElementNS(NS_TFD, 'tfd:TimbreFiscalDigital');
  tfdEl.setAttribute('Version', '1.1');
  if (tfd.uuid)             tfdEl.setAttribute('UUID', tfd.uuid);
  if (tfd.fechaTimbrado)    tfdEl.setAttribute('FechaTimbrado', tfd.fechaTimbrado);
  if (tfd.rfcProvCertif)    tfdEl.setAttribute('RfcProvCertif', tfd.rfcProvCertif);
  if (tfd.selloCFD)         tfdEl.setAttribute('SelloCFD', tfd.selloCFD);
  if (tfd.noCertificadoSAT) tfdEl.setAttribute('NoCertificadoSAT', tfd.noCertificadoSAT);
  if (tfd.selloSAT)         tfdEl.setAttribute('SelloSAT', tfd.selloSAT);

  complemento.appendChild(tfdEl);
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Envía el XML ya sellado (con CSD) al PAC para su timbrado fiscal y devuelve
 * un resultado estructurado. NO decide nada sobre folios/estatus del pedido:
 * eso queda a cargo del llamador, que sí conoce el estado en base de datos
 * (importante para el manejo de código 307, ver más abajo).
 *
 * @param {string} xmlFirmado XML CFDI ya sellado con el CSD (Sello/Certificado llenos)
 * @param {{url: string, usuario: string}} conexion Endpoint y credencial ya
 *   resueltos por el llamador según el flag TESTFEL de la Empresa (ver
 *   dbo.Empresas: DIRSERWS/DirDemoWS/USUARIO). Este módulo no decide cuál usar.
 * @returns {Promise<{
 *   exito: boolean,
 *   uuid: string|null,
 *   fechaTimbrado: string|null,
 *   selloCFD: string|null,
 *   selloSAT: string|null,
 *   noCertificadoSAT: string|null,
 *   rfcProvCertif: string|null,
 *   codigoRespuesta: string|null,
 *   subCodigo: string|null,
 *   mensajeError: string|null,
 *   reenvio: boolean,
 *   xmlTimbrado: string|null
 * }>}
 */
async function timbrarConPAC(xmlFirmado, { url, usuario }) {
  if (!url)     throw new Error('Falta la URL de conexión al PAC (revise DIRSERWS/DirDemoWS en dbo.Empresas)');
  if (!usuario) throw new Error('Falta la credencial (USUARIO) de conexión al PAC en dbo.Empresas');
  const sobre = armarSobreSOAP(xmlFirmado, usuario);

  const vacio = {
    exito: false, uuid: null, fechaTimbrado: null, selloCFD: null, selloSAT: null,
    noCertificadoSAT: null, rfcProvCertif: null, codigoRespuesta: null, subCodigo: null,
    mensajeError: null, reenvio: false, xmlTimbrado: null,
  };

  let respuesta;
  try {
    respuesta = await postSOAP(url, sobre, SOAP_ACTION);
  } catch (err) {
    return { ...vacio, mensajeError: `Error de comunicación con el PAC: ${err.message}` };
  }

  if (respuesta.statusCode < 200 || respuesta.statusCode >= 300) {
    // Muchos servidores SOAP regresan 500 con el Fault dentro del body — se intenta
    // igual extraer un mensaje útil del cuerpo antes de rendirse.
    let mensaje = `El PAC respondió HTTP ${respuesta.statusCode}`;
    try {
      const doc = new DOMParser({ errorHandler: () => {} }).parseFromString(respuesta.body, 'text/xml');
      const faultString = textDe(doc, 'faultstring') || textDe(doc, 'Reason') || textDe(doc, 'Text');
      if (faultString) mensaje = faultString;
    } catch (e) { /* cuerpo no era XML, se deja el mensaje genérico */ }
    return { ...vacio, mensajeError: mensaje };
  }

  let interpretado;
  try {
    interpretado = interpretarRespuesta(respuesta.body);
  } catch (err) {
    return { ...vacio, mensajeError: `No se pudo interpretar la respuesta del PAC: ${err.message}` };
  }

  const { code, subCode, message, tfd, xmlCompleto } = interpretado;
  const esExito   = code === '200';
  const esReenvio = code === '307';

  if (!esExito && !esReenvio) {
    return { ...vacio, codigoRespuesta: code, subCodigo: subCode, mensajeError: message || 'El PAC rechazó el timbrado sin mensaje de error' };
  }

  if (!tfd || !tfd.uuid) {
    return {
      ...vacio, codigoRespuesta: code, subCodigo: subCode, reenvio: esReenvio,
      mensajeError: `El PAC respondió código ${code} sin traer TimbreFiscalDigital/UUID identificable en la respuesta`,
    };
  }

  let xmlTimbrado = xmlCompleto; // el PAC ya regresó el CFDI completo
  if (!xmlTimbrado) {
    try {
      xmlTimbrado = insertarTFDEnXML(xmlFirmado, tfd);
    } catch (err) {
      return {
        ...vacio, uuid: tfd.uuid, fechaTimbrado: tfd.fechaTimbrado, selloCFD: tfd.selloCFD,
        selloSAT: tfd.selloSAT, noCertificadoSAT: tfd.noCertificadoSAT, rfcProvCertif: tfd.rfcProvCertif,
        codigoRespuesta: code, subCodigo: subCode, reenvio: esReenvio,
        mensajeError: `El PAC timbró (UUID ${tfd.uuid}) pero no se pudo insertar el complemento en el XML: ${err.message}`,
      };
    }
  }

  return {
    exito: true,
    uuid: tfd.uuid,
    fechaTimbrado: tfd.fechaTimbrado,
    selloCFD: tfd.selloCFD,
    selloSAT: tfd.selloSAT,
    noCertificadoSAT: tfd.noCertificadoSAT,
    rfcProvCertif: tfd.rfcProvCertif,
    codigoRespuesta: code,
    subCodigo: subCode,
    mensajeError: null,
    reenvio: esReenvio, // 307: si en BD ya hay UUID para este folio, el llamador debe ignorar este resultado
    xmlTimbrado,
  };
}

// ── Sobre SOAP para cancelar (CSD original en DER + contraseña) ────────────
// Confirmado por WSDL (Timbrador Xpress): operación cancelar(apikey, keyCSD,
// cerCSD, passCSD, uuid, rfcEmisor, rfcReceptor, total, motivo, folioSustitucion)
// -> RespuestaCancelar. A diferencia de cancelarPEM (que espera la llave ya
// desencriptada en PEM y falló con "No se pudo generar el PFX" -- probado
// contra el sandbox real), esta manda el .cer/.key ORIGINALES tal cual vienen
// de SAT (DER, la llave aún encriptada) en base64, más su contraseña -- el
// mismo material crudo que ya usa cargarCSD()/sellarXML(), sin reconvertir.
function armarSobreSOAPCancelarCSD(usuario, { keyCSD, cerCSD, passCSD, uuid, rfcEmisor, rfcReceptor, total, motivo, folioSustitucion }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <SOAP-ENV:Body>
    <ns1:cancelar xmlns:ns1="${SOAP_NAMESPACE}">
      <apikey xsi:type="xsd:string">${usuario}</apikey>
      <keyCSD xsi:type="xsd:string"><![CDATA[${cdata(keyCSD)}]]></keyCSD>
      <cerCSD xsi:type="xsd:string"><![CDATA[${cdata(cerCSD)}]]></cerCSD>
      <passCSD xsi:type="xsd:string">${passCSD}</passCSD>
      <uuid xsi:type="xsd:string">${uuid}</uuid>
      <rfcEmisor xsi:type="xsd:string">${rfcEmisor}</rfcEmisor>
      <rfcReceptor xsi:type="xsd:string">${rfcReceptor}</rfcReceptor>
      <total xsi:type="xsd:string">${total}</total>
      <motivo xsi:type="xsd:string">${motivo}</motivo>
      <folioSustitucion xsi:type="xsd:string">${folioSustitucion || ''}</folioSustitucion>
    </ns1:cancelar>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

/**
 * Cancela un CFDI ya timbrado ante el PAC (operación cancelar del WSDL de
 * Timbrador Xpress -- CSD original en DER+base64, no PEM). A diferencia de
 * timbrarConPAC, NO recibe un XML firmado -- recibe las rutas del .cer/.key
 * tal cual (mismo material que usa cargarCSD()) y los datos sueltos del CFDI.
 *
 * Contrato CONFIRMADO contra el sandbox real (2026-09-10, UUID de prueba
 * cancelado con éxito, acuse SAT firmado recibido): a diferencia de timbrar
 * (éxito = code 200), cancelar responde éxito con code="201" y status=
 * "success" -- se usa status como señal principal por ser explícita, con el
 * code como respaldo. El intento inicial con la operación cancelarPEM (CSD
 * ya desencriptado en PEM) fue rechazado por el PAC ("No se pudo generar el
 * PFX"); esta operación (DER+contraseña, el material crudo tal cual lo usa
 * cargarCSD/sellarXML) sí funciona.
 *
 * @param {{cerPath: string, keyPath: string, password: string}} archivosCSD Rutas/contraseña del CSD (dbo.Empresas.CERTIFICADOCER/KEY/PASSWORDKEY)
 * @param {{url: string, usuario: string}} conexion
 * @param {{uuid: string, rfcEmisor: string, rfcReceptor: string, total: string|number, motivo: string, folioSustitucion?: string}} datos
 * @returns {Promise<{exito: boolean, codigoRespuesta: string|null, status: string|null, mensajeError: string|null, acuseXml: string|null}>}
 */
async function cancelarConPAC({ cerPath, keyPath, password }, { url, usuario }, datos) {
  if (!url)     throw new Error('Falta la URL de conexión al PAC');
  if (!usuario) throw new Error('Falta la credencial (USUARIO) de conexión al PAC');
  const keyCSD = fs.readFileSync(keyPath).toString('base64');
  const cerCSD = fs.readFileSync(cerPath).toString('base64');
  const sobre = armarSobreSOAPCancelarCSD(usuario, { keyCSD, cerCSD, passCSD: password, ...datos });

  const vacio = { exito: false, codigoRespuesta: null, status: null, mensajeError: null };

  let respuesta;
  try {
    respuesta = await postSOAP(url, sobre, `urn:ServicioTimbradoWS#cancelar`);
  } catch (err) {
    return { ...vacio, mensajeError: `Error de comunicación con el PAC: ${err.message}` };
  }

  if (respuesta.statusCode < 200 || respuesta.statusCode >= 300) {
    let mensaje = `El PAC respondió HTTP ${respuesta.statusCode}`;
    try {
      const doc = new DOMParser({ errorHandler: () => {} }).parseFromString(respuesta.body, 'text/xml');
      const faultString = textDe(doc, 'faultstring') || textDe(doc, 'Reason') || textDe(doc, 'Text');
      if (faultString) mensaje = faultString;
    } catch (e) { /* cuerpo no era XML */ }
    return { ...vacio, mensajeError: mensaje };
  }

  let doc;
  try {
    doc = new DOMParser({ errorHandler: (level, msg) => { if (level === 'error') throw new Error(msg); } })
      .parseFromString(respuesta.body, 'text/xml');
  } catch (err) {
    return { ...vacio, mensajeError: `Respuesta del PAC no es XML válido: ${err.message}` };
  }

  const code    = textDe(doc, 'code')    || textDe(doc, 'Code');
  const message = textDe(doc, 'message') || textDe(doc, 'Message');
  const status  = textDe(doc, 'status')  || textDe(doc, 'Status');
  const dataTexto = textDe(doc, 'data')  || textDe(doc, 'Data');

  // Confirmado contra el sandbox real: cancelar usa code=201 (NO 200, ese es
  // solo para timbrar) con status="success" -- se usa status como señal
  // principal de éxito por ser explícita, con el code como respaldo.
  const esExito = status === 'success' || code === '201';
  if (!esExito) {
    return { ...vacio, codigoRespuesta: code, status, mensajeError: message || 'El PAC rechazó la cancelación sin mensaje de error' };
  }

  // El acuse de cancelación (XML firmado por el SAT, con EstatusUUID) viene
  // embebido como JSON escapado dentro de "data" -- se extrae para poder
  // guardarlo en disco como evidencia fiscal (mismo criterio que el XML
  // timbrado: el archivo en disco es la fuente de verdad, no la BD).
  let acuseXml = null;
  if (dataTexto) {
    try {
      const parsed = JSON.parse(dataTexto);
      if (parsed && parsed.acuse) acuseXml = parsed.acuse;
    } catch (e) { /* si no es el JSON esperado, se omite sin tronar */ }
  }

  return { exito: true, codigoRespuesta: code, status, mensajeError: null, acuseXml };
}

// ── Resolución de conexión al PAC (sandbox vs. producción) ─────────────────
// Movido tal cual desde app/routes/cfdi.js para que servicios nuevos
// (app/services/cfdi-cancelacion.js) puedan reutilizarlo sin crear una
// dependencia circular ruta→servicio→ruta. Comportamiento sin cambios.

// El PAC (URL) es el mismo para todas las Empresas/series — solo cambia entre
// prueba y producción, y eso sale de .env, no de dbo.Empresas.
function urlPACGlobal(testFel) {
  const url = ((testFel ? process.env.PAC_URL_PRUEBA : process.env.PAC_URL_PRODUCCION) || '').trim();
  if (!url) throw new Error(`URL del PAC no configurada en .env (PAC_URL_${testFel ? 'PRUEBA' : 'PRODUCCION'})`);
  return url.replace(/\?wsdl$/i, '');
}

// Resuelve credencial/URL del PAC para una Serie según el flag TESTFEL de su
// Empresa. dbo.Empresas.USUARIO solo tiene la credencial de PRODUCCIÓN; no
// existe un usuario de prueba ahí, por eso en modo prueba se toma de .env.
// Varios centrales comparten la misma razón social/CSD (ver config/empresa-serie.js).
async function resolverConexionPAC(pool, serie) {
  const empRes = await pool.request()
    .input('serie', sql.VarChar(10), serieFiscal(serie))
    .query(`SELECT TESTFEL, USUARIO FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE)) = @serie`);
  const emp = empRes.recordset[0];
  if (!emp) throw new Error(`No se encontró configuración de Empresa para la serie "${serie}"`);

  const testFel = !!parseInt(emp.TESTFEL) || false;
  const url     = urlPACGlobal(testFel);
  const usuario = testFel ? (process.env.PAC_USUARIO_PRUEBA || '').trim() : (emp.USUARIO || '').trim();

  if (!usuario) throw new Error(testFel
    ? 'No hay credencial de prueba configurada (PAC_USUARIO_PRUEBA en .env)'
    : `La Empresa de la serie "${serie}" no tiene USUARIO (credencial del PAC) configurado`);

  return { url, usuario, testFel };
}

module.exports = { timbrarConPAC, cancelarConPAC, resolverConexionPAC, urlPACGlobal };
