'use strict';

// ── Parámetros del módulo de Liquidaciones de operadores ────────────────────
// Todo lo que sería un "número mágico" vive aquí para poder ajustarlo sin tocar el cálculo.

module.exports = {
  // IVA incluido en las casetas: sinIva = real / (1 + IVA_TASA)
  IVA_TASA: 0.16,

  // Serie de dbo.Empresas de la que se toman SueldoBaseOpe / PagoIMSSOpe al crear una liquidación.
  SERIE_EMPRESA_PARAMS: process.env.LIQ_SERIE_EMPRESA || 'CUA',

  // Infonavit del operador (Operadores.TipoDesInfonavit): monto / divisor según el periodo.
  //   S = monto completo, Q = monto / 2, M = monto / 4. Otro valor o vacío = sin descuento.
  INFONAVIT_DIVISOR: { S: 1, Q: 2, M: 4 },
  // Montos de Infonavit mayores a esto se consideran dato corrupto de la migración y se ignoran con advertencia.
  INFONAVIT_MAX_VALIDO: 100000,

  // Año al que corresponde Empresa2.CartaPorte (y Liquida/LiqDeta). Los años anteriores viven en
  // Empresa2.CartaPorteAA (AA = últimos 2 dígitos del año).
  anioTablaActual: () => parseInt(process.env.LIQ_ANIO_ACTUAL, 10) || new Date().getFullYear(),

  // Mes activo para las liquidaciones nuevas.
  mesActivo: () => new Date().getMonth() + 1,

  STATUS_GENERADA: 'GENERADA',
  STATUS_PAGADA: 'PAGADA',
  STATUS_CANCELADA: 'CANCELADA',
};
