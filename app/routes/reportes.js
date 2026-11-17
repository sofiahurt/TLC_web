const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { getPool, sql } = require('../config/db');
const { requierePermiso } = require('../middleware/permisos');

const trim = v => (v == null ? '' : String(v).trim());

router.get('/', (req, res) => res.redirect('/reportes/cartaporte'));
router.get('/cartaporte', requierePermiso('reportes.cartaporte.ver'), (req, res) => res.render('reportes-cartaporte', { usuario: req.session.usuario, modulo: 'reportes-cartaporte' }));
router.get('/facturas', requierePermiso('reportes.facturas.ver'), (req, res) => res.render('reportes-facturas', { usuario: req.session.usuario, modulo: 'reportes-facturas' }));

// ── Series con Carta Porte capturada (para el combo "Serie") ──────────────
router.get('/cartaporte/series', requierePermiso('reportes.cartaporte.ver'), async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT DISTINCT Serie FROM Empresa2.CartaPorte ORDER BY Serie`);
    res.json({ series: r.recordset.map(row => trim(row.Serie)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// El resultado de las funciones de reporte trae las fechas convertidas a
// varchar formato dd/mm/yyyy (CONVERT(...,103)) -- se reconvierten a Date
// real para que Excel las trate como fecha, no como texto.
function parseFechaDDMMYYYY(v) {
  const s = trim(v);
  if (!s) return null;
  const [d, m, y] = s.split('/');
  if (!d || !m || !y) return null;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

// Convierte 'YYYY-MM-DD' (como llega en el query string) a 'DD/MM/YYYY' para
// mostrar en el título del reporte.
function fmtFechaTitulo(v) {
  const [y, m, d] = trim(v).split('-');
  if (!y || !m || !d) return trim(v);
  return `${d}/${m}/${y}`;
}

const NUMFMT_POR_TIPO = { fecha: 'dd/mm/yyyy', moneda: '$#,##0.00', numero: '#,##0.00', entero: '#,##0' };
const TIPOS_NUMERICOS = ['moneda', 'numero', 'entero'];

// ── Construcción genérica de un reporte Excel: título + subtítulo (filas
// 1-2), encabezados sombreados de amarillo con autofiltro (fila 4), datos
// desde la fila 5, y fila de totales opcional. Reutilizada por todos los
// reportes de este módulo para que se vean y se comporten igual. ──────────
function construirWorkbookReporte({ nombreHoja, titulo, subtitulo, columnas, filas, columnasTotales }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(nombreHoja);
  const numCols = columnas.length;
  const FILA_ENCABEZADOS = 4;

  columnas.forEach((c, idx) => {
    const columna = sheet.getColumn(idx + 1);
    columna.width = c.ancho || 16;
    if (NUMFMT_POR_TIPO[c.tipo]) columna.numFmt = NUMFMT_POR_TIPO[c.tipo];
  });

  sheet.mergeCells(1, 1, 1, numCols);
  const celdaTitulo = sheet.getCell(1, 1);
  celdaTitulo.value = titulo;
  celdaTitulo.font = { bold: true, size: 18 };
  celdaTitulo.alignment = { horizontal: 'left' };

  sheet.mergeCells(2, 1, 2, numCols);
  const celdaSub = sheet.getCell(2, 1);
  celdaSub.value = subtitulo;
  celdaSub.font = { bold: true, size: 14 };
  celdaSub.alignment = { horizontal: 'left' };

  // Fila 3 se deja en blanco a propósito -- los encabezados arrancan en la 4.

  const filaEncabezados = sheet.getRow(FILA_ENCABEZADOS);
  columnas.forEach((c, idx) => {
    const celda = filaEncabezados.getCell(idx + 1);
    celda.value = c.header;
    celda.font = { bold: true };
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
  });
  sheet.autoFilter = { from: { row: FILA_ENCABEZADOS, column: 1 }, to: { row: FILA_ENCABEZADOS, column: numCols } };

  // Índices de las columnas a totalizar, por nombre de encabezado -- así no
  // se rompe si el orden de columnas cambia más adelante.
  const idxTotales = (columnasTotales || [])
    .map(h => columnas.findIndex(c => c.header === h))
    .filter(i => i >= 0);
  const sumas = new Array(numCols).fill(0);

  let filaActual = FILA_ENCABEZADOS + 1;
  for (const row of filas) {
    const excelRow = sheet.getRow(filaActual);
    columnas.forEach((col, idx) => {
      let valor = row[col.campo];
      if (col.tipo === 'fecha') valor = parseFechaDDMMYYYY(valor);
      else if (TIPOS_NUMERICOS.includes(col.tipo)) {
        // Un NaN escrito en una celda numérica corrompe el .xlsx (Excel pide
        // reparar) -- si el dato no convierte limpio, se deja vacío.
        const n = valor == null ? null : Number(valor);
        valor = (n == null || isNaN(n)) ? null : n;
      } else valor = valor == null ? '' : trim(valor);
      excelRow.getCell(idx + 1).value = valor;
      if (idxTotales.includes(idx) && typeof valor === 'number') sumas[idx] += valor;
    });
    filaActual++;
  }

  if (idxTotales.length) {
    const filaTotales = sheet.getRow(filaActual);
    filaTotales.getCell(1).value = 'Totales:';
    filaTotales.getCell(1).font = { bold: true };
    idxTotales.forEach(idx => {
      const celda = filaTotales.getCell(idx + 1);
      celda.value = Math.round(sumas[idx] * 100) / 100;
      celda.font = { bold: true };
      celda.numFmt = NUMFMT_POR_TIPO[columnas[idx].tipo] || '$#,##0.00';
    });
  }

  return workbook;
}

function enviarWorkbook(res, workbook, nombreBase, fechaIni, fechaFin) {
  const ahora = new Date();
  const hhmmss = ahora.toTimeString().slice(0, 8).replace(/:/g, '');
  const nombreArchivo = `${nombreBase}_${fechaIni}_a_${fechaFin}_${hhmmss}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
  return workbook.xlsx.write(res).then(() => res.end());
}

// ═══════════════════════ REPORTE: CARTAS PORTE ═══════════════════════════

// Encabezados del reporte, en el orden exacto pedido, con el nombre de
// columna que devuelve Empresa2.fn_CartaPorteDetalle (o el join extra para
// Id_Cliente) y el tipo de formato de celda a aplicar en Excel.
const COLUMNAS_CARTAPORTE = [
  { header: 'CT',          campo: 'Serie',        tipo: 'texto' },
  { header: 'Carta Porte', campo: 'CartaPorte',   tipo: 'texto' },
  { header: 'Shipmente',   campo: 'NoPedidoCliente', tipo: 'texto' },
  { header: 'Observaciones', campo: 'Observaciones', tipo: 'texto' },
  { header: 'FechaCrea',   campo: 'FechaPedido',  tipo: 'fecha' },
  { header: 'FechaCarga',  campo: 'FechaCarga',   tipo: 'fecha' },
  { header: 'Cliente',     campo: 'NombreComunCli', tipo: 'texto' },
  { header: 'Operador',    campo: 'Operador',     tipo: 'texto' },
  // Id_Camion NO siempre es numérico (hay unidades identificadas con código
  // alfanumérico, ej. "TR01") -- tratarlo como número producía NaN en esas
  // filas y corrompía el .xlsx (Excel pedía "reparar" el archivo al abrirlo).
  { header: 'No Camion',   campo: 'Id_Camion',    tipo: 'texto' },
  { header: 'Origen',      campo: 'DomCarga',     tipo: 'texto' },
  { header: 'Destino',     campo: 'DomDescarga',  tipo: 'texto' },
  { header: 'Doc.Rela',    campo: 'NoRainde',     tipo: 'texto' },
  { header: 'CP Rela',     campo: 'CP_Rela',      tipo: 'texto' },
  { header: 'No Fac',      campo: 'NoFactura',    tipo: 'texto' },
  { header: 'Año Fac',     campo: 'AnioFactura',  tipo: 'texto' },
  { header: 'Moneda',      campo: 'c_Moneda',     tipo: 'texto' },
  { header: 'TipoCambio',  campo: 'TipoCambio',   tipo: 'moneda' },
  { header: 'Flete',       campo: 'Flete',        tipo: 'moneda' },
  { header: 'Renta',       campo: 'CostoRenta',   tipo: 'moneda' },
  { header: 'Kilometros',  campo: 'Kilometros',   tipo: 'moneda' },
  { header: 'Maniobras',   campo: 'Maniobras',    tipo: 'moneda' },
  { header: 'Casetas',     campo: 'Casetas',      tipo: 'moneda' },
  { header: 'Pension',     campo: 'Pension',      tipo: 'moneda' },
  { header: 'Estadias',    campo: 'Estadias',     tipo: 'moneda' },
  { header: 'Demoras',     campo: 'Demoras',      tipo: 'moneda' },
  { header: 'Otros',       campo: 'Otros_Depo',   tipo: 'moneda' },
  { header: 'CargoExtra',  campo: 'CargoExtra',   tipo: 'moneda' },
  { header: 'Subtotal',    campo: 'SubTotalMX',   tipo: 'moneda' },
  { header: 'IVA',         campo: 'IVAMX',        tipo: 'moneda' },
  { header: 'Retención',   campo: 'RetenMX',      tipo: 'moneda' },
  { header: 'Total',       campo: 'TOTALMX',      tipo: 'moneda' },
  { header: 'Depositos',   campo: 'Depositos',    tipo: 'moneda' },
  { header: 'Status',      campo: 'Status',       tipo: 'texto' },
  { header: 'Realizo',     campo: 'RealizoPedido', tipo: 'texto' },
  { header: 'F.Cancela',   campo: 'FechaCancela', tipo: 'fecha' },
  { header: 'Cancelo',     campo: 'WhoCancela',   tipo: 'texto' },
];

// fn_CartaPorteDetalle divide Maniobras entre 1.16 como si llevara IVA incluido,
// pero se captura en Depósitos ya como importe neto (solo Casetas lleva IVA
// incluido). Se sustituye por el monto capturado y se ajustan Subtotal/IVA/Total.
function maniobrasSinDividir(r) {
  const neto = Math.round((Number(r.ManiobrasNeto) || 0) * 100) / 100;
  const delta = neto - (Number(r.Maniobras) || 0);
  if (Math.abs(delta) < 0.005) return;
  r.Maniobras = neto;
  r.SubTotalMX = (Number(r.SubTotalMX) || 0) + delta;
  r.IVAMX = (Number(r.IVAMX) || 0) + delta * 0.16;
  r.TOTALMX = (Number(r.TOTALMX) || 0) + delta * 1.16;
}

// Una Carta Porte Cancelada sale con TODOS los importes en 0, incluidos los que vienen de
// Depósitos (DepoSolicitud).
// Una de Traslado no se cobra: se quitan sus costos y solo queda la parte de Depósitos
// (maniobras, casetas, pensión, estadías, demoras, otros y el monto de depósitos).
// Subtotal/IVA/Total se recalculan únicamente con esos extras (IVA 16%, sin retención),
// igual que fn_CartaPorteDetalle. Aplica también a los traslados anteriores, que conservan
// sus costos en la BD.
function soloDepositosSiTraslado(r) {
  // CANCELADO/CANCELADA y el typo legado CANCELAD0 (con cero).
  const st = trim(r.Status).toUpperCase();
  if (st.startsWith('CANCELAD')) {
    ['Flete', 'CostoRenta', 'Kilometros', 'CargoExtra', 'Maniobras', 'Casetas', 'Pension', 'Estadias', 'Demoras',
      'Otros_Depo', 'Depositos', 'SubTotalMX', 'IVAMX', 'RetenMX', 'TOTALMX'].forEach(k => { r[k] = 0; });
    return;
  }
  if (st !== 'TRASLADO') return;
  const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
  r.Flete = 0; r.CostoRenta = 0; r.Kilometros = 0; r.CargoExtra = 0;
  const subtotal = r2(['Maniobras', 'Casetas', 'Pension', 'Estadias', 'Demoras', 'Otros_Depo']
    .reduce((a, k) => a + (Number(r[k]) || 0), 0));
  r.SubTotalMX = subtotal;
  r.IVAMX = r2(subtotal * 0.16);
  r.RetenMX = 0;
  r.TOTALMX = r2(subtotal + r.IVAMX);
}

router.get('/cartaporte/excel', requierePermiso('reportes.cartaporte.ver'), async (req, res) => {
  try {
    const fechaIni = trim(req.query.fechaIni);
    const fechaFin = trim(req.query.fechaFin);
    if (!fechaIni || !fechaFin) return res.status(400).json({ error: 'El rango de fechas es obligatorio.' });

    const serie = trim(req.query.serie); // '' = todas
    const soloSinFactura = req.query.soloSinFactura === '1';
    const clienteIni = parseInt(req.query.clienteIni) || null;
    const clienteFin = parseInt(req.query.clienteFin) || null;

    const pool = await getPool();
    const request = pool.request()
      .input('fechaIni', sql.Date, fechaIni)
      .input('fechaFin', sql.Date, fechaFin);

    let where = 'WHERE 1=1';
    if (serie) { request.input('serie', sql.VarChar(3), serie); where += ' AND fd.Serie=@serie'; }
    if (soloSinFactura) { where += " AND fd.NoFactura IS NULL"; }
    if (clienteIni != null && clienteFin != null) {
      // fn_CartaPorteDetalle no expone Id_Cliente -- se toma del join contra
      // CartaPorte por su llave natural (Serie, CartaPorte).
      request.input('clienteIni', sql.Decimal(7), Math.min(clienteIni, clienteFin));
      request.input('clienteFin', sql.Decimal(7), Math.max(clienteIni, clienteFin));
      where += ' AND cp.Id_Cliente BETWEEN @clienteIni AND @clienteFin';
    }

    const query = `
      SELECT fd.*, cp.CP_Rela, mn.ManiobrasNeto
      FROM Empresa2.fn_CartaPorteDetalle(@fechaIni, @fechaFin) fd
      JOIN Empresa2.CartaPorte cp ON cp.Serie = fd.Serie AND cp.CartaPorte = fd.CartaPorte
      OUTER APPLY (SELECT ISNULL(SUM(CASE WHEN d.FlagCobMan = 1 THEN d.Maniobra ELSE 0 END),0) AS ManiobrasNeto
                   FROM Empresa2.DepoSolicitud d WHERE d.CARTAPORTE = fd.CartaPorte) mn
      ${where}
      ORDER BY fd.Serie, fd.CartaPorte`;
    const result = await request.query(query);
    result.recordset.forEach(maniobrasSinDividir);
    result.recordset.forEach(soloDepositosSiTraslado);

    const workbook = construirWorkbookReporte({
      nombreHoja: 'Cartas Porte',
      titulo: 'Reporte de Cartas Porte',
      subtitulo: `Del ${fmtFechaTitulo(fechaIni)} al ${fmtFechaTitulo(fechaFin)}`,
      columnas: COLUMNAS_CARTAPORTE,
      filas: result.recordset,
      columnasTotales: ['Flete', 'Renta', 'Kilometros', 'Maniobras', 'Casetas', 'Pension', 'Estadias', 'Demoras', 'Otros', 'CargoExtra', 'Subtotal', 'IVA', 'Retención', 'Total', 'Depositos'],
    });
    await enviarWorkbook(res, workbook, 'CartasPorte', fechaIni, fechaFin);
  } catch (err) {
    console.error('reportes/cartaporte/excel error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════ REPORTE: FACTURAS ═══════════════════════════════

// fn_ReporteFacturas devuelve Facturas + Notas de Crédito/Débito en una sola
// tabla (columna TipoDocumento distingue F/NC/ND).
const COLUMNAS_FACTURAS = [
  { header: 'Tipo',           campo: 'TipoDocumento',  tipo: 'texto' },
  { header: 'No. Documento',  campo: 'Id_Documento',   tipo: 'entero' },
  { header: 'Fecha',          campo: 'Fecha',          tipo: 'fecha' },
  { header: 'Carta Porte',    campo: 'CartaPorte',     tipo: 'texto' },
  { header: 'Pedido Cliente', campo: 'NoPedidoCliente', tipo: 'texto' },
  // Id_Camion NO siempre es numérico (unidades con código alfanumérico como
  // "TR01"/"TR02") -- mismo caso ya visto en el reporte de Cartas Porte.
  { header: 'No Camion',      campo: 'Id_Camion',      tipo: 'texto' },
  { header: 'Cliente',        campo: 'NombreCom',      tipo: 'texto' },
  { header: 'Moneda',         campo: 'MonFactura',     tipo: 'texto' },
  { header: 'TipoCambio',     campo: 'TipoCambio',     tipo: 'numero' },
  { header: 'Subtotal',       campo: 'SubTotal',       tipo: 'moneda' },
  { header: 'IVA',            campo: 'IVA',            tipo: 'moneda' },
  { header: 'Retención',      campo: 'Retencion',      tipo: 'moneda' },
  { header: 'Total',          campo: 'Total',          tipo: 'moneda' },
  { header: 'UUID',           campo: 'UUID',           tipo: 'texto' },
  { header: 'Status',         campo: 'Status',         tipo: 'texto' },
  { header: 'F.Cancela',      campo: 'FechaCancela',   tipo: 'fecha' },
  { header: 'Cancelo',        campo: 'Cancelo',        tipo: 'texto' },
  { header: 'FlagWeb',        campo: 'FlagWeb',        tipo: 'entero' },
  { header: 'Realizo',        campo: 'Realizo',        tipo: 'texto' },
];

// Una Nota de Crédito/Débito cancelada (CANCELADO/CANCELADA) sale con sus importes en 0.
// Las facturas canceladas ya vienen en 0 desde fn_ReporteFacturas.
function ceroSiNotaCancelada(r) {
  if (!['NC', 'ND'].includes(trim(r.TipoDocumento).toUpperCase())) return;
  if (!trim(r.Status).toUpperCase().startsWith('CANCELAD')) return;
  ['SubTotal', 'IVA', 'Retencion', 'Total'].forEach(k => { r[k] = 0; });
}

router.get('/facturas/excel', requierePermiso('reportes.facturas.ver'), async (req, res) => {
  try {
    const fechaIni = trim(req.query.fechaIni);
    const fechaFin = trim(req.query.fechaFin);
    if (!fechaIni || !fechaFin) return res.status(400).json({ error: 'El rango de fechas es obligatorio.' });

    const tipoDocumento = trim(req.query.tipoDocumento) || 'T'; // T/F/NC/ND

    const pool = await getPool();
    const result = await pool.request()
      .input('fechaIni', sql.Date, fechaIni).input('fechaFin', sql.Date, fechaFin)
      .input('tipoDocumento', sql.VarChar(2), tipoDocumento)
      .query(`SELECT * FROM Empresa2.fn_ReporteFacturas(@fechaIni, @fechaFin, @tipoDocumento) ORDER BY TipoDocumento, Id_Documento`);

    result.recordset.forEach(ceroSiNotaCancelada);

    const workbook = construirWorkbookReporte({
      nombreHoja: 'Facturas',
      titulo: 'Reporte de Facturas',
      subtitulo: `Del ${fmtFechaTitulo(fechaIni)} al ${fmtFechaTitulo(fechaFin)}`,
      columnas: COLUMNAS_FACTURAS,
      filas: result.recordset,
      columnasTotales: ['Subtotal', 'IVA', 'Retención', 'Total'],
    });
    await enviarWorkbook(res, workbook, 'Facturas', fechaIni, fechaFin);
  } catch (err) {
    console.error('reportes/facturas/excel error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════ REPORTE: DEPÓSITOS ══════════════════════════════

// Un renglón por solicitud VALIDADA y por concepto con monto (> 0).
const CONCEPTOS_DEPO = ['Prestamo','Talachas','Llantas','Diesel','Comidas','Pension','Bascula','Casetas','Refacciones','Maniobra','Otros','Estadias','Demoras'];
const COLUMNAS_DEPOSITOS = [
  { header: 'Fecha',          campo: 'Fecha',       tipo: 'fecha' },
  { header: 'Carta Porte',    campo: 'CartaPorte',  tipo: 'texto' },
  { header: 'Origen-Destino', campo: 'OrigenDestino', tipo: 'texto', ancho: 50 },
  { header: 'Id Operador',    campo: 'ID_OPERADOR', tipo: 'entero' },
  { header: 'Operador',       campo: 'OPERADOR',    tipo: 'texto' },
  { header: 'Concepto',       campo: 'Concepto',    tipo: 'texto' },
  { header: 'Monto',          campo: 'Monto',       tipo: 'moneda' },
];

router.get('/depositos', requierePermiso('reportes.depositos.ver'), (req, res) => res.render('reportes-depositos', { usuario: req.session.usuario, modulo: 'reportes-depositos' }));

// Operadores con solicitudes (para el combo "Operador").
router.get('/depositos/operadores', requierePermiso('reportes.depositos.ver'), async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT DISTINCT ID_OPERADOR, LTRIM(RTRIM(OPERADOR)) AS OPERADOR FROM Empresa2.DepoSolicitud
      WHERE ID_OPERADOR IS NOT NULL ORDER BY OPERADOR`);
    res.json({ operadores: r.recordset.map(o => ({ id: o.ID_OPERADOR, nombre: trim(o.OPERADOR) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/depositos/excel', requierePermiso('reportes.depositos.ver'), async (req, res) => {
  try {
    const fechaIni = trim(req.query.fechaIni);
    const fechaFin = trim(req.query.fechaFin);
    if (!fechaIni || !fechaFin) return res.status(400).json({ error: 'El rango de fechas es obligatorio.' });
    const idOperador = parseInt(req.query.idOperador) || null;   // vacío = todos

    const pool = await getPool();
    const result = await pool.request()
      .input('fechaIni', sql.Date, fechaIni).input('fechaFin', sql.Date, fechaFin)
      .input('op', sql.Decimal(9, 0), idOperador)
      .query(`SELECT CONVERT(varchar(10), ds.Fecha, 103) AS Fecha,
                     LTRIM(RTRIM(ds.Serie)) + '-' + LTRIM(RTRIM(ds.CartaPorte)) AS CartaPorte,
                     LTRIM(RTRIM(ISNULL(ds.Origen,''))) + CASE WHEN ISNULL(ds.Origen,'') <> '' AND ISNULL(ds.Destino,'') <> '' THEN ' - ' ELSE '' END + LTRIM(RTRIM(ISNULL(ds.Destino,''))) AS OrigenDestino,
                     ds.ID_OPERADOR, LTRIM(RTRIM(ds.OPERADOR)) AS OPERADOR, c.Concepto, c.Monto
                FROM Empresa2.DepoSolicitud ds
                CROSS APPLY (VALUES ${CONCEPTOS_DEPO.map((c, i) => `(${i}, '${c}', ISNULL(ds.${c},0))`).join(', ')}) AS c(Ord, Concepto, Monto)
               WHERE ds.Fecha BETWEEN @fechaIni AND @fechaFin AND ISNULL(ds.Validado,0) = 1 AND c.Monto > 0
                 AND (@op IS NULL OR ds.ID_OPERADOR = @op)
                 AND NOT EXISTS (SELECT 1 FROM Empresa2.CartaPorte cpc WHERE cpc.Serie = ds.Serie AND cpc.CartaPorte = ds.CartaPorte AND UPPER(LTRIM(RTRIM(cpc.Status))) LIKE 'CANCELAD%')
               ORDER BY ds.Fecha, ds.Id_DepoSol, c.Ord`);

    const operador = idOperador ? (result.recordset[0] ? trim(result.recordset[0].OPERADOR) : `Id ${idOperador}`) : 'Todos los operadores';
    const workbook = construirWorkbookReporte({
      nombreHoja: 'Depositos',
      titulo: 'Reporte de Depósitos',
      subtitulo: `Del ${fmtFechaTitulo(fechaIni)} al ${fmtFechaTitulo(fechaFin)} — ${operador} (solo validadas)`,
      columnas: COLUMNAS_DEPOSITOS,
      filas: result.recordset,
      columnasTotales: ['Monto'],
    });
    await enviarWorkbook(res, workbook, 'Depositos', fechaIni, fechaFin);
  } catch (err) {
    console.error('reportes/depositos/excel error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message }); else res.end();
  }
});

// ═══════════════════════ REPORTE: LIQUIDACIONES ══════════════════════════

// Costos reales capturados en la liquidación (columnas *REAL de Empresa2.Liquida).
const REALES_LIQ = [
  ['Maniobras', 'TOTALMANREAL'], ['Préstamo', 'COSTOPRESTAMOREAL'], ['Talacha', 'COSTOTALACHAREAL'], ['Llanta', 'COSTOCOMPLLANTAREAL'],
  ['Comidas', 'COSTOCOMIDASREAL'], ['Casetas', 'COSTOCASETATICKREAL'], ['Maniobras extra / báscula', 'COSTOMANIOBRASEXTREAL'],
  ['Pensión', 'COSTOPENSIONREAL'], ['Refacciones', 'COSTOREFACCIONESREAL'], ['Diesel', 'COSTODIESELREAL'],
  ['Estadías', 'COSTOESTADIASREAL'], ['Demoras', 'COSTODEMORASREAL'], ['Otros', 'COSTOOTROSREAL'],
];
const COLUMNAS_LIQUIDACIONES = [
  { header: 'Mes',               campo: 'MES',              tipo: 'entero' },
  { header: 'Id Liquidación',    campo: 'ID_LIQUIDACION',   tipo: 'entero' },
  { header: 'Fecha',             campo: 'Fecha',            tipo: 'fecha' },
  { header: 'Id Operador',       campo: 'ID_OPERADOR',      tipo: 'entero' },
  { header: 'Operador',          campo: 'OPERADOR',         tipo: 'texto' },
  { header: 'Total Liquidación', campo: 'TOTALLIQUIDACION', tipo: 'moneda' },
  { header: 'Desc. Incidencias', campo: 'DESCINCIDENCIAS', tipo: 'moneda' },
  ...REALES_LIQ.map(([h, c]) => ({ header: `Real ${h}`, campo: c, tipo: 'moneda' })),
  { header: 'Total Diferencia',  campo: 'TOTALDIF',         tipo: 'moneda' },
  { header: 'Dif. Aplicada',     campo: 'Aplicada',         tipo: 'texto' },
];

router.get('/liquidaciones', requierePermiso('reportes.liquidaciones.ver'), (req, res) => res.render('reportes-liquidaciones', { usuario: req.session.usuario, modulo: 'reportes-liquidaciones' }));

// Operadores con liquidaciones (para el combo "Operador").
router.get('/liquidaciones/operadores', requierePermiso('reportes.liquidaciones.ver'), async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT DISTINCT ID_OPERADOR, LTRIM(RTRIM(OPERADOR)) AS OPERADOR FROM Empresa2.Liquida
      WHERE ID_OPERADOR IS NOT NULL ORDER BY OPERADOR`);
    res.json({ operadores: r.recordset.map(o => ({ id: o.ID_OPERADOR, nombre: trim(o.OPERADOR) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/liquidaciones/excel', requierePermiso('reportes.liquidaciones.ver'), async (req, res) => {
  try {
    const fechaIni = trim(req.query.fechaIni);
    const fechaFin = trim(req.query.fechaFin);
    if (!fechaIni || !fechaFin) return res.status(400).json({ error: 'El rango de fechas es obligatorio.' });
    const idOperador = parseInt(req.query.idOperador) || null;   // vacío = todos

    const pool = await getPool();
    const result = await pool.request()
      .input('fechaIni', sql.Date, fechaIni).input('fechaFin', sql.Date, fechaFin)
      .input('op', sql.Int, idOperador)
      .query(`SELECT MES, ID_LIQUIDACION, CONVERT(varchar(10), FECHA, 103) AS Fecha, ID_OPERADOR, LTRIM(RTRIM(OPERADOR)) AS OPERADOR,
                     ISNULL(TOTALLIQUIDACION,0) AS TOTALLIQUIDACION, ISNULL(DESCINCIDENCIAS,0) AS DESCINCIDENCIAS,
                     ${REALES_LIQ.map(([, c]) => `ISNULL(${c},0) AS ${c}`).join(', ')},
                     ISNULL(TOTALDIF,0) AS TOTALDIF,
                     CASE WHEN ISNULL(DifAplicada,0) <> 0 THEN 'Sí' ELSE 'No' END AS Aplicada
                FROM Empresa2.Liquida
               WHERE FECHA BETWEEN @fechaIni AND @fechaFin AND UPPER(LTRIM(RTRIM(ISNULL(STATUS,'')))) NOT LIKE 'CANCEL%'
                 AND (@op IS NULL OR ID_OPERADOR = @op)
               ORDER BY FECHA, MES, ID_LIQUIDACION`);

    const operador = idOperador ? (result.recordset[0] ? trim(result.recordset[0].OPERADOR) : `Id ${idOperador}`) : 'Todos los operadores';
    const workbook = construirWorkbookReporte({
      nombreHoja: 'Liquidaciones',
      titulo: 'Reporte de Liquidaciones',
      subtitulo: `Del ${fmtFechaTitulo(fechaIni)} al ${fmtFechaTitulo(fechaFin)} — ${operador} (sin canceladas)`,
      columnas: COLUMNAS_LIQUIDACIONES,
      filas: result.recordset,
      columnasTotales: ['Total Liquidación', 'Desc. Incidencias', ...REALES_LIQ.map(([h]) => `Real ${h}`), 'Total Diferencia'],
    });
    await enviarWorkbook(res, workbook, 'Liquidaciones', fechaIni, fechaFin);
  } catch (err) {
    console.error('reportes/liquidaciones/excel error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message }); else res.end();
  }
});

module.exports = router;
