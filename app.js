require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { tienePermiso, requierePermiso } = require('./app/middleware/permisos');

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
  res.locals.anio     = req.session.anio     || null;
  res.locals.central  = req.session.central  || null;
  res.locals.serie    = req.session.usuario ? req.session.usuario.serie : null;
  res.locals.isAdmin  = req.session.usuario ? !!req.session.usuario.isAdmin : false;
  res.locals.tienePermiso = clave => tienePermiso(req, clave);
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  if (!req.session.anio || !req.session.central) return res.redirect('/seleccionar-anio');
  next();
}

app.use('/', require('./app/routes/auth'));
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.use(requireAuth);

app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', (req, res) => res.render('dashboard', { usuario: req.session.usuario, modulo: 'dashboard' }));

app.use('/cartaporte',  requierePermiso('cartaporte.ver'), require('./app/routes/cartaporte'));
app.use('/facturas',    requierePermiso('facturas.ver'),   require('./app/routes/facturas'));
app.use('/notacred',    requierePermiso('notacred.ver'),   require('./app/routes/notacred'));
app.use('/pagos',       requierePermiso('pagos.ver'),      require('./app/routes/pagos'));
app.use('/seguridad',   requierePermiso('seguridad.administrar'), require('./app/routes/seguridad'));
app.use('/usuarios',    requierePermiso('usuarios.ver'),     require('./app/routes/usuarios'));
app.use('/centrales',   requierePermiso('centrales.ver'),  require('./app/routes/centrales'));
app.use('/ciudades',    requierePermiso('ciudades.ver'),   require('./app/routes/ciudades'));
app.use('/colonias',    requierePermiso('colonias.ver'),   require('./app/routes/colonias'));
app.use('/tipoflete',   requierePermiso('tipoflete.ver'),  require('./app/routes/tipoflete'));
app.use('/operadores',  requierePermiso('operadores.ver'), require('./app/routes/operadores'));
app.use('/prodserv',    requierePermiso('prodserv.ver'),   require('./app/routes/prodserv'));
app.use('/clientes',    requierePermiso('clientes.ver'),   require('./app/routes/clientes'));
app.use('/contacto',    requierePermiso('contacto.ver'),   require('./app/routes/contacto'));
app.use('/domicilios',  requierePermiso('domicilios.ver'), require('./app/routes/domicilios'));
app.use('/transport',   requierePermiso('transport.ver'),  require('./app/routes/transport'));
app.use('/camiones',    requierePermiso('camiones.ver'),   require('./app/routes/camiones'));
app.use('/tarifas',     requierePermiso('tarifas.ver'),    require('./app/routes/tarifas'));
app.use('/tarkilomts',  requierePermiso('tarkilomts.ver'), require('./app/routes/tarkilomts'));
app.use('/dieselpre',   requierePermiso('dieselpre.ver'),  require('./app/routes/dieselpre'));
app.use('/reportes',    requierePermiso('reportes.ver'),   require('./app/routes/reportes'));
app.use('/cfdi',        require('./app/routes/cfdi'));

const { RUTA_XML } = require('./app/config/storage');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TLC Web corriendo en http://localhost:${PORT}`);
  console.log(`Almacenamiento XML:  ${RUTA_XML}`);
});
