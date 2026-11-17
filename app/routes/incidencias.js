'use strict';

// ── Incidencias de viajes (cobrables al operador) ───────────────────────────
// Pantalla (navegador) y API JSON. La lógica vive en services/incidencias.js.
const express = require('express');
const router = express.Router();
const { requierePermiso } = require('../middleware/permisos');
const svc = require('../services/incidencias');

const trim = v => (v == null ? '' : String(v).trim());
const quien = req => [req.session.usuario.nombre, req.session.usuario.apellido].filter(Boolean).map(trim).join(' ');
const manejar = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (!e.status || e.status >= 500) console.error('incidencias:', e);
    res.status(e.status || 500).json({ error: e.message });
  }
};

router.get('/', requierePermiso('incidencias.ver'), manejar(async (req, res) => {
  res.render('incidencias', { usuario: req.session.usuario, modulo: 'incidencias' });
}));

router.get('/data', requierePermiso('incidencias.ver'), manejar(async (req, res) => res.json(await svc.listar(req.query))));

// Cartas porte para ligar la incidencia (antes de /:id)
router.get('/cartasporte', requierePermiso('incidencias.ver'), manejar(async (req, res) => res.json({ rows: await svc.buscarCartasPorte(req.query.q) })));

router.get('/:id', requierePermiso('incidencias.ver'), manejar(async (req, res) => res.json(await svc.obtener(req.params.id))));
router.post('/', requierePermiso('incidencias.crear'), manejar(async (req, res) => res.status(201).json(await svc.crear(req.body, quien(req)))));
router.put('/:id', requierePermiso('incidencias.editar'), manejar(async (req, res) => res.json(await svc.editar(req.params.id, req.body, quien(req)))));
router.post('/:id/cancelar', requierePermiso('incidencias.cancelar'), manejar(async (req, res) => res.json(await svc.cancelar(req.params.id, quien(req)))));
router.post('/:id/cobros', requierePermiso('incidencias.cobrar'), manejar(async (req, res) => res.json(await svc.registrarCobroManual(req.params.id, req.body, quien(req)))));
router.delete('/:id/cobros/:idPago', requierePermiso('incidencias.cobrar'), manejar(async (req, res) => res.json(await svc.quitarCobroManual(req.params.id, req.params.idPago, quien(req)))));

module.exports = router;
