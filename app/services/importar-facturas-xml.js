'use strict';

// ── Importar facturas desde XML CFDI 4.0 ────────────────────────────────────
//
// Lee XML timbrados (Ingreso) y los da de alta en Empresa2.Factura/FacDeta, y
// guarda el XML original donde el sistema ya guarda los timbrados de Facturas
// (RUTA_XML, FAC_{Serie}{Folio}_Timbrada.xml) para que PDF y descarga lo hallen.
//
//   - Solo TipoDeComprobante="I"; los demás se omiten sin fallar el lote.
//   - Si ya existe (SerieFac + Id_NoFactura) no se inserta.
//   - Cabecera + conceptos en UNA transacción por archivo.
//   - Los importes salen del XML tal cual (no se llama a recalcularCabecera).

const fs   = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');
const { sql } = require('../config/db');
const { RUTA_XML } = require('../config/storage');
const { importeALetras } = require('./importe-letras');
const { fmt, porLocalName, attr } = require('./pdf-utils');

const r2  = v => Math.round((Number(v) || 0) * 100) / 100;
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const cortar = (s, n) => fmt(s).slice(0, n);

// Hijos directos con ese localName (Impuestos del Comprobante != Impuestos de cada Concepto).
function hijos(node, name) {
  const out = [];
  if (!node) return out;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && (c.localName || c.nodeName.split(':').pop()) === name) out.push(c);
  }
  return out;
}
const hijo = (node, name) => hijos(node, name)[0] || null;

// ── Parseo ──────────────────────────────────────────────────────────────────
// Devuelve { tipo } si no es Ingreso; si lo es, todos los datos para insertar.
function parsearFacturaXml(xmlString) {
  const errores = [];
  let doc;
  try {
    doc = new DOMParser({ onError: (nivel, msg) => { if (nivel !== 'warning') errores.push(msg); } })
      .parseFromString(xmlString, 'text/xml');
  } catch (err) { errores.push(err.message); }
  const comp = doc && doc.documentElement;
  if (errores.length || !comp || (comp.localName || comp.nodeName.split(':').pop()) !== 'Comprobante') {
    throw new Error('El archivo no es un XML CFDI válido (no se encontró cfdi:Comprobante).');
  }

  const tipo = attr(comp, 'TipoDeComprobante').toUpperCase();
  if (tipo !== 'I') return { tipo };

  if (attr(comp, 'Version') !== '4.0') throw new Error(`Solo se admite CFDI 4.0 (el archivo es versión "${attr(comp, 'Version')}").`);

  const folioTxt = attr(comp, 'Folio');
  if (!/^\d+$/.test(folioTxt)) throw new Error(`El Folio "${folioTxt}" no es numérico; no se puede usar como número de factura.`);
  const fechaTxt = attr(comp, 'Fecha');
  const mf = fechaTxt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  if (!mf) throw new Error(`Fecha del comprobante inválida: "${fechaTxt}".`);

  const receptor = hijo(comp, 'Receptor');
  const tfd = porLocalName(comp, 'TimbreFiscalDigital');
  const uuid = attr(tfd, 'UUID');
  if (!uuid) throw new Error('El XML no trae TimbreFiscalDigital/UUID (no está timbrado).');

  const impComp = hijo(comp, 'Impuestos');
  const conceptosNode = hijo(comp, 'Conceptos');
  const conceptos = hijos(conceptosNode, 'Concepto').map((c, i) => {
    const imp = hijo(c, 'Impuestos');
    const sumar = (contenedor, nodo) => r2(hijos(hijo(imp, contenedor), nodo).reduce((a, n) => a + num(n.getAttribute('Importe')), 0));
    const subtotal = r2(num(attr(c, 'Importe')));
    const iva = sumar('Traslados', 'Traslado');
    const reten = sumar('Retenciones', 'Retencion');
    return {
      id: i + 1,
      claveProdServ: attr(c, 'ClaveProdServ'), claveUnidad: attr(c, 'ClaveUnidad'),
      descripcion: attr(c, 'Descripcion'), cantidad: num(attr(c, 'Cantidad')),
      subtotal, iva, reten, total: r2(subtotal + iva - reten),
    };
  });
  if (!conceptos.length) throw new Error('El XML no trae conceptos.');

  const subTotal = r2(num(attr(comp, 'SubTotal')));
  const descuento = r2(num(attr(comp, 'Descuento')));
  const iva = r2(num(attr(impComp, 'TotalImpuestosTrasladados')));
  const retencion = r2(num(attr(impComp, 'TotalImpuestosRetenidos')));
  const total = r2(num(attr(comp, 'Total')));

  const advertencias = [];
  const esperado = r2(subTotal - descuento + iva - retencion);
  if (Math.abs(esperado - total) > 0.01) {
    advertencias.push(`Total del XML (${total.toFixed(2)}) no coincide con SubTotal+IVA-Retención (${esperado.toFixed(2)}).`);
  }

  const moneda = attr(comp, 'Moneda') || 'MXN';
  return {
    tipo, serie: attr(comp, 'Serie') || null, folio: parseInt(folioTxt, 10),
    fecha: mf[1], hora: mf[2],
    subTotal, iva, retencion, total, moneda,
    tipoCambio: moneda === 'MXN' ? 1 : num(attr(comp, 'TipoCambio')) || 1,
    formaPago: attr(comp, 'FormaPago'), metodoPago: attr(comp, 'MetodoPago') || 'PUE',
    lugarExpedicion: attr(comp, 'LugarExpedicion'), exportacion: attr(comp, 'Exportacion'),
    noCertificado: attr(comp, 'NoCertificado'),
    rfc: attr(receptor, 'Rfc'), nombre: attr(receptor, 'Nombre'), usoCfdi: attr(receptor, 'UsoCFDI'),
    uuid, fechaTimbrado: attr(tfd, 'FechaTimbrado'), rfcProvCertif: attr(tfd, 'RfcProvCertif'),
    idCCP: attr(porLocalName(comp, 'CartaPorte'), 'IdCCP'),
    conceptos, advertencias,
  };
}

// ── Cliente: RFC (respaldo: nombre). Id 0 si no hay coincidencia única ───────
async function buscarCliente(tx, d) {
  const buscar = async (campo, valor) => {
    if (!valor) return [];
    const r = await new sql.Request(tx).input('v', sql.VarChar(150), valor)
      .query(`SELECT ID_CLIENTE, LTRIM(RTRIM(NOMBRECOM)) NOMBRECOM FROM Empresa2.Clientes WHERE LTRIM(RTRIM(${campo})) = @v`);
    return r.recordset;
  };
  const porRfc = await buscar('RFC', d.rfc);
  if (porRfc.length === 1) return { id: Number(porRfc[0].ID_CLIENTE) };
  if (porRfc.length > 1) {
    const afinan = porRfc.filter(c => (c.NOMBRECOM || '').toUpperCase() === d.nombre.toUpperCase());
    if (afinan.length === 1) return { id: Number(afinan[0].ID_CLIENTE) };
    return { id: 0, motivo: `RFC ${d.rfc} está en ${porRfc.length} clientes (ambiguo)` };
  }
  const porNombre = await buscar('NOMBRECOM', d.nombre);
  if (porNombre.length === 1) return { id: Number(porNombre[0].ID_CLIENTE) };
  if (porNombre.length > 1) return { id: 0, motivo: `el nombre "${d.nombre}" está en ${porNombre.length} clientes (ambiguo)` };
  return { id: 0, motivo: `RFC ${d.rfc} / nombre "${d.nombre}" no están en el catálogo` };
}

const SERIEFAC_EQ = `ISNULL(LTRIM(RTRIM(SerieFac)),'') = ISNULL(@serieFac,'')`;
const nombreXml = d => `FAC_${d.serie || ''}${d.folio}_Timbrada.xml`;

function guardarXml(d, xmlString) {
  fs.mkdirSync(RUTA_XML, { recursive: true });
  const destino = path.join(RUTA_XML, nombreXml(d));
  if (!fs.existsSync(destino)) { fs.writeFileSync(destino, xmlString, 'utf8'); return nombreXml(d); }
  return null;
}

// ── Importa UN xml. Nunca lanza: devuelve { estado, ... } ────────────────────
// estado: importada | existente | completada | omitida | error
async function importarXml(pool, archivo, xmlString, opts = {}) {
  const res = { archivo, estado: 'error' };
  let d;
  try {
    d = parsearFacturaXml(xmlString);
  } catch (err) { res.motivo = err.message; return res; }

  if (d.tipo !== 'I') { res.estado = 'omitida'; res.motivo = `omitido: tipo ${d.tipo || '(sin tipo)'}`; return res; }
  res.factura = `${d.serie ? d.serie + '-' : ''}${d.folio}`;
  res.advertencias = d.advertencias.slice();

  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    const rq = () => new sql.Request(tx).input('id', sql.Decimal(9), d.folio).input('serieFac', sql.VarChar(20), d.serie);

    const ex = await rq().query(`SELECT UUID FROM Empresa2.Factura WITH (UPDLOCK, HOLDLOCK) WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);
    if (ex.recordset[0]) {
      if (opts.completarUuid && !fmt(ex.recordset[0].UUID)) {
        await rq().input('uuid', sql.VarChar(149), d.uuid).input('ft', sql.VarChar(20), cortar(d.fechaTimbrado, 20)).input('rfcp', sql.VarChar(20), cortar(d.rfcProvCertif, 20))
          .query(`UPDATE Empresa2.Factura SET UUID=@uuid, FechaTimbrado=@ft, RfcProvCertif=@rfcp WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ} AND ISNULL(LTRIM(RTRIM(UUID)),'')=''`);
        await tx.commit();
        res.estado = 'completada'; res.motivo = 'ya existía sin UUID; se completaron UUID/FechaTimbrado/RfcProvCertif';
        guardarXml(d, xmlString);
        return res;
      }
      await tx.rollback();
      res.estado = 'existente'; res.motivo = 'ya existe';
      return res;
    }

    const dupUuid = await new sql.Request(tx).input('uuid', sql.VarChar(149), d.uuid)
      .query(`SELECT TOP 1 Id_NoFactura, LTRIM(RTRIM(SerieFac)) SerieFac FROM Empresa2.Factura WHERE LTRIM(RTRIM(UUID)) = @uuid`);
    if (dupUuid.recordset[0]) {
      await tx.rollback();
      const o = dupUuid.recordset[0];
      res.estado = 'existente'; res.motivo = `ya existe: el UUID está en la factura ${o.SerieFac ? o.SerieFac + '-' : ''}${o.Id_NoFactura}`;
      return res;
    }

    const cli = await buscarCliente(tx, d);
    if (!cli.id) res.clienteNoEncontrado = cli.motivo;

    await rq()
      .input('fecha', sql.VarChar(10), d.fecha).input('hora', sql.VarChar(8), d.hora)
      .input('idCli', sql.Decimal(7), cli.id)
      .input('nombreCom', sql.VarChar(150), cortar(d.nombre, 150)).input('rfc', sql.VarChar(15), cortar(d.rfc, 15))
      .input('mon', sql.VarChar(15), cortar(d.moneda, 15)).input('tc', sql.Decimal(9, 2), d.tipoCambio)
      .input('sub', sql.Decimal(11, 2), d.subTotal).input('iva', sql.Decimal(11, 2), d.iva)
      .input('ret', sql.Decimal(11, 2), d.retencion).input('tot', sql.Decimal(11, 2), d.total)
      .input('letras', sql.VarChar(150), importeALetras(d.total, d.moneda))
      .input('cformapago', sql.VarChar(4), cortar(d.formaPago, 4) || null).input('clavemp', sql.VarChar(3), cortar(d.metodoPago, 3))
      .input('cusocfdi', sql.VarChar(5), cortar(d.usoCfdi, 5) || null).input('lugarexp', sql.VarChar(60), cortar(d.lugarExpedicion, 60) || null)
      .input('cexport', sql.VarChar(2), cortar(d.exportacion, 2) || null).input('nocert', sql.VarChar(30), cortar(d.noCertificado, 30) || null)
      .input('uuid', sql.VarChar(149), d.uuid).input('ft', sql.VarChar(20), cortar(d.fechaTimbrado, 20) || null)
      .input('rfcp', sql.VarChar(20), cortar(d.rfcProvCertif, 20) || null)
      .input('idccp', sql.VarChar(36), cortar(d.idCCP, 36) || null).input('incluircp', sql.Int, d.idCCP ? 1 : 0)
      .query(`INSERT INTO Empresa2.Factura(
          Id_NoFactura,SerieFac,FechaFactura,Hora,Id_Cliente,NombreCom,RFC,MonFactura,TipoCambio,Status,
          SubTotal,IVA,Retencion,TOTAL,ImporteLetras,c_FormaPago,ClaveMP,c_UsoCFDI,LugarExpedicion,TipoCFDI,c_Exportacion,noCertificado,
          UUID,FechaTimbrado,RfcProvCertif,IdCCP,IncluirCP,FlagResFac,PagosReal,NotasCredito
        ) VALUES(
          @id,@serieFac,@fecha,@hora,@idCli,@nombreCom,@rfc,@mon,@tc,'EMITIDA',
          @sub,@iva,@ret,@tot,@letras,@cformapago,@clavemp,@cusocfdi,@lugarexp,'CFDI40',@cexport,@nocert,
          @uuid,@ft,@rfcp,@idccp,@incluircp,0,0,0
        )`);

    for (const c of d.conceptos) {
      if (c.descripcion.length > 80) res.advertencias.push(`Concepto ${c.id}: la descripción (${c.descripcion.length} car.) se recortó a 80 en DesFlete.`);
      await rq().input('idd', sql.Decimal(3), c.id).input('idCli', sql.Decimal(7), cli.id)
        .input('desc', sql.VarChar(150), cortar(c.descripcion, 150)).input('descf', sql.VarChar(80), cortar(c.descripcion, 80))
        .input('cant', sql.Decimal(9, 2), c.cantidad).input('sub', sql.Decimal(11, 2), c.subtotal)
        .input('iva', sql.Decimal(11, 2), c.iva).input('ret', sql.Decimal(11, 2), c.reten).input('tot', sql.Decimal(11, 2), c.total)
        .input('cprod', sql.VarChar(20), cortar(c.claveProdServ, 20)).input('cuni', sql.VarChar(5), cortar(c.claveUnidad, 5))
        .query(`INSERT INTO Empresa2.FacDeta(
            ID_NOFACTURA,ID_NODETAFAC,SerieFac,ID_CLIENTE,SERIE,CARTAPORTE,NOTACARGO,DESCOMOTRO,DESFLETE,CANTIDAD,
            SUBTOTAL,IVA,RETEN,TOTAL,C_CLAVEPRODSERV,C_CLAVEUNIDAD,FLAGIVA,FLAGRETMAN
          ) VALUES(
            @id,@idd,@serieFac,@idCli,'','','Otro',@desc,@descf,@cant,
            @sub,@iva,@ret,@tot,@cprod,@cuni,0,0
          )`);
    }

    // Todo en BD: recién entonces el XML al almacenamiento. Si el disco falla, rollback.
    try { guardarXml(d, xmlString); }
    catch (err) { throw new Error(`No se pudo guardar el XML en ${RUTA_XML}: ${err.message}`); }

    await tx.commit();
    res.estado = 'importada'; res.conceptos = d.conceptos.length;
    return res;
  } catch (err) {
    try { await tx.rollback(); } catch (_) { /* ya cerrada */ }
    res.estado = 'error'; res.motivo = err.message;
    return res;
  }
}

// ── Lote (carpeta) con progreso ──────────────────────────────────────────────
function listarXml(carpeta) {
  return fs.readdirSync(carpeta, { withFileTypes: true })
    .filter(e => e.isFile() && /\.xml$/i.test(e.name)).map(e => e.name).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
}

function resumenVacio(total) {
  return { total, procesados: 0, importadas: 0, existentes: 0, completadas: 0, omitidas: 0, errores: 0, clientesNoEncontrados: 0, detalle: [], terminado: false };
}
function acumular(resumen, r) {
  resumen.procesados++;
  ({ importada: () => resumen.importadas++, existente: () => resumen.existentes++, completada: () => resumen.completadas++,
     omitida: () => resumen.omitidas++, error: () => resumen.errores++ })[r.estado]();
  if (r.clienteNoEncontrado) resumen.clientesNoEncontrados++;
  resumen.detalle.push(r);
}

async function importarLote(pool, carpeta, archivos, opts, resumen) {
  for (const nombre of archivos) {
    let r;
    try { r = await importarXml(pool, nombre, fs.readFileSync(path.join(carpeta, nombre), 'utf8').replace(/^﻿/, ''), opts); }
    catch (err) { r = { archivo: nombre, estado: 'error', motivo: err.message }; }
    acumular(resumen, r);
  }
  resumen.terminado = true;
  return resumen;
}

// Nombre con el que debe quedar un XML de factura timbrada: FAC_{Serie}{Folio}_Timbrada.xml,
// tomando Serie y Folio del propio comprobante. null si no se pueden leer (el
// llamador usa entonces el nombre derivado del archivo).
function nombreDestinoDesdeXml(xmlString) {
  try {
    const doc = new DOMParser({ onError: () => {} }).parseFromString(xmlString, 'text/xml');
    const comp = doc.documentElement;
    if (!comp || (comp.localName || comp.nodeName.split(':').pop()) !== 'Comprobante') return null;
    const folio = attr(comp, 'Folio');
    if (!/^\d+$/.test(folio)) return null;
    return `FAC_${attr(comp, 'Serie')}${folio}_Timbrada.xml`;
  } catch (_) { return null; }
}

// ── Revisión de nombres de XML ───────────────────────────────────────────────
// Facturas con serie cuyo XML se copió sin la serie (FAC_122428_... en vez de
// FAC_F122428_...). El archivo solo se considera suyo si el UUID del XML coincide
// con el de la factura: un FAC_71794 puede ser de otra factura sin serie.
const SUFIJOS_XML = ['_Timbrada.xml', '_Prueba.xml'];

async function revisarNombresXml(pool) {
  const facs = (await pool.request().query(
    `SELECT LTRIM(RTRIM(SerieFac)) serie, Id_NoFactura id, LTRIM(RTRIM(UUID)) uuid FROM Empresa2.Factura
     WHERE LTRIM(RTRIM(ISNULL(SerieFac,''))) <> '' AND LTRIM(RTRIM(ISNULL(UUID,''))) <> '' ORDER BY SerieFac, Id_NoFactura`)).recordset;
  const archivos = new Set(fs.existsSync(RUTA_XML) ? fs.readdirSync(RUTA_XML) : []);
  const plan = { revisadas: facs.length, correctos: 0, porRenombrar: [], otraFactura: [], sinArchivo: [] };

  for (const f of facs) {
    const base = `FAC_${f.serie}${f.id}`;
    if (SUFIJOS_XML.some(s => archivos.has(base + s))) { plan.correctos++; continue; }
    const suf = SUFIJOS_XML.find(s => archivos.has(`FAC_${f.id}${s}`));
    const factura = `${f.serie}-${f.id}`;
    if (!suf) { plan.sinArchivo.push({ factura }); continue; }
    const actual = `FAC_${f.id}${suf}`;
    let uuidXml = '';
    try {
      const doc = new DOMParser({ onError: () => {} }).parseFromString(fs.readFileSync(path.join(RUTA_XML, actual), 'utf8'), 'text/xml');
      uuidXml = attr(porLocalName(doc, 'TimbreFiscalDigital'), 'UUID');
    } catch (_) { /* XML ilegible: se trata como de otra factura */ }
    if (uuidXml.toUpperCase() !== f.uuid.toUpperCase()) { plan.otraFactura.push({ factura, actual, motivo: 'el UUID del XML no coincide (es de otra factura)' }); continue; }
    plan.porRenombrar.push({ factura, actual, nuevo: base + suf });
  }
  return plan;
}

// Aplica el plan recalculado al momento: renombra solo lo que sigue siendo válido.
async function renombrarNombresXml(pool) {
  const plan = await revisarNombresXml(pool);
  const renombrados = [], errores = [];
  for (const r of plan.porRenombrar) {
    try {
      const destino = path.join(RUTA_XML, r.nuevo);
      if (fs.existsSync(destino)) throw new Error('ya existe un archivo con el nombre nuevo');
      fs.renameSync(path.join(RUTA_XML, r.actual), destino);
      renombrados.push(r);
    } catch (err) { errores.push({ ...r, motivo: err.message }); }
  }
  return { renombrados, errores };
}

module.exports = { nombreDestinoDesdeXml, revisarNombresXml, renombrarNombresXml, parsearFacturaXml, importarXml, importarLote, listarXml, resumenVacio, acumular, nombreXml };
