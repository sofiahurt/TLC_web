'use strict';

const express  = require('express');
const router   = express.Router();
const { getPool, sql } = require('../config/db');
const { buildCFDITraslado } = require('../services/cfdi-traslado');
const { sellarXML, enviarAPAC } = require('../services/cfdi-sello');

// ── PREVIEW (debug) ──────────────────────────────────────────────────────────
// GET /cfdi/preview?serie=CUI&cartaporte=CUI0000517
router.get('/preview', async (req, res) => {
  try {
    const serie      = (req.query.serie || req.session.central || '').trim();
    const cartaporte = (req.query.cartaporte || '').trim();
    if (!serie || !cartaporte) return res.status(400).send('Faltan parámetros: serie y cartaporte');

    const pool = await getPool();
    const xml  = await buildCFDITraslado(serie, cartaporte, pool);

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

    // 1. Armar XML
    const xml = await buildCFDITraslado(serie, cartaporte, pool);

    // 2. Sellar con CSD y guardar en disco
    const xmlSellado = await sellarXML(xml, serie, cartaporte, pool);

    // 3. Enviar al PAC (stub — pendiente de integración con Facturalo)
    const pacResult = await enviarAPAC(xmlSellado);

    // Status permanece en EMITIDO hasta que el PAC confirme el UUID
    res.json({
      ok:        true,
      mensaje:   'XML generado y sellado correctamente. Pendiente de envío al PAC.',
      pacResult,
    });
  } catch (err) {
    console.error('CFDI timbrar error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
