const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/db');
const { browseQuery } = require('../config/browse');
const { requierePermiso } = require('../middleware/permisos');

const trim = v => (v == null ? '' : String(v).trim());

router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT Central, Descripcion FROM Empresa2.Centrales ORDER BY Central`);
    res.render('usuarios', { usuario: req.session.usuario, modulo: 'usuarios', centrales: r.recordset });
  } catch (err) {
    res.render('usuarios', { usuario: req.session.usuario, modulo: 'usuarios', centrales: [] });
  }
});

// ── BROWSE ──────────────────────────────────────────────────────────────────
router.get('/data', async (req, res) => {
  try {
    const data = await browseQuery({
      table: 'dbo.UsuariosWeb',
      columns: ['ID_USUARIOWEB', 'NOMBRE', 'APELLIDO', 'SERIE', 'ACTIVO'],
      searchableCols: ['ID_USUARIOWEB', 'NOMBRE', 'APELLIDO', 'SERIE'],
      req,
    });
    const rows = data.rows.map(r => `<tr data-id="${r.ID_USUARIOWEB}">
      <td data-field="ID_USUARIOWEB" data-value="${r.ID_USUARIOWEB}">${r.ID_USUARIOWEB}</td>
      <td data-field="NOMBRE" data-value="${trim(r.NOMBRE)}">${trim(r.NOMBRE)}</td>
      <td data-field="APELLIDO" data-value="${trim(r.APELLIDO)}">${trim(r.APELLIDO)}</td>
      <td data-field="SERIE" data-value="${trim(r.SERIE)}">${trim(r.SERIE)}</td>
      <td data-field="ACTIVO" data-value="${r.ACTIVO || 0}">${r.ACTIVO ? '<span class="badge bg-success">Activo</span>' : '<span class="badge bg-secondary">Inactivo</span>'}</td>
    </tr>`).join('');
    res.json({ rows, page: data.page, totalPages: data.totalPages, total: data.total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GUARDAR (alta/edición) ───────────────────────────────────────────────────
router.post('/guardar', requierePermiso('usuarios.editar'), async (req, res) => {
  const { ID_USUARIOWEB, NOMBRE, APELLIDO, PASSWORD, SERIE, ACTIVO, _mode } = req.body;
  const nombre = trim(NOMBRE);
  const serie = trim(SERIE).toUpperCase();
  if (!nombre) return res.status(400).json({ error: 'El nombre de usuario es requerido.' });
  if (!serie) return res.status(400).json({ error: 'La serie es requerida.' });
  if (_mode === 'add' && !trim(PASSWORD)) return res.status(400).json({ error: 'La contraseña es requerida.' });

  try {
    const pool = await getPool();

    // NOMBRE es la clave de login (auth.js hace match LTRIM/RTRIM) -- no puede
    // haber dos usuarios con el mismo nombre, sin importar mayúsculas/espacios.
    const dupReq = pool.request().input('nombre', sql.Char(80), nombre);
    let dupWhere = `UPPER(LTRIM(RTRIM(NOMBRE))) = UPPER(@nombre)`;
    if (_mode !== 'add') {
      dupReq.input('id', sql.Decimal(5), ID_USUARIOWEB);
      dupWhere += ` AND ID_USUARIOWEB <> @id`;
    }
    const dup = await dupReq.query(`SELECT TOP 1 1 AS x FROM dbo.UsuariosWeb WHERE ${dupWhere}`);
    if (dup.recordset[0]) return res.status(400).json({ error: `Ya existe un usuario con el nombre "${nombre}".` });

    if (_mode === 'add') {
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const nextRes = await new sql.Request(tx)
          .query(`SELECT ISNULL(MAX(ID_USUARIOWEB), 0) + 1 AS next FROM dbo.UsuariosWeb WITH (UPDLOCK, HOLDLOCK)`);
        const nextId = nextRes.recordset[0].next;
        await new sql.Request(tx)
          .input('id', sql.Decimal(5), nextId)
          .input('nombre', sql.Char(80), nombre)
          .input('apellido', sql.Char(100), trim(APELLIDO) || null)
          .input('password', sql.Char(20), trim(PASSWORD))
          .input('serie', sql.Char(3), serie)
          .input('activo', sql.TinyInt, ACTIVO ? 1 : 0)
          .query(`INSERT INTO dbo.UsuariosWeb (ID_USUARIOWEB, NOMBRE, APELLIDO, PASSWORD, SERIE, ACTIVO)
                  VALUES (@id, @nombre, @apellido, @password, @serie, @activo)`);
        await tx.commit();
        return res.json({ ok: true, idUsuarioWeb: nextId });
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    }

    // Edición: la contraseña solo se actualiza si se capturó una nueva --
    // dejarla en blanco significa "no cambiar".
    const passwordNueva = trim(PASSWORD);
    const req2 = pool.request()
      .input('id', sql.Decimal(5), ID_USUARIOWEB)
      .input('nombre', sql.Char(80), nombre)
      .input('apellido', sql.Char(100), trim(APELLIDO) || null)
      .input('serie', sql.Char(3), serie)
      .input('activo', sql.TinyInt, ACTIVO ? 1 : 0);
    let setPassword = '';
    if (passwordNueva) {
      req2.input('password', sql.Char(20), passwordNueva);
      setPassword = ', PASSWORD=@password';
    }
    await req2.query(`UPDATE dbo.UsuariosWeb SET NOMBRE=@nombre, APELLIDO=@apellido, SERIE=@serie, ACTIVO=@activo${setPassword} WHERE ID_USUARIOWEB=@id`);
    res.json({ ok: true, idUsuarioWeb: ID_USUARIOWEB });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ELIMINAR ─────────────────────────────────────────────────────────────────
router.post('/eliminar', requierePermiso('usuarios.editar'), async (req, res) => {
  const idUsuarioWeb = parseInt(req.body.ID_USUARIOWEB);
  if (!idUsuarioWeb) return res.status(400).json({ error: 'Falta ID_USUARIOWEB' });
  try {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      // Primero las membresías de grupo (FK real hacia SegUsuarioGrupo), luego el usuario.
      await new sql.Request(tx).input('id', sql.Decimal(5), idUsuarioWeb)
        .query(`DELETE FROM dbo.SegUsuarioGrupo WHERE Id_UsuarioWeb=@id`);
      await new sql.Request(tx).input('id', sql.Decimal(5), idUsuarioWeb)
        .query(`DELETE FROM dbo.UsuariosWeb WHERE ID_USUARIOWEB=@id`);
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
