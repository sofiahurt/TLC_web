'use strict';

// ── Cancelación fiscal ante el PAC — compartida entre Carta Porte, Factura y
// Notas de Crédito/Débito, parametrizada por los datos del CFDI a cancelar,
// no por tipo de documento (el llamador decide qué tabla/columnas tocar).
//
// Reutiliza tal cual (sin reescribir): resolverConexionPAC (sandbox vs.
// producción según TESTFEL), cargarCSD (mismo CSD que sellarXML) y
// cancelarConPAC (operación "cancelar" del PAC, DER+contraseña — confirmada
// en vivo contra el sandbox real; la alternativa cancelarPEM fue rechazada
// por el PAC, ver [[project_modulo_notacred]]).

const { resolverConexionPAC } = require('./cfdi-pac');
const { cargarCSD } = require('./cfdi-sello');
const { cancelarConPAC } = require('./cfdi-pac');

/**
 * Ejecuta la cancelación fiscal de un CFDI ya timbrado ante el PAC.
 *
 * @param {object} pool Conexión mssql
 * @param {string} central Serie/central activa (para resolver Empresa/CSD/conexión PAC)
 * @param {{uuid: string, rfcEmisor: string, rfcReceptor: string, total: string|number, motivo: string, folioSustitucion?: string}} datos
 * @returns {Promise<{
 *   resultado: 'exito'|'pendiente'|'error',
 *   mensaje: string,
 *   acuseXml: string|null,
 *   pacResult: object,
 * }>}
 */
async function ejecutarCancelacionFiscal(pool, central, datos) {
  const conexion = await resolverConexionPAC(pool, central);
  const { emp } = await cargarCSD(central, pool);

  const pacResult = await cancelarConPAC(
    { cerPath: (emp.CERTIFICADOCER || '').trim(), keyPath: (emp.CERTIFICADOKEY || '').trim(), password: (emp.PASSWORDKEY || '').trim() },
    conexion,
    datos,
  );

  if (pacResult.exito) {
    return { resultado: 'exito', mensaje: 'Cancelación aceptada por el SAT.', acuseXml: pacResult.acuseXml || null, pacResult };
  }

  // El PAC no distingue explícitamente "pendiente" de "error" con un código
  // propio confirmado (solo se probó en vivo el camino de éxito) -- se
  // detecta por el texto del mensaje como mejor esfuerzo razonable. Si en la
  // práctica el PAC usa otra palabra/código para este caso, ajustar aquí.
  const mensaje = pacResult.mensajeError || 'El PAC rechazó la cancelación sin mensaje de error';
  if (/pendiente/i.test(mensaje)) {
    return { resultado: 'pendiente', mensaje, acuseXml: null, pacResult };
  }

  return { resultado: 'error', mensaje, acuseXml: null, pacResult };
}

module.exports = { ejecutarCancelacionFiscal };
