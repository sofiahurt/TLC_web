'use strict';

const fs   = require('fs');
const path = require('path');
const express  = require('express');
const router   = express.Router();
const { getPool, sql } = require('../config/db');
const { buildCFDITraslado } = require('../services/cfdi-traslado');
const { buildCFDIFactura } = require('../services/cfdi-factura');
const { buildCFDINotaCredito } = require('../services/cfdi-notacredito');
const { sellarXML, cargarCSD } = require('../services/cfdi-sello');
const { timbrarConPAC, resolverConexionPAC } = require('../services/cfdi-pac');
const { ejecutarCancelacionFiscal } = require('../services/cfdi-cancelacion');
const { descontarTimbre } = require('../services/timbre-consumo');
const { generarPDFBuffer } = require('../services/cfdi-pdf');
const { generarPDFBufferFactura } = require('../services/factura-pdf');
const { generarPDFBufferNotaCredito } = require('../services/notacred-pdf');
const { generarPDFBufferAcuse } = require('../services/cfdi-acuse-pdf');
const { revertirEfectoSaldo } = require('../routes/notacred');
const { recalcularImporteFacCP } = require('../routes/facturas');
const { requierePermiso } = require('../middleware/permisos');
const { RUTA_XML } = require('../config/storage');

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
router.post('/timbrar', requierePermiso('cartaporte.btn_timbrar'), async (req, res) => {
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
router.post('/timbrar-factura', requierePermiso('facturas.btn_timbrar'), async (req, res) => {
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

// ── TIMBRAR NOTA DE CRÉDITO/DÉBITO ────────────────────────────────────────────
// POST /cfdi/timbrar-notacredito { tipo, serie, idNotaCredito }
router.post('/timbrar-notacredito', requierePermiso('notacred.btn_timbrar'), async (req, res) => {
  try {
    const tipo = req.body.tipo === 'ND' ? 'ND' : 'NC';
    const idNotaCredito = parseInt(req.body.idNotaCredito);
    if (!idNotaCredito) return res.status(400).json({ ok: false, error: 'Falta idNotaCredito' });
    const serieKey = (req.body.serie == null ? '' : String(req.body.serie)).trim() || null;
    const NC_EQ = `LTRIM(RTRIM(Tipo))=@tipo AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`;

    const pool = await getPool();

    // 0. UUID ya existente (307) + Status (no se timbra una nota cancelada)
    const prevRes = await pool.request()
      .input('tipo', sql.VarChar(3), tipo).input('serie', sql.VarChar(10), serieKey).input('id', sql.Decimal(7), idNotaCredito)
      .query(`SELECT UUID, Status FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
    if (!prevRes.recordset[0]) return res.status(404).json({ ok: false, error: 'Nota no encontrada' });
    const uuidExistente = (prevRes.recordset[0].UUID || '').trim();
    if (uuidExistente) return res.status(400).json({ ok: false, error: 'Esta nota ya está timbrada.' });
    if ((prevRes.recordset[0].Status || '').trim().toUpperCase() === 'CANCELADO') {
      return res.status(400).json({ ok: false, error: 'Esta nota está cancelada, no puede timbrarse.' });
    }

    // 1. Resolver a qué PAC conectarse — igual que Factura, usa el central de la sesión activa.
    const central = (req.session.central || '').trim();
    const conexion = await resolverConexionPAC(pool, central);

    // 2. Armar XML
    const { xml } = await buildCFDINotaCredito(tipo, serieKey, idNotaCredito, central, pool);

    // 3. Sellar con CSD y guardar en disco
    const nombreBase = `NC_${tipo}${serieKey || 'SF'}${idNotaCredito}`;
    const { xml: xmlSellado, noCertificado } = await sellarXML(xml, central, nombreBase, pool);
    await pool.request()
      .input('tipo', sql.VarChar(3), tipo).input('serie', sql.VarChar(10), serieKey).input('id', sql.Decimal(7), idNotaCredito)
      .input('noCert', sql.VarChar(30), noCertificado || null)
      .query(`UPDATE Empresa2.NotaCred SET noCertificado=@noCert WHERE Id_NotaCredito=@id AND ${NC_EQ}`);

    // 4. Enviar al PAC y timbrar
    const pacResult = await timbrarConPAC(xmlSellado, conexion);
    if (!pacResult.exito) {
      return res.json({ ok: false, error: pacResult.mensajeError || 'El PAC rechazó el timbrado' });
    }

    // Reenvío (307) — mismo manejo que Carta Porte/Factura.
    if (pacResult.reenvio && uuidExistente) {
      return res.json({ ok: true, mensaje: `Esta nota ya estaba timbrada. UUID: ${uuidExistente}`, pacResult: { ...pacResult, uuid: uuidExistente } });
    }

    // 5. Persistir UUID/FechaTimbrado/RfcProvCertif. Status se queda tal cual
    // (EMITIDA) — igual que Factura, no representa "timbrada" (eso es UUID IS NOT NULL).
    await pool.request()
      .input('tipo', sql.VarChar(3), tipo).input('serie', sql.VarChar(10), serieKey).input('id', sql.Decimal(7), idNotaCredito)
      .input('uuid', sql.VarChar(40), pacResult.uuid).input('fecha', sql.VarChar(30), pacResult.fechaTimbrado || null)
      .input('rfcProv', sql.VarChar(20), pacResult.rfcProvCertif || null)
      .query(`UPDATE Empresa2.NotaCred SET UUID=@uuid, FechaTimbrado=@fecha, RfcProvCertif=@rfcProv WHERE Id_NotaCredito=@id AND ${NC_EQ}`);

    // 6. Guardar el XML timbrado final.
    const sufijoArchivo = conexion.testFel ? 'Prueba' : 'Timbrada';
    fs.mkdirSync(RUTA_XML, { recursive: true });
    fs.writeFileSync(path.join(RUTA_XML, `${nombreBase}_${sufijoArchivo}.xml`), pacResult.xmlTimbrado, 'utf8');
    const rutaSellado = path.join(RUTA_XML, `${nombreBase}_sellado.xml`);
    if (fs.existsSync(rutaSellado)) fs.unlinkSync(rutaSellado);

    // 7. Descuento/bitácora de timbres — solo fuera de modo prueba.
    if (!conexion.testFel) {
      await descontarTimbre(pool, { tipo: tipo === 'NC' ? 'NotaCredito' : 'NotaDebito', serie: serieKey, idFacVen: String(idNotaCredito), uuid: pacResult.uuid });
    }

    res.json({
      ok: true,
      mensaje: `Nota timbrada correctamente${conexion.testFel ? ' (modo prueba)' : ''}. UUID: ${pacResult.uuid}`,
      testFel: conexion.testFel,
      pacResult,
    });
  } catch (err) {
    console.error('CFDI timbrar-notacredito error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── CANCELAR NOTA (fiscal, ante el PAC) ──────────────────────────────────────
// POST /cfdi/cancelar-notacredito { tipo, serie, idNotaCredito, motivo, folioSustitucion }
router.post('/cancelar-notacredito', requierePermiso('notacred.btn_cancelar'), async (req, res) => {
  try {
    const tipo = req.body.tipo === 'ND' ? 'ND' : 'NC';
    const idNotaCredito = parseInt(req.body.idNotaCredito);
    if (!idNotaCredito) return res.status(400).json({ ok: false, error: 'Falta idNotaCredito' });
    const serieKey = (req.body.serie == null ? '' : String(req.body.serie)).trim() || null;
    const motivo = (req.body.motivo || '02').trim();
    const folioSustitucion = (req.body.folioSustitucion || '').trim();
    if (motivo === '01' && !folioSustitucion) {
      return res.status(400).json({ ok: false, error: 'El motivo 01 requiere el UUID que sustituye.' });
    }
    const NC_EQ = `LTRIM(RTRIM(Tipo))=@tipo AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`;

    const pool = await getPool();
    const cabRes = await pool.request()
      .input('tipo', sql.VarChar(3), tipo).input('serie', sql.VarChar(10), serieKey).input('id', sql.Decimal(7), idNotaCredito)
      .query(`SELECT * FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
    const nc = cabRes.recordset[0];
    if (!nc) return res.status(404).json({ ok: false, error: 'Nota no encontrada' });
    const uuid = (nc.UUID || '').trim();
    if (!uuid) return res.status(400).json({ ok: false, error: 'Esta nota no está timbrada; use la cancelación normal (sin PAC).' });
    if ((nc.Status || '').trim().toUpperCase() === 'CANCELADO') return res.status(400).json({ ok: false, error: 'Ya está cancelada.' });

    const central = (req.session.central || '').trim();

    // El receptor de la nota es el emisor de la propia Empresa/CSD -- necesitamos
    // el RFC del cliente (receptor real del CFDI), no el de la Empresa.
    const cliRes = await pool.request().input('id', sql.Decimal(18, 0), nc.Id_Cliente).query(`SELECT RFC FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
    const rfcReceptor = (cliRes.recordset[0]?.RFC || '').trim();
    const { emp } = await cargarCSD(central, pool);

    const cancelacion = await ejecutarCancelacionFiscal(pool, central, {
      uuid, rfcEmisor: (emp.RFC || '').trim(), rfcReceptor, total: Number(nc.ImporteTotal || 0).toFixed(2), motivo, folioSustitucion,
    });
    if (cancelacion.resultado !== 'exito') {
      return res.json({ ok: false, pendiente: cancelacion.resultado === 'pendiente', error: cancelacion.mensaje });
    }

    // Solo si el PAC confirma la cancelación se revierte el efecto de saldo y
    // se marca la nota como cancelada -- en una sola transacción.
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await revertirEfectoSaldo(tx, tipo, serieKey, idNotaCredito);
      await new sql.Request(tx)
        .input('tipo', sql.VarChar(3), tipo).input('serie', sql.VarChar(10), serieKey).input('id', sql.Decimal(7), idNotaCredito)
        .query(`UPDATE Empresa2.NotaCred SET Status='CANCELADO' WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (_) { /* ya cerrada */ }
      throw err;
    }

    // Acuse de cancelación (XML firmado por el SAT) -- se guarda en disco
    // como evidencia fiscal, mismo criterio que el XML timbrado.
    if (cancelacion.acuseXml) {
      const nombreBase = `NC_${tipo}${serieKey || 'SF'}${idNotaCredito}`;
      fs.mkdirSync(RUTA_XML, { recursive: true });
      fs.writeFileSync(path.join(RUTA_XML, `${nombreBase}_Acuse.xml`), cancelacion.acuseXml, 'utf8');
    }

    res.json({ ok: true, mensaje: 'Nota cancelada correctamente ante el SAT.', pacResult: cancelacion.pacResult });
  } catch (err) {
    console.error('CFDI cancelar-notacredito error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── CANCELAR CARTA PORTE ──────────────────────────────────────────────────────
// POST /cfdi/cancelar-cartaporte { serie, cartaporte, motivo?, folioSustitucion?, nota? }
// Sin folio fiscal (UUID): cancelación interna directa, sin llamar al PAC.
// Con folio fiscal: exige motivo, cancela ante el PAC primero y solo si eso
// tiene éxito aplica los efectos en BD -- nunca queda "a medias".
router.post('/cancelar-cartaporte', requierePermiso('cartaporte.btn_cancelar'), async (req, res) => {
  try {
    const serie      = (req.body.serie || '').trim();
    const cartaporte = (req.body.cartaporte || '').trim();
    if (!serie || !cartaporte) return res.status(400).json({ ok: false, error: 'Faltan parámetros: serie y cartaporte' });
    const motivo = (req.body.motivo || '').trim();
    const folioSustitucion = (req.body.folioSustitucion || '').trim();
    const nota = (req.body.nota || '').trim();

    const pool = await getPool();
    const cpRes = await pool.request()
      .input('serie', sql.VarChar(3), serie).input('cp', sql.VarChar(30), cartaporte)
      .query(`SELECT * FROM Empresa2.CartaPorte WHERE Serie=@serie AND CartaPorte=@cp`);
    const cp = cpRes.recordset[0];
    if (!cp) return res.status(404).json({ ok: false, error: 'Carta Porte no encontrada' });

    const status = (cp.Status || '').trim().toUpperCase();
    if (status === 'FACTURADO') return res.status(400).json({ ok: false, error: 'El pedido ya fue facturado y no se puede cancelar.' });
    // 'CANCELAD0' (cero) es un typo real del sistema legado presente en datos
    // reales -- se sigue detectando en la lectura, pero esta ruta SIEMPRE
    // escribe 'CANCELADO' correcto, nunca repite el error.
    if (status === 'CANCELADO' || status === 'CANCELAD0') return res.status(400).json({ ok: false, error: 'El pedido ya fue cancelado.' });

    const uuid = (cp.UUID || '').trim();
    const quien = [req.session.usuario.nombre, req.session.usuario.apellido].filter(Boolean).join(' ');
    let acuseXml = null;

    if (uuid) {
      if (!motivo) return res.status(400).json({ ok: false, error: 'Debe indicar el motivo de cancelación.' });
      if (motivo === '01' && !folioSustitucion) return res.status(400).json({ ok: false, error: 'El motivo 01 requiere el UUID que sustituye.' });

      const central = (req.session.central || '').trim();
      const { emp } = await cargarCSD(central, pool);
      const cliRes = await pool.request().input('id', sql.Decimal(18, 0), cp.Id_Cliente).query(`SELECT RFC FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
      const rfcReceptor = (cliRes.recordset[0]?.RFC || '').trim();

      const cancelacion = await ejecutarCancelacionFiscal(pool, central, {
        uuid, rfcEmisor: (emp.RFC || '').trim(), rfcReceptor,
        // El comprobante "T" (Traslado) siempre declara Total="0" fiscal,
        // independientemente del importe operativo (TOTALMX) -- mismo
        // criterio ya usado para el QR de Carta Porte.
        total: '0.00',
        motivo, folioSustitucion,
      });
      if (cancelacion.resultado !== 'exito') {
        return res.json({ ok: false, pendiente: cancelacion.resultado === 'pendiente', error: cancelacion.mensaje });
      }
      acuseXml = cancelacion.acuseXml;
    }

    await pool.request()
      .input('serie', sql.VarChar(3), serie).input('cp', sql.VarChar(30), cartaporte)
      .input('motivo', sql.VarChar(3), motivo || null).input('folioSust', sql.VarChar(52), folioSustitucion || null)
      .input('nota', sql.VarChar(250), nota || null).input('quien', sql.VarChar(80), quien)
      .query(`UPDATE Empresa2.CartaPorte SET
        Status='CANCELADO', SubTotalMX=0, IVAMX=0, RetenMX=0, TOTALMX=0,
        FechaCancela=GETDATE(), WhoCancela=@quien, c_MotCancela=@motivo, UUIDRelCan=@folioSust, NotaCancelacion=@nota
        WHERE Serie=@serie AND CartaPorte=@cp`);

    if (acuseXml) {
      fs.mkdirSync(RUTA_XML, { recursive: true });
      fs.writeFileSync(path.join(RUTA_XML, `CP_${cartaporte}_Acuse.xml`), acuseXml, 'utf8');
    }

    res.json({ ok: true, mensaje: uuid ? 'Carta Porte cancelada correctamente ante el SAT.' : 'Carta Porte cancelada.' });
  } catch (err) {
    console.error('CFDI cancelar-cartaporte error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── CANCELAR FACTURA ──────────────────────────────────────────────────────────
// POST /cfdi/cancelar-factura { idNoFactura, serieFac, motivo?, folioSustitucion?, nota? }
// Mismo esqueleto que cancelar-cartaporte; efecto extra confirmado con el
// usuario: libera cada Carta Porte aplicada de vuelta a EMITIDO.
router.post('/cancelar-factura', requierePermiso('facturas.btn_cancelar'), async (req, res) => {
  try {
    const idNoFactura = parseInt(req.body.idNoFactura);
    if (!idNoFactura) return res.status(400).json({ ok: false, error: 'Falta idNoFactura' });
    const serieFacKey = (req.body.serieFac == null ? '' : String(req.body.serieFac)).trim() || null;
    const SERIEFAC_EQ = `ISNULL(LTRIM(RTRIM(SerieFac)),'') = ISNULL(@serieFac,'')`;
    const motivo = (req.body.motivo || '').trim();
    const folioSustitucion = (req.body.folioSustitucion || '').trim();
    const nota = (req.body.nota || '').trim();

    const pool = await getPool();
    const facRes = await pool.request()
      .input('id', sql.Decimal(9), idNoFactura).input('serieFac', sql.VarChar(20), serieFacKey)
      .query(`SELECT * FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);
    const fac = facRes.recordset[0];
    if (!fac) return res.status(404).json({ ok: false, error: 'Factura no encontrada' });

    const status = (fac.Status || '').trim().toUpperCase();
    if (status === 'PAGADA') return res.status(400).json({ ok: false, error: 'La factura ya está pagada y no se puede cancelar.' });
    if (status === 'CANCELADA') return res.status(400).json({ ok: false, error: 'La factura ya fue cancelada.' });

    const uuid = (fac.UUID || '').trim();
    const quien = [req.session.usuario.nombre, req.session.usuario.apellido].filter(Boolean).join(' ');
    let acuseXml = null;

    if (uuid) {
      if (!motivo) return res.status(400).json({ ok: false, error: 'Debe indicar el motivo de cancelación.' });
      if (motivo === '01' && !folioSustitucion) return res.status(400).json({ ok: false, error: 'El motivo 01 requiere el UUID que sustituye.' });

      const central = (req.session.central || '').trim();
      const { emp } = await cargarCSD(central, pool);
      const cliRes = await pool.request().input('id', sql.Decimal(18, 0), fac.Id_Cliente).query(`SELECT RFC FROM Empresa2.Clientes WHERE ID_CLIENTE=@id`);
      const rfcReceptor = (cliRes.recordset[0]?.RFC || '').trim();

      const cancelacion = await ejecutarCancelacionFiscal(pool, central, {
        uuid, rfcEmisor: (emp.RFC || '').trim(), rfcReceptor, total: Number(fac.TOTAL || 0).toFixed(2), motivo, folioSustitucion,
      });
      if (cancelacion.resultado !== 'exito') {
        return res.json({ ok: false, pendiente: cancelacion.resultado === 'pendiente', error: cancelacion.mensaje });
      }
      acuseXml = cancelacion.acuseXml;
    }

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx)
        .input('id', sql.Decimal(9), idNoFactura).input('serieFac', sql.VarChar(20), serieFacKey)
        .input('motivo', sql.VarChar(3), motivo || null).input('folioSust', sql.VarChar(52), folioSustitucion || null)
        .input('nota', sql.VarChar(150), nota || null).input('quien', sql.VarChar(80), quien)
        .query(`UPDATE Empresa2.Factura SET
          Status='CANCELADA', SubTotal=0, IVA=0, Retencion=0, TOTAL=0,
          FechaCancela=GETDATE(), WhoCancela=@quien, c_MotCancela=@motivo, UUIDRelCan=@folioSust, NotaCancelacion=@nota
          WHERE Id_NoFactura=@id AND ${SERIEFAC_EQ}`);

      // Libera cada Carta Porte aplicada -- recalcularImporteFacCP detecta
      // "0 líneas no-canceladas" en cuanto la Factura queda CANCELADA (misma
      // tx) y regresa la CP a EMITIDO, sin reescribir esa lógica.
      const lineasRes = await new sql.Request(tx)
        .input('id', sql.Decimal(9), idNoFactura).input('serieFac', sql.VarChar(20), serieFacKey)
        .query(`SELECT DISTINCT LTRIM(RTRIM(SERIE)) SERIE, LTRIM(RTRIM(CARTAPORTE)) CARTAPORTE
                FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'')`);
      for (const linea of lineasRes.recordset) {
        if (linea.SERIE && linea.CARTAPORTE) await recalcularImporteFacCP(tx, linea.SERIE, linea.CARTAPORTE);
      }
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (_) { /* ya cerrada */ }
      throw err;
    }

    if (acuseXml) {
      const nombreBase = `FAC_${serieFacKey || 'SF'}${idNoFactura}`;
      fs.mkdirSync(RUTA_XML, { recursive: true });
      fs.writeFileSync(path.join(RUTA_XML, `${nombreBase}_Acuse.xml`), acuseXml, 'utf8');
    }

    res.json({ ok: true, mensaje: uuid ? 'Factura cancelada correctamente ante el SAT.' : 'Factura cancelada.' });
  } catch (err) {
    console.error('CFDI cancelar-factura error:', err);
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

// ── PDF de Factura ───────────────────────────────────────────────────────────
// GET /cfdi/pdf-factura?idNoFactura=&serieFac= — disponible con o sin timbre.
router.get('/pdf-factura', async (req, res) => {
  try {
    const idNoFactura = parseInt(req.query.idNoFactura);
    if (!idNoFactura) return res.status(400).send('Falta el parámetro idNoFactura');
    const serieFac = req.query.serieFac || '';

    const pool = await getPool();
    const buffer = await generarPDFBufferFactura(idNoFactura, serieFac, pool);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="FAC_${idNoFactura}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('CFDI pdf-factura error:', err);
    res.status(500).send(`Error al generar el PDF: ${err.message}`);
  }
});

// ── PDF de Nota de Crédito/Débito ─────────────────────────────────────────────
// GET /cfdi/pdf-notacredito?tipo=&serie=&idNotaCredito= — disponible con o sin timbre.
router.get('/pdf-notacredito', async (req, res) => {
  try {
    const tipo = req.query.tipo === 'ND' ? 'ND' : 'NC';
    const idNotaCredito = parseInt(req.query.idNotaCredito);
    if (!idNotaCredito) return res.status(400).send('Falta el parámetro idNotaCredito');
    const serie = req.query.serie || '';
    const central = (req.session.central || '').trim();

    const pool = await getPool();
    const buffer = await generarPDFBufferNotaCredito(tipo, serie, idNotaCredito, central, pool);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="NC_${tipo}${idNotaCredito}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('CFDI pdf-notacredito error:', err);
    res.status(500).send(`Error al generar el PDF: ${err.message}`);
  }
});

// ── ACUSE DE CANCELACIÓN (PDF) ──────────────────────────────────────────────
// Solo disponible cuando el documento está cancelado CON folio fiscal (hubo
// llamada real al PAC/SAT) -- una cancelación interna sin UUID no tiene
// acuse porque nunca se llamó al PAC.

// GET /cfdi/acuse-cartaporte?serie=&cartaporte=
router.get('/acuse-cartaporte', async (req, res) => {
  try {
    const serie = (req.query.serie || '').trim();
    const cartaporte = (req.query.cartaporte || '').trim();
    if (!serie || !cartaporte) return res.status(400).send('Faltan parámetros');
    const pool = await getPool();
    const buffer = await generarPDFBufferAcuse('cartaporte', { serie, cartaporte }, pool);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="CP_${cartaporte}_Acuse.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('CFDI acuse-cartaporte error:', err);
    res.status(400).send(`No se pudo generar el acuse: ${err.message}`);
  }
});

// GET /cfdi/acuse-factura?idNoFactura=&serieFac=
router.get('/acuse-factura', async (req, res) => {
  try {
    const idNoFactura = parseInt(req.query.idNoFactura);
    if (!idNoFactura) return res.status(400).send('Falta el parámetro idNoFactura');
    const serieFac = req.query.serieFac || '';
    const pool = await getPool();
    const buffer = await generarPDFBufferAcuse('factura', { idNoFactura, serieFac }, pool);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="FAC_${idNoFactura}_Acuse.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('CFDI acuse-factura error:', err);
    res.status(400).send(`No se pudo generar el acuse: ${err.message}`);
  }
});

// GET /cfdi/acuse-notacredito?tipo=&serie=&idNotaCredito=
router.get('/acuse-notacredito', async (req, res) => {
  try {
    const tipo = req.query.tipo === 'ND' ? 'ND' : 'NC';
    const idNotaCredito = parseInt(req.query.idNotaCredito);
    if (!idNotaCredito) return res.status(400).send('Falta el parámetro idNotaCredito');
    const serie = req.query.serie || '';
    const central = (req.session.central || '').trim();
    const pool = await getPool();
    const buffer = await generarPDFBufferAcuse('notacredito', { tipo, serie, idNotaCredito, central }, pool);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="NC_${tipo}${idNotaCredito}_Acuse.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('CFDI acuse-notacredito error:', err);
    res.status(400).send(`No se pudo generar el acuse: ${err.message}`);
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

// GET /cfdi/xml-factura?idNoFactura=&serieFac= — solo disponible una vez timbrada.
router.get('/xml-factura', async (req, res) => {
  try {
    const idNoFactura = parseInt(req.query.idNoFactura);
    if (!idNoFactura) return res.status(400).json({ error: 'Falta el parámetro idNoFactura' });
    const serieFacKey = (req.query.serieFac || '').trim() || null;

    const pool = await getPool();
    const facRes = await pool.request()
      .input('id', sql.Decimal(9), idNoFactura)
      .input('serieFac', sql.VarChar(20), serieFacKey)
      .query(`SELECT UUID FROM Empresa2.Factura
              WHERE Id_NoFactura=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'') = ISNULL(@serieFac,'')`);
    const fac = facRes.recordset[0];
    if (!fac) return res.status(404).json({ error: 'Factura no encontrada' });
    if (!(fac.UUID || '').trim()) return res.status(400).json({ error: 'Esta Factura todavía no está timbrada' });

    const nombreBase = `FAC_${serieFacKey || 'SF'}${idNoFactura}`;
    const rutaTimbrada = path.join(RUTA_XML, `${nombreBase}_Timbrada.xml`);
    const rutaPrueba   = path.join(RUTA_XML, `${nombreBase}_Prueba.xml`);
    const ruta = fs.existsSync(rutaTimbrada) ? rutaTimbrada : (fs.existsSync(rutaPrueba) ? rutaPrueba : null);
    if (!ruta) return res.status(404).json({ error: `No se encontró el archivo XML en ${RUTA_XML}` });

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(ruta)}"`);
    res.send(fs.readFileSync(ruta, 'utf8'));
  } catch (err) {
    console.error('CFDI xml-factura error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /cfdi/xml-notacredito?tipo=&serie=&idNotaCredito= — solo disponible una vez timbrada.
router.get('/xml-notacredito', async (req, res) => {
  try {
    const tipo = req.query.tipo === 'ND' ? 'ND' : 'NC';
    const idNotaCredito = parseInt(req.query.idNotaCredito);
    if (!idNotaCredito) return res.status(400).json({ error: 'Falta el parámetro idNotaCredito' });
    const serieKey = (req.query.serie || '').trim() || null;
    const NC_EQ = `LTRIM(RTRIM(Tipo))=@tipo AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`;

    const pool = await getPool();
    const ncRes = await pool.request()
      .input('tipo', sql.VarChar(3), tipo).input('serie', sql.VarChar(10), serieKey).input('id', sql.Decimal(7), idNotaCredito)
      .query(`SELECT UUID FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND ${NC_EQ}`);
    const nc = ncRes.recordset[0];
    if (!nc) return res.status(404).json({ error: 'Nota no encontrada' });
    if (!(nc.UUID || '').trim()) return res.status(400).json({ error: 'Esta nota todavía no está timbrada' });

    const nombreBase = `NC_${tipo}${serieKey || 'SF'}${idNotaCredito}`;
    const rutaTimbrada = path.join(RUTA_XML, `${nombreBase}_Timbrada.xml`);
    const rutaPrueba   = path.join(RUTA_XML, `${nombreBase}_Prueba.xml`);
    const ruta = fs.existsSync(rutaTimbrada) ? rutaTimbrada : (fs.existsSync(rutaPrueba) ? rutaPrueba : null);
    if (!ruta) return res.status(404).json({ error: `No se encontró el archivo XML en ${RUTA_XML}` });

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(ruta)}"`);
    res.send(fs.readFileSync(ruta, 'utf8'));
  } catch (err) {
    console.error('CFDI xml-notacredito error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
