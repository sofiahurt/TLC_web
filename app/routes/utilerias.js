const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requierePermiso } = require('../middleware/permisos');
const { RUTA_XML } = require('../config/storage');

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

// Convierte un patrón con UN SOLO "*" (ej. "FACTURA*_Timbrada.xml") en una
// expresión regular que captura la parte variable (el folio). Solo se
// permiten nombres de archivo simples (letras, números, ".", "_", "-", "*"),
// nunca separadores de ruta, para evitar cualquier ambigüedad o escape de carpeta.
function compilarPatron(patron) {
  if (!/^[A-Za-z0-9_\-.]*\*[A-Za-z0-9_\-.]*$/.test(patron)) {
    throw new Error('El patrón debe tener exactamente un "*" y solo letras, números, "_", "-" o "." (sin rutas).');
  }
  const [prefijo, sufijo] = patron.split('*');
  const escapar = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { regex: new RegExp(`^${escapar(prefijo)}(.+)${escapar(sufijo)}$`), sufijo };
}

// ── Copiar/renombrar XML de una carpeta externa a la carpeta del sistema ───
router.post('/copiar-xml', requierePermiso('utilerias.copiarxml'), (req, res) => {
  const carpetaOrigen = (req.body.carpetaOrigen || '').trim();
  const patronOrigen = (req.body.patronOrigen || '').trim();
  const prefijoDestino = (req.body.prefijoDestino || '').trim();

  if (!carpetaOrigen || !patronOrigen || !prefijoDestino) {
    return res.status(400).json({ error: 'Carpeta origen, patrón y prefijo destino son requeridos.' });
  }
  if (!/^[A-Za-z0-9_\-]+$/.test(prefijoDestino.replace(/_$/, '') + '_')) {
    return res.status(400).json({ error: 'El prefijo destino solo puede tener letras, números, "_" o "-".' });
  }

  let compilado;
  try {
    compilado = compilarPatron(patronOrigen);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

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

  for (const nombre of archivos) {
    const m = nombre.match(compilado.regex);
    if (!m) continue;
    const folio = m[1];
    const nombreDestino = `${prefijoDestino}${folio}${compilado.sufijo}`;
    const rutaDestino = path.join(RUTA_XML, nombreDestino);
    if (fs.existsSync(rutaDestino)) {
      omitidos.push({ origen: nombre, destino: nombreDestino, motivo: 'Ya existe en la carpeta de XML del sistema.' });
      continue;
    }
    try {
      fs.copyFileSync(path.join(carpetaOrigen, nombre), rutaDestino);
      copiados.push({ origen: nombre, destino: nombreDestino });
    } catch (err) {
      errores.push({ origen: nombre, motivo: err.message });
    }
  }

  res.json({
    ok: true,
    totalEncontrados: copiados.length + omitidos.length + errores.length,
    copiados, omitidos, errores,
  });
});

module.exports = router;
