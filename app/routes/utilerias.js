const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requierePermiso } = require('../middleware/permisos');
const { RUTA_XML } = require('../config/storage');
const { getPool, sql } = require('../config/db');
const conciliacion = require('../services/conciliacion-saldos');
const importarFacturas = require('../services/importar-facturas-xml');

router.get('/', requierePermiso('utilerias.ver'), (req, res) =>
  res.render('utilerias', { usuario: req.session.usuario, modulo: 'utilerias', rutaXml: RUTA_XML }));

// ── Explorador de carpetas del servidor (para elegir la carpeta origen) ────
// Sin path: lista las unidades de disco existentes (C:\, D:\, E:\...) como raíces.
// Con path: lista solo subcarpetas (no archivos) de esa ruta.
router.get('/fs/list', requierePermiso('utilerias.ver'), (req, res) => {
  const reqPath = (req.query.path || '').trim();
  try {
    if (!reqPath) {
      const raices = [];
      for (let i = 65; i <= 90; i++) {
        const letra = String.fromCharCode(i);
        const raiz = `${letra}:\\`;
        if (fs.existsSync(raiz)) raices.push({ nombre: raiz, ruta: raiz });
      }
      return res.json({ path: '', parent: null, entries: raices });
    }
    const resuelto = path.resolve(reqPath);
    const stat = fs.statSync(resuelto);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'La ruta indicada no es una carpeta.' });

    const entradas = fs.readdirSync(resuelto, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({ nombre: d.name, ruta: path.join(resuelto, d.name) }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    const parent = path.dirname(resuelto);
    res.json({ path: resuelto, parent: parent !== resuelto ? parent : null, entries: entradas });
  } catch (err) {
    res.status(400).json({ error: `No se pudo abrir la carpeta: ${err.message}` });
  }
});

// Tipos de documento: patrón del archivo ORIGEN (un solo "*" = el folio) y
// nombre DESTINO que usa el sistema (prefijo + folio + sufijo). El usuario ya no
// escribe patrones: solo marca qué tipos quiere copiar.
const TIPOS_XML = {
  FAC:  { etiqueta: 'Facturas',          origenPrefijo: 'FACTURA', origenSufijo: '_Timbrada.xml', destinoPrefijo: 'FAC_',  destinoSufijo: '_Timbrada.xml' },
  NC:   { etiqueta: 'Notas de Crédito',  origenPrefijo: 'NC_',     origenSufijo: '_Timbrada.xml', destinoPrefijo: 'NC_',   destinoSufijo: '_Timbrada.xml' },
  ND:   { etiqueta: 'Notas de Débito',   origenPrefijo: 'ND_',     origenSufijo: '_Timbrada.xml', destinoPrefijo: 'ND_',   destinoSufijo: '_Timbrada.xml' },
  CP:   { etiqueta: 'Cartas Porte',      origenPrefijo: 'CP_',     origenSufijo: '_Timbrada.xml', destinoPrefijo: 'CP_',   destinoSufijo: '_Timbrada.xml' },
  PAGO: { etiqueta: 'Pagos',             origenPrefijo: 'PAGO',    origenSufijo: '_TIMBRADO.xml', destinoPrefijo: 'PAGO_', destinoSufijo: '_TIMBRADO.xml' },
};
const escapar = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const t of Object.values(TIPOS_XML)) {
  t.regex = new RegExp('^' + escapar(t.origenPrefijo) + '(.+)' + escapar(t.origenSufijo) + '$', 'i');
}

router.get('/tipos-xml', requierePermiso('utilerias.ver'), (req, res) =>
  res.json(Object.entries(TIPOS_XML).map(([clave, t]) => ({
    clave, etiqueta: t.etiqueta, origen: t.origenPrefijo + '*' + t.origenSufijo, destino: t.destinoPrefijo + '*' + t.destinoSufijo,
  }))));

// ── Copiar/renombrar XML de una carpeta externa a la carpeta del sistema ───
router.post('/copiar-xml', requierePermiso('utilerias.copiarxml'), (req, res) => {
  const carpetaOrigen = (req.body.carpetaOrigen || '').trim();
  const claves = (Array.isArray(req.body.tipos) ? req.body.tipos : []).filter(k => TIPOS_XML[k]);

  if (!carpetaOrigen) return res.status(400).json({ error: 'La carpeta origen es requerida.' });
  if (!claves.length) return res.status(400).json({ error: 'Seleccione al menos un tipo de documento.' });

  try {
    const stat = fs.statSync(carpetaOrigen);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'La carpeta origen no existe o no es una carpeta.' });
  } catch (err) {
    return res.status(400).json({ error: `No se pudo abrir la carpeta origen: ${err.message}` });
  }

  fs.mkdirSync(RUTA_XML, { recursive: true });

  const copiados = [];
  const omitidos = [];
  const errores = [];

  let archivos;
  try {
    archivos = fs.readdirSync(carpetaOrigen, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name);
  } catch (err) {
    return res.status(400).json({ error: `No se pudo leer la carpeta origen: ${err.message}` });
  }

  const porTipo = Object.fromEntries(claves.map(k => [k, 0]));
  for (const nombre of archivos) {
    for (const clave of claves) {
      const t = TIPOS_XML[clave];
      const m = nombre.match(t.regex);
      if (!m) continue;
      // Si el prefijo destino termina en "_" y el folio origen empieza con "_"
      // (ej. PAGO_3498_TIMBRADO.xml), no se duplica el guion bajo.
      const folio = t.destinoPrefijo.endsWith('_') ? m[1].replace(/^_+/, '') : m[1];
      if (!folio) continue;
      const nombreDestino = `${t.destinoPrefijo}${folio}${t.destinoSufijo}`;
      const rutaDestino = path.join(RUTA_XML, nombreDestino);
      porTipo[clave]++;
      if (fs.existsSync(rutaDestino)) {
        omitidos.push({ tipo: t.etiqueta, origen: nombre, destino: nombreDestino, motivo: 'Ya existe en la carpeta de XML del sistema.' });
        break;
      }
      try {
        fs.copyFileSync(path.join(carpetaOrigen, nombre), rutaDestino);
        copiados.push({ tipo: t.etiqueta, origen: nombre, destino: nombreDestino });
      } catch (err) {
        errores.push({ tipo: t.etiqueta, origen: nombre, motivo: err.message });
      }
      break;
    }
  }

  res.json({
    ok: true,
    totalEncontrados: copiados.length + omitidos.length + errores.length,
    porTipo: claves.map(k => ({ tipo: TIPOS_XML[k].etiqueta, encontrados: porTipo[k] })),
    copiados, omitidos, errores,
  });
});

// ── Importar facturas desde XML CFDI 4.0 (carpeta del servidor) ────────────
// El lote corre en segundo plano; el navegador consulta el avance por id.
const trabajosImportacion = new Map();

router.post('/importar-facturas', requierePermiso('utilerias.importarfacturas'), async (req, res) => {
  const carpeta = (req.body.carpetaOrigen || '').trim();
  if (!carpeta) return res.status(400).json({ error: 'La carpeta origen es requerida.' });
  let archivos;
  try {
    if (!fs.statSync(carpeta).isDirectory()) return res.status(400).json({ error: 'La carpeta origen no es una carpeta.' });
    archivos = importarFacturas.listarXml(carpeta);
  } catch (err) { return res.status(400).json({ error: `No se pudo leer la carpeta origen: ${err.message}` }); }
  if (!archivos.length) return res.status(400).json({ error: 'La carpeta no contiene archivos .xml.' });
  if ([...trabajosImportacion.values()].some(t => !t.terminado)) {
    return res.status(409).json({ error: 'Ya hay una importación en curso; espere a que termine.' });
  }

  const id = String(Date.now());
  const resumen = importarFacturas.resumenVacio(archivos.length);
  trabajosImportacion.set(id, resumen);
  for (const k of [...trabajosImportacion.keys()].slice(0, -5)) trabajosImportacion.delete(k);

  const pool = await getPool();
  const u = req.session.usuario || {};
  importarFacturas.importarLote(pool, carpeta, archivos, { completarUuid: req.body.completarUuid === true }, resumen)
    .then(r => console.log(`Importar facturas XML por ${(u.nombre || '').trim()}: ${r.importadas} importadas, ${r.existentes} existentes, ${r.omitidas} omitidas, ${r.errores} con error`))
    .catch(err => { resumen.terminado = true; resumen.errorGeneral = err.message; });
  res.json({ ok: true, id, total: archivos.length });
});

router.get('/importar-facturas/estado/:id', requierePermiso('utilerias.importarfacturas'), (req, res) => {
  const t = trabajosImportacion.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Importación no encontrada.' });
  res.json(t);
});

// ── Conciliar Facturas contra Cobros y Notas de Crédito ────────────────────
router.get('/conciliacion', requierePermiso('utilerias.conciliar'), (req, res) =>
  res.render('conciliacion', { usuario: req.session.usuario, modulo: 'conciliacion' }));

router.get('/conciliacion/data', requierePermiso('utilerias.conciliar'), async (req, res) => {
  const q = req.query;
  const filtros = {
    idCliente: parseInt(q.cliente) || null, folio: parseInt(q.folio) || null,
    folioDesde: parseInt(q.folioDesde) || null, folioHasta: parseInt(q.folioHasta) || null,
    desde: /^\d{4}-\d{2}-\d{2}$/.test(q.desde || '') ? q.desde : null,
    hasta: /^\d{4}-\d{2}-\d{2}$/.test(q.hasta || '') ? q.hasta : null,
  };
  try {
    const pool = await getPool();
    const nd = q.tipo === 'nd';
    const todas = nd ? await conciliacion.analizarNotasDebito(pool, filtros) : await conciliacion.analizarFacturas(pool, filtros);
    const filas = todas.filter(f => f.hallazgos.length);
    res.json({ tipo: nd ? 'nd' : 'factura', revisados: todas.length, filas: filas.slice(0, 2000), totalConDiferencias: filas.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/conciliacion/ajustar', requierePermiso('utilerias.conciliar'), async (req, res) => {
  const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 500)
    .map(i => ({ id: parseInt(i.id), serie: i.serie })).filter(i => i.id > 0);
  if (!items.length) return res.status(400).json({ error: 'No hay documentos seleccionados.' });
  const opts = { incluirSinRespaldo: req.body.incluirSinRespaldo === true };
  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    let resultado;
    try {
      resultado = req.body.tipo === 'nd' ? await conciliacion.ajustarNotasDebito(tx, items, opts) : await conciliacion.ajustarFacturas(tx, items, opts);
      await tx.commit();
    } catch (e) { try { await tx.rollback(); } catch (_) {} throw e; }
    const u = req.session.usuario || {};
    console.log(`Conciliación (${req.body.tipo === 'nd' ? 'ND' : 'Facturas'}) por ${(u.nombre || '').trim()}: ${JSON.stringify(resultado.filter(r => r.ok))}`);
    res.json({ ok: true, resultado });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
