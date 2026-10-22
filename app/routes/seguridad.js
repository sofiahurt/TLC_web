const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');
const { MIN_EN_LINEA } = require('../services/sesiones');
const { conProteccionAdmin } = require('../middleware/permisos');

const trim = v => (v == null ? '' : String(v).trim());

async function withTransaction(pool, fn) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch (_) { /* la tx ya pudo cerrarse */ }
    throw err;
  }
}

router.get('/', (req, res) => res.render('seguridad', { usuario: req.session.usuario, modulo: 'seguridad' }));

router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'dbo.SegGrupos',
      columns: ['Id_Grupo', 'Nombre', 'Descripcion', 'EsAdmin', 'Activo'],
      searchableCols: ['Id_Grupo', 'Nombre', 'Descripcion'],
      req,
    });
    const rows = data.rows.map(r =>
      `<tr data-id="${r.Id_Grupo}">
        <td data-field="Id_Grupo" data-value="${r.Id_Grupo}">${r.Id_Grupo}</td>
        <td data-field="Nombre" data-value="${trim(r.Nombre)}">${trim(r.Nombre)}</td>
        <td data-field="Descripcion" data-value="${trim(r.Descripcion)}">${trim(r.Descripcion)}</td>
        <td data-field="EsAdmin" data-value="${r.EsAdmin || 0}">${r.EsAdmin ? '<span class="badge bg-danger">Sí</span>' : ''}</td>
        <td data-field="Activo" data-value="${r.Activo || 0}">${r.Activo ? '<span class="badge bg-success">Activo</span>' : '<span class="badge bg-secondary">Inactivo</span>'}</td>
      </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/grupo/:id', async (req, res) => {
  try {
    const idGrupo = parseInt(req.params.id);
    const pool = await getPool();
    const grupoRes = await pool.request().input('id', sql.Int, idGrupo)
      .query(`SELECT * FROM dbo.SegGrupos WHERE Id_Grupo=@id`);
    if (!grupoRes.recordset[0]) return res.status(404).json({ error: 'Grupo no encontrado.' });
    const clavesRes = await pool.request().input('id', sql.Int, idGrupo)
      .query(`SELECT Clave FROM dbo.SegGrupoPermiso WHERE Id_Grupo=@id`);
    const usuariosRes = await pool.request().input('id', sql.Int, idGrupo)
      .query(`SELECT Id_UsuarioWeb FROM dbo.SegUsuarioGrupo WHERE Id_Grupo=@id`);
    res.json({
      grupo: grupoRes.recordset[0],
      claves: clavesRes.recordset.map(r => trim(r.Clave)),
      idsUsuarios: usuariosRes.recordset.map(r => Number(r.Id_UsuarioWeb)),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guardar', async (req, res) => {
  const { Id_Grupo, Nombre, Descripcion, EsAdmin, Activo, _mode } = req.body;
  if (!trim(Nombre)) return res.status(400).json({ error: 'El nombre del grupo es requerido.' });
  try {
    const pool = await getPool();
    if (_mode === 'add') {
      const r = await pool.request()
        .input('nombre', sql.VarChar(60), trim(Nombre))
        .input('descripcion', sql.VarChar(200), trim(Descripcion) || null)
        .input('esadmin', sql.Bit, EsAdmin ? 1 : 0)
        .input('activo', sql.Bit, Activo ? 1 : 0)
        .query(`INSERT INTO dbo.SegGrupos(Nombre, Descripcion, EsAdmin, Activo)
                OUTPUT INSERTED.Id_Grupo
                VALUES(@nombre, @descripcion, @esadmin, @activo)`);
      res.json({ ok: true, idGrupo: r.recordset[0].Id_Grupo });
    } else {
      await conProteccionAdmin(pool, tx => new sql.Request(tx)
        .input('id', sql.Int, Id_Grupo)
        .input('nombre', sql.VarChar(60), trim(Nombre))
        .input('descripcion', sql.VarChar(200), trim(Descripcion) || null)
        .input('esadmin', sql.Bit, EsAdmin ? 1 : 0)
        .input('activo', sql.Bit, Activo ? 1 : 0)
        .query(`UPDATE dbo.SegGrupos SET Nombre=@nombre, Descripcion=@descripcion, EsAdmin=@esadmin, Activo=@activo WHERE Id_Grupo=@id`));
      res.json({ ok: true, idGrupo: Id_Grupo });
    }
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/eliminar', async (req, res) => {
  try {
    const pool = await getPool();
    await conProteccionAdmin(pool, tx => new sql.Request(tx).input('id', sql.Int, req.body.Id_Grupo)
      .query(`DELETE FROM dbo.SegGrupos WHERE Id_Grupo=@id`));
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Reemplaza el set completo de permisos del grupo (borra todo lo anterior e
// inserta lo seleccionado, en una sola transacción).
router.post('/permisos/guardar', async (req, res) => {
  const idGrupo = parseInt(req.body.idGrupo);
  const claves = Array.isArray(req.body.claves) ? req.body.claves.map(trim).filter(Boolean) : [];
  if (!idGrupo) return res.status(400).json({ error: 'Grupo inválido.' });
  try {
    const pool = await getPool();
    await withTransaction(pool, async (tx) => {
      await new sql.Request(tx).input('id', sql.Int, idGrupo)
        .query(`DELETE FROM dbo.SegGrupoPermiso WHERE Id_Grupo=@id`);
      for (const clave of claves) {
        await new sql.Request(tx).input('id', sql.Int, idGrupo).input('clave', sql.VarChar(80), clave)
          .query(`INSERT INTO dbo.SegGrupoPermiso(Id_Grupo, Clave) VALUES(@id, @clave)`);
      }
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reemplaza el set completo de usuarios miembros del grupo.
router.post('/usuarios/guardar', async (req, res) => {
  const idGrupo = parseInt(req.body.idGrupo);
  const idsUsuarios = Array.isArray(req.body.idsUsuarios) ? req.body.idsUsuarios.map(v => parseInt(v)).filter(Boolean) : [];
  if (!idGrupo) return res.status(400).json({ error: 'Grupo inválido.' });
  try {
    const pool = await getPool();
    await conProteccionAdmin(pool, async (tx) => {
      await new sql.Request(tx).input('id', sql.Int, idGrupo)
        .query(`DELETE FROM dbo.SegUsuarioGrupo WHERE Id_Grupo=@id`);
      for (const idUsuario of idsUsuarios) {
        await new sql.Request(tx).input('id', sql.Int, idGrupo).input('idu', sql.Decimal(5), idUsuario)
          .query(`INSERT INTO dbo.SegUsuarioGrupo(Id_Grupo, Id_UsuarioWeb) VALUES(@id, @idu)`);
      }
    });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.get('/permisos-catalogo', async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT Clave, Modulo, Descripcion, Orden FROM dbo.SegPermisos ORDER BY Modulo, Orden, Clave`);
    res.json({ permisos: r.recordset.map(p => ({ Clave: trim(p.Clave), Modulo: trim(p.Modulo), Descripcion: trim(p.Descripcion) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/usuarios-catalogo', async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT ID_USUARIOWEB, NOMBRE, APELLIDO, SERIE FROM dbo.UsuariosWeb ORDER BY NOMBRE`);
    res.json({
      usuarios: r.recordset.map(u => ({
        id: Number(u.ID_USUARIOWEB), nombre: trim(u.NOMBRE), apellido: trim(u.APELLIDO), serie: trim(u.SERIE),
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Sesiones web: quién está conectado y el historial de entradas/salidas ──────
router.get('/sesiones', (req, res) => res.render('sesiones', { usuario: req.session.usuario, modulo: 'sesiones' }));

const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Sesiones abiertas (Salida IS NULL). En línea = actividad reciente; si no, Inactivo.
router.get('/sesiones/activas', async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().input('min', sql.Int, MIN_EN_LINEA).query(`
      SELECT Id_Sesion, Usuario, IP, Anio, Central,
             CONVERT(varchar(19), Entrada, 120) AS Entrada,
             CONVERT(varchar(19), UltimaActividad, 120) AS UltimaActividad,
             DATEDIFF(MINUTE, Entrada, SYSDATETIME()) AS MinConectado,
             DATEDIFF(SECOND, UltimaActividad, SYSDATETIME()) AS SegInactivo
        FROM dbo.SesionesWeb WHERE Salida IS NULL ORDER BY UltimaActividad DESC`);
    const filas = r.recordset.map(x => ({ ...x, Usuario: esc(x.Usuario), IP: esc(x.IP), EnLinea: x.SegInactivo < MIN_EN_LINEA * 60 }));
    res.json({ filas, enLinea: filas.filter(f => f.EnLinea).length, abiertas: filas.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Historial con filtros: usuario (texto), desde/hasta (yyyy-mm-dd), tope 500 filas.
router.get('/sesiones/historial', async (req, res) => {
  try {
    const pool = await getPool();
    const rq = pool.request();
    let where = 'WHERE 1=1';
    const usr = trim(req.query.usuario);
    if (usr) { rq.input('usr', sql.VarChar(100), '%' + usr + '%'); where += ' AND Usuario LIKE @usr'; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '')) { rq.input('d', sql.Date, req.query.desde); where += ' AND Entrada >= @d'; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '')) { rq.input('h', sql.Date, req.query.hasta); where += ' AND Entrada < DATEADD(DAY,1,@h)'; }
    const r = await rq.query(`
      SELECT TOP 500 Id_Sesion, Usuario, IP, Navegador, Anio, Central, MotivoSalida,
             CONVERT(varchar(19), Entrada, 120) AS Entrada,
             CONVERT(varchar(19), UltimaActividad, 120) AS UltimaActividad,
             CONVERT(varchar(19), Salida, 120) AS Salida,
             DATEDIFF(MINUTE, Entrada, ISNULL(Salida, SYSDATETIME())) AS Minutos
        FROM dbo.SesionesWeb ${where} ORDER BY Entrada DESC`);
    res.json({ filas: r.recordset.map(x => ({ ...x, Usuario: esc(x.Usuario), IP: esc(x.IP), Navegador: esc(x.Navegador) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
