'use strict';

const fs   = require('fs');
const path = require('path');
const { Credential } = require('@nodecfdi/credentials/node');
const { Xslt, XmlParser } = require('xslt-processor');
const { sql } = require('../config/db');

const { RUTA_XML } = require('../config/storage');

const XSLT_PATH   = path.join(__dirname, '../resources/cadenaoriginal_cfdi40_cp31.xslt');
const xsltContent = fs.readFileSync(XSLT_PATH, 'utf8');

function fmt(v) { return v ? String(v).trim() : ''; }

/**
 * Sella el XML CFDI con el CSD de la empresa obtenido de dbo.Empresas.
 * Genera la cadena original via XSLT, firma con SHA256withRSA e inyecta
 * NoCertificado, Certificado y Sello en el XML.
 *
 * @param {string} xmlString  XML sin sellar (NoCertificado/Certificado/Sello vacíos)
 * @param {string} serie      Serie/central activa (req.session.central)
 * @param {string} cartaporte Folio de la Carta Porte (ej. "CUI0000517") — usado para el nombre del archivo
 * @param {object} pool       Conexión mssql
 * @returns {Promise<string>} XML sellado
 */
async function sellarXML(xmlString, serie, cartaporte, pool) {
  // 1. Empresa
  const empRes = await pool.request()
    .input('serie', sql.VarChar(10), serie)
    .query(`SELECT * FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE)) = @serie`);
  if (!empRes.recordset[0]) throw new Error(`Empresa no encontrada para serie "${serie}"`);
  const emp = empRes.recordset[0];

  // 2. Rutas del CSD
  const cerPath  = fmt(emp.CERTIFICADOCER);
  const keyPath  = fmt(emp.CERTIFICADOKEY);
  const password = fmt(emp.PASSWORDKEY);
  if (!cerPath) throw new Error('Ruta del certificado (.cer) no configurada en dbo.Empresas');
  if (!keyPath) throw new Error('Ruta de la llave privada (.key) no configurada en dbo.Empresas');
  if (!fs.existsSync(cerPath)) throw new Error(`Archivo .cer no encontrado: ${cerPath}`);
  if (!fs.existsSync(keyPath)) throw new Error(`Archivo .key no encontrado: ${keyPath}`);

  // 3. Cargar CSD
  let csd;
  try {
    csd = Credential.openFiles(cerPath, keyPath, password);
  } catch (e) {
    throw new Error(`Error al cargar el CSD (revise archivos y contraseña): ${e.message}`);
  }

  // 4. Cadena original via XSLT
  const parser  = new XmlParser();
  const xslt    = new Xslt();
  const xmlDoc  = parser.xmlParse(xmlString);
  const xsltDoc = parser.xmlParse(xsltContent);
  const cadena  = await xslt.xsltProcess(xmlDoc, xsltDoc);
  if (!cadena || !cadena.startsWith('||')) {
    throw new Error(`La cadena original generada parece inválida: ${String(cadena).slice(0, 80)}`);
  }

  // 5. Firma SHA256withRSA → Base64
  const binarySig = csd.sign(cadena, 'sha256');
  const sello     = Buffer.from(binarySig, 'binary').toString('base64');

  // 6. Datos del certificado
  const noCertificado = csd.certificate().serialNumber().bytes();
  const certificado   = csd.certificate().pemAsOneLine();

  // 7. Inyectar en el XML
  const signed = xmlString
    .replace('NoCertificado=""', `NoCertificado="${noCertificado}"`)
    .replace('Certificado=""',   `Certificado="${certificado}"`)
    .replace('Sello=""',         `Sello="${sello}"`);

  // 8. Guardar en disco: <unidad>:\TLC_Web\Empresa2\XML\CP_<cartaporte>_sellado.xml
  fs.mkdirSync(RUTA_XML, { recursive: true });
  fs.writeFileSync(path.join(RUTA_XML, `CP_${cartaporte}_sellado.xml`), signed, 'utf8');

  // TODO: cuando se implemente la integración con el PAC (Facturalo), al guardar
  // exitosamente CP_<CartaPorte>_timbrado.xml, eliminar el archivo
  // CP_<CartaPorte>_sellado.xml correspondiente, ya que el timbrado lo reemplaza
  // como versión oficial final.

  return signed;
}

/**
 * Envía el XML sellado al PAC (Facturalo) para su timbrado fiscal.
 *
 * TODO: Implementar integración con PAC Facturalo.
 *   Pendiente: endpoint, credenciales de acceso, formato de request/response, manejo de UUID.
 *
 * STUB: devuelve resultado simulado sin llamada HTTP real.
 */
async function enviarAPAC(xmlSellado) {
  return { ok: true, uuid: null, mensaje: 'PAC no conectado — stub de prueba' };
}

module.exports = { sellarXML, enviarAPAC };
