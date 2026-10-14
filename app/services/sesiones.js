// Registro de sesiones web (quién está conectado y cuándo entró/salió).
// Las sesiones de express-session viven en memoria; esta tabla es el registro
// durable. Una fila abierta (Salida IS NULL) es una sesión vigente.
//   MotivoSalida: 'salio' (Cerrar sesión), 'inactividad', 'expiro' (8 h) o
//   'reinicio' (el servidor se reinició y las sesiones en memoria se perdieron).
const { getPool, sql } = require('../config/db');

const MIN_EN_LINEA = 5;        // última actividad más reciente que esto = "En línea"
const MIN_INACTIVIDAD = 30;    // sin actividad más tiempo que esto = sesión cerrada por inactividad
const HORAS_SESION = 8;        // igual que cookie.maxAge en app.js
const TOUCH_CADA_MS = 60 * 1000;

let tablaLista = false;

async function asegurarTabla() {
  const pool = await getPool();
  await pool.request().query(`
    IF OBJECT_ID('dbo.SesionesWeb','U') IS NULL
    BEGIN
      CREATE TABLE dbo.SesionesWeb(
        Id_Sesion        bigint IDENTITY(1,1) PRIMARY KEY,
        Id_UsuarioWeb    int          NULL,
        Usuario          varchar(100) NOT NULL,
        IP               varchar(64)  NULL,
        Navegador        varchar(300) NULL,
        Anio             int          NULL,
        Central          varchar(10)  NULL,
        Entrada          datetime2(0) NOT NULL DEFAULT SYSDATETIME(),
        UltimaActividad  datetime2(0) NOT NULL DEFAULT SYSDATETIME(),
        Salida           datetime2(0) NULL,
        MotivoSalida     varchar(20)  NULL
      );
      CREATE INDEX IX_SesionesWeb_Abiertas ON dbo.SesionesWeb(Salida, UltimaActividad);
      CREATE INDEX IX_SesionesWeb_Usuario  ON dbo.SesionesWeb(Id_UsuarioWeb, Entrada);
    END`);
  tablaLista = true;
}

// Al arrancar: las sesiones en memoria se perdieron, así que cualquier fila
// abierta quedó huérfana.
async function iniciar() {
  try {
    await asegurarTabla();
    const pool = await getPool();
    await pool.request().query(`
      UPDATE dbo.SesionesWeb SET Salida = UltimaActividad, MotivoSalida = 'reinicio'
      WHERE Salida IS NULL`);
  } catch (err) {
    console.error('SesionesWeb: no se pudo inicializar el registro de sesiones:', err.message);
  }
  setInterval(barrer, 60 * 1000).unref();
}

async function barrer() {
  if (!tablaLista) return;
  try {
    const pool = await getPool();
    await pool.request()
      .input('hrs', sql.Int, HORAS_SESION)
      .input('min', sql.Int, MIN_INACTIVIDAD)
      .query(`
        UPDATE dbo.SesionesWeb SET Salida = SYSDATETIME(), MotivoSalida = 'expiro'
         WHERE Salida IS NULL AND Entrada < DATEADD(HOUR, -@hrs, SYSDATETIME());
        UPDATE dbo.SesionesWeb SET Salida = UltimaActividad, MotivoSalida = 'inactividad'
         WHERE Salida IS NULL AND UltimaActividad < DATEADD(MINUTE, -@min, SYSDATETIME());`);
  } catch (err) { console.error('SesionesWeb: barrido falló:', err.message); }
}

const ipDe = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
  .split(',')[0].trim().replace(/^::ffff:/, '').slice(0, 64);

async function registrarEntrada(req, usuario) {
  if (!tablaLista) return;
  try {
    // Si este navegador ya traía una sesión registrada, se cierra primero.
    await registrarSalida(req, 'salio');
    const pool = await getPool();
    const r = await pool.request()
      .input('idu', sql.Int, usuario.id)
      .input('usr', sql.VarChar(100), `${usuario.nombre} ${usuario.apellido || ''}`.trim())
      .input('ip', sql.VarChar(64), ipDe(req))
      .input('nav', sql.VarChar(300), String(req.headers['user-agent'] || '').slice(0, 300))
      .query(`INSERT INTO dbo.SesionesWeb(Id_UsuarioWeb, Usuario, IP, Navegador)
              OUTPUT INSERTED.Id_Sesion VALUES(@idu, @usr, @ip, @nav)`);
    req.session.sesionId = Number(r.recordset[0].Id_Sesion);
    req.session.sesionTouch = Date.now();
  } catch (err) { console.error('SesionesWeb: no se pudo registrar la entrada:', err.message); }
}

async function registrarAnioCentral(req) {
  if (!tablaLista || !req.session.sesionId) return;
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.BigInt, req.session.sesionId)
      .input('anio', sql.Int, req.session.anio || null)
      .input('cen', sql.VarChar(10), req.session.central || null)
      .query(`UPDATE dbo.SesionesWeb SET Anio=@anio, Central=@cen, UltimaActividad=SYSDATETIME() WHERE Id_Sesion=@id`);
  } catch (err) { console.error('SesionesWeb:', err.message); }
}

async function registrarSalida(req, motivo) {
  const id = req.session && req.session.sesionId;
  if (!tablaLista || !id) return;
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.BigInt, id).input('mot', sql.VarChar(20), motivo)
      .query(`UPDATE dbo.SesionesWeb SET Salida = SYSDATETIME(), MotivoSalida = @mot
              WHERE Id_Sesion=@id AND (Salida IS NULL OR MotivoSalida='inactividad')`);
  } catch (err) { console.error('SesionesWeb: no se pudo registrar la salida:', err.message); }
  delete req.session.sesionId;
}

// Middleware: marca actividad (máx. una escritura por minuto por sesión).
function latido(req, res, next) {
  const s = req.session;
  if (tablaLista && s && s.usuario && s.sesionId && Date.now() - (s.sesionTouch || 0) > TOUCH_CADA_MS) {
    s.sesionTouch = Date.now();
    getPool().then(pool => pool.request().input('id', sql.BigInt, s.sesionId).query(
      // Si el barrido la cerró por inactividad pero el usuario volvió, se reabre.
      `UPDATE dbo.SesionesWeb SET UltimaActividad = SYSDATETIME(),
              Salida = CASE WHEN MotivoSalida='inactividad' THEN NULL ELSE Salida END,
              MotivoSalida = CASE WHEN MotivoSalida='inactividad' THEN NULL ELSE MotivoSalida END
        WHERE Id_Sesion=@id AND (Salida IS NULL OR MotivoSalida='inactividad')`))
      .catch(err => console.error('SesionesWeb: latido falló:', err.message));
  }
  next();
}

module.exports = { iniciar, latido, registrarEntrada, registrarAnioCentral, registrarSalida, MIN_EN_LINEA };
