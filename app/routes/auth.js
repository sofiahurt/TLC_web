const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');

// Login page
router.get('/login', (req, res) => {
  if (req.session.usuario) {
    return req.session.anio
      ? res.redirect('/dashboard')
      : res.redirect('/seleccionar-anio');
  }
  res.render('login', { error: null });
});

// Process login
router.post('/login', async (req, res) => {
  const { nombre, password } = req.body;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('nombre', sql.Char(80), nombre)
      .query(`SELECT * FROM dbo.UsuariosWeb WHERE LTRIM(RTRIM(NOMBRE)) = LTRIM(RTRIM(@nombre))`);
    const user = result.recordset[0];
    if (!user || user.PASSWORD.trim() !== password) {
      return res.render('login', { error: 'Usuario o contraseña incorrectos' });
    }
    req.session.usuario = {
      id: user.ID_USUARIOWEB,
      nombre: user.NOMBRE.trim(),
      apellido: user.APELLIDO ? user.APELLIDO.trim() : '',
      serie: user.SERIE ? user.SERIE.trim() : ''
    };
    res.redirect('/seleccionar-anio');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Error de conexión con la base de datos' });
  }
});

// Year selection page
router.get('/seleccionar-anio', (req, res) => {
  if (!req.session.usuario) return res.redirect('/login');
  if (req.session.anio)     return res.redirect('/dashboard');
  res.render('seleccionar-anio', { usuario: req.session.usuario });
});

// Process year selection
router.post('/seleccionar-anio', (req, res) => {
  if (!req.session.usuario) return res.redirect('/login');
  const anio = parseInt(req.body.anio);
  if (isNaN(anio) || anio < 2000 || anio > 2099) {
    return res.redirect('/seleccionar-anio');
  }
  req.session.anio = anio;
  res.redirect('/dashboard');
});

module.exports = router;
