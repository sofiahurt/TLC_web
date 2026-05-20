const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');

router.get('/', (req, res) => {
  if (req.session.usuario) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

router.post('/', async (req, res) => {
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
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Error de conexión con la base de datos' });
  }
});

module.exports = router;
