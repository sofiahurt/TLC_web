'use strict';

// Varios "Centrales" (Empresa2.Centrales) operan bajo la misma razón social/CSD
// registrada en dbo.Empresas (que solo tiene una fila por empresa fiscal real,
// no por central operativo). Este mapa resuelve a qué SERIE de dbo.Empresas
// consultar para timbrado/PDF cuando el central activo no tiene su propia fila
// ahí — SOLO para esa consulta; el Serie real de Empresa2.CartaPorte (folio,
// numeración, etc.) sigue siendo el central operativo tal cual (CUI, CUV...).
//
// Confirmado con el usuario: TODOS los centrales de Empresa2.Centrales (CUA,
// GDL, TOL, CHD, CUI, CUV) son sucursales de la misma razón social —
// Transportación y Logística El Cedro (SERIE='CUA' en dbo.Empresas) — y
// comparten RFC/CSD/PAC. TLA es una empresa distinta (no aparece como central
// operativo aquí) y conserva su propia fila en dbo.Empresas sin pasar por este mapa.
const MAPA_SERIE_FISCAL = {
  CUA: 'CUA',
  GDL: 'CUA',
  TOL: 'CUA',
  CHD: 'CUA',
  CUI: 'CUA',
  CUV: 'CUA',
};

function serieFiscal(central) {
  const c = String(central || '').trim().toUpperCase();
  return MAPA_SERIE_FISCAL[c] || c;
}

module.exports = { serieFiscal };
