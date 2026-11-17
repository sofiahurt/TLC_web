'use strict';

// ── Series por default de los documentos nuevos ─────────────────────────────
// Se usan cuando el usuario no teclea una serie. Los documentos anteriores a este cambio se actualizan
// con scripts/sql/series-por-defecto.sql (misma serie, mismos consecutivos).
//   Facturas -> Factura.SerieFac     Notas de Crédito/Débito -> NotaCred.Serie     Cobros -> Pagos.Serie
const SERIES = {
  FACTURA: process.env.SERIE_FACTURA || 'FTLC',
  NOTA_CREDITO: process.env.SERIE_NOTA_CREDITO || 'NCTLC',
  NOTA_DEBITO: process.env.SERIE_NOTA_DEBITO || 'NDTLC',
  PAGO: process.env.SERIE_PAGO || 'PTLC',
};

// 'NC' / 'ND' -> serie por default de la nota
const serieNota = tipo => (String(tipo || '').trim().toUpperCase() === 'ND' ? SERIES.NOTA_DEBITO : SERIES.NOTA_CREDITO);

module.exports = { ...SERIES, serieNota };
