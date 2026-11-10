'use strict';

// ── Conceptos de una Factura con "Incluir CP" y varias partidas ─────────────
// Con Factura.IncluirCP=1 y MÁS de una partida:
//   - la partida 1 es el flete: se factura con sus propios datos y es la que arma el complemento Carta Porte;
//   - las demás partidas son conceptos normales de la factura, con la clave 78141500 y la descripción
//     "Gastos logísticos de apoyo y otros cargos operativos del traslado".
// Con una sola partida (o sin Incluir CP) todo queda como siempre. Lo usan el XML (cfdi-factura.js) y el PDF
// (factura-pdf.js) para que ambos digan lo mismo.

const CLAVE_PRODSERV_APOYO = '78141500';
const DESCRIPCION_APOYO = 'Gastos logísticos de apoyo y otros cargos operativos del traslado';

const esMultipartidaConCP = (fac, lineas) => parseInt(fac && fac.IncluirCP) === 1 && (lineas || []).length > 1;

// ¿La partida en la posición `idx` (0 = primera) es un concepto de apoyo?
const esPartidaDeApoyo = (fac, lineas, idx) => esMultipartidaConCP(fac, lineas) && idx > 0;

module.exports = { CLAVE_PRODSERV_APOYO, DESCRIPCION_APOYO, esMultipartidaConCP, esPartidaDeApoyo };
