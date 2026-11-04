'use strict';

// ── Cálculo de totales de una Liquidación de operador ───────────────────────
// Función PURA y única fuente de verdad: se ejecuta SIEMPRE en el servidor al crear, agregar/quitar
// viaje, editar reales y guardar. No toca la base ni muta sus argumentos.
//
// El dinero se maneja en CENTAVOS ENTEROS (nunca se suman floats): cada valor entra con
// aCentavos() y sale con deCentavos().

const cfg = require('../config/liquidaciones');

// Conceptos de costo por viaje. Cada uno tiene trío { estimado, real, dif } en la liquidación y
// un costo por renglón en renglon.costos[clave].
const CONCEPTOS = ['maniobras', 'prestamo', 'talacha', 'compllanta', 'comidas', 'caseta',
  'maniobrasExt', 'pension', 'refacciones', 'diesel', 'estadias', 'demoras', 'otros'];

const aCentavos = v => {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.round(Number(n.toFixed(6)) * 100);
};
const deCentavos = c => c / 100;
// n (con decimales) * m (con decimales) -> centavos
const productoCentavos = (a, b) => Math.round(Number((Number(a || 0) * Number(b || 0)).toFixed(6)) * 100);

const trio = (liq, k) => (liq && liq[k]) || {};

/**
 * @param {object} liq      Cabecera: sueldoBase, imss, infonavit, extraComision, extraDescuento,
 *                          dieselRellenado, totalAdelanto y, por concepto, { real } capturado.
 * @param {object[]} renglones  { costoFlete, kilometros, pagoKilometro, pagoViaje, dieselPermitido,
 *                          costos: { maniobras, prestamo, ... } }
 * @returns {object} copia de liq con todos los totales recalculados
 */
function calcularTotales(liq, renglones, opciones = {}) {
  liq = liq || {};
  renglones = renglones || [];
  const ivaTasa = opciones.ivaTasa != null ? opciones.ivaTasa : cfg.IVA_TASA;
  const out = { ...liq };

  // 1. Sumatoria de renglones
  const est = {};
  CONCEPTOS.forEach(k => { est[k] = 0; });
  let totalFlete = 0, dieselPermitido = 0, totalComision = 0;
  for (const r of renglones) {
    CONCEPTOS.forEach(k => { est[k] += aCentavos((r.costos || {})[k]); });
    totalFlete += aCentavos(r.costoFlete);
    dieselPermitido += aCentavos(r.dieselPermitido);
    // 3. Comisión por renglón: por kilómetro si hay pagoKilometro; si no, por viaje.
    if (Number(r.pagoKilometro) !== 0 && r.pagoKilometro != null) totalComision += productoCentavos(r.kilometros, r.pagoKilometro);
    else if (Number(r.pagoViaje) !== 0 && r.pagoViaje != null) totalComision += aCentavos(r.pagoViaje);
  }

  // 9. Reales y diferencias por concepto. real == 0 -> real = estimado (un real ya capturado NO se pisa).
  const real = {};
  let totalDif = 0;
  CONCEPTOS.forEach(k => {
    const capturado = aCentavos(trio(liq, k).real);
    real[k] = capturado === 0 ? est[k] : capturado;
    const dif = est[k] - real[k];
    totalDif += dif;
    out[k] = { estimado: deCentavos(est[k]), real: deCentavos(real[k]), dif: deCentavos(dif) };
  });

  // 2. Caseta sin IVA
  out.caseta.sinIva = deCentavos(Math.round(real.caseta / (1 + ivaTasa)));

  // 4. Diesel descontado: siempre positivo; 0 si no excede lo permitido
  const dieselRellenado = aCentavos(liq.dieselRellenado);
  const desDiesel = Math.max(0, dieselRellenado - dieselPermitido);

  // 5. Descuentos: diesel excedido + adelanto (el adelanto SÍ se descuenta al operador)
  const totalAdelanto = aCentavos(liq.totalAdelanto);
  const totalDesc = desDiesel + totalAdelanto;

  // 6. Total a liquidar al operador
  const sueldoBase = aCentavos(liq.sueldoBase), imss = aCentavos(liq.imss), infonavit = aCentavos(liq.infonavit);
  const extraComision = aCentavos(liq.extraComision), extraDescuento = aCentavos(liq.extraDescuento);
  const totalLiquidacion = (totalComision + extraComision + sueldoBase) - (totalDesc + extraDescuento + infonavit + imss);

  // 7. Gastos del viaje que absorbe la empresa
  const casetaSinIva = Math.round(real.caseta / (1 + ivaTasa));
  const totalViaje = dieselRellenado + totalAdelanto + real.maniobras + real.prestamo + real.talacha
    + real.compllanta + real.comidas + real.pension + real.refacciones + casetaSinIva
    + real.maniobrasExt + real.diesel + real.estadias + real.demoras + real.otros;

  // 8. Gran total y utilidad
  const granTotalLiq = totalLiquidacion + totalViaje;

  Object.assign(out, {
    totalFlete: deCentavos(totalFlete),
    dieselPermitido: deCentavos(dieselPermitido),
    dieselRellenado: deCentavos(dieselRellenado),
    totalComision: deCentavos(totalComision),
    desDiesel: deCentavos(desDiesel),
    totalAdelanto: deCentavos(totalAdelanto),
    totalDesc: deCentavos(totalDesc),
    totalLiquidacion: deCentavos(totalLiquidacion),
    totalViaje: deCentavos(totalViaje),
    granTotalLiq: deCentavos(granTotalLiq),
    totalUtilidad: deCentavos(totalFlete - granTotalLiq),
    totalDif: deCentavos(totalDif),
  });
  return out;
}

// Comisión de un renglón (para mostrarla y para el recibo): la misma regla del paso 3.
function comisionRenglon(r) {
  if (r.pagoKilometro != null && Number(r.pagoKilometro) !== 0) return deCentavos(productoCentavos(r.kilometros, r.pagoKilometro));
  if (r.pagoViaje != null && Number(r.pagoViaje) !== 0) return deCentavos(aCentavos(r.pagoViaje));
  return 0;
}

module.exports = { calcularTotales, comisionRenglon, CONCEPTOS, aCentavos, deCentavos };
