'use strict';

const fs   = require('fs');
const path = require('path');
const { Credential } = require('@nodecfdi/credentials/node');
const { Xslt, XmlParser } = require('xslt-processor');
const { sql } = require('../config/db');
const { serieFiscal } = require('../config/empresa-serie');

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
 * @param {string} nombreBase Identificador para el nombre del archivo en disco
 *   (ej. "CP_CUI0000517" para Carta Porte, "FAC_TESTQA126251" para Factura) —
 *   el llamador decide el prefijo/formato, este módulo solo lo usa tal cual.
 * @param {object} pool       Conexión mssql
 * @returns {Promise<{xml: string, noCertificado: string}>} XML sellado y el
 *   número de certificado del CSD usado (para persistirlo de inmediato, antes
 *   de siquiera intentar el timbrado — no depende de que el PAC responda).
 */
async function sellarXML(xmlString, serie, nombreBase, pool) {
  // 1. Empresa — varios centrales comparten la misma razón social/CSD (ver
  // config/empresa-serie.js), por eso se resuelve la serie fiscal primero.
  const empRes = await pool.request()
    .input('serie', sql.VarChar(10), serieFiscal(serie))
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

  // 4. Datos del certificado — se conocen de antemano (vienen del CSD, no de la
  // firma) y DEBEN estar ya inyectados en el XML antes de calcular la cadena
  // original, porque NoCertificado SÍ forma parte de la cadena firmada (a
  // diferencia de Certificado y Sello, que el propio XSLT excluye). Firmar la
  // cadena con NoCertificado="" y rellenarlo después produce un sello que jamás
  // coincide con la cadena real que recalcula el SAT/PAC.
  const noCertificado = csd.certificate().serialNumber().bytes();
  const certificado   = csd.certificate().pemAsOneLine();
  const xmlConCert = xmlString
    .replace('NoCertificado=""', `NoCertificado="${noCertificado}"`)
    .replace('Certificado=""',   `Certificado="${certificado}"`);

  // 5. Cadena original via XSLT (ya con NoCertificado real)
  const parser  = new XmlParser();
  const xslt    = new Xslt();
  const xmlDoc  = parser.xmlParse(xmlConCert);
  const xsltDoc = parser.xmlParse(xsltContent);
  const cadena  = await xslt.xsltProcess(xmlDoc, xsltDoc);
  if (!cadena || !cadena.startsWith('||')) {
    throw new Error(`La cadena original generada parece inválida: ${String(cadena).slice(0, 80)}`);
  }

  // 6. Firma SHA256withRSA → Base64
  // @nodecfdi/credentials firma con node-forge SIN especificar 'utf8' al hacer
  // md.update(); forge por default trata el string como binary/latin1 (1 char =
  // 1 byte), así que cualquier cadena original con acentos (ó, í, á, é, ñ...) se
  // firma sobre los bytes equivocados y el sello no cuadra con la digestión real
  // que recalcula el SAT/PAC (siempre en UTF-8). Se pre-codifica la cadena a sus
  // bytes UTF-8 reales (representados como string "binary") ANTES de firmar,
  // para que ese update() sin encoding termine operando sobre los bytes correctos.
  const cadenaUtf8Binaria = Buffer.from(cadena, 'utf8').toString('binary');
  const binarySig = csd.sign(cadenaUtf8Binaria, 'sha256');
  const sello     = Buffer.from(binarySig, 'binary').toString('base64');

  // 7. Inyectar el Sello (único dato que sí depende de la firma, va al final)
  const signed = xmlConCert.replace('Sello=""', `Sello="${sello}"`);

  // 8. Guardar en disco: <unidad>:\TLC_Web\Empresa2\XML\<nombreBase>_sellado.xml
  fs.mkdirSync(RUTA_XML, { recursive: true });
  fs.writeFileSync(path.join(RUTA_XML, `${nombreBase}_sellado.xml`), signed, 'utf8');

  // TODO: cuando se confirme el timbrado (ver app/services/cfdi-pac.js), al guardar
  // exitosamente <nombreBase>_Timbrada.xml, eliminar el archivo
  // <nombreBase>_sellado.xml correspondiente, ya que el timbrado lo reemplaza
  // como versión oficial final.

  return { xml: signed, noCertificado };
}

module.exports = { sellarXML };
