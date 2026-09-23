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
    columna.width = 16;
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
      SELECT fd.*
      FROM Empresa2.fn_CartaPorteDetalle(@fechaIni, @fechaFin) fd
      JOIN Empresa2.CartaPorte cp ON cp.Serie = fd.Serie AND cp.CartaPorte = fd.CartaPorte
      ${where}
      ORDER BY fd.Serie, fd.CartaPorte`;
    const result = await request.query(query);

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

module.exports = router;
