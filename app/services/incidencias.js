'use strict';

// ── Incidencias de viajes (cobrables al operador) ───────────────────────────
// Cabecera = Empresa2.Incidencias (una por incidencia, siempre ligada a una Carta Porte)
// Cobros   = Empresa2.IncidenciasPagos (cada parcialidad cobrada: descontada en una liquidación o capturada a mano)
//
// ImporteCob / ParcialPag / MontoAdeudo / Status se RECALCULAN siempre desde los cobros (recomputar), nunca se
// suman a mano: así aplicar, quitar o cancelar un cobro siempre deja la incidencia consistente.

const { getPool, sql } = require('../config/db');

const trim = v => (v == null ? '' : String(v).trim());
const num = v => (v == null || v === '' || isNaN(Number(v)) ? 0 : Number(v));
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const fechaISO = d => (d instanceof Date ? d.toISOString().slice(0, 10) : trim(d));
const hoyISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const err = (status, message) => Object.assign(new Error(message), { status });
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const ST_ACTIVA = 'ACTIVA', ST_SALDADA = 'SALDADA', ST_CANCELADA = 'CANCELADA';

// ── Esquema (idempotente, se crea al arrancar) ──────────────────────────────
let _esquema = null;
function asegurarEsquema() {
  if (!_esquema) {
    _esquema = getPool().then(async pool => {
      await pool.request().query(`
        IF OBJECT_ID('Empresa2.Incidencias', 'U') IS NULL
        CREATE TABLE Empresa2.Incidencias (
          Id_Incidencia   INT           NOT NULL,
          Fecha           DATE          NOT NULL,
          Id_Operador     INT           NOT NULL,
          Operador        VARCHAR(80)   NULL,
          Serie           VARCHAR(3)    NOT NULL,
          CartaPorte      VARCHAR(30)   NOT NULL,
          Id_Camion       VARCHAR(10)   NULL,
          TipoIncidencia  VARCHAR(60)   NOT NULL,
          Descripcion     VARCHAR(MAX)  NULL,
          Importe         DECIMAL(11,2) NOT NULL CONSTRAINT DF_Incidencias_Importe DEFAULT 0,
          FlagCobOpe      TINYINT       NOT NULL CONSTRAINT DF_Incidencias_FlagCobOpe DEFAULT 0,
          Parcialidades   INT           NOT NULL CONSTRAINT DF_Incidencias_Parcialidades DEFAULT 0,
          ImporteParcial  DECIMAL(11,2) NOT NULL CONSTRAINT DF_Incidencias_ImporteParcial DEFAULT 0,
          ImporteCob      DECIMAL(11,2) NOT NULL CONSTRAINT DF_Incidencias_ImporteCob DEFAULT 0,
          MontoAdeudo     DECIMAL(11,2) NOT NULL CONSTRAINT DF_Incidencias_MontoAdeudo DEFAULT 0,
          ParcialPag      INT           NOT NULL CONSTRAINT DF_Incidencias_ParcialPag DEFAULT 0,
          Status          VARCHAR(20)   NOT NULL CONSTRAINT DF_Incidencias_Status DEFAULT 'ACTIVA',
          Observaciones   VARCHAR(500)  NULL,
          WhoCaptura      VARCHAR(80)   NULL,
          FechaCaptura    DATE          NULL,
          WhoModifica     VARCHAR(80)   NULL,
          FechaUltMod     DATE          NULL,
          CONSTRAINT PK_Incidencias PRIMARY KEY (Id_Incidencia)
        )`);
      await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Incidencias_Operador' AND object_id = OBJECT_ID('Empresa2.Incidencias'))
          CREATE INDEX IX_Incidencias_Operador ON Empresa2.Incidencias (Id_Operador, Status)`);
      await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Incidencias_CartaPorte' AND object_id = OBJECT_ID('Empresa2.Incidencias'))
          CREATE INDEX IX_Incidencias_CartaPorte ON Empresa2.Incidencias (Serie, CartaPorte)`);
      await pool.request().query(`
        IF OBJECT_ID('Empresa2.IncidenciasPagos', 'U') IS NULL
        CREATE TABLE Empresa2.IncidenciasPagos (
          Id_Incidencia   INT           NOT NULL,
          Id_Pago         INT           NOT NULL,
          Fecha           DATE          NOT NULL,
          Importe         DECIMAL(11,2) NOT NULL,
          Origen          VARCHAR(15)   NOT NULL,           -- LIQUIDACION (descontado en una liquidación) o MANUAL
          Mes             DECIMAL(3,0)  NULL,               -- liquidación: clave MES + ID_LIQUIDACION
          Id_Liquidacion  DECIMAL(9,0)  NULL,
          Observaciones   VARCHAR(200)  NULL,
          WhoCaptura      VARCHAR(80)   NULL,
          FechaCaptura    DATE          NULL,
          CONSTRAINT PK_IncidenciasPagos PRIMARY KEY (Id_Incidencia, Id_Pago),
          CONSTRAINT FK_IncidenciasPagos_Incidencias FOREIGN KEY (Id_Incidencia) REFERENCES Empresa2.Incidencias (Id_Incidencia)
        )`);
      await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_IncidenciasPagos_Liquidacion' AND object_id = OBJECT_ID('Empresa2.IncidenciasPagos'))
          CREATE INDEX IX_IncidenciasPagos_Liquidacion ON Empresa2.IncidenciasPagos (Mes, Id_Liquidacion)`);
      // Descuento por incidencias en la liquidación (se recalcula desde IncidenciasPagos).
      await pool.request().query(`IF COL_LENGTH('Empresa2.Liquida', 'DESCINCIDENCIAS') IS NULL ALTER TABLE Empresa2.Liquida ADD DESCINCIDENCIAS DECIMAL(18,2) NULL`);
    }).catch(e => { _esquema = null; throw e; });
  }
  return _esquema;
}

async function enTransaccion(fn) {
  await asegurarEsquema();
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const out = await fn(tx, pool);
    await tx.commit();
    return out;
  } catch (e) {
    try { await tx.rollback(); } catch (_) { /* ya revertida */ }
    throw e;
  }
}

// ── Cálculo de la cabecera ──────────────────────────────────────────────────
// Si se cobra al operador: ImporteParcial = Importe / Parcialidades (mínimo 1 parcialidad).
// Si no se cobra: sin parcialidades ni importe parcial.
function normalizarCobro({ importe, flagCobOpe, parcialidades }) {
  const imp = r2(importe);
  if (!isFinite(imp) || imp < 0) throw err(400, 'El importe debe ser un número mayor o igual a 0.');
  const cobra = flagCobOpe === true || flagCobOpe === 1 || flagCobOpe === '1' || flagCobOpe === 'true';
  if (!cobra) return { Importe: imp, FlagCobOpe: 0, Parcialidades: 0, ImporteParcial: 0 };
  if (imp <= 0) throw err(400, 'Para cobrar al operador el importe debe ser mayor a 0.');
  const parc = parseInt(parcialidades, 10) || 1;
  if (parc < 1 || parc > 200) throw err(400, 'Las parcialidades deben ser entre 1 y 200.');
  return { Importe: imp, FlagCobOpe: 1, Parcialidades: parc, ImporteParcial: r2(imp / parc) };
}

// Recalcula ImporteCob, ParcialPag, MontoAdeudo y Status desde los cobros registrados.
async function recomputar(tx, id, quien) {
  const q = (sqlTxt) => new sql.Request(tx).input('id', sql.Int, id).query(sqlTxt);
  const inc = (await q(`SELECT Importe, FlagCobOpe, Status FROM Empresa2.Incidencias WITH (UPDLOCK, ROWLOCK) WHERE Id_Incidencia=@id`)).recordset[0];
  if (!inc) throw err(404, 'Incidencia no encontrada.');
  const p = (await q(`SELECT ISNULL(SUM(Importe),0) AS cob, COUNT(*) AS n FROM Empresa2.IncidenciasPagos WHERE Id_Incidencia=@id`)).recordset[0];
  const cob = r2(p.cob), cobra = num(inc.FlagCobOpe) === 1;
  const adeudo = cobra ? Math.max(r2(num(inc.Importe) - cob), 0) : 0;
  let status = trim(inc.Status).toUpperCase();
  if (status !== ST_CANCELADA) status = cobra && adeudo <= 0.004 ? ST_SALDADA : ST_ACTIVA;
  await new sql.Request(tx).input('id', sql.Int, id).input('cob', sql.Decimal(11, 2), cob).input('adeudo', sql.Decimal(11, 2), adeudo)
    .input('n', sql.Int, p.n).input('st', sql.VarChar(20), status)
    .input('who', sql.VarChar(80), trim(quien).slice(0, 80) || null).input('f', sql.Date, hoyISO())
    .query(`UPDATE Empresa2.Incidencias SET ImporteCob=@cob, MontoAdeudo=@adeudo, ParcialPag=@n, Status=@st,
                   WhoModifica=ISNULL(@who, WhoModifica), FechaUltMod=@f WHERE Id_Incidencia=@id`);
}

// Importe sugerido para el siguiente cobro (recibe el modelo ya en camelCase): una parcialidad, o lo que falte si es la última (absorbe el redondeo).
function sugerido(inc) {
  const adeudo = num(inc.montoAdeudo);
  const quedan = num(inc.parcialidades) - num(inc.parcialPag);
  return r2(quedan <= 1 ? adeudo : Math.min(num(inc.importeParcial), adeudo));
}

function filaAModelo(r) {
  return {
    id: num(r.Id_Incidencia), fecha: fechaISO(r.Fecha), idOperador: num(r.Id_Operador), operador: trim(r.Operador),
    serie: trim(r.Serie), cartaPorte: trim(r.CartaPorte), idCamion: trim(r.Id_Camion), tipoIncidencia: trim(r.TipoIncidencia),
    descripcion: trim(r.Descripcion), importe: num(r.Importe), flagCobOpe: num(r.FlagCobOpe), parcialidades: num(r.Parcialidades),
    importeParcial: num(r.ImporteParcial), importeCob: num(r.ImporteCob), montoAdeudo: num(r.MontoAdeudo), parcialPag: num(r.ParcialPag),
    status: trim(r.Status), observaciones: trim(r.Observaciones), whoCaptura: trim(r.WhoCaptura), fechaCaptura: fechaISO(r.FechaCaptura),
    whoModifica: trim(r.WhoModifica), fechaUltMod: fechaISO(r.FechaUltMod),
  };
}
const pagoAModelo = r => ({
  idIncidencia: num(r.Id_Incidencia), idPago: num(r.Id_Pago), fecha: fechaISO(r.Fecha), importe: num(r.Importe), origen: trim(r.Origen),
  mes: r.Mes == null ? null : num(r.Mes), idLiquidacion: r.Id_Liquidacion == null ? null : num(r.Id_Liquidacion),
  observaciones: trim(r.Observaciones), whoCaptura: trim(r.WhoCaptura),
});

// ── Cartas porte (año actual + históricas) ──────────────────────────────────
let _tablasCP = null;
async function tablasCP(pool) {
  if (!_tablasCP) {
    const r = await pool.request().query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='Empresa2' AND (TABLE_NAME='CartaPorte' OR TABLE_NAME LIKE 'CartaPorte[0-9][0-9]')`);
    _tablasCP = r.recordset.map(t => 'Empresa2.' + t.TABLE_NAME).sort().reverse();   // nombres validados contra el catálogo
  }
  return _tablasCP;
}

// Operadores para elegir en el formulario (por id o nombre); los ACTIVOS primero.
async function buscarOperadores(q) {
  const pool = await getPool();
  q = trim(q);
  const r = await pool.request().input('q', sql.VarChar(80), '%' + q + '%').query(
    `SELECT TOP 40 ID_OPERADOR, LTRIM(RTRIM(OPERADOR)) AS OPERADOR, LTRIM(RTRIM(STATUS)) AS STATUS FROM Empresa2.Operadores
      WHERE OPERADOR LIKE @q OR CAST(ID_OPERADOR AS VARCHAR(10)) LIKE @q
      ORDER BY CASE WHEN UPPER(LTRIM(RTRIM(STATUS)))='ACTIVO' THEN 0 ELSE 1 END, OPERADOR`);
  return r.recordset.map(o => ({ idOperador: num(o.ID_OPERADOR), operador: trim(o.OPERADOR), status: trim(o.STATUS) }));
}

// Cartas porte DEL OPERADOR (año actual + históricas), con búsqueda opcional por número, para ligarlas a una incidencia.
// Trae la unidad del viaje.
async function buscarCartasPorte(q, idOperador) {
  q = trim(q).toUpperCase();
  idOperador = parseInt(idOperador, 10) || 0;
  if (!idOperador) throw err(400, 'Elija primero el operador.');
  const pool = await getPool();
  const out = [];
  for (const tabla of await tablasCP(pool)) {
    const rq = pool.request().input('op', sql.Int, idOperador);
    if (q) rq.input('q', sql.VarChar(40), '%' + q + '%');
    const r = await rq.query(
      `SELECT TOP 40 Serie, CartaPorte, Id_Operador, Operador, Id_Camion, FehcaCarga, FechaPedido, Status
         FROM ${tabla}
        WHERE Id_Operador=@op
          ${q ? "AND (UPPER(LTRIM(RTRIM(CartaPorte))) LIKE @q OR UPPER(LTRIM(RTRIM(Serie))) + '-' + UPPER(LTRIM(RTRIM(CartaPorte))) LIKE @q)" : ''}
        ORDER BY FechaPedido DESC`);
    r.recordset.forEach(c => out.push({
      serie: trim(c.Serie), cartaPorte: trim(c.CartaPorte), idOperador: num(c.Id_Operador), operador: trim(c.Operador),
      idCamion: trim(c.Id_Camion), fecha: fechaISO(c.FehcaCarga || c.FechaPedido), status: trim(c.Status),
    }));
  }
  out.sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  return out.slice(0, 40);
}

async function cartaPorteExacta(pool, serie, cartaPorte) {
  for (const tabla of await tablasCP(pool)) {
    const c = (await pool.request().input('s', sql.VarChar(3), serie).input('c', sql.VarChar(30), cartaPorte)
      .query(`SELECT TOP 1 Serie, CartaPorte, Id_Operador, Operador, Id_Camion, Status FROM ${tabla} WHERE LTRIM(RTRIM(Serie))=@s AND LTRIM(RTRIM(CartaPorte))=@c`)).recordset[0];
    if (c) return c;
  }
  return null;
}

// ── Consultas ───────────────────────────────────────────────────────────────
async function listar(f = {}) {
  await asegurarEsquema();
  const pool = await getPool();
  const pagina = Math.max(1, parseInt(f.page, 10) || 1);
  const tam = Math.min(200, Math.max(1, parseInt(f.pageSize, 10) || 25));
  const req = pool.request();
  const where = [];
  if (FECHA_RE.test(trim(f.fechaIni))) { req.input('fi', sql.Date, trim(f.fechaIni)); where.push('Fecha>=@fi'); }
  if (FECHA_RE.test(trim(f.fechaFin))) { req.input('ff', sql.Date, trim(f.fechaFin)); where.push('Fecha<=@ff'); }
  if (trim(f.buscar)) {
    const b = trim(f.buscar);
    if (/^\d+$/.test(b)) { req.input('bn', sql.Int, parseInt(b, 10)); where.push(`(Id_Operador=@bn OR Id_Incidencia=@bn OR CartaPorte LIKE '%' + @bt + '%')`); }
    else where.push(`(Operador LIKE '%' + @bt + '%' OR CartaPorte LIKE '%' + @bt + '%' OR TipoIncidencia LIKE '%' + @bt + '%')`);
    req.input('bt', sql.VarChar(80), b);
  }
  if (trim(f.status)) { req.input('st', sql.VarChar(20), trim(f.status).toUpperCase()); where.push('Status=@st'); }
  if (f.soloPendientes === '1' || f.soloPendientes === true) where.push('FlagCobOpe=1 AND MontoAdeudo>0 AND Status<>\'CANCELADA\'');
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await req.query(`SELECT COUNT(*) n FROM Empresa2.Incidencias ${W}`)).recordset[0].n;
  const rows = (await req.query(`SELECT * FROM Empresa2.Incidencias ${W} ORDER BY Fecha DESC, Id_Incidencia DESC
    OFFSET ${(pagina - 1) * tam} ROWS FETCH NEXT ${tam} ROWS ONLY`)).recordset;
  return { total, page: pagina, pageSize: tam, totalPages: Math.max(1, Math.ceil(total / tam)), rows: rows.map(filaAModelo) };
}

async function obtener(id) {
  await asegurarEsquema();
  const pool = await getPool();
  const inc = (await pool.request().input('id', sql.Int, parseInt(id, 10) || 0).query(`SELECT * FROM Empresa2.Incidencias WHERE Id_Incidencia=@id`)).recordset[0];
  if (!inc) throw err(404, 'Incidencia no encontrada.');
  const pagos = (await pool.request().input('id', sql.Int, inc.Id_Incidencia).query(`SELECT * FROM Empresa2.IncidenciasPagos WHERE Id_Incidencia=@id ORDER BY Id_Pago`)).recordset;
  const modelo = filaAModelo(inc);
  modelo.pagos = pagos.map(pagoAModelo);
  modelo.sugerido = modelo.flagCobOpe === 1 && modelo.status === ST_ACTIVA ? sugerido(modelo) : 0;
  return modelo;
}

// ── Alta / cambio / cancelación ─────────────────────────────────────────────
function validarCapturados(d) {
  const tipo = trim(d.tipoIncidencia);
  if (!tipo) throw err(400, 'Indique el tipo de incidencia.');
  if (tipo.length > 60) throw err(400, 'El tipo de incidencia admite máximo 60 caracteres.');
  const fecha = trim(d.fecha) || hoyISO();
  if (!FECHA_RE.test(fecha)) throw err(400, 'La fecha no es válida.');
  return { tipo, fecha, descripcion: trim(d.descripcion), observaciones: trim(d.observaciones).slice(0, 500) };
}

async function crear(d, quien) {
  d = d || {};
  const cap = validarCapturados(d);
  const cobro = normalizarCobro({ importe: d.importe, flagCobOpe: d.flagCobOpe, parcialidades: d.parcialidades });
  const serie = trim(d.serie), cp = trim(d.cartaPorte);
  if (!serie || !cp) throw err(400, 'La incidencia debe ir ligada a una Carta Porte.');
  return enTransaccion(async (tx, pool) => {
    const c = await cartaPorteExacta(pool, serie, cp);
    if (!c) throw err(400, `No existe la Carta Porte ${serie}-${cp}.`);
    if (trim(c.Status).toUpperCase().startsWith('CANCELAD')) throw err(400, `La Carta Porte ${serie}-${cp} está cancelada.`);
    if (!num(c.Id_Operador)) throw err(400, 'La Carta Porte no tiene operador asignado.');
    if (parseInt(d.idOperador, 10) && parseInt(d.idOperador, 10) !== num(c.Id_Operador)) throw err(400, `La Carta Porte ${serie}-${cp} es del operador ${num(c.Id_Operador)}, no del operador elegido.`);
    const id = (await new sql.Request(tx).query(`SELECT ISNULL(MAX(Id_Incidencia),0)+1 AS n FROM Empresa2.Incidencias WITH (UPDLOCK, HOLDLOCK)`)).recordset[0].n;
    await new sql.Request(tx).input('id', sql.Int, id).input('f', sql.Date, cap.fecha).input('op', sql.Int, num(c.Id_Operador))
      .input('opn', sql.VarChar(80), trim(c.Operador).slice(0, 80) || null).input('s', sql.VarChar(3), trim(c.Serie)).input('cp', sql.VarChar(30), trim(c.CartaPorte))
      .input('cam', sql.VarChar(10), trim(c.Id_Camion) || null).input('tipo', sql.VarChar(60), cap.tipo).input('desc', sql.VarChar(sql.MAX), cap.descripcion || null)
      .input('imp', sql.Decimal(11, 2), cobro.Importe).input('flag', sql.TinyInt, cobro.FlagCobOpe).input('parc', sql.Int, cobro.Parcialidades)
      .input('ip', sql.Decimal(11, 2), cobro.ImporteParcial).input('adeudo', sql.Decimal(11, 2), cobro.FlagCobOpe ? cobro.Importe : 0)
      .input('obs', sql.VarChar(500), cap.observaciones || null).input('who', sql.VarChar(80), trim(quien).slice(0, 80) || null).input('fc', sql.Date, hoyISO())
      .query(`INSERT INTO Empresa2.Incidencias(Id_Incidencia, Fecha, Id_Operador, Operador, Serie, CartaPorte, Id_Camion, TipoIncidencia, Descripcion,
                Importe, FlagCobOpe, Parcialidades, ImporteParcial, ImporteCob, MontoAdeudo, ParcialPag, Status, Observaciones, WhoCaptura, FechaCaptura)
              VALUES(@id, @f, @op, @opn, @s, @cp, @cam, @tipo, @desc, @imp, @flag, @parc, @ip, 0, @adeudo, 0, 'ACTIVA', @obs, @who, @fc)`);
    return id;
  }).then(obtener);
}

async function editar(id, d, quien) {
  d = d || {};
  id = parseInt(id, 10) || 0;
  const cap = validarCapturados(d);
  const cobro = normalizarCobro({ importe: d.importe, flagCobOpe: d.flagCobOpe, parcialidades: d.parcialidades });
  await enTransaccion(async (tx, pool) => {
    const inc = (await new sql.Request(tx).input('id', sql.Int, id).query(`SELECT * FROM Empresa2.Incidencias WITH (UPDLOCK, ROWLOCK) WHERE Id_Incidencia=@id`)).recordset[0];
    if (!inc) throw err(404, 'Incidencia no encontrada.');
    if (trim(inc.Status).toUpperCase() === ST_CANCELADA) throw err(409, 'La incidencia está CANCELADA: es de solo lectura.');
    const nPagos = (await new sql.Request(tx).input('id', sql.Int, id).query(`SELECT COUNT(*) n, ISNULL(SUM(Importe),0) cob FROM Empresa2.IncidenciasPagos WHERE Id_Incidencia=@id`)).recordset[0];
    let serie = trim(inc.Serie), cp = trim(inc.CartaPorte), idOp = num(inc.Id_Operador), opn = trim(inc.Operador), cam = trim(inc.Id_Camion);
    const cambioCP = trim(d.serie) && trim(d.cartaPorte) && (trim(d.serie) !== serie || trim(d.cartaPorte) !== cp);
    if (cambioCP) {
      if (nPagos.n > 0) throw err(409, 'La incidencia ya tiene cobros: no se puede cambiar su Carta Porte.');
      const c = await cartaPorteExacta(pool, trim(d.serie), trim(d.cartaPorte));
      if (!c) throw err(400, `No existe la Carta Porte ${trim(d.serie)}-${trim(d.cartaPorte)}.`);
      if (trim(c.Status).toUpperCase().startsWith('CANCELAD')) throw err(400, 'La Carta Porte está cancelada.');
      if (parseInt(d.idOperador, 10) && parseInt(d.idOperador, 10) !== num(c.Id_Operador)) throw err(400, `La Carta Porte ${trim(d.serie)}-${trim(d.cartaPorte)} es del operador ${num(c.Id_Operador)}, no del operador elegido.`);
      serie = trim(c.Serie); cp = trim(c.CartaPorte); idOp = num(c.Id_Operador); opn = trim(c.Operador); cam = trim(c.Id_Camion);
    }
    if (nPagos.n > 0) {
      if (!cobro.FlagCobOpe) throw err(409, 'La incidencia ya tiene cobros: no se puede dejar de cobrar al operador. Quite primero los cobros.');
      if (cobro.Importe + 0.004 < r2(nPagos.cob)) throw err(409, `El importe no puede ser menor a lo ya cobrado (${r2(nPagos.cob).toFixed(2)}).`);
      if (cobro.Parcialidades < nPagos.n) throw err(409, `Las parcialidades no pueden ser menos que las ya cobradas (${nPagos.n}).`);
    }
    await new sql.Request(tx).input('id', sql.Int, id).input('f', sql.Date, cap.fecha).input('op', sql.Int, idOp).input('opn', sql.VarChar(80), opn.slice(0, 80) || null)
      .input('s', sql.VarChar(3), serie).input('cp', sql.VarChar(30), cp).input('cam', sql.VarChar(10), cam || null)
      .input('tipo', sql.VarChar(60), cap.tipo).input('desc', sql.VarChar(sql.MAX), cap.descripcion || null)
      .input('imp', sql.Decimal(11, 2), cobro.Importe).input('flag', sql.TinyInt, cobro.FlagCobOpe).input('parc', sql.Int, cobro.Parcialidades)
      .input('ip', sql.Decimal(11, 2), cobro.ImporteParcial).input('obs', sql.VarChar(500), cap.observaciones || null)
      .query(`UPDATE Empresa2.Incidencias SET Fecha=@f, Id_Operador=@op, Operador=@opn, Serie=@s, CartaPorte=@cp, Id_Camion=@cam, TipoIncidencia=@tipo, Descripcion=@desc,
                     Importe=@imp, FlagCobOpe=@flag, Parcialidades=@parc, ImporteParcial=@ip, Observaciones=@obs WHERE Id_Incidencia=@id`);
    await recomputar(tx, id, quien);
  });
  return obtener(id);
}

// Cancelar: la incidencia queda CANCELADA (solo lectura). Solo si no tiene cobros aplicados.
async function cancelar(id, quien) {
  id = parseInt(id, 10) || 0;
  await enTransaccion(async (tx) => {
    const inc = (await new sql.Request(tx).input('id', sql.Int, id).query(`SELECT Status FROM Empresa2.Incidencias WITH (UPDLOCK, ROWLOCK) WHERE Id_Incidencia=@id`)).recordset[0];
    if (!inc) throw err(404, 'Incidencia no encontrada.');
    if (trim(inc.Status).toUpperCase() === ST_CANCELADA) throw err(409, 'La incidencia ya está CANCELADA.');
    const n = (await new sql.Request(tx).input('id', sql.Int, id).query(`SELECT COUNT(*) n FROM Empresa2.IncidenciasPagos WHERE Id_Incidencia=@id`)).recordset[0].n;
    if (n > 0) throw err(409, 'La incidencia ya tiene cobros aplicados: quítelos antes de cancelarla.');
    await new sql.Request(tx).input('id', sql.Int, id).input('who', sql.VarChar(80), trim(quien).slice(0, 80) || null).input('f', sql.Date, hoyISO())
      .query(`UPDATE Empresa2.Incidencias SET Status='CANCELADA', MontoAdeudo=0, WhoModifica=@who, FechaUltMod=@f WHERE Id_Incidencia=@id`);
  });
  return obtener(id);
}

// ── Cobros ──────────────────────────────────────────────────────────────────
// Inserta un cobro (valida contra el adeudo) y recalcula la incidencia. Se usa tanto desde la pantalla
// de Incidencias (MANUAL) como desde Liquidaciones (LIQUIDACION, con Mes + Id_Liquidacion).
async function insertarPago(tx, { idIncidencia, importe, origen, mes, idLiquidacion, fecha, observaciones }, quien) {
  const inc = (await new sql.Request(tx).input('id', sql.Int, idIncidencia).query(`SELECT * FROM Empresa2.Incidencias WITH (UPDLOCK, ROWLOCK) WHERE Id_Incidencia=@id`)).recordset[0];
  if (!inc) throw err(404, `Incidencia ${idIncidencia} no encontrada.`);
  const st = trim(inc.Status).toUpperCase();
  if (st === ST_CANCELADA) throw err(409, `La incidencia ${idIncidencia} está CANCELADA.`);
  if (num(inc.FlagCobOpe) !== 1) throw err(409, `La incidencia ${idIncidencia} no es cobrable al operador.`);
  const imp = r2(importe);
  if (!isFinite(imp) || imp <= 0) throw err(400, 'El importe del cobro debe ser mayor a 0.');
  if (imp > r2(num(inc.MontoAdeudo)) + 0.004) throw err(400, `El cobro (${imp.toFixed(2)}) excede el adeudo de la incidencia ${idIncidencia} (${r2(num(inc.MontoAdeudo)).toFixed(2)}).`);
  const idPago = (await new sql.Request(tx).input('id', sql.Int, idIncidencia).query(`SELECT ISNULL(MAX(Id_Pago),0)+1 AS n FROM Empresa2.IncidenciasPagos WITH (UPDLOCK, HOLDLOCK) WHERE Id_Incidencia=@id`)).recordset[0].n;
  await new sql.Request(tx).input('id', sql.Int, idIncidencia).input('p', sql.Int, idPago).input('f', sql.Date, fecha || hoyISO()).input('imp', sql.Decimal(11, 2), imp)
    .input('o', sql.VarChar(15), origen).input('mes', sql.Decimal(3, 0), mes == null ? null : mes).input('liq', sql.Decimal(9, 0), idLiquidacion == null ? null : idLiquidacion)
    .input('obs', sql.VarChar(200), trim(observaciones).slice(0, 200) || null).input('who', sql.VarChar(80), trim(quien).slice(0, 80) || null).input('fc', sql.Date, hoyISO())
    .query(`INSERT INTO Empresa2.IncidenciasPagos(Id_Incidencia, Id_Pago, Fecha, Importe, Origen, Mes, Id_Liquidacion, Observaciones, WhoCaptura, FechaCaptura)
            VALUES(@id, @p, @f, @imp, @o, @mes, @liq, @obs, @who, @fc)`);
  await recomputar(tx, idIncidencia, quien);
  return idPago;
}

// Cobro capturado a mano (el operador pagó directamente, fuera de una liquidación).
async function registrarCobroManual(id, d, quien) {
  id = parseInt(id, 10) || 0;
  d = d || {};
  const fecha = trim(d.fecha) || hoyISO();
  if (!FECHA_RE.test(fecha)) throw err(400, 'La fecha del cobro no es válida.');
  await enTransaccion(tx => insertarPago(tx, { idIncidencia: id, importe: d.importe, origen: 'MANUAL', fecha, observaciones: d.observaciones }, quien));
  return obtener(id);
}

// Quita un cobro MANUAL (los descontados en una liquidación se quitan desde esa liquidación).
async function quitarCobroManual(id, idPago, quien) {
  id = parseInt(id, 10) || 0;
  await enTransaccion(async (tx) => {
    const p = (await new sql.Request(tx).input('id', sql.Int, id).input('p', sql.Int, parseInt(idPago, 10) || 0)
      .query(`SELECT Origen FROM Empresa2.IncidenciasPagos WITH (UPDLOCK) WHERE Id_Incidencia=@id AND Id_Pago=@p`)).recordset[0];
    if (!p) throw err(404, 'Cobro no encontrado.');
    if (trim(p.Origen).toUpperCase() !== 'MANUAL') throw err(409, 'Este cobro se descontó en una liquidación: quítelo desde la liquidación.');
    await new sql.Request(tx).input('id', sql.Int, id).input('p', sql.Int, parseInt(idPago, 10))
      .query(`DELETE FROM Empresa2.IncidenciasPagos WHERE Id_Incidencia=@id AND Id_Pago=@p`);
    await recomputar(tx, id, quien);
  });
  return obtener(id);
}

// ── Integración con Liquidaciones ───────────────────────────────────────────
// Incidencias cobrables del operador con adeudo (con el importe sugerido a descontar) y las ya descontadas en esta liquidación.
async function paraLiquidacion(db, idOperador, mes, numero) {
  await asegurarEsquema();
  const pend = (await new sql.Request(db).input('op', sql.Int, idOperador).input('mes', sql.Decimal(3, 0), mes).input('liq', sql.Decimal(9, 0), numero).query(
    `SELECT i.* FROM Empresa2.Incidencias i
      WHERE i.Id_Operador=@op AND i.FlagCobOpe=1 AND i.Status='ACTIVA' AND i.MontoAdeudo>0
        AND NOT EXISTS (SELECT 1 FROM Empresa2.IncidenciasPagos p WHERE p.Id_Incidencia=i.Id_Incidencia AND p.Mes=@mes AND p.Id_Liquidacion=@liq)
      ORDER BY i.Fecha, i.Id_Incidencia`)).recordset.map(filaAModelo).map(i => ({ ...i, sugerido: sugerido(i) }));
  const aplicadas = (await new sql.Request(db).input('mes', sql.Decimal(3, 0), mes).input('liq', sql.Decimal(9, 0), numero).query(
    `SELECT p.Id_Incidencia, p.Id_Pago, p.Importe, i.TipoIncidencia, i.Serie, i.CartaPorte, i.Fecha AS FechaInc, i.Parcialidades, i.Importe AS ImporteInc, i.MontoAdeudo
       FROM Empresa2.IncidenciasPagos p JOIN Empresa2.Incidencias i ON i.Id_Incidencia=p.Id_Incidencia
      WHERE p.Mes=@mes AND p.Id_Liquidacion=@liq ORDER BY p.Id_Incidencia, p.Id_Pago`)).recordset.map(r => ({
    idIncidencia: num(r.Id_Incidencia), idPago: num(r.Id_Pago), importe: num(r.Importe), tipoIncidencia: trim(r.TipoIncidencia),
    cartaPorte: `${trim(r.Serie)}-${trim(r.CartaPorte)}`, fechaIncidencia: fechaISO(r.FechaInc), importeIncidencia: num(r.ImporteInc), montoAdeudo: num(r.MontoAdeudo),
  }));
  return { pendientes: pend, aplicadas };
}

// Aplica (descuenta) cobros de incidencias en una liquidación. items = [{ idIncidencia, importe }].
async function aplicarEnLiquidacion(tx, idOperador, mes, numero, items, quien) {
  if (!Array.isArray(items) || !items.length) throw err(400, 'Seleccione al menos una incidencia.');
  const vistos = new Set();
  for (const it of items) {
    const idInc = parseInt(it.idIncidencia, 10) || 0;
    if (vistos.has(idInc)) throw err(400, `La incidencia ${idInc} viene repetida.`);
    vistos.add(idInc);
    const inc = (await new sql.Request(tx).input('id', sql.Int, idInc).query(`SELECT Id_Operador FROM Empresa2.Incidencias WHERE Id_Incidencia=@id`)).recordset[0];
    if (!inc) throw err(404, `Incidencia ${idInc} no encontrada.`);
    if (num(inc.Id_Operador) !== idOperador) throw err(400, `La incidencia ${idInc} es de otro operador.`);
    const ya = (await new sql.Request(tx).input('id', sql.Int, idInc).input('mes', sql.Decimal(3, 0), mes).input('liq', sql.Decimal(9, 0), numero)
      .query(`SELECT COUNT(*) n FROM Empresa2.IncidenciasPagos WHERE Id_Incidencia=@id AND Mes=@mes AND Id_Liquidacion=@liq`)).recordset[0].n;
    if (ya > 0) throw err(409, `La incidencia ${idInc} ya está descontada en esta liquidación.`);
    await insertarPago(tx, { idIncidencia: idInc, importe: it.importe, origen: 'LIQUIDACION', mes, idLiquidacion: numero, observaciones: `Liquidación ${mes}-${numero}` }, quien);
  }
}

// Quita un cobro descontado en la liquidación indicada.
async function quitarDeLiquidacion(tx, mes, numero, idIncidencia, idPago, quien) {
  const r = await new sql.Request(tx).input('id', sql.Int, parseInt(idIncidencia, 10) || 0).input('p', sql.Int, parseInt(idPago, 10) || 0)
    .input('mes', sql.Decimal(3, 0), mes).input('liq', sql.Decimal(9, 0), numero)
    .query(`DELETE FROM Empresa2.IncidenciasPagos WHERE Id_Incidencia=@id AND Id_Pago=@p AND Mes=@mes AND Id_Liquidacion=@liq`);
  if (!r.rowsAffected[0]) throw err(404, 'Ese cobro no está en esta liquidación.');
  await recomputar(tx, parseInt(idIncidencia, 10), quien);
}

// Cancelar / eliminar una liquidación: sus cobros de incidencias se revierten (las incidencias vuelven a tener adeudo).
async function revertirLiquidacion(tx, mes, numero, quien) {
  const ids = (await new sql.Request(tx).input('mes', sql.Decimal(3, 0), mes).input('liq', sql.Decimal(9, 0), numero)
    .query(`SELECT DISTINCT Id_Incidencia FROM Empresa2.IncidenciasPagos WITH (UPDLOCK) WHERE Mes=@mes AND Id_Liquidacion=@liq`)).recordset;
  if (!ids.length) return;
  await new sql.Request(tx).input('mes', sql.Decimal(3, 0), mes).input('liq', sql.Decimal(9, 0), numero)
    .query(`DELETE FROM Empresa2.IncidenciasPagos WHERE Mes=@mes AND Id_Liquidacion=@liq`);
  for (const i of ids) await recomputar(tx, i.Id_Incidencia, quien);
}

// Total descontado por incidencias en la liquidación (fuente de verdad: IncidenciasPagos).
async function totalLiquidacion(db, mes, numero) {
  const r = (await new sql.Request(db).input('mes', sql.Decimal(3, 0), mes).input('liq', sql.Decimal(9, 0), numero)
    .query(`SELECT ISNULL(SUM(Importe),0) AS t FROM Empresa2.IncidenciasPagos WHERE Mes=@mes AND Id_Liquidacion=@liq`)).recordset[0];
  return r2(r.t);
}

module.exports = {
  asegurarEsquema, listar, obtener, crear, editar, cancelar, buscarOperadores, buscarCartasPorte, registrarCobroManual, quitarCobroManual,
  paraLiquidacion, aplicarEnLiquidacion, quitarDeLiquidacion, revertirLiquidacion, totalLiquidacion,
};
