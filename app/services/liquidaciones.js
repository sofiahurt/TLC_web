'use strict';

// ── Liquidaciones de operadores: capa de datos ──────────────────────────────
// Cabecera = Empresa2.Liquida (clave MES + ID_LIQUIDACION; el número se reinicia cada mes)
// Renglón  = Empresa2.LiqDeta (un renglón por carta porte; clave MES + ID_LIQUIDACION + ID_LIQDETA)
// Las cartas porte se consultan de Empresa2.CartaPorte (año actual) o Empresa2.CartaPorteAA (histórico).
//
// Todo el cálculo vive en liquidaciones-calc.js; aquí solo se lee, se persiste y se valida.
// Cada operación que cambia datos corre en UNA transacción y termina recalculando los totales.

const { getPool, sql } = require('../config/db');
const cfg = require('../config/liquidaciones');
const { calcularTotales, comisionRenglon, repartirCentavos, aCentavos, deCentavos, CONCEPTOS } = require('./liquidaciones-calc');

const trim = v => (v == null ? '' : String(v).trim());
const num = v => (v == null || v === '' || isNaN(Number(v)) ? 0 : Number(v));
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const fechaISO = d => (d instanceof Date ? d.toISOString().slice(0, 10) : trim(d));
const hoyISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const err = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

// ── Esquema ─────────────────────────────────────────────────────────────────
// DifAplicada = lo que "aplicar diferencias" ya sumó a ExtraDescuento (evita sumarlo dos veces).
let _esquema = null;
function asegurarEsquema() {
  if (!_esquema) {
    // Columnas que el esquema legado no traía: Estadías y Demoras (conceptos de DepoSolicitud),
    // y Costo Renta / Costo Kilómetros por viaje.
    const nuevas = [['Empresa2.Liquida', 'DifAplicada', 'DECIMAL(13,2)'], ['Empresa2.LiqDeta', 'COSTORENTA', 'DECIMAL(18,2)'], ['Empresa2.LiqDeta', 'COSTOKILOMETROS', 'DECIMAL(18,2)']];
    ['ESTADIAS', 'DEMORAS'].forEach(c => ['', 'REAL', 'DIF'].forEach(s => nuevas.push(['Empresa2.Liquida', `COSTO${c}${s}`, 'DECIMAL(18,2)'])));
    _esquema = getPool().then(async pool => {
      for (const [t, c, tipo] of nuevas) {
        await pool.request().query(`IF COL_LENGTH('${t}', '${c}') IS NULL ALTER TABLE ${t} ADD ${c} ${tipo} NULL`);
      }
    }).catch(e => { _esquema = null; throw e; });
  }
  return _esquema;
}

// ── Cartas porte: tabla del año actual o histórica ──────────────────────────
let _tablasCP = null;   // { anio: 'Empresa2.CartaPorteAA' }
async function tablasHistoricas(pool) {
  if (!_tablasCP) {
    const r = await pool.request().query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='Empresa2' AND TABLE_NAME LIKE 'CartaPorte[0-9][0-9]'`);
    _tablasCP = {};
    r.recordset.forEach(t => { _tablasCP[2000 + parseInt(t.TABLE_NAME.slice(-2), 10)] = 'Empresa2.' + t.TABLE_NAME; });
  }
  return _tablasCP;
}
// Nombre de tabla validado contra el catálogo (nunca se arma SQL con datos del usuario).
async function tablaCP(pool, anio) {
  anio = parseInt(anio, 10);
  if (anio === cfg.anioTablaActual()) return 'Empresa2.CartaPorte';
  const t = (await tablasHistoricas(pool))[anio];
  if (!t) throw err(400, `No existe la tabla de cartas porte del año ${anio}.`);
  return t;
}
async function aniosCP(pool) {
  const hist = Object.keys(await tablasHistoricas(pool)).map(Number).filter(a => a !== cfg.anioTablaActual());
  return [cfg.anioTablaActual(), ...hist.sort((a, b) => b - a)];
}

// ── Mapeo modelo <-> columnas ───────────────────────────────────────────────
const ESCALARES = {
  fecha: 'FECHA', status: 'STATUS', idOperador: 'ID_OPERADOR', operador: 'OPERADOR',
  sueldoBase: 'SUELDOBASE', imss: 'IMSS', infonavit: 'INFONAVIT', extraComision: 'EXTRACOMISION', extraDescuento: 'EXTRADESCUENTO',
  totalComision: 'TOTALCOMISION', dieselPermitido: 'DISELPERMITIDO', dieselRellenado: 'DISELRELLENADO', desDiesel: 'DESDISEL',
  totalDesc: 'TOTALDESC', totalAdelanto: 'TOTALADELANTO', totalLiquidacion: 'TOTALLIQUIDACION', totalViaje: 'TOTALVIAJE',
  granTotalLiq: 'GRANTOTALLIQ', totalFlete: 'TOTALFLETE', totalUtilidad: 'TOTALUTILIDAD', totalDif: 'TOTALDIF',
  descripcionOtros: 'DESOTROSCOSTOS',
};
// concepto -> [estimado, real, dif] (+ sinIva para caseta)
const COLS_CONCEPTO = {
  maniobras:    ['TOTALMANIOBRAS', 'TOTALMANREAL', 'TOTALMANDIF'],
  prestamo:     ['COSTOPRESTAMO', 'COSTOPRESTAMOREAL', 'COSTOPRESTAMODIF'],
  talacha:      ['COSTOTALACHA', 'COSTOTALACHAREAL', 'COSTOTALACHADIF'],
  compllanta:   ['COSTOCOMPLLANTA', 'COSTOCOMPLLANTAREAL', 'COSTOCOMPLLANTADIF'],
  comidas:      ['COSTOCOMIDAS', 'COSTOCOMIDASREAL', 'COSTOCOMIDASDIF'],
  caseta:       ['COSTOCASETATICK', 'COSTOCASETATICKREAL', 'COSTOCASETATICKDIF'],
  maniobrasExt: ['COSTOMANIOBRASEXT', 'COSTOMANIOBRASEXTREAL', 'COSTOMANIOBRASEXTDIF'],
  pension:      ['COSTOPENSION', 'COSTOPENSIONREAL', 'COSTOPENSIONDIF'],
  refacciones:  ['COSTOREFACCIONES', 'COSTOREFACCIONESREAL', 'COSTOREFACCIONESDIF'],
  diesel:       ['COSTODIESEL', 'COSTODIESELREAL', 'COSTODIESELDIF'],
  estadias:     ['COSTOESTADIAS', 'COSTOESTADIASREAL', 'COSTOESTADIASDIF'],
  demoras:      ['COSTODEMORAS', 'COSTODEMORASREAL', 'COSTODEMORASDIF'],
  otros:        ['COSTOOTROS', 'COSTOOTROSREAL', 'COSTOOTROSDIF'],
};
const COL_CASETA_SINIVA = 'COSTOCASETATICKS';
// Columna de DepoSolicitud que alimenta cada concepto (la báscula va a maniobras extra).
const COL_DEPOSITO = {
  maniobras: 'Maniobra', prestamo: 'Prestamo', talacha: 'Talachas', compllanta: 'Llantas', comidas: 'Comidas', caseta: 'Casetas',
  maniobrasExt: 'Bascula', pension: 'Pension', refacciones: 'Refacciones', diesel: 'Diesel', estadias: 'Estadias', demoras: 'Demoras', otros: 'Otros',
};
const ESCALARES_TEXTO = new Set(['fecha', 'status', 'operador', 'descripcionOtros']);

const idLiq = (mes, numero) => `${mes}-${numero}`;
function parseId(id) {
  const m = /^(\d{1,2})-(\d{1,9})$/.exec(String(id || '').trim());
  if (!m) throw err(400, 'Identificador de liquidación inválido (formato mes-número, p. ej. 10-3).');
  return { mes: parseInt(m[1], 10), numero: parseInt(m[2], 10) };
}

function filaAModelo(r) {
  const liq = { id: idLiq(r.MES, r.ID_LIQUIDACION), mes: num(r.MES), numero: num(r.ID_LIQUIDACION) };
  for (const [k, col] of Object.entries(ESCALARES)) liq[k] = ESCALARES_TEXTO.has(k) ? (k === 'fecha' ? fechaISO(r[col]) : trim(r[col])) : num(r[col]);
  for (const [k, [e, re, d]] of Object.entries(COLS_CONCEPTO)) liq[k] = { estimado: num(r[e]), real: num(r[re]), dif: num(r[d]) };
  liq.caseta.sinIva = num(r[COL_CASETA_SINIVA]);
  // DifAplicada guarda la diferencia aplicada al total (con signo); distinta de 0 = "aplicar diferencias" activo.
  liq.difAplicada = num(r.DifAplicada);
  liq.aplicarDif = liq.difAplicada !== 0;
  return liq;
}

function renglonAModelo(r, costos) {
  const modelo = {
    idDeta: num(r.ID_LIQDETA), idLiquidacion: num(r.ID_LIQUIDACION), mes: num(r.MES), idPedido: num(r.ID_PEDIDO),
    idCliente: num(r.ID_CLIENTE), cliente: trim(r.CLIENTE), serie: trim(r.SERIE), cartaPorte: trim(r.CARTAPORTE),
    anioCP: num(r.ANIOCP), fechaViaje: fechaISO(r.FECHAVIAJE), idTarifa: num(r.ID_TARIFA), desFlete: trim(r.DESFLETE),
    costoFlete: num(r.COSTOFLETE), costoManiobras: num(r.COSTOMANIOBRAS), costoRenta: num(r.COSTORENTA), costoKilometros: num(r.COSTOKILOMETROS),
    kilometros: num(r.KILOMETROS),
    pagoKilometro: num(r.PAGOKILOMETRO), pagoViaje: num(r.PAGOVIAJE), dieselPermitido: num(r.DIESELPERMITIDO),
    costos: costos || {},   // solo lectura: vienen de la carta porte
  };
  modelo.comision = comisionRenglon(modelo);
  return modelo;
}

// ── Lectura ─────────────────────────────────────────────────────────────────
async function leerCabecera(req, mes, numero, bloquear) {
  const r = await req.input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero)
    .query(`SELECT * FROM Empresa2.Liquida ${bloquear ? 'WITH (UPDLOCK, ROWLOCK)' : ''} WHERE MES=@mes AND ID_LIQUIDACION=@num`);
  if (!r.recordset[0]) throw err(404, 'Liquidación no encontrada.');
  return r.recordset[0];
}

// Tablas de DepoSolicitud por año: la del año actual y las históricas (DepoSolicitudAA), con sus columnas.
let _tablasDepo = null;   // { 'DepoSolicitud25': Set(columnas) }
async function columnasDepositos(pool) {
  if (!_tablasDepo) {
    const r = await pool.request().query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='Empresa2' AND TABLE_NAME LIKE 'DepoSolicitud%'`);
    _tablasDepo = {};
    r.recordset.forEach(c => { (_tablasDepo[c.TABLE_NAME] = _tablasDepo[c.TABLE_NAME] || new Set()).add(c.COLUMN_NAME.toLowerCase()); });
  }
  return _tablasDepo;
}

// Costos por concepto de cada viaje = lo DEPOSITADO en sus solicitudes VALIDADAS en DepoSolicitud (Validado=1),
// no lo solicitado. MontoDepositado es un total por solicitud: se reparte entre sus rubros en proporción a lo
// solicitado de cada uno (con un solo rubro es directo). Si una solicitud no trae MontoDepositado (tablas
// históricas, que además no tienen Validado y usan FlagDeposito=1), se toma lo solicitado.
// Devuelve { 'anio|serie|cp': { concepto: importe } }.
async function costosDeDepositos(pool, filas) {
  const porAnio = {};
  filas.forEach(r => { (porAnio[num(r.ANIOCP)] = porAnio[num(r.ANIOCP)] || []).push(r); });
  const out = {};
  const tablas = await columnasDepositos(pool);
  for (const [anio, grupo] of Object.entries(porAnio)) {
    const nombre = parseInt(anio, 10) === cfg.anioTablaActual() ? 'DepoSolicitud' : `DepoSolicitud${String(anio).slice(-2)}`;
    const cols = tablas[nombre];
    if (!cols) continue;
    const q = new sql.Request(pool);
    const cond = grupo.map((f, i) => {
      q.input('s' + i, sql.VarChar(3), trim(f.SERIE)).input('c' + i, sql.VarChar(30), trim(f.CARTAPORTE));
      return `(LTRIM(RTRIM(Serie))=@s${i} AND LTRIM(RTRIM(CartaPorte))=@c${i})`;
    }).join(' OR ');
    const validado = cols.has('validado') ? 'ISNULL(Validado,0)=1' : 'ISNULL(FlagDeposito,0)=1';
    const rubros = CONCEPTOS.map(k => (cols.has(COL_DEPOSITO[k].toLowerCase()) ? `ISNULL(${COL_DEPOSITO[k]},0) AS ${k}` : `CAST(0 AS DECIMAL(18,2)) AS ${k}`)).join(', ');
    const monto = cols.has('montodepositado') ? 'MontoDepositado' : 'CAST(NULL AS DECIMAL(18,2)) AS MontoDepositado';
    const res = await q.query(`SELECT LTRIM(RTRIM(Serie)) AS Serie, LTRIM(RTRIM(CartaPorte)) AS CartaPorte, ${rubros}, ${monto}
      FROM Empresa2.${nombre} WHERE ${validado} AND (${cond})`);
    res.recordset.forEach(c => {
      const llave = `${anio}|${c.Serie}|${c.CartaPorte}`;
      const acum = out[llave] = out[llave] || Object.fromEntries(CONCEPTOS.map(k => [k, 0]));
      const solicitado = CONCEPTOS.map(k => aCentavos(c[k]));
      let reparto = solicitado;                                   // sin monto depositado: lo solicitado
      if (c.MontoDepositado != null) {
        const dep = aCentavos(c.MontoDepositado);
        reparto = solicitado.some(v => v > 0) ? repartirCentavos(dep, solicitado)
          : CONCEPTOS.map(k => (k === 'otros' ? dep : 0));        // depositado sin rubro solicitado: va a Otros
      }
      CONCEPTOS.forEach((k, i) => { acum[k] = deCentavos(aCentavos(acum[k]) + reparto[i]); });
    });
  }
  return out;
}

// Renglones de la liquidación con los costos que traen sus depósitos validados (solo lectura).
async function leerRenglones(pool, mes, numero) {
  const rs = (await new sql.Request(pool)
    .input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero)
    .query(`SELECT * FROM Empresa2.LiqDeta WHERE MES=@mes AND ID_LIQUIDACION=@num ORDER BY ID_LIQDETA`)).recordset;
  const costos = rs.length ? await costosDeDepositos(pool, rs) : {};
  return rs.map(r => {
    const c = costos[`${num(r.ANIOCP)}|${trim(r.SERIE)}|${trim(r.CARTAPORTE)}`];
    const porConcepto = {};
    CONCEPTOS.forEach(k => { porConcepto[k] = r2(c ? num(c[k]) : 0); });
    return renglonAModelo(r, porConcepto);
  });
}

async function modeloCompleto(pool, mes, numero) {
  const cab = await leerCabecera(new sql.Request(pool), mes, numero, false);
  const liq = filaAModelo(cab);
  liq.viajes = await leerRenglones(pool, mes, numero);
  return liq;
}

// ── Persistencia de totales ─────────────────────────────────────────────────
async function persistir(tx, liq, quien) {
  const q = new sql.Request(tx).input('mes', sql.Decimal(3, 0), liq.mes).input('num', sql.Decimal(9, 0), liq.numero);
  const sets = [];
  const poner = (col, tipo, valor, p) => { q.input(p, tipo, valor); sets.push(`${col}=@${p}`); };
  for (const k of ['sueldoBase', 'imss', 'infonavit', 'extraComision', 'extraDescuento', 'totalComision',
    'dieselPermitido', 'dieselRellenado', 'desDiesel', 'totalDesc', 'totalAdelanto', 'totalLiquidacion', 'totalViaje',
    'granTotalLiq', 'totalFlete', 'totalUtilidad', 'totalDif']) poner(ESCALARES[k], sql.Decimal(18, 2), r2(liq[k]), 'p_' + k);
  poner(ESCALARES.descripcionOtros, sql.VarChar(299), trim(liq.descripcionOtros).slice(0, 299) || null, 'p_desc');
  CONCEPTOS.forEach(k => {
    const [e, re, d] = COLS_CONCEPTO[k];
    poner(e, sql.Decimal(18, 2), r2(liq[k].estimado), 'e_' + k);
    poner(re, sql.Decimal(18, 2), r2(liq[k].real), 'r_' + k);
    poner(d, sql.Decimal(18, 2), r2(liq[k].dif), 'd_' + k);
  });
  poner(COL_CASETA_SINIVA, sql.Decimal(18, 2), r2(liq.caseta.sinIva), 'p_sinIva');
  poner('DifAplicada', sql.Decimal(13, 2), r2(liq.difAplicada), 'p_difApl');
  poner('WHOMODIFICA', sql.VarChar(79), trim(quien).slice(0, 79) || null, 'p_who');
  poner('FECHAULTMOD', sql.Date, hoyISO(), 'p_fum');
  await q.query(`UPDATE Empresa2.Liquida SET ${sets.join(', ')} WHERE MES=@mes AND ID_LIQUIDACION=@num`);
}

// Un "real" que quedó IGUAL al estimado se llenó solo (no lo capturó nadie): se suelta para que siga al estimado
// nuevo cuando cambian las cartas porte o los depósitos. Los reales capturados (distintos del estimado) se respetan.
function soltarRealesAutomaticos(liq) {
  CONCEPTOS.forEach(k => { if (liq[k].real === liq[k].estimado) liq[k].real = 0; });
}

// Recalcula desde cero (cabecera + renglones con costos) y guarda. Devuelve el modelo completo.
async function recalcular(tx, mes, numero, quien, ajustar) {
  const cab = await leerCabecera(new sql.Request(tx), mes, numero, true);
  const base = filaAModelo(cab);
  soltarRealesAutomaticos(base);
  if (ajustar) ajustar(base);
  const viajes = await leerRenglones(tx, mes, numero);
  const calculado = calcularTotales(base, viajes);
  await persistir(tx, calculado, quien);
  calculado.viajes = viajes;
  return calculado;
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

const esGenerada = cab => trim(cab.STATUS).toUpperCase() === cfg.STATUS_GENERADA;
function exigirGenerada(cab) {
  if (!esGenerada(cab)) throw err(409, `La liquidación está ${trim(cab.STATUS).toUpperCase() || 'cerrada'}: es de solo lectura.`);
}

// ── Consultas ───────────────────────────────────────────────────────────────
async function listar(f = {}) {
  await asegurarEsquema();
  const pool = await getPool();
  const pagina = Math.max(1, parseInt(f.page, 10) || 1);
  const tam = Math.min(200, Math.max(1, parseInt(f.pageSize, 10) || 25));
  const req = pool.request();
  const where = [];
  const mes = f.mes === '' || f.mes == null ? cfg.mesActivo() : parseInt(f.mes, 10);
  if (f.mes !== 'todos' && mes) { req.input('mes', sql.Decimal(3, 0), mes); where.push('l.MES=@mes'); }
  if (trim(f.operador)) {
    if (/^\d+$/.test(trim(f.operador))) { req.input('op', sql.Int, parseInt(f.operador, 10)); where.push('l.ID_OPERADOR=@op'); }
    else { req.input('opn', sql.VarChar(60), '%' + trim(f.operador) + '%'); where.push('l.OPERADOR LIKE @opn'); }
  }
  if (trim(f.status)) { req.input('st', sql.VarChar(20), trim(f.status).toUpperCase()); where.push('UPPER(LTRIM(RTRIM(l.STATUS)))=@st'); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trim(f.fechaIni))) { req.input('fi', sql.Date, trim(f.fechaIni)); where.push('l.FECHA>=@fi'); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trim(f.fechaFin))) { req.input('ff', sql.Date, trim(f.fechaFin)); where.push('l.FECHA<=@ff'); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await req.query(`SELECT COUNT(*) n FROM Empresa2.Liquida l ${W}`)).recordset[0].n;
  const rows = (await req.query(`SELECT l.MES, l.ID_LIQUIDACION, l.FECHA, l.ID_OPERADOR, l.OPERADOR, l.TOTALLIQUIDACION, l.STATUS, l.WHOCAPTURA
    FROM Empresa2.Liquida l ${W} ORDER BY l.MES DESC, l.FECHA DESC, l.ID_LIQUIDACION DESC
    OFFSET ${(pagina - 1) * tam} ROWS FETCH NEXT ${tam} ROWS ONLY`)).recordset;
  // cartas porte de las liquidaciones de la página
  const cps = {};
  if (rows.length) {
    const q = pool.request();
    const cond = rows.map((r, i) => { q.input('m' + i, sql.Decimal(3, 0), r.MES).input('n' + i, sql.Decimal(9, 0), r.ID_LIQUIDACION); return `(MES=@m${i} AND ID_LIQUIDACION=@n${i})`; }).join(' OR ');
    (await q.query(`SELECT MES, ID_LIQUIDACION, CARTAPORTE FROM Empresa2.LiqDeta WHERE ${cond} ORDER BY ID_LIQDETA`)).recordset
      .forEach(d => { (cps[idLiq(d.MES, d.ID_LIQUIDACION)] = cps[idLiq(d.MES, d.ID_LIQUIDACION)] || []).push(trim(d.CARTAPORTE)); });
  }
  return {
    total, page: pagina, pageSize: tam, totalPages: Math.max(1, Math.ceil(total / tam)),
    rows: rows.map(r => ({
      id: idLiq(r.MES, r.ID_LIQUIDACION), mes: num(r.MES), numero: num(r.ID_LIQUIDACION), fecha: fechaISO(r.FECHA),
      idOperador: num(r.ID_OPERADOR), operador: trim(r.OPERADOR), totalLiquidacion: num(r.TOTALLIQUIDACION),
      status: trim(r.STATUS), realizo: trim(r.WHOCAPTURA), cartasPorte: cps[idLiq(r.MES, r.ID_LIQUIDACION)] || [],
    })),
  };
}

async function obtener(id) {
  await asegurarEsquema();
  const { mes, numero } = parseId(id);
  return modeloCompleto(await getPool(), mes, numero);
}

// Cartas porte del operador (año actual + histórico) todavía no liquidadas. Es una consulta, no una tabla temporal.
// Tabla de DepoSolicitud del mismo año que la de la carta porte y su condición de "depósito validado":
// Validado=1 (el que se marca en la pantalla Depósitos). Las tablas históricas no tienen Validado: ahí se usa
// FlagDeposito=1. Devuelve null si ese año no tiene tabla de solicitudes.
async function depositosValidados(pool, anio, alias = 'd') {
  const nombre = parseInt(anio, 10) === cfg.anioTablaActual() ? 'DepoSolicitud' : `DepoSolicitud${String(anio).slice(-2)}`;
  const cols = (await columnasDepositos(pool))[nombre];
  if (!cols) return null;
  return { tabla: 'Empresa2.' + nombre, condicion: cols.has('validado') ? `ISNULL(${alias}.Validado,0)=1` : `ISNULL(${alias}.FlagDeposito,0)=1` };
}

// Solo salen las cartas porte con depósito VALIDADO (DepoSolicitud.Validado=1). Con `q` se busca por
// número de carta porte (parcial o completo, p. ej. CUI0003295) en todas las tablas.
// Si hay búsqueda y no aparece, `motivo` explica por qué no es candidata.
async function candidatas(idOperador, opciones = {}) {
  idOperador = parseInt(idOperador, 10);
  if (!idOperador) throw err(400, 'Indique el operador.');
  const pool = await getPool();
  const limite = Math.min(500, Math.max(1, parseInt(opciones.limit, 10) || 200));
  const anios = opciones.anio ? [parseInt(opciones.anio, 10)] : await aniosCP(pool);
  const q = trim(opciones.q).toUpperCase();
  const out = [];
  for (const anio of anios) {
    const tabla = await tablaCP(pool, anio);
    const depo = await depositosValidados(pool, anio);
    if (!depo) continue;   // sin solicitudes de depósito de ese año no hay nada validado
    const req = pool.request().input('op', sql.Int, idOperador);
    if (q) req.input('q', sql.VarChar(40), '%' + q + '%');
    const r = await req.query(
      `SELECT TOP ${limite} c.Serie, c.CartaPorte, c.Id_Pedido, c.Id_Cliente, c.NombreComunCli, c.FehcaCarga, c.FechaPedido, c.Id_Tarifa, c.DesFlete,
              c.CostoFlete, c.Status
         FROM ${tabla} c
        WHERE c.Id_Operador=@op AND ISNULL(c.FlagLiq,0)=0 AND UPPER(LTRIM(RTRIM(ISNULL(c.Status,'')))) NOT LIKE 'CANCELAD%'
          ${q ? 'AND UPPER(LTRIM(RTRIM(c.CartaPorte))) LIKE @q' : ''}
          AND EXISTS (SELECT 1 FROM ${depo.tabla} d WHERE d.Serie=c.Serie AND d.CartaPorte=c.CartaPorte AND ${depo.condicion})
        ORDER BY c.FechaPedido DESC, c.Id_Pedido DESC`);
    r.recordset.forEach(c => out.push({
      anioCP: anio, serie: trim(c.Serie), cartaPorte: trim(c.CartaPorte), idPedido: num(c.Id_Pedido), idCliente: num(c.Id_Cliente),
      cliente: trim(c.NombreComunCli), fechaViaje: fechaISO(c.FehcaCarga || c.FechaPedido), idTarifa: num(c.Id_Tarifa),
      desFlete: trim(c.DesFlete), costoFlete: num(c.CostoFlete), status: trim(c.Status), liquidada: false,
    }));
  }
  out.sort((a, b) => (a.fechaViaje < b.fechaViaje ? 1 : -1));
  const filas = out.slice(0, limite);
  return opciones.conMotivo ? { rows: filas, motivo: filas.length || q.length < 6 ? '' : await motivoNoCandidata(pool, idOperador, q) } : filas;
}

// Por qué una carta porte buscada por número no aparece entre las candidatas.
async function motivoNoCandidata(pool, idOperador, q) {
  for (const anio of await aniosCP(pool)) {
    const tabla = await tablaCP(pool, anio);
    const c = (await pool.request().input('q', sql.VarChar(40), q)
      .query(`SELECT TOP 1 Serie, CartaPorte, Id_Operador, FlagLiq, Status FROM ${tabla} WHERE UPPER(LTRIM(RTRIM(CartaPorte)))=@q`)).recordset[0];
    if (!c) continue;
    if (num(c.Id_Operador) !== idOperador) return `La carta porte ${q} pertenece al operador ${num(c.Id_Operador)}, no a este operador.`;
    if (trim(c.Status).toUpperCase().startsWith('CANCELAD')) return `La carta porte ${q} está cancelada.`;
    if (num(c.FlagLiq) === 1) return `La carta porte ${q} ya está liquidada.`;
    return `La carta porte ${q} no tiene un depósito validado en Depósitos.`;
  }
  return `No existe la carta porte ${q}.`;
}

// ── Alta ────────────────────────────────────────────────────────────────────
async function crear(idOperador, quien) {
  idOperador = parseInt(idOperador, 10);
  if (!idOperador) throw err(400, 'Indique el operador.');
  const advertencias = [];
  const liq = await enTransaccion(async (tx, pool) => {
    const op = (await new sql.Request(tx).input('id', sql.Int, idOperador)
      .query(`SELECT ID_OPERADOR, OPERADOR, STATUS, TIPODESINFONAVIT, INFONAVIT FROM Empresa2.Operadores WHERE ID_OPERADOR=@id`)).recordset[0];
    if (!op) throw err(404, 'El operador no existe.');
    if (trim(op.STATUS).toUpperCase() !== 'ACTIVO') advertencias.push(`El operador no está ACTIVO (estatus: ${trim(op.STATUS) || 'vacío'}).`);

    const emp = (await new sql.Request(tx).input('s', sql.VarChar(3), cfg.SERIE_EMPRESA_PARAMS)
      .query(`SELECT SUELDOBASEOPE, PAGOIMSSOPE FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE))=@s`)).recordset[0];
    if (!emp) advertencias.push(`No se encontró la empresa '${cfg.SERIE_EMPRESA_PARAMS}' para tomar sueldo base e IMSS: quedaron en 0.`);

    const tipo = trim(op.TIPODESINFONAVIT).toUpperCase();
    const divisor = cfg.INFONAVIT_DIVISOR[tipo];
    let infonavit = 0;
    if (divisor && num(op.INFONAVIT) > 0) {
      if (num(op.INFONAVIT) > cfg.INFONAVIT_MAX_VALIDO) advertencias.push(`El Infonavit capturado del operador (${num(op.INFONAVIT)}) es inválido y se ignoró; captúrelo en la liquidación.`);
      else infonavit = r2(num(op.INFONAVIT) / divisor);
    }

    const mes = cfg.mesActivo();
    const numero = (await new sql.Request(tx).input('mes', sql.Decimal(3, 0), mes)
      .query(`SELECT ISNULL(MAX(ID_LIQUIDACION),0)+1 AS n FROM Empresa2.Liquida WITH (UPDLOCK, HOLDLOCK) WHERE MES=@mes`)).recordset[0].n;

    await new sql.Request(tx)
      .input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero).input('fecha', sql.Date, hoyISO())
      .input('op', sql.Int, idOperador).input('nom', sql.VarChar(45), trim(op.OPERADOR).slice(0, 45))
      .input('sb', sql.Decimal(18, 2), num(emp && emp.SUELDOBASEOPE))
      .input('imss', sql.Decimal(18, 2), num(emp && emp.PAGOIMSSOPE)).input('info', sql.Decimal(18, 2), infonavit)
      .input('st', sql.VarChar(20), cfg.STATUS_GENERADA).input('who', sql.VarChar(79), trim(quien).slice(0, 79) || null).input('fc', sql.Date, hoyISO())
      .query(`INSERT INTO Empresa2.Liquida(MES, ID_LIQUIDACION, FECHA, ID_OPERADOR, OPERADOR, SUELDOBASE, IMSS, INFONAVIT, STATUS, WHOCAPTURA, FECHACAPTURA)
              VALUES(@mes, @num, @fecha, @op, @nom, @sb, @imss, @info, @st, @who, @fc)`);
    return recalcular(tx, mes, numero, quien);
  });
  return { liquidacion: liq, advertencias };
}

// ── Viajes ──────────────────────────────────────────────────────────────────
async function buscarCP(tx, serie, cartaPorte, anioCP) {
  const pool = await getPool();
  const anios = anioCP ? [parseInt(anioCP, 10)] : await aniosCP(pool);
  const hallazgos = [];
  for (const anio of anios) {
    const tabla = await tablaCP(pool, anio);
    const r = await new sql.Request(tx).input('s', sql.VarChar(3), serie).input('c', sql.VarChar(30), cartaPorte)
      .query(`SELECT TOP 1 * FROM ${tabla} WITH (UPDLOCK, ROWLOCK) WHERE LTRIM(RTRIM(Serie))=@s AND LTRIM(RTRIM(CartaPorte))=@c`);
    if (r.recordset[0]) hallazgos.push({ anio, tabla, cp: r.recordset[0] });
  }
  if (!hallazgos.length) throw err(404, `No existe la carta porte ${serie}-${cartaPorte}.`);
  if (hallazgos.length > 1) throw err(409, `La carta porte ${cartaPorte} existe en varios años (${hallazgos.map(h => h.anio).join(', ')}); indique anioCP.`);
  return hallazgos[0];
}

async function agregarViaje(id, { serie, cartaPorte, anioCP }, quien) {
  const { mes, numero } = parseId(id);
  serie = trim(serie); cartaPorte = trim(cartaPorte);
  if (!cartaPorte) throw err(400, 'Indique la carta porte.');
  return enTransaccion(async (tx) => {
    const cab = await leerCabecera(new sql.Request(tx), mes, numero, true);
    exigirGenerada(cab);
    const { anio, tabla, cp } = await buscarCP(tx, serie || trim(cartaPorte).slice(0, 3), cartaPorte, anioCP);

    if (num(cp.Id_Operador) !== num(cab.ID_OPERADOR)) throw err(409, `La carta porte pertenece al operador ${num(cp.Id_Operador)}, no al de esta liquidación (${num(cab.ID_OPERADOR)}).`);
    if (trim(cp.Status).toUpperCase().startsWith('CANCELAD')) throw err(409, 'La carta porte está cancelada.');
    const dup = (await new sql.Request(tx).input('s', sql.VarChar(3), trim(cp.Serie)).input('c', sql.VarChar(30), trim(cp.CartaPorte)).input('a', sql.Decimal(4, 0), anio)
      .query(`SELECT TOP 1 d.MES, d.ID_LIQUIDACION FROM Empresa2.LiqDeta d
                JOIN Empresa2.Liquida l ON l.MES=d.MES AND l.ID_LIQUIDACION=d.ID_LIQUIDACION AND UPPER(LTRIM(RTRIM(l.STATUS)))<>'CANCELADA'
               WHERE LTRIM(RTRIM(d.SERIE))=@s AND LTRIM(RTRIM(d.CARTAPORTE))=@c AND d.ANIOCP=@a`)).recordset[0];
    if (dup) throw err(409, `La carta porte ya está en la liquidación ${idLiq(dup.MES, dup.ID_LIQUIDACION)}.`);
    if (num(cp.FlagLiq) === 1) throw err(409, 'La carta porte ya está marcada como liquidada.');
    // Solo se liquidan cartas porte con depósito validado (misma regla que la lista de candidatas)
    const depo = await depositosValidados(tx, anio);
    const validado = depo && (await new sql.Request(tx).input('s', sql.VarChar(3), trim(cp.Serie)).input('c', sql.VarChar(30), trim(cp.CartaPorte))
      .query(`SELECT TOP 1 1 AS x FROM ${depo.tabla} d WHERE LTRIM(RTRIM(d.Serie))=@s AND LTRIM(RTRIM(d.CartaPorte))=@c AND ${depo.condicion}`)).recordset[0];
    if (!validado) throw err(409, `La carta porte ${trim(cp.CartaPorte)} no tiene un depósito validado en Depósitos.`);

    const tar = num(cp.Id_Tarifa) ? (await new sql.Request(tx).input('t', sql.Decimal(9, 0), num(cp.Id_Tarifa))
      .query(`SELECT KILOMETROS, COSTOPORKILO, PAGOTARIFA, DIESELPERMITIDO FROM Empresa2.Tarifas WHERE ID_TARIFA=@t`)).recordset[0] : null;
    const idDeta = (await new sql.Request(tx).input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero)
      .query(`SELECT ISNULL(MAX(ID_LIQDETA),0)+1 AS n FROM Empresa2.LiqDeta WITH (UPDLOCK, HOLDLOCK) WHERE MES=@mes AND ID_LIQUIDACION=@num`)).recordset[0].n;

    await new sql.Request(tx)
      .input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero).input('det', sql.Decimal(9, 0), idDeta)
      .input('fv', sql.Date, fechaISO(cp.FehcaCarga || cp.FechaPedido) || hoyISO()).input('viaje', sql.Int, idDeta)
      .input('cli', sql.Int, num(cp.Id_Cliente)).input('ncli', sql.VarChar(20), trim(cp.NombreComunCli).slice(0, 20))
      .input('ped', sql.Decimal(9, 0), num(cp.Id_Pedido)).input('serie', sql.VarChar(3), trim(cp.Serie)).input('cp', sql.VarChar(30), trim(cp.CartaPorte))
      .input('tar', sql.Decimal(9, 0), num(cp.Id_Tarifa)).input('desf', sql.VarChar(80), trim(cp.DesFlete).slice(0, 80))
      .input('cflete', sql.Decimal(18, 2), num(cp.CostoFlete)).input('cman', sql.Decimal(18, 2), num(cp.CostoManiobras))
      .input('crenta', sql.Decimal(18, 2), num(cp.CostoRenta)).input('ckm', sql.Decimal(18, 2), num(cp.Kilometros))   // Kilometros de la CP = costo por kilómetros
      .input('km', sql.Decimal(18, 2), num(cp.KilometrosTar) || num(tar && tar.KILOMETROS))
      .input('pkm', sql.Decimal(18, 2), num(tar && tar.COSTOPORKILO)).input('pv', sql.Decimal(18, 2), num(tar && tar.PAGOTARIFA))
      .input('dp', sql.Decimal(18, 2), num(tar && tar.DIESELPERMITIDO)).input('anio', sql.Decimal(4, 0), anio)
      .query(`INSERT INTO Empresa2.LiqDeta(MES, ID_LIQUIDACION, ID_LIQDETA, FECHAVIAJE, ID_VIAJES, ID_CLIENTE, CLIENTE, ID_PEDIDO, SERIE, CARTAPORTE,
                ID_TARIFA, DESFLETE, COSTOFLETE, COSTOMANIOBRAS, COSTORENTA, COSTOKILOMETROS, KILOMETROS, PAGOKILOMETRO, PAGOVIAJE, DIESELPERMITIDO, ANIOCP)
              VALUES(@mes, @num, @det, @fv, @viaje, @cli, @ncli, @ped, @serie, @cp, @tar, @desf, @cflete, @cman, @crenta, @ckm, @km, @pkm, @pv, @dp, @anio)`);
    await new sql.Request(tx).input('s', sql.VarChar(3), trim(cp.Serie)).input('c', sql.VarChar(30), trim(cp.CartaPorte))
      .query(`UPDATE ${tabla} SET FlagLiq=1 WHERE LTRIM(RTRIM(Serie))=@s AND LTRIM(RTRIM(CartaPorte))=@c`);
    return recalcular(tx, mes, numero, quien);
  });
}

async function quitarViaje(id, idDeta, quien) {
  const { mes, numero } = parseId(id);
  return enTransaccion(async (tx, pool) => {
    exigirGenerada(await leerCabecera(new sql.Request(tx), mes, numero, true));
    const det = (await new sql.Request(tx).input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero)
      .input('det', sql.Decimal(9, 0), parseInt(idDeta, 10) || 0)
      .query(`SELECT * FROM Empresa2.LiqDeta WITH (UPDLOCK) WHERE MES=@mes AND ID_LIQUIDACION=@num AND ID_LIQDETA=@det`)).recordset[0];
    if (!det) throw err(404, 'El viaje no existe en esta liquidación.');
    const tabla = await tablaCP(pool, num(det.ANIOCP));
    await new sql.Request(tx).input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero).input('det', sql.Decimal(9, 0), num(det.ID_LIQDETA))
      .query(`DELETE FROM Empresa2.LiqDeta WHERE MES=@mes AND ID_LIQUIDACION=@num AND ID_LIQDETA=@det`);
    await new sql.Request(tx).input('s', sql.VarChar(3), trim(det.SERIE)).input('c', sql.VarChar(30), trim(det.CARTAPORTE))
      .query(`UPDATE ${tabla} SET FlagLiq=0 WHERE LTRIM(RTRIM(Serie))=@s AND LTRIM(RTRIM(CartaPorte))=@c`);
    return recalcular(tx, mes, numero, quien);
  });
}

// ── Edición ─────────────────────────────────────────────────────────────────
const CAMPOS_EDITABLES = ['sueldoBase', 'imss', 'infonavit', 'extraComision', 'extraDescuento', 'dieselRellenado', 'totalAdelanto'];
// Un campo vacío o en 0 es válido (p. ej. quitar el IMSS o el Infonavit): se toma como 0 y los totales se recalculan sin él.
const validaImporte = (nombre, v) => {
  if (v === '' || v == null) return 0;
  if (!isFinite(Number(v)) || Number(v) < 0) throw err(400, `${nombre} debe ser un número mayor o igual a 0.`);
  return Number(v);
};
// Aplica los cambios capturados al modelo de la liquidación (sin guardar nada).
function aplicarCambios(liq, cambios) {
  CAMPOS_EDITABLES.forEach(k => { if (cambios[k] !== undefined) liq[k] = validaImporte(k, cambios[k]); });
  if (cambios.descripcionOtros !== undefined) liq.descripcionOtros = trim(cambios.descripcionOtros);
  if (cambios.aplicarDif !== undefined) liq.aplicarDif = cambios.aplicarDif === true || cambios.aplicarDif === 1 || cambios.aplicarDif === '1' || cambios.aplicarDif === 'true';
  if (cambios.real && typeof cambios.real === 'object') {
    for (const [k, v] of Object.entries(cambios.real)) {
      if (!CONCEPTOS.includes(k)) throw err(400, `Concepto desconocido: ${k}.`);
      liq[k].real = validaImporte('real.' + k, v);
    }
  }
}

async function editar(id, cambios, quien) {
  const { mes, numero } = parseId(id);
  cambios = cambios || {};
  return enTransaccion(async (tx) => {
    exigirGenerada(await leerCabecera(new sql.Request(tx), mes, numero, true));
    return recalcular(tx, mes, numero, quien, (liq) => aplicarCambios(liq, cambios));
  });
}

// Vista previa mientras se teclea: calcula con calcularTotales (la misma función de siempre) los cambios
// capturados y devuelve el resultado SIN guardar nada. Si la liquidación ya no es editable devuelve lo guardado.
async function previsualizar(id, cambios) {
  await asegurarEsquema();
  const { mes, numero } = parseId(id);
  const pool = await getPool();
  const cab = await leerCabecera(new sql.Request(pool), mes, numero, false);
  const base = filaAModelo(cab);
  if (!esGenerada(cab)) return modeloCompleto(pool, mes, numero);
  soltarRealesAutomaticos(base);
  aplicarCambios(base, cambios || {});
  const viajes = await leerRenglones(pool, mes, numero);
  const calculado = calcularTotales(base, viajes);
  calculado.viajes = viajes;
  return calculado;
}

const recalcularDiferencias = (id, quien) => {
  const { mes, numero } = parseId(id);
  return enTransaccion(async (tx) => {
    exigirGenerada(await leerCabecera(new sql.Request(tx), mes, numero, true));
    // las diferencias se ponen en 0 y se recalculan contra estimado y real vigentes
    return recalcular(tx, mes, numero, quien, (liq) => { CONCEPTOS.forEach(k => { liq[k].dif = 0; }); liq.totalDif = 0; });
  });
};

// Poner / quitar la diferencia aplicada: con aplicar=true el total de diferencias (estimado - real) entra al total de
// la liquidación como "Dif. aplicada" (positiva = se descuenta; negativa = se paga); con false se quita.
// No toca Extra comisión ni Extra descuento. Mientras la liquidación no se guarda, la pantalla lo maneja con
// el cambio `aplicarDif` (vista previa); este método es el equivalente directo para quien llame a la API.
const aplicarDiferencias = (id, aplicar, quien) => {
  const { mes, numero } = parseId(id);
  return enTransaccion(async (tx) => {
    exigirGenerada(await leerCabecera(new sql.Request(tx), mes, numero, true));
    return recalcular(tx, mes, numero, quien, (liq) => { liq.aplicarDif = aplicar !== false; });
  });
};

// ── Estado ──────────────────────────────────────────────────────────────────
async function cambiarStatus(id, de, a, quien, mensajeConflicto) {
  const { mes, numero } = parseId(id);
  return enTransaccion(async (tx) => {
    const cab = await leerCabecera(new sql.Request(tx), mes, numero, true);
    if (trim(cab.STATUS).toUpperCase() !== de) throw err(409, mensajeConflicto);
    await new sql.Request(tx).input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero)
      .input('st', sql.VarChar(20), a).input('who', sql.VarChar(79), trim(quien).slice(0, 79) || null).input('f', sql.Date, hoyISO())
      .query(`UPDATE Empresa2.Liquida SET STATUS=@st, WHOMODIFICA=@who, FECHAULTMOD=@f WHERE MES=@mes AND ID_LIQUIDACION=@num`);
    return recalcular(tx, mes, numero, quien);
  });
}
// Pagar no genera póliza ni movimientos: solo cambia el estatus.
const pagar = (id, quien) => cambiarStatus(id, cfg.STATUS_GENERADA, cfg.STATUS_PAGADA, quien, 'Solo se puede pagar una liquidación GENERADA (esta ya está PAGADA o CANCELADA).');
// Reabrir (permiso especial): PAGADA -> GENERADA; queda WhoModifica / FechaUltMod con quién y cuándo.
const reabrir = (id, quien) => cambiarStatus(id, cfg.STATUS_PAGADA, cfg.STATUS_GENERADA, quien, 'Solo se puede reabrir una liquidación PAGADA.');

// Cancelar: la liquidación NO se borra. Pasa a CANCELADA (solo lectura), conserva sus renglones como
// historial y libera sus cartas porte (FlagLiq=0 en su tabla) para que puedan liquidarse otra vez.
async function cancelar(id, quien) {
  const { mes, numero } = parseId(id);
  return enTransaccion(async (tx, pool) => {
    const cab = await leerCabecera(new sql.Request(tx), mes, numero, true);
    const st = trim(cab.STATUS).toUpperCase();
    if (st === cfg.STATUS_CANCELADA) throw err(409, 'La liquidación ya está CANCELADA.');
    if (st === cfg.STATUS_PAGADA) throw err(409, 'La liquidación está PAGADA: primero hay que reabrirla para poder cancelarla.');
    const dets = (await new sql.Request(tx).input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero)
      .query(`SELECT SERIE, CARTAPORTE, ANIOCP FROM Empresa2.LiqDeta WITH (UPDLOCK) WHERE MES=@mes AND ID_LIQUIDACION=@num`)).recordset;
    for (const d of dets) {
      const tabla = await tablaCP(pool, num(d.ANIOCP));
      await new sql.Request(tx).input('s', sql.VarChar(3), trim(d.SERIE)).input('c', sql.VarChar(30), trim(d.CARTAPORTE))
        .query(`UPDATE ${tabla} SET FlagLiq=0 WHERE LTRIM(RTRIM(Serie))=@s AND LTRIM(RTRIM(CartaPorte))=@c`);
    }
    await new sql.Request(tx).input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero)
      .input('st', sql.VarChar(20), cfg.STATUS_CANCELADA).input('who', sql.VarChar(79), trim(quien).slice(0, 79) || null).input('f', sql.Date, hoyISO())
      .query(`UPDATE Empresa2.Liquida SET STATUS=@st, WHOMODIFICA=@who, FECHAULTMOD=@f WHERE MES=@mes AND ID_LIQUIDACION=@num`);
    return recalcular(tx, mes, numero, quien);
  });
}

async function eliminar(id) {
  const { mes, numero } = parseId(id);
  return enTransaccion(async (tx, pool) => {
    exigirGenerada(await leerCabecera(new sql.Request(tx), mes, numero, true));
    const dets = (await new sql.Request(tx).input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero)
      .query(`SELECT SERIE, CARTAPORTE, ANIOCP FROM Empresa2.LiqDeta WITH (UPDLOCK) WHERE MES=@mes AND ID_LIQUIDACION=@num`)).recordset;
    for (const d of dets) {
      const tabla = await tablaCP(pool, num(d.ANIOCP));
      await new sql.Request(tx).input('s', sql.VarChar(3), trim(d.SERIE)).input('c', sql.VarChar(30), trim(d.CARTAPORTE))
        .query(`UPDATE ${tabla} SET FlagLiq=0 WHERE LTRIM(RTRIM(Serie))=@s AND LTRIM(RTRIM(CartaPorte))=@c`);
    }
    await new sql.Request(tx).input('mes', sql.Decimal(3, 0), mes).input('num', sql.Decimal(9, 0), numero)
      .query(`DELETE FROM Empresa2.LiqDeta WHERE MES=@mes AND ID_LIQUIDACION=@num;
              DELETE FROM Empresa2.Liquida WHERE MES=@mes AND ID_LIQUIDACION=@num`);
    return { ok: true, liberadas: dets.length };
  });
}

// ── Recibos ─────────────────────────────────────────────────────────────────
// Liquidaciones por rango de fechas (y, si se da rango de operadores, solo operadores ACTIVOS).
async function paraRecibos({ fechaIni, fechaFin, idOpeIni, idOpeFin }) {
  await asegurarEsquema();
  const pool = await getPool();
  const req = pool.request();
  const where = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trim(fechaIni)) || !/^\d{4}-\d{2}-\d{2}$/.test(trim(fechaFin))) throw err(400, 'Indique fechaIni y fechaFin (aaaa-mm-dd).');
  req.input('fi', sql.Date, fechaIni).input('ff', sql.Date, fechaFin);
  where.push('l.FECHA BETWEEN @fi AND @ff');
  const oi = parseInt(idOpeIni, 10), of = parseInt(idOpeFin, 10);
  if (oi || of) {
    req.input('oi', sql.Int, Math.min(oi || of, of || oi)).input('of', sql.Int, Math.max(oi || of, of || oi));
    where.push('l.ID_OPERADOR BETWEEN @oi AND @of');
    where.push(`EXISTS (SELECT 1 FROM Empresa2.Operadores o WHERE o.ID_OPERADOR=l.ID_OPERADOR AND UPPER(LTRIM(RTRIM(o.STATUS)))='ACTIVO')`);
  }
  const ids = (await req.query(`SELECT l.MES, l.ID_LIQUIDACION FROM Empresa2.Liquida l WHERE ${where.join(' AND ')} ORDER BY l.ID_OPERADOR, l.MES, l.ID_LIQUIDACION`)).recordset;
  const out = [];
  for (const i of ids) out.push(await modeloCompleto(pool, num(i.MES), num(i.ID_LIQUIDACION)));
  return out;
}

module.exports = {
  parseId, listar, obtener, candidatas, crear, agregarViaje, quitarViaje, editar,
  recalcularDiferencias, aplicarDiferencias, pagar, reabrir, cancelar, eliminar, previsualizar, paraRecibos, asegurarEsquema,
  tablaCP, aniosCP,
};
