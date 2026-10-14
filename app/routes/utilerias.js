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

module.exports = router;
