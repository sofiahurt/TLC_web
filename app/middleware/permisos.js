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

// ── Protección del último administrador ──────────────────────────────────────
// Usuarios que hoy son administradores: miembros de algún grupo activo con
// EsAdmin=1 (el mismo criterio que usa cargarPermisos).
async function contarAdmins(tx) {
  const r = await new sql.Request(tx).query(`
    SELECT COUNT(DISTINCT ug.Id_UsuarioWeb) AS n
      FROM dbo.SegUsuarioGrupo ug
      JOIN dbo.SegGrupos g   ON g.Id_Grupo = ug.Id_Grupo AND g.EsAdmin = 1 AND g.Activo = 1
      JOIN dbo.UsuariosWeb u ON u.ID_USUARIOWEB = ug.Id_UsuarioWeb`);
  return r.recordset[0].n;
}

// Ejecuta fn(tx) en una transacción y la revierte si, de haber administradores
// antes, la operación los dejaría en cero (quitar el último miembro, desactivar o
// borrar el grupo administrador, quitarle EsAdmin, borrar al último usuario admin).
async function conProteccionAdmin(pool, fn) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const antes = await contarAdmins(tx);
    const result = await fn(tx);
    if (antes > 0 && (await contarAdmins(tx)) === 0) {
      throw Object.assign(new Error('Operación cancelada: el sistema debe conservar al menos un usuario administrador (grupo activo con acceso total y al menos un miembro).'), { status: 400 });
    }
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch (_) { /* la tx ya pudo cerrarse */ }
    throw err;
  }
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

module.exports = { cargarPermisos, tienePermiso, requierePermiso, conProteccionAdmin };
