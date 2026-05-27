require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'app/views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'tlc_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
  res.locals.anio  = req.session.anio  || null;
  res.locals.serie = req.session.usuario ? req.session.usuario.serie : null;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  if (!req.session.anio)    return res.redirect('/seleccionar-anio');
  next();
}

app.use('/', require('./app/routes/auth'));
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.use(requireAuth);

app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', (req, res) => res.render('dashboard', { usuario: req.session.usuario, modulo: 'dashboard' }));

app.use('/ciudades',    require('./app/routes/ciudades'));
app.use('/colonias',    require('./app/routes/colonias'));
app.use('/tipoflete',   require('./app/routes/tipoflete'));
app.use('/operadores',  require('./app/routes/operadores'));
app.use('/prodserv',    require('./app/routes/prodserv'));
app.use('/clientes',    require('./app/routes/clientes'));
app.use('/contacto',    require('./app/routes/contacto'));
app.use('/domicilios',  require('./app/routes/domicilios'));
app.use('/transport',   require('./app/routes/transport'));
app.use('/camiones',    require('./app/routes/camiones'));
app.use('/tarifas',     require('./app/routes/tarifas'));
app.use('/tarkilomts',  require('./app/routes/tarkilomts'));
app.use('/dieselpre',   require('./app/routes/dieselpre'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TLC Web corriendo en http://localhost:${PORT}`));
