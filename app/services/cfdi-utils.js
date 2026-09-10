'use strict';

// Helpers compartidos para armar CFDI 4.0 (Facturas, Notas de Crédito/Débito).
// Extraído de cfdi-factura.js para no duplicar la lógica de Impuestos por
// concepto (IVA 16%/retención ISR 001 4%), incluido el Base obligatorio que
// costó un bug real de cadena original ya corregido una vez.

const { getSatDb } = require('../config/sat-db');

function fmt(v) { return v ? String(v).trim() : ''; }
function fmtDec(v, dec = 2) { return (parseFloat(v) || 0).toFixed(dec); }

function isoFecha(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().replace(/\.\d{3}Z$/, '');
}

// Combina una fecha (date) y una hora (time/datetime) en un solo ISO local
// sin zona -- misma convención usada en todo el módulo de timbrado.
function isoFechaHora(fecha, hora) {
  if (!fecha) return isoFecha(new Date());
  const f = (fecha instanceof Date ? fecha : new Date(fecha)).toISOString().slice(0, 10);
  const h = hora ? (hora instanceof Date ? hora.toISOString().slice(11, 19) : String(hora).slice(0, 8)) : '00:00:00';
  return `${f}T${h}`;
}

const IVA_TASA = '0.160000';
const RET_TASA = '0.040000';

function claveUnidadDescripcion(claveUnidad) {
  const clave = fmt(claveUnidad);
  if (!clave) return '';
  try {
    const db = getSatDb();
    const row = db.prepare('SELECT nombre FROM sat_Unidad WHERE c_claveunidad = ?').get(clave);
    return row ? fmt(row.nombre) : '';
  } catch (e) { return ''; }
}

// Arma un cfdi:Concepto con su Impuestos (IVA 16% + retención ISR 001 4% si
// aplica) y regresa los importes para acumular a nivel comprobante.
function agregarConcepto(conceptosNode, { claveProdServ, claveUnidad, descripcion, subtotal, iva, reten }) {
  const importe = fmtDec(subtotal, 2);
  const concepto = conceptosNode.ele('cfdi:Concepto', {
    ClaveProdServ: fmt(claveProdServ) || '78141500',
    Cantidad:      '1',
    ClaveUnidad:   fmt(claveUnidad) || 'E48',
    Unidad:        claveUnidadDescripcion(claveUnidad) || undefined,
    Descripcion:   fmt(descripcion) || 'SERVICIO DE TRANSPORTE',
    ValorUnitario: importe,
    Importe:       importe,
    ObjetoImp:     '02',
  });

  const impuestosNode = concepto.ele('cfdi:Impuestos');
  if (iva > 0.005) {
    impuestosNode.ele('cfdi:Traslados').ele('cfdi:Traslado', {
      Base: importe, Impuesto: '002', TipoFactor: 'Tasa', TasaOCuota: IVA_TASA, Importe: fmtDec(iva, 2),
    }).up().up();
  }
  if (reten > 0.005) {
    impuestosNode.ele('cfdi:Retenciones').ele('cfdi:Retencion', {
      Base: importe, Impuesto: '001', TipoFactor: 'Tasa', TasaOCuota: RET_TASA, Importe: fmtDec(reten, 2),
    }).up().up();
  }
  impuestosNode.up();
  concepto.up();

  return { subtotal: parseFloat(importe), iva, reten };
}

module.exports = {
  fmt, fmtDec, isoFecha, isoFechaHora, IVA_TASA, RET_TASA, claveUnidadDescripcion, agregarConcepto,
};
