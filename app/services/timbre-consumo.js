'use strict';

const { sql } = require('../config/db');

// ── Descuento y bitácora de timbres consumidos ─────────────────────────────
//
// Compartido entre Carta Porte y Factura (parametrizado por `tipo`). Se
// llama SOLO después de un timbrado exitoso ante el PAC — nunca antes, y
// nunca en caso de error (no se consume crédito por un intento fallido).
//
// Confirmado contra datos reales de Empresa2.ParamTimbreDeta: el literal de
// `Tipo` para facturas ya usado históricamente por el sistema legado es
// exactamente 'Factura' (13,009 filas reales). 'Traslado' para Carta Porte
// es nuevo (el timbrado de CP no existía en el sistema legado), pero sigue
// la misma convención de un tipo capitalizado en español.
//
// @param {object} pool Conexión mssql
// @param {{tipo: 'Factura'|'Traslado', serie: string, idFacVen: string, uuid: string}} datos
// @returns {Promise<void>}
async function descontarTimbre(pool, { tipo, serie, idFacVen, uuid }) {
  const vigenteRes = await pool.request()
    .query(`SELECT TOP 1 ID_TIMBRES FROM Empresa2.ParamTimbre WHERE VIGENTE=1 AND TIMBRESUTIL>0 ORDER BY FECHA DESC`);
  const vigente = vigenteRes.recordset[0];
  if (!vigente) {
    // No hay timbres disponibles para descontar. NO se revierte el timbrado
    // (el CFDI ya está timbrado ante el SAT, es válido pase lo que pase aquí)
    // — solo se deja de llevar la bitácora/descuento, y se registra el aviso
    // para que el llamador decida si informarlo al usuario.
    console.error(`descontarTimbre: no hay ningún lote de Empresa2.ParamTimbre VIGENTE con crédito disponible (tipo=${tipo}, uuid=${uuid})`);
    return;
  }

  // Nota: ULTIMAFACTIM no se toca -- es decimal y su contrato exacto (¿folio
  // numérico de factura? ¿otra cosa?) no está confirmado, y el folio de
  // Carta Porte ni siquiera es numérico. TIMBRESUTIL es lo único con
  // semántica clara (crédito restante) y es lo único que se decrementa aquí.
  await pool.request()
    .input('id', sql.Decimal(9), vigente.ID_TIMBRES)
    .query(`UPDATE Empresa2.ParamTimbre SET TIMBRESUTIL = TIMBRESUTIL - 1 WHERE ID_TIMBRES=@id`);

  const nextRes = await pool.request()
    .input('id', sql.Decimal(9), vigente.ID_TIMBRES)
    .query(`SELECT ISNULL(MAX(Id_NoTimbre),0)+1 AS next FROM Empresa2.ParamTimbreDeta WHERE Id_Timbres=@id`);
  const idNoTimbre = nextRes.recordset[0].next;

  await pool.request()
    .input('idTimbres', sql.Decimal(9), vigente.ID_TIMBRES)
    .input('idNoTimbre', sql.Decimal(9), idNoTimbre)
    .input('tipo', sql.VarChar(20), tipo)
    .input('serie', sql.VarChar(20), serie || null)
    .input('idFacVen', sql.VarChar(20), String(idFacVen))
    .input('uuid', sql.VarChar(40), uuid)
    .query(`INSERT INTO Empresa2.ParamTimbreDeta(Id_Timbres, Id_NoTimbre, Tipo, Serie, Id_FacVen, UUID, CodigoError, DesError)
            VALUES(@idTimbres, @idNoTimbre, @tipo, @serie, @idFacVen, @uuid, '', '')`);
}

module.exports = { descontarTimbre };
