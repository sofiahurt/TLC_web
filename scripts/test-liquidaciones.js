'use strict';

// Prueba de integración del módulo de Liquidaciones contra la base real (con limpieza).
// Crea una liquidación de prueba, agrega/quita viajes (año actual e histórico), edita, aplica
// diferencias, paga, reabre y la elimina. Al terminar deja FlagLiq y las tablas como estaban.
// Ejecutar: node scripts/test-liquidaciones.js
const assert = require('assert');
const { getPool, sql } = require('../app/config/db');
const svc = require('../app/services/liquidaciones');

let ok = 0;
const paso = (n) => { ok++; console.log('  ok  ' + n); };
const rechaza = async (fn, status, nombre) => {
  try { await fn(); } catch (e) { assert.strictEqual(e.status, status, `${nombre}: status ${e.status} (${e.message})`); paso(nombre); return; }
  assert.fail(`${nombre}: debía rechazarse con ${status}`);
};

(async () => {
  const pool = await getPool();
  const q = async (s, p = {}) => { const r = pool.request(); Object.entries(p).forEach(([k, v]) => r.input(k, v)); return (await r.query(s)).recordset; };
  const creadas = [];
  const flags = [];   // { tabla, serie, cp, flagOriginal }
  const validados = [];   // DepoSolicitud que se marcan Validado=1 para la prueba (se restauran)
  try {
    // operador activo con cartas porte sin liquidar en el año actual
    // (con al menos 2 cartas porte con casetas en DepoSolicitud, para probar que los costos se suman)
    const op = (await q(`SELECT TOP 1 c.Id_Operador FROM Empresa2.CartaPorte c
        JOIN Empresa2.DepoSolicitud d ON d.Serie=c.Serie AND d.CartaPorte=c.CartaPorte AND ISNULL(d.Casetas,0)>0
        JOIN Empresa2.Operadores o ON o.ID_OPERADOR=c.Id_Operador AND UPPER(LTRIM(RTRIM(o.STATUS)))='ACTIVO'
       WHERE ISNULL(c.FlagLiq,0)=0 AND UPPER(LTRIM(RTRIM(c.Status))) NOT LIKE 'CANCELAD%'
       GROUP BY c.Id_Operador HAVING COUNT(DISTINCT c.CartaPorte)>=2 ORDER BY COUNT(DISTINCT c.CartaPorte) DESC`))[0];
    assert.ok(op, 'no hay operador de prueba con cartas porte');

    // Las canceladas no deben aparecer como candidatas
    const canc = (await q(`SELECT TOP 1 Id_Operador, CartaPorte FROM Empresa2.CartaPorte WHERE UPPER(LTRIM(RTRIM(Status))) LIKE 'CANCELAD%' AND Id_Operador>0 AND ISNULL(FlagLiq,0)=0`))[0];
    if (canc) {
      const cands = await svc.candidatas(canc.Id_Operador, { anio: new Date().getFullYear(), limit: 500 });
      assert.ok(!cands.some(c => c.cartaPorte === canc.CartaPorte.trim()), 'una carta porte cancelada apareció como candidata');
      paso(`las canceladas no aparecen como candidatas (${canc.CartaPorte.trim()})`);
    }

    const { liquidacion: liq, advertencias } = await svc.crear(op.Id_Operador, 'PRUEBA');
    creadas.push(liq.id);
    assert.strictEqual(liq.status, 'GENERADA');
    assert.strictEqual(liq.viajes.length, 0);
    paso(`crear liquidación ${liq.id} (advertencias: ${advertencias.length})`);
    assert.ok(liq.sueldoBase >= 0 && liq.imss >= 0);

    const cand = await svc.candidatas(op.Id_Operador, { limit: 10 });
    assert.ok(cand.length >= 2 && cand.every(c => !c.liquidada));
    paso(`candidatas: ${cand.length} cartas porte sin liquidar`);

    const conDepo = await q(`SELECT DISTINCT TOP 2 LTRIM(RTRIM(c.Serie)) serie, LTRIM(RTRIM(c.CartaPorte)) cartaPorte FROM Empresa2.CartaPorte c
        JOIN Empresa2.DepoSolicitud d ON d.Serie=c.Serie AND d.CartaPorte=c.CartaPorte AND ISNULL(d.Casetas,0)>0
       WHERE c.Id_Operador=@o AND ISNULL(c.FlagLiq,0)=0 AND UPPER(LTRIM(RTRIM(c.Status))) NOT LIKE 'CANCELAD%'`, { o: op.Id_Operador });
    const [c1, c2] = conDepo.map(c => ({ anioCP: new Date().getFullYear(), serie: c.serie, cartaPorte: c.cartaPorte }));
    for (const c of [c1, c2]) {
      const t = await svc.tablaCP(pool, c.anioCP);
      flags.push({ tabla: t, serie: c.serie, cp: c.cartaPorte });
    }
    // Costos desde DepoSolicitud: solo cuentan las solicitudes VALIDADAS. Se validan las de c1 y c2 (y se restauran).
    const depos = await q(`SELECT Id_DepoSol, Validado, ISNULL(Casetas,0) Casetas, ISNULL(Maniobra,0) Maniobra, ISNULL(Otros,0) Otros, CartaPorte FROM Empresa2.DepoSolicitud
        WHERE LTRIM(RTRIM(CartaPorte)) IN (@a, @b)`, { a: c1.cartaPorte, b: c2.cartaPorte });
    const esperadoCasetas = (cp) => Math.round(depos.filter(d => d.CartaPorte.trim() === cp).reduce((s, d) => s + Number(d.Casetas), 0) * 100) / 100;
    let r = await svc.agregarViaje(liq.id, c1, 'PRUEBA');
    assert.strictEqual(r.caseta.estimado, 0, 'sin validar no debe traer costos');
    paso('depósitos sin validar no suman costos');
    for (const d of depos) { validados.push({ id: d.Id_DepoSol, valor: d.Validado }); }
    if (depos.length) await q(`UPDATE Empresa2.DepoSolicitud SET Validado=1 WHERE Id_DepoSol IN (${depos.map(d => Number(d.Id_DepoSol)).join(',')})`);
    r = await svc.recalcularDiferencias(liq.id, 'PRUEBA');
    assert.ok(esperadoCasetas(c1.cartaPorte) > 0, 'la carta porte de prueba debe tener casetas');
    assert.strictEqual(r.caseta.estimado, esperadoCasetas(c1.cartaPorte));
    assert.strictEqual(r.viajes[0].costos.caseta, esperadoCasetas(c1.cartaPorte));
    paso(`depósitos validados suman costos (caseta ${r.caseta.estimado})`);
    assert.strictEqual(r.viajes.length, 1);
    assert.strictEqual((await q(`SELECT FlagLiq FROM ${flags[0].tabla} WHERE Serie=@s AND CartaPorte=@c`, { s: c1.serie, c: c1.cartaPorte }))[0].FlagLiq, 1);
    paso('agregar viaje marca la carta porte como liquidada');

    await rechaza(() => svc.agregarViaje(liq.id, c1, 'PRUEBA'), 409, 'viaje duplicado rechazado');
    const otro = (await q(`SELECT TOP 1 Serie, CartaPorte FROM Empresa2.CartaPorte WHERE Id_Operador<>@o AND ISNULL(FlagLiq,0)=0`, { o: op.Id_Operador }))[0];
    await rechaza(() => svc.agregarViaje(liq.id, { serie: otro.Serie.trim(), cartaPorte: otro.CartaPorte.trim() }, 'PRUEBA'), 409, 'carta porte de otro operador rechazada');

    r = await svc.agregarViaje(liq.id, c2, 'PRUEBA');
    assert.strictEqual(r.viajes.length, 2);
    assert.strictEqual(r.caseta.estimado, Math.round((esperadoCasetas(c1.cartaPorte) + esperadoCasetas(c2.cartaPorte)) * 100) / 100);
    paso('los costos se suman conforme se agregan cartas porte');
    assert.ok(r.viajes[0].costoRenta !== undefined && r.viajes[0].costoKilometros !== undefined);
    const comision = r.viajes.reduce((s, v) => s + v.comision, 0);
    assert.strictEqual(Math.round(r.totalComision * 100), Math.round(comision * 100));
    paso(`segundo viaje; totalComision ${r.totalComision} = suma de comisiones`);

    // editar: reales, descuentos y diesel
    r = await svc.editar(liq.id, { extraDescuento: 100, totalAdelanto: 50, real: { comidas: 10 }, descripcionOtros: 'prueba' }, 'PRUEBA');
    assert.strictEqual(r.comidas.real, 10);
    assert.strictEqual(r.comidas.dif, Math.round((r.comidas.estimado - 10) * 100) / 100);
    assert.strictEqual(r.totalAdelanto, 50);
    assert.strictEqual(r.descripcionOtros, 'prueba');
    paso('editar: real capturado se respeta; recalcula diferencia y adelanto');
    await rechaza(() => svc.editar(liq.id, { sueldoBase: -5 }, 'PRUEBA'), 400, 'valor negativo rechazado');
    await rechaza(() => svc.editar(liq.id, { real: { inexistente: 1 } }, 'PRUEBA'), 400, 'concepto desconocido rechazado');

    // el real capturado no se pisa al agregar/quitar viajes
    const antes = (await svc.obtener(liq.id)).comidas.real;
    assert.strictEqual(antes, 10);

    // aplicar diferencias: idempotente
    const dif = (await svc.recalcularDiferencias(liq.id, 'PRUEBA')).totalDif;
    const extraAntes = (await svc.obtener(liq.id)).extraDescuento;
    r = await svc.aplicarDiferencias(liq.id, 'PRUEBA');
    assert.strictEqual(Math.round(r.extraDescuento * 100), Math.round((extraAntes + dif) * 100));
    const r2 = await svc.aplicarDiferencias(liq.id, 'PRUEBA');
    assert.strictEqual(r2.extraDescuento, r.extraDescuento);
    paso(`aplicar diferencias suma totalDif (${dif}) una sola vez`);

    // pagar -> solo lectura
    r = await svc.pagar(liq.id, 'PRUEBA');
    assert.strictEqual(r.status, 'PAGADA');
    await rechaza(() => svc.pagar(liq.id, 'PRUEBA'), 409, 'pagar una PAGADA -> 409');
    await rechaza(() => svc.editar(liq.id, { imss: 1 }, 'PRUEBA'), 409, 'PATCH de PAGADA -> 409');
    await rechaza(() => svc.quitarViaje(liq.id, r.viajes[0].idDeta, 'PRUEBA'), 409, 'quitar viaje de PAGADA -> 409');
    await rechaza(() => svc.agregarViaje(liq.id, c1, 'PRUEBA'), 409, 'agregar viaje a PAGADA -> 409');
    await rechaza(() => svc.eliminar(liq.id), 409, 'eliminar PAGADA -> 409');
    r = await svc.reabrir(liq.id, 'PRUEBA');
    assert.strictEqual(r.status, 'GENERADA');
    await rechaza(() => svc.reabrir(liq.id, 'PRUEBA'), 409, 'reabrir una GENERADA -> 409');

    // quitar viaje libera la carta porte
    r = await svc.quitarViaje(liq.id, r.viajes[0].idDeta, 'PRUEBA');
    assert.strictEqual(r.viajes.length, 1);
    assert.strictEqual((await q(`SELECT ISNULL(FlagLiq,0) f FROM ${flags[0].tabla} WHERE Serie=@s AND CartaPorte=@c`, { s: c1.serie, c: c1.cartaPorte }))[0].f, 0);
    paso('quitar viaje libera la carta porte');

    // listado
    const lista = await svc.listar({ mes: liq.mes });
    assert.ok(lista.rows.some(x => x.id === liq.id && x.cartasPorte.length === 1));
    paso('listado incluye la liquidación con sus cartas porte');

    // recibos
    const { generarRecibosPDF } = require('../app/services/liquidaciones-recibo-pdf');
    const pdf = await generarRecibosPDF([await svc.obtener(liq.id)]);
    assert.ok(pdf.slice(0, 4).toString() === '%PDF' && pdf.length > 1000);
    paso(`recibo PDF generado (${pdf.length} bytes)`);

    // cancelar: no borra, queda CANCELADA (solo lectura), conserva renglones y libera la carta porte
    r = await svc.agregarViaje(liq.id, c1, 'PRUEBA');
    r = await svc.cancelar(liq.id, 'PRUEBA');
    assert.strictEqual(r.status, 'CANCELADA');
    assert.strictEqual(r.viajes.length, 2);
    for (const c of [c1, c2]) assert.strictEqual((await q(`SELECT ISNULL(FlagLiq,0) f FROM ${flags[0].tabla} WHERE Serie=@s AND CartaPorte=@c`, { s: c.serie, c: c.cartaPorte }))[0].f, 0);
    await rechaza(() => svc.editar(liq.id, { imss: 1 }, 'PRUEBA'), 409, 'PATCH de CANCELADA -> 409');
    await rechaza(() => svc.pagar(liq.id, 'PRUEBA'), 409, 'pagar una CANCELADA -> 409');
    await rechaza(() => svc.cancelar(liq.id, 'PRUEBA'), 409, 'cancelar dos veces -> 409');
    paso('cancelar deja la liquidación CANCELADA, conserva renglones y libera las cartas porte');
    // las cartas porte liberadas se pueden usar en otra liquidación
    const { liquidacion: liq2 } = await svc.crear(op.Id_Operador, 'PRUEBA');
    creadas.push(liq2.id);
    r = await svc.agregarViaje(liq2.id, c1, 'PRUEBA');
    assert.strictEqual(r.viajes.length, 1);
    paso('una carta porte de una liquidación cancelada puede liquidarse de nuevo');
    // eliminar (solo GENERADA) libera las cartas porte y borra cabecera y renglones
    const e = await svc.eliminar(liq2.id);
    assert.strictEqual(e.liberadas, 1);
    assert.strictEqual((await q(`SELECT ISNULL(FlagLiq,0) f FROM ${flags[0].tabla} WHERE Serie=@s AND CartaPorte=@c`, { s: c1.serie, c: c1.cartaPorte }))[0].f, 0);
    assert.strictEqual((await q(`SELECT COUNT(*) n FROM Empresa2.Liquida WHERE MES=@m AND ID_LIQUIDACION=@i`, { m: liq2.mes, i: liq2.numero }))[0].n, 0);
    await rechaza(() => svc.eliminar(liq.id), 409, 'eliminar una CANCELADA -> 409');
    paso('eliminar (GENERADA) libera las cartas porte y borra cabecera y renglones');
    // la liquidación de prueba CANCELADA se borra directo (el servicio no la elimina)
    await pool.request().input('m', sql.Decimal(3, 0), liq.mes).input('n', sql.Decimal(9, 0), liq.numero)
      .query('DELETE FROM Empresa2.LiqDeta WHERE MES=@m AND ID_LIQUIDACION=@n; DELETE FROM Empresa2.Liquida WHERE MES=@m AND ID_LIQUIDACION=@n');
    creadas.length = 0;

    // histórico: una carta porte de un año anterior se libera en SU tabla
    const hist = (await svc.aniosCP(pool)).filter(a => a !== new Date().getFullYear())[0];
    if (hist) {
      const tabla = await svc.tablaCP(pool, hist);
      const h = (await q(`SELECT TOP 1 c.Id_Operador, c.Serie, c.CartaPorte FROM ${tabla} c JOIN Empresa2.Operadores o ON o.ID_OPERADOR=c.Id_Operador
         WHERE ISNULL(c.FlagLiq,0)=0 AND UPPER(LTRIM(RTRIM(c.Status))) NOT LIKE 'CANCELAD%' AND c.Id_Operador>0`))[0];
      if (h) {
        const { liquidacion: l2 } = await svc.crear(h.Id_Operador, 'PRUEBA');
        creadas.push(l2.id);
        flags.push({ tabla, serie: h.Serie.trim(), cp: h.CartaPorte.trim() });
        const rr = await svc.agregarViaje(l2.id, { serie: h.Serie.trim(), cartaPorte: h.CartaPorte.trim(), anioCP: hist }, 'PRUEBA');
        assert.strictEqual(rr.viajes[0].anioCP, hist);
        assert.strictEqual((await q(`SELECT FlagLiq FROM ${tabla} WHERE Serie=@s AND CartaPorte=@c`, { s: h.Serie.trim(), c: h.CartaPorte.trim() }))[0].FlagLiq, 1);
        await svc.quitarViaje(l2.id, rr.viajes[0].idDeta, 'PRUEBA');
        assert.strictEqual((await q(`SELECT ISNULL(FlagLiq,0) f FROM ${tabla} WHERE Serie=@s AND CartaPorte=@c`, { s: h.Serie.trim(), c: h.CartaPorte.trim() }))[0].f, 0);
        await svc.eliminar(l2.id);
        creadas.length = 0;
        paso(`carta porte histórica (${hist}) se marca y se libera en su tabla`);
      }
    }
  } finally {
    // limpieza de lo que haya quedado
    for (const id of creadas) { try { await svc.eliminar(id); } catch (e) {
      const { mes, numero } = svc.parseId(id);
      await pool.request().input('m', sql.Decimal(3, 0), mes).input('n', sql.Decimal(9, 0), numero)
        .query('DELETE FROM Empresa2.LiqDeta WHERE MES=@m AND ID_LIQUIDACION=@n; DELETE FROM Empresa2.Liquida WHERE MES=@m AND ID_LIQUIDACION=@n'); } }
    for (const v of validados) await pool.request().input('i', sql.Decimal(9, 0), v.id).input('v', v.valor == null ? sql.TinyInt : sql.TinyInt, v.valor)
      .query('UPDATE Empresa2.DepoSolicitud SET Validado=@v WHERE Id_DepoSol=@i');
    for (const f of flags) await pool.request().input('s', sql.VarChar(3), f.serie).input('c', sql.VarChar(30), f.cp)
      .query(`UPDATE ${f.tabla} SET FlagLiq=0 WHERE LTRIM(RTRIM(Serie))=@s AND LTRIM(RTRIM(CartaPorte))=@c`);
  }
  console.log(`\n${ok} pasos correctos.`);
  process.exit(0);
})().catch(e => { console.error('FALLÓ:', e); process.exit(1); });
