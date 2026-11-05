'use strict';

// ── Recibo de liquidación del operador (PDF) ────────────────────────────────
// Un recibo por liquidación. Los costos del viaje (casetas, maniobras, etc.) NO se imprimen:
// solo el importe comisionado de cada viaje y el desglose del pago al operador.

const { getPool, sql } = require('../config/db');
const cfg = require('../config/liquidaciones');

const PdfPrinter  = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;
const vfs         = require('pdfmake/js/virtual-fs.js').default;
const FONTS = { Helvetica: require('pdfmake/standard-fonts/Helvetica.js').Helvetica };

const dinero = v => Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const fechaMx = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

async function empresa() {
  const pool = await getPool();
  const r = await pool.request().input('s', sql.VarChar(3), cfg.SERIE_EMPRESA_PARAMS)
    .query(`SELECT NOMBRECORTO, RFC FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE))=@s`);
  return r.recordset[0] || {};
}

function paginaRecibo(liq, emp, esPrimera) {
  const filas = liq.viajes.map(v => [
    { text: v.serie, noWrap: true }, { text: v.cartaPorte, noWrap: true }, { text: v.desFlete },
    { text: dinero(v.comision), alignment: 'right', noWrap: true },
  ]);
  const linea = (concepto, importe, negrita) => [
    { text: concepto, bold: !!negrita }, { text: dinero(importe), alignment: 'right', bold: !!negrita },
  ];
  return [
    { text: (emp.NOMBRECORTO || '').trim(), bold: true, fontSize: 13, alignment: 'center', pageBreak: esPrimera ? undefined : 'before' },
    { text: 'RECIBO DE LIQUIDACIÓN', bold: true, fontSize: 11, alignment: 'center', margin: [0, 2, 0, 8] },
    { columns: [
      { text: [{ text: 'Mes - No. Pago: ', bold: true }, `${MESES[liq.mes] || liq.mes} - ${liq.numero}`] },
      { text: [{ text: 'Fecha: ', bold: true }, fechaMx(liq.fecha)], alignment: 'right' },
    ] },
    { text: [{ text: 'Operador: ', bold: true }, `${liq.idOperador} - ${liq.operador}`], margin: [0, 2, 0, 8] },
    {
      table: {
        headerRows: 1, widths: [40, 95, '*', 85],
        body: [
          [{ text: 'Serie', bold: true }, { text: 'Carta Porte', bold: true }, { text: 'Descripción del flete', bold: true }, { text: 'Importe', bold: true, alignment: 'right' }],
          ...(filas.length ? filas : [[{ text: 'Sin viajes', colSpan: 4, alignment: 'center', italics: true }, {}, {}, {}]]),
        ],
      },
      layout: { hLineWidth: (i) => (i <= 1 ? 1 : 0.3), vLineWidth: () => 0, hLineColor: () => '#888' },
    },
    { text: '', margin: [0, 6, 0, 0] },
    {
      columns: [{ text: '', width: '*' }, {
        width: 250,
        table: {
          widths: ['*', 90],
          body: [
            linea('Viajes', liq.totalComision),
            linea('Sueldo Base', liq.sueldoBase),
            ...(liq.extraComision ? [linea('Extra comisión', liq.extraComision)] : []),
            linea('Desc. Diesel', -liq.desDiesel),
            ...(liq.totalAdelanto ? [linea('Adelantos', -liq.totalAdelanto)] : []),
            ...(liq.extraDescuento ? [linea('Otros descuentos', -liq.extraDescuento)] : []),
            ...(liq.difAplicada ? [linea('Diferencias', -liq.difAplicada)] : []),
            linea('IMSS', -liq.imss),
            linea('Infonavit', -liq.infonavit),
            linea('Total a Liquidar', liq.totalLiquidacion, true),
          ],
        },
        layout: { hLineWidth: (i, n) => (i === n.table.body.length - 1 ? 1 : 0), vLineWidth: () => 0 },
      }],
    },
    { text: '', margin: [0, 50, 0, 0] },
    { columns: [{ text: '', width: '*' }, { width: 220, stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 220, y2: 0, lineWidth: 0.7 }] },
      { text: liq.operador, alignment: 'center', margin: [0, 2, 0, 0] },
      { text: 'Firma del operador', alignment: 'center', fontSize: 7, color: '#555' },
    ] }, { text: '', width: '*' }] },
  ];
}

// liquidaciones: modelos completos (con viajes). Devuelve Buffer PDF.
async function generarRecibosPDF(liquidaciones) {
  const emp = await empresa();
  const content = liquidaciones.length
    ? liquidaciones.flatMap((l, i) => paginaRecibo(l, emp, i === 0))
    : [{ text: 'No hay liquidaciones para los filtros indicados.', alignment: 'center' }];
  const docDefinition = { pageSize: 'LETTER', pageMargins: [40, 40, 40, 40], defaultStyle: { font: 'Helvetica', fontSize: 9, lineHeight: 1.2 }, content };
  const printer = new PdfPrinter(FONTS, vfs, new URLResolver());
  const pdfDoc = await printer.createPdfKitDocument(docDefinition);
  return new Promise((resolve, reject) => {
    const chunks = [];
    pdfDoc.on('data', c => chunks.push(c));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
    pdfDoc.end();
  });
}

module.exports = { generarRecibosPDF };
