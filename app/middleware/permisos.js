const { sql } = require('../config/db');

// Carga los permisos de un usuario (unión de todos sus grupos activos) una
// sola vez, al iniciar sesión. Si pertenece a algún grupo con EsAdmin=1,
// isAdmin=true implica bypass total y no hace falta resolver las claves.
async function cargarPermisos(pool, idUsuarioWeb) {
  const gruposRes = await pool.request().input('id', sql.Decimal(5), idUsuarioWeb)
    .query(`SELECT g.Id_Grupo, g.EsAdmin FROM dbo.SegUsuarioGrupo ug
            JOIN dbo.SegGrupos g ON g.Id_Grupo = ug.Id_Grupo AND g.Activo = 1
            WHERE ug.Id_UsuarioWeb = @id`);
  const grupos = gruposRes.recordset;
  const isAdmin = grupos.some(g => Number(g.EsAdmin) === 1);
  if (isAdmin || !grupos.length) return { isAdmin, permisos: [] };

  const ids = grupos.map(g => Number(g.Id_Grupo));
  const permRes = await pool.request()
    .query(`SELECT DISTINCT Clave FROM dbo.SegGrupoPermiso WHERE Id_Grupo IN (${ids.join(',')})`);
  return { isAdmin: false, permisos: permRes.recordset.map(r => r.Clave.trim()) };
}

function tienePermiso(req, clave) {
  const u = req.session.usuario;
  if (!u) return false;
  if (u.isAdmin) return true;
  return (u.permisos || []).includes(clave);
}

function requierePermiso(clave) {
  return (req, res, next) => {
    if (tienePermiso(req, clave)) return next();
    res.status(403).send('No tiene permiso para acceder a este módulo.');
  };
}

module.exports = { cargarPermisos, tienePermiso, requierePermiso };
