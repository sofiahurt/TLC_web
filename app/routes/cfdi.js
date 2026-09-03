'use strict';

const fs   = require('fs');
const path = require('path');
const express  = require('express');
const router   = express.Router();
const { getPool, sql } = require('../config/db');
const { buildCFDITraslado } = require('../services/cfdi-traslado');
const { buildCFDIFactura } = require('../services/cfdi-factura');
const { sellarXML } = require('../services/cfdi-sello');
const { timbrarConPAC } = require('../services/cfdi-pac');
const { descontarTimbre } = require('../services/timbre-consumo');
const { generarPDFBuffer } = require('../services/cfdi-pdf');
const { RUTA_XML } = require('../config/storage');
const { serieFiscal } = require('../config/empresa-serie');

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

// ── PREVIEW (debug) ──────────────────────────────────────────────────────────
// GET /cfdi/preview?serie=CUI&cartaporte=CUI0000517
router.get('/preview', async (req, res) => {
  try {
    const serie      = (req.query.serie || req.session.central || '').trim();
    const cartaporte = (req.query.cartaporte || '').trim();
    if (!serie || !cartaporte) return res.status(400).send('Faltan parámetros: serie y cartaporte');

    const pool = await getPool();
    const { xml } = await buildCFDITraslado(serie, cartaporte, pool);

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    console.error('CFDI preview error:', err);
    res.status(500).send(`Error: ${err.message}`);
  }
});

// ── VALIDAR ──────────────────────────────────────────────────────────────────
// GET /cfdi/validar?serie=X&cartaporte=Y
// Valida completitud de datos antes de armar el XML. Devuelve { ok, errores[] }.
router.get('/validar', async (req, res) => {
  try {
    const serie      = (req.query.serie || '').trim();
    const cartaporte = (req.query.cartaporte || '').trim();
    if (!serie || !cartaporte) return res.json({ ok: false, errores: ['Faltan parámetros'] });

    const pool   = await getPool();
    const errores = [];

    // Registro principal
    const cpRes = await pool.request()
      .input('serie', sql.VarChar(10), serie)
      .input('cp',    sql.VarChar(30), cartaporte)
      .query(`SELECT * FROM Empresa2.CartaPorte
              WHERE LTRIM(RTRIM(Serie)) = @serie AND LTRIM(RTRIM(CartaPorte)) = @cp`);
    if (!cpRes.recordset[0]) return res.json({ ok: false, errores: ['Carta Porte no encontrada'] });
    const cp = cpRes.recordset[0];

    const status = (cp.Status || '').trim().toUpperCase();
    if (status !== 'EMITIDO') {
      return res.json({ ok: false, errores: [`Status inválido para timbrado: ${status || '(vacío)'}`] });
    }

    // 1. Al menos una mercancía
    const mercRes = await pool.request()
      .input('serie', sql.VarChar(10), serie)
      .input('cp',    sql.VarChar(30), cartaporte)
      .query(`SELECT COUNT(*) AS cnt FROM Empresa2.PedMercancias
              WHERE LTRIM(RTRIM(Serie)) = @serie AND LTRIM(RTRIM(CartaPorte)) = @cp`);
    if (!mercRes.recordset[0].cnt) errores.push('No hay mercancías registradas');

    // 2. Domicilio de carga con código postal
    if (cp.Id_DomCarga) {
      const dcRes = await pool.request()
        .input('idCliente',   sql.Decimal(18, 0), cp.Id_ClienteCarga || cp.Id_Cliente)
        .input('idDomicilio', sql.Decimal(18, 0), cp.Id_DomCarga)
        .query(`SELECT CP FROM Empresa2.DomCarDes
                WHERE ID_CLIENTE = @idCliente AND ID_DOMICILIO = @idDomicilio`);
      const dc = dcRes.recordset[0];
      if (!dc || !String(dc.CP || '').trim())
        errores.push('Domicilio de carga sin código postal');
    } else {
      errores.push('No se ha seleccionado domicilio de carga');
    }

    // 3. Domicilio de descarga con código postal
    if (cp.Id_DomDescarga1) {
      const ddRes = await pool.request()
        .input('idCliente',   sql.Decimal(18, 0), cp.Id_Cliente)
        .input('idDomicilio', sql.Decimal(18, 0), cp.Id_DomDescarga1)
        .query(`SELECT CP FROM Empresa2.DomCarDes
                WHERE ID_CLIENTE = @idCliente AND ID_DOMICILIO = @idDomicilio`);
      const dd = ddRes.recordset[0];
      if (!dd || !String(dd.CP || '').trim())
        errores.push('Domicilio de descarga sin código postal');
    } else {
      errores.push('No se ha seleccionado domicilio de descarga');
    }

    // 4. Autotransporte: placa y configuración vehicular
    if (cp.Id_Camion) {
      const camRes = await pool.request()
        .input('id', sql.VarChar(10), String(cp.Id_Camion).trim())
        .query(`SELECT PLACA, CONFIGVEHICULAR FROM Empresa2.Camiones
                WHERE LTRIM(RTRIM(ID_CAMION)) = LTRIM(RTRIM(@id))`);
      const cam = camRes.recordset[0];
      if (!cam) {
        errores.push('Camión no encontrado en catálogo');
      } else {
        if (!String(cam.PLACA || '').trim())         errores.push('Camión sin placa registrada');
        if (!String(cam.CONFIGVEHICULAR || '').trim()) errores.push('Camión sin configuración vehicular (SCT)');
      }
    } else {
      errores.push('No se ha seleccionado camión/autotransporte');
    }

    // 5. Operador/figura: RFC, licencia, nombre
    if (cp.Id_Operador) {
      const opRes = await pool.request()
        .input('id', sql.Int, cp.Id_Operador)
        .query(`SELECT RFC, NOLICENCIA, OPERADOR FROM Empresa2.Operadores
                WHERE Id_Operador = @id`);
      const op = opRes.recordset[0];
      if (!op) {
        errores.push('Operador no encontrado en catálogo');
      } else {
        if (!String(op.RFC      || '').trim()) errores.push('Operador sin RFC registrado');
        if (!String(op.NOLICENCIA || '').trim()) errores.push('Operador sin número de licencia');
        if (!String(op.OPERADOR || '').trim()) errores.push('Operador sin nombre registrado');
      }
    } else {
      errores.push('No se ha seleccionado operador/figura de transporte');
    }

    res.json({ ok: errores.length === 0, errores });
  } catch (err) {
    console.error('CFDI validar error:', err);
    res.status(500).json({ ok: false, errores: [`Error interno: ${err.message}`] });
  }
});

// ── TIMBRAR ──────────────────────────────────────────────────────────────────
// POST /cfdi/timbrar  { serie, cartaporte }
router.post('/timbrar', async (req, res) => {
  try {
    const serie      = (req.body.serie      || '').trim();
    const cartaporte = (req.body.cartaporte || '').trim();
    if (!serie || !cartaporte) return res.status(400).json({ ok: false, error: 'Faltan parámetros' });

    const pool = await getPool();

    // 0. UUID ya existente (para el manejo de reenvío/código 307 más abajo)
    const prevRes = await pool.request()
      .input('serie', sql.VarChar(3),  serie)
      .input('cp',    sql.VarChar(30), cartaporte)
      .query(`SELECT UUID, FechaTimbrado FROM Empresa2.CartaPorte WHERE Serie=@serie AND CartaPorte=@cp`);
    if (!prevRes.recordset[0]) return res.status(404).json({ ok: false, error: 'Carta Porte no encontrada' });
    const uuidExistente = (prevRes.recordset[0].UUID || '').trim();

    // 1. Resolver a qué PAC conectarse (según TESTFEL de la Empresa)
    const conexion = await resolverConexionPAC(pool, serie);

    // 2. Armar XML
    const { xml, idCCP } = await buildCFDITraslado(serie, cartaporte, pool);

    // 3. Sellar con CSD y guardar en disco
    const { xml: xmlSellado, noCertificado: noCertificadoPropio } = await sellarXML(xml, serie, `CP_${cartaporte}`, pool);

    // 4. Enviar al PAC y timbrar
    const pacResult = await timbrarConPAC(xmlSellado, conexion);

    if (!pacResult.exito) {
      return res.json({ ok: false, error: pacResult.mensajeError || 'El PAC rechazó el timbrado' });
    }

    // Reenvío (307): el PAC ya tenía timbrado este comprobante. Si nuestra BD
    // ya tiene UUID guardado para este folio, no lo volvemos a escribir (evita
    // duplicar/sobreescribir); solo informamos el timbre ya existente.
    if (pacResult.reenvio && uuidExistente) {
      return res.json({
        ok:      true,
        mensaje: `Esta Carta Porte ya estaba timbrada. UUID: ${uuidExistente}`,
        pacResult: { ...pacResult, uuid: uuidExistente },
      });
    }

    // 5. Persistir UUID/FechaTimbrado/IdCCP/NoCertificado. El Status SOLO avanza
    //    a TRASLADO fuera de modo prueba — un timbrado de prueba no debe marcar
    //    el pedido como si ya se hubiera trasladado de verdad.
    // NoCertificado = el de NUESTRO propio CSD (Comprobante@NoCertificado, ya
    // regresado por sellarXML) — NO el del PAC (pacResult.noCertificadoSAT es el
    // de la autoridad certificadora del timbre, un dato distinto que no tiene
    // columna propia y se sigue leyendo del XML timbrado cuando se arma el PDF.
    const setStatus = conexion.testFel ? '' : `, Status='TRASLADO'`;
    await pool.request()
      .input('serie',  sql.VarChar(3),  serie)
      .input('cp',     sql.VarChar(30), cartaporte)
      .input('uuid',   sql.VarChar(40), pacResult.uuid)
      .input('fecha',  sql.VarChar(30), pacResult.fechaTimbrado || null)
      .input('idCCP',  sql.VarChar(36), idCCP)
      .input('noCert', sql.VarChar(30), noCertificadoPropio || null)
      .query(`UPDATE Empresa2.CartaPorte
              SET UUID=@uuid, FechaTimbrado=@fecha, IdCCP=@idCCP, NoCertificado=@noCert${setStatus}
              WHERE Serie=@serie AND CartaPorte=@cp`);

    // 6. Guardar el XML timbrado final; el sellado ya no es la versión oficial.
    //    En modo prueba (TESTFEL) el nombre lleva "_Prueba" en vez de "_Timbrada",
    //    usando siempre el folio CartaPorte como identificador del archivo.
    const sufijoArchivo = conexion.testFel ? 'Prueba' : 'Timbrada';
    fs.mkdirSync(RUTA_XML, { recursive: true });
    fs.writeFileSync(path.join(RUTA_XML, `CP_${cartaporte}_${sufijoArchivo}.xml`), pacResult.xmlTimbrado, 'utf8');
    const rutaSellado = path.join(RUTA_XML, `CP_${cartaporte}_sellado.xml`);
    if (fs.existsSync(rutaSellado)) fs.unlinkSync(rutaSellado);

    // 7. Descuento/bitácora de timbres — solo fuera de modo prueba (un timbrado
    //    de prueba no debe consumir crédito real de Empresa2.ParamTimbre).
    if (!conexion.testFel) {
      await descontarTimbre(pool, { tipo: 'Traslado', serie, idFacVen: cartaporte, uuid: pacResult.uuid });
    }

    res.json({
      ok:      true,
      mensaje: `Carta Porte timbrada correctamente${conexion.testFel ? ' (modo prueba)' : ''}. UUID: ${pacResult.uuid}`,
      testFel: conexion.testFel,
      pacResult,
    });
  } catch (err) {
    console.error('CFDI timbrar error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── TIMBRAR FACTURA ────────────────────────────────────────────────────────
// POST /cfdi/timbrar-factura  { idNoFactura, serieFac }
router.post('/timbrar-factura', async (req, res) => {
  try {
    const idNoFactura = parseInt(req.body.idNoFactura);
    if (!idNoFactura) return res.status(400).json({ ok: false, error: 'Falta idNoFactura' });
    const serieFacKey = (req.body.serieFac == null ? '' : String(req.body.serieFac)).trim() || null;
    const SERIEFAC_EQ = `ISNULL(LTRIM(RTRIM(SerieFac)),'') = ISNULL(@serieFac,'')`;

    const pool = await getPool();

    // 0. UUID ya existente (para el manejo de reenvío/código 307 más abajo)
    const prevRes = await pool.request()
      .input('id', sql.Decimal(9), idNoFactura)
      .input('serieFac', sql.VarChar(20), serieFacKey)
      .query(`SELECT UUID, FechaTimbrado FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);
    if (!prevRes.recordset[0]) return res.status(404).json({ ok: false, error: 'Factura no encontrada' });
    const uuidExistente = (prevRes.recordset[0].UUID || '').trim();

    // 1. Resolver a qué PAC conectarse — Factura no guarda su propio central
    // operativo (solo SerieFac, que es otra cosa), así que se usa el central
    // de la sesión activa, igual que hace Carta Porte con el suyo.
    const central = (req.session.central || '').trim();
    const conexion = await resolverConexionPAC(pool, central);

    // 2. Armar XML
    const { xml, idCCP } = await buildCFDIFactura(idNoFactura, serieFacKey, central, pool);

    // 3. Sellar con CSD y guardar en disco
    const nombreBase = `FAC_${serieFacKey || 'SF'}${idNoFactura}`;
    const { xml: xmlSellado, noCertificado } = await sellarXML(xml, central, nombreBase, pool);

    // Punto 3 pedido por el usuario: el NoCertificado del emisor se guarda en
    // cuanto se lee del CSD (dentro de sellarXML), ANTES de siquiera intentar
    // el timbrado — no depende de que el PAC responda.
    await pool.request()
      .input('id', sql.Decimal(9), idNoFactura)
      .input('serieFac', sql.VarChar(20), serieFacKey)
      .input('noCert', sql.VarChar(30), noCertificado || null)
      .query(`UPDATE Empresa2.Factura SET noCertificado=@noCert WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);

    // 4. Enviar al PAC y timbrar
    const pacResult = await timbrarConPAC(xmlSellado, conexion);

    if (!pacResult.exito) {
      return res.json({ ok: false, error: pacResult.mensajeError || 'El PAC rechazó el timbrado' });
    }

    // Reenvío (307): igual manejo que Carta Porte — si ya hay UUID local para
    // este folio, no se vuelve a escribir (evita duplicar/sobreescribir).
    if (pacResult.reenvio && uuidExistente) {
      return res.json({
        ok:      true,
        mensaje: `Esta Factura ya estaba timbrada. UUID: ${uuidExistente}`,
        pacResult: { ...pacResult, uuid: uuidExistente },
      });
    }

    // 5. Persistir UUID/FechaTimbrado/IdCCP/RfcProvCertif. El Status de Factura
    // NO cambia (solo tiene EMITIDA/CANCELADA/PAGADA, ninguno representa
    // "timbrada") — que ya esté timbrada se sabe por UUID IS NOT NULL.
    await pool.request()
      .input('id', sql.Decimal(9), idNoFactura)
      .input('serieFac', sql.VarChar(20), serieFacKey)
      .input('uuid',  sql.VarChar(40), pacResult.uuid)
      .input('fecha', sql.VarChar(30), pacResult.fechaTimbrado || null)
      .input('idCCP', sql.VarChar(36), idCCP)
      .input('rfcProv', sql.VarChar(15), pacResult.rfcProvCertif || null)
      .query(`UPDATE Empresa2.Factura
              SET UUID=@uuid, FechaTimbrado=@fecha, IdCCP=@idCCP, RfcProvCertif=@rfcProv
              WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);

    // 6. Guardar el XML timbrado final; el sellado ya no es la versión oficial.
    const sufijoArchivo = conexion.testFel ? 'Prueba' : 'Timbrada';
    fs.mkdirSync(RUTA_XML, { recursive: true });
    fs.writeFileSync(path.join(RUTA_XML, `${nombreBase}_${sufijoArchivo}.xml`), pacResult.xmlTimbrado, 'utf8');
    const rutaSellado = path.join(RUTA_XML, `${nombreBase}_sellado.xml`);
    if (fs.existsSync(rutaSellado)) fs.unlinkSync(rutaSellado);

    // 7. Descuento/bitácora de timbres — solo fuera de modo prueba.
    if (!conexion.testFel) {
      await descontarTimbre(pool, { tipo: 'Factura', serie: serieFacKey, idFacVen: String(idNoFactura), uuid: pacResult.uuid });
    }

    res.json({
      ok:      true,
      mensaje: `Factura timbrada correctamente${conexion.testFel ? ' (modo prueba)' : ''}. UUID: ${pacResult.uuid}`,
      testFel: conexion.testFel,
      pacResult,
    });
  } catch (err) {
    console.error('CFDI timbrar-factura error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PDF (representación impresa) ────────────────────────────────────────────
// GET /cfdi/pdf?serie=&cartaporte= — disponible con o sin timbre.
router.get('/pdf', async (req, res) => {
  try {
    const serie      = (req.query.serie || '').trim();
    const cartaporte = (req.query.cartaporte || '').trim();
    if (!serie || !cartaporte) return res.status(400).send('Faltan parámetros: serie y cartaporte');

    const pool = await getPool();
    const buffer = await generarPDFBuffer(serie, cartaporte, pool);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="CP_${cartaporte}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('CFDI pdf error:', err);
    res.status(500).send(`Error al generar el PDF: ${err.message}`);
  }
});

// ── XML timbrado ─────────────────────────────────────────────────────────────
// GET /cfdi/xml?serie=&cartaporte= — solo disponible si Status=TRASLADO y hay UUID.
router.get('/xml', async (req, res) => {
  try {
    const serie      = (req.query.serie || '').trim();
    const cartaporte = (req.query.cartaporte || '').trim();
    if (!serie || !cartaporte) return res.status(400).json({ error: 'Faltan parámetros' });

    const pool = await getPool();
    const cpRes = await pool.request()
      .input('serie', sql.VarChar(3), serie)
      .input('cp',    sql.VarChar(30), cartaporte)
      .query(`SELECT Status, UUID FROM Empresa2.CartaPorte WHERE Serie=@serie AND CartaPorte=@cp`);
    const cp = cpRes.recordset[0];
    if (!cp) return res.status(404).json({ error: 'Carta Porte no encontrada' });
    if ((cp.Status || '').trim().toUpperCase() !== 'TRASLADO' || !(cp.UUID || '').trim()) {
      return res.status(400).json({ error: 'Esta Carta Porte todavía no está timbrada' });
    }

    const rutaTimbrada = path.join(RUTA_XML, `CP_${cartaporte}_Timbrada.xml`);
    const rutaPrueba   = path.join(RUTA_XML, `CP_${cartaporte}_Prueba.xml`);
    const ruta = fs.existsSync(rutaTimbrada) ? rutaTimbrada : (fs.existsSync(rutaPrueba) ? rutaPrueba : null);
    if (!ruta) return res.status(404).json({ error: `No se encontró el archivo XML en ${RUTA_XML}` });

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(ruta)}"`);
    res.send(fs.readFileSync(ruta, 'utf8'));
  } catch (err) {
    console.error('CFDI xml error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
