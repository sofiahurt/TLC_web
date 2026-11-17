'use strict';

// Prueba de integración de Incidencias contra la base real: alta, cobros manuales, descuento en una liquidación
// (aplicar / quitar / eliminar liquidación) y limpieza. Todo lo que crea se borra al final.
//   node scripts/test-incidencias.js
const assert = require('assert');
const { getPool, sql } = require('../app/config/db');
const inc = require('../app/services/incidencias');
const liq = require('../app/services/liquidaciones');

const ok = m => console.log('  ok  ' + m);
const r2 = v => Math.round(Number(v) * 100) / 100;

(async () => {
  await inc.asegurarEsquema();
  const pool = await getPool();
  const creadas = [], liqs = [];
  try {
    // Una carta porte real (no cancelada) de un operador activo
    const cp = (await pool.request().query(`SELECT TOP 1 c.Serie, c.CartaPorte, c.Id_Operador FROM Empresa2.CartaPorte c
      JOIN Empresa2.Operadores o ON o.ID_OPERADOR=c.Id_Operador
      WHERE UPPER(LTRIM(RTRIM(o.STATUS)))='ACTIVO' AND UPPER(LTRIM(RTRIM(ISNULL(c.Status,'')))) NOT LIKE 'CANCELAD%' ORDER BY c.FechaPedido DESC`)).recordset[0];
    assert(cp, 'No hay carta porte de prueba');
    const dat = { serie: cp.Serie.trim(), cartaPorte: cp.CartaPorte.trim(), tipoIncidencia: 'PRUEBA QA', descripcion: 'prueba automática', importe: 1000, flagCobOpe: true, parcialidades: 3 };

    // 1. Alta: ImporteParcial, adeudo y operador tomado de la carta porte
    const a = await inc.crear(dat, 'QA'); creadas.push(a.id);
    assert.strictEqual(a.importeParcial, 333.33); assert.strictEqual(a.montoAdeudo, 1000); assert.strictEqual(a.idOperador, cp.Id_Operador); assert.strictEqual(a.status, 'ACTIVA');
    assert.strictEqual(a.sugerido, 333.33); ok('alta: parcialidad 333.33, adeudo 1000, operador de la carta porte');

    // 2. Validaciones
    await assert.rejects(inc.crear({ ...dat, serie: 'ZZZ', cartaPorte: 'NOEXISTE' }, 'QA'), /No existe la Carta Porte/);
    await assert.rejects(inc.crear({ ...dat, tipoIncidencia: '' }, 'QA'), /tipo de incidencia/);
    await assert.rejects(inc.crear({ ...dat, importe: 0 }, 'QA'), /mayor a 0/);
    ok('validaciones (carta porte inexistente, tipo vacío, importe 0)');

    // 3. No cobrable: sin parcialidades ni adeudo
    const b = await inc.crear({ ...dat, flagCobOpe: false }, 'QA'); creadas.push(b.id);
    assert.strictEqual(b.parcialidades, 0); assert.strictEqual(b.montoAdeudo, 0); assert.strictEqual(b.importeParcial, 0);
    await assert.rejects(inc.registrarCobroManual(b.id, { importe: 10 }, 'QA'), /no es cobrable/); ok('no cobrable: sin adeudo ni cobros');

    // 4. Cobro manual + recálculo
    let x = await inc.registrarCobroManual(a.id, { importe: 333.33, observaciones: 'manual' }, 'QA');
    assert.strictEqual(x.importeCob, 333.33); assert.strictEqual(x.montoAdeudo, 666.67); assert.strictEqual(x.parcialPag, 1);
    await assert.rejects(inc.registrarCobroManual(a.id, { importe: 5000 }, 'QA'), /excede el adeudo/); ok('cobro manual: cobrado 333.33, adeudo 666.67, 1 parcialidad; no deja pasar del adeudo');
    await assert.rejects(inc.cancelar(a.id, 'QA'), /ya tiene cobros/);
    await assert.rejects(inc.editar(a.id, { ...dat, importe: 100, parcialidades: 3 }, 'QA'), /menor a lo ya cobrado/); ok('con cobros no se cancela ni se baja el importe por debajo de lo cobrado');

    // 5. Descuento en una liquidación (aplicar, total, quitar, reaplicar)
    const nueva = await liq.crear(cp.Id_Operador, 'QA'); const idL = nueva.liquidacion.id; liqs.push(idL);
    const antes = nueva.liquidacion.totalLiquidacion;
    let d = await liq.incidenciasDeLiquidacion(idL);
    const p = d.pendientes.find(i => i.id === a.id); assert(p, 'la incidencia debe aparecer pendiente'); assert.strictEqual(p.sugerido, 333.33);
    let l = await liq.aplicarIncidencias(idL, [{ idIncidencia: a.id, importe: 333.33 }], 'QA');
    assert.strictEqual(l.descIncidencias, 333.33); assert.strictEqual(r2(l.totalLiquidacion), r2(antes - 333.33)); ok('liquidación: descuento 333.33 resta del total a liquidar');
    x = await inc.obtener(a.id); assert.strictEqual(x.importeCob, 666.66); assert.strictEqual(x.parcialPag, 2); assert.strictEqual(x.montoAdeudo, 333.34);
    assert.strictEqual(x.sugerido, 333.34); ok('incidencia: cobrado 666.66, 2 de 3, la última parcialidad absorbe el redondeo (333.34)');
    await assert.rejects(liq.aplicarIncidencias(idL, [{ idIncidencia: a.id, importe: 10 }], 'QA'), /ya está descontada/);
    d = await liq.incidenciasDeLiquidacion(idL); assert.strictEqual(d.aplicadas.length, 1);
    l = await liq.quitarIncidencia(idL, a.id, d.aplicadas[0].idPago, 'QA');
    assert.strictEqual(l.descIncidencias, 0); assert.strictEqual(r2(l.totalLiquidacion), r2(antes));
    x = await inc.obtener(a.id); assert.strictEqual(x.importeCob, 333.33); ok('quitar el descuento regresa el total y el adeudo');

    // 6. Cobrar toda la incidencia -> SALDADA; eliminar la liquidación revierte lo descontado
    l = await liq.aplicarIncidencias(idL, [{ idIncidencia: a.id, importe: 666.67 }], 'QA');
    x = await inc.obtener(a.id); assert.strictEqual(x.status, 'SALDADA'); assert.strictEqual(x.montoAdeudo, 0);
    await assert.rejects(inc.registrarCobroManual(a.id, { importe: 1 }, 'QA'), /excede el adeudo|CANCELADA|no es cobrable/); ok('saldada al cobrar todo; ya no admite más cobros');
    await liq.eliminar(idL); liqs.pop();
    x = await inc.obtener(a.id); assert.strictEqual(x.status, 'ACTIVA'); assert.strictEqual(x.importeCob, 333.33); assert.strictEqual(x.montoAdeudo, 666.67);
    ok('eliminar la liquidación revierte el descuento (la incidencia vuelve a ACTIVA con su adeudo)');

    // 7. Cancelar una liquidación con descuento también lo revierte
    const n2 = await liq.crear(cp.Id_Operador, 'QA'); liqs.push(n2.liquidacion.id);
    await liq.aplicarIncidencias(n2.liquidacion.id, [{ idIncidencia: a.id, importe: 100 }], 'QA');
    await liq.cancelar(n2.liquidacion.id, 'QA');
    x = await inc.obtener(a.id); assert.strictEqual(x.importeCob, 333.33); ok('cancelar la liquidación revierte el descuento');

    // 8. Quitar el cobro manual y cancelar incidencias
    x = await inc.quitarCobroManual(a.id, x.pagos[0].idPago, 'QA'); assert.strictEqual(x.importeCob, 0); assert.strictEqual(x.montoAdeudo, 1000);
    x = await inc.cancelar(a.id, 'QA'); assert.strictEqual(x.status, 'CANCELADA'); ok('quitar cobro manual y cancelar incidencia sin cobros');
    console.log('\nTodas las pruebas correctas.');
  } finally {
    // limpieza: solo lo creado aquí (la liquidación cancelada se borra por su clave exacta; no tiene viajes)
    for (const id of liqs) {
      const [mes, num] = id.split('-').map(Number);
      const det = (await pool.request().input('m', sql.Decimal(3, 0), mes).input('n', sql.Decimal(9, 0), num).query('SELECT COUNT(*) n FROM Empresa2.LiqDeta WHERE MES=@m AND ID_LIQUIDACION=@n')).recordset[0].n;
      if (det === 0) await pool.request().input('m', sql.Decimal(3, 0), mes).input('n', sql.Decimal(9, 0), num).query("DELETE FROM Empresa2.Liquida WHERE MES=@m AND ID_LIQUIDACION=@n AND WHOCAPTURA='QA'");
    }
    for (const id of creadas) {
      await pool.request().input('i', sql.Int, id).query("DELETE FROM Empresa2.IncidenciasPagos WHERE Id_Incidencia=@i; DELETE FROM Empresa2.Incidencias WHERE Id_Incidencia=@i AND WhoCaptura='QA'");
    }
    const resto = (await pool.request().query("SELECT (SELECT COUNT(*) FROM Empresa2.Incidencias WHERE WhoCaptura='QA') i, (SELECT COUNT(*) FROM Empresa2.Liquida WHERE WHOCAPTURA='QA') l")).recordset[0];
    console.log(`Restos de prueba -> incidencias: ${resto.i}, liquidaciones: ${resto.l}`);
  }
})().then(() => process.exit(0)).catch(e => { console.error('FALLÓ:', e.message); process.exit(1); });
