'use strict';

const { getPool } = require('../config/db');

// Empresa2.NotaCred no traía moneda: se agregan Moneda (clave SAT, como Factura.MonFactura) y TipoCambio.
// Las notas existentes quedan en NULL, que se interpreta como MXN.
let _esquema = null;
function asegurarEsquemaNotaCred() {
  if (!_esquema) {
    const nuevas = [['Moneda', 'VARCHAR(5)'], ['TipoCambio', 'DECIMAL(9,2)']];
    _esquema = getPool().then(async pool => {
      for (const [c, tipo] of nuevas) {
        await pool.request().query(`IF COL_LENGTH('Empresa2.NotaCred', '${c}') IS NULL ALTER TABLE Empresa2.NotaCred ADD ${c} ${tipo} NULL`);
      }
    }).catch(e => { _esquema = null; throw e; });
  }
  return _esquema;
}

// 'Pesos'/vacío -> MXN; 'Dolares' -> USD; si no, la clave tal cual en mayúsculas.
function monedaNota(v) {
  const m = (v == null ? '' : String(v)).trim().toUpperCase();
  if (!m || m === 'PESOS') return 'MXN';
  if (m === 'DOLARES' || m === 'DÓLARES') return 'USD';
  return m;
}

module.exports = { asegurarEsquemaNotaCred, monedaNota };
