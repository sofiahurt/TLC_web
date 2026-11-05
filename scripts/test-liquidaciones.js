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
  const montos = [];      // MontoDepositado original de las que se modifican para la prueba (se restauran)
  try {
    // operador activo con cartas porte sin liquidar en el año actual
    // (con al menos 2 cartas porte con casetas en DepoSolicitud, para probar que los costos se suman)
    const op = (await q(`SELECT TOP 1 c.Id_Operador FROM Empresa2.CartaPorte c
        JOIN Empresa2.DepoSolicitud d ON d.Serie=c.Serie AND d.CartaPorte=c.CartaPorte AND ISNULL(d.Casetas,0)>0 AND (ISNULL(d.Prestamo,0)+ISNULL(d.Talachas,0)+ISNULL(d.Llantas,0)+ISNULL(d.Diesel,0)+ISNULL(d.Comidas,0)+ISNULL(d.Pension,0)+ISNULL(d.Bascula,0)+ISNULL(d.Refacciones,0)+ISNULL(d.Maniobra,0)+ISNULL(d.Otros,0)+ISNULL(d.Estadias,0)+ISNULL(d.Demoras,0))=0
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

    // Candidatas: solo cartas porte con depósito VALIDADO (Validado=1), búsqueda por número y motivo si no aparece
    const aut = (await q(`SELECT TOP 1 LTRIM(RTRIM(c.CartaPorte)) cp, c.Id_Operador FROM Empresa2.CartaPorte c
        JOIN Empresa2.DepoSolicitud d ON d.Serie=c.Serie AND d.CartaPorte=c.CartaPorte AND ISNULL(d.Validado,0)=1
       WHERE ISNULL(c.FlagLiq,0)=0 AND c.Id_Operador>0 AND UPPER(LTRIM(RTRIM(c.Status))) NOT LIKE 'CANCELAD%'`))[0];
    assert.ok(aut, 'no hay carta porte con depósito validado para probar');
    const todas = await svc.candidatas(aut.Id_Operador, { anio: new Date().getFullYear(), limit: 500 });
    assert.ok(todas.length >= 1);
    for (const c of todas) {
      const n = (await q(`SELECT COUNT(*) n FROM Empresa2.DepoSolicitud WHERE LTRIM(RTRIM(CartaPorte))=@c AND ISNULL(Validado,0)=1`, { c: c.cartaPorte }))[0].n;
      assert.ok(n > 0, `${c.cartaPorte} salió como candidata sin depósito validado`);
    }
    paso(`candidatas: las ${todas.length} del operador ${aut.Id_Operador} tienen depósito validado`);
    const porNumero = await svc.candidatas(aut.Id_Operador, { q: aut.cp.toLowerCase(), conMotivo: true });
    assert.ok(porNumero.rows.length === 1 && porNumero.rows[0].cartaPorte === aut.cp && porNumero.motivo === '');
    paso(`búsqueda por número de carta porte (${aut.cp}) devuelve ese registro`);
    const sinAut = (await q(`SELECT TOP 1 LTRIM(RTRIM(c.CartaPorte)) cp, c.Id_Operador FROM Empresa2.CartaPorte c
       WHERE ISNULL(c.FlagLiq,0)=0 AND c.Id_Operador>0 AND UPPER(LTRIM(RTRIM(c.Status))) NOT LIKE 'CANCELAD%'
         AND NOT EXISTS (SELECT 1 FROM Empresa2.DepoSolicitud d WHERE d.Serie=c.Serie AND d.CartaPorte=c.CartaPorte AND ISNULL(d.Validado,0)=1)`))[0];
    const noAut = await svc.candidatas(sinAut.Id_Operador, { q: sinAut.cp, conMotivo: true });
    assert.strictEqual(noAut.rows.length, 0);
    assert.ok(/depósito validado/.test(noAut.motivo), noAut.motivo);
    paso(`una carta porte sin depósito validado no sale y se explica: "${noAut.motivo}"`);

    const conDepo = await q(`SELECT DISTINCT TOP 2 LTRIM(RTRIM(c.Serie)) serie, LTRIM(RTRIM(c.CartaPorte)) cartaPorte FROM Empresa2.CartaPorte c
        JOIN Empresa2.DepoSolicitud d ON d.Serie=c.Serie AND d.CartaPorte=c.CartaPorte AND ISNULL(d.Casetas,0)>0 AND (ISNULL(d.Prestamo,0)+ISNULL(d.Talachas,0)+ISNULL(d.Llantas,0)+ISNULL(d.Diesel,0)+ISNULL(d.Comidas,0)+ISNULL(d.Pension,0)+ISNULL(d.Bascula,0)+ISNULL(d.Refacciones,0)+ISNULL(d.Maniobra,0)+ISNULL(d.Otros,0)+ISNULL(d.Estadias,0)+ISNULL(d.Demoras,0))=0
       WHERE c.Id_Operador=@o AND ISNULL(c.FlagLiq,0)=0 AND UPPER(LTRIM(RTRIM(c.Status))) NOT LIKE 'CANCELAD%'`, { o: op.Id_Operador });
    const [c1, c2] = conDepo.map(c => ({ anioCP: new Date().getFullYear(), serie: c.serie, cartaPorte: c.cartaPorte }));
    for (const c of [c1, c2]) {
      const t = await svc.tablaCP(pool, c.anioCP);
      flags.push({ tabla: t, serie: c.serie, cp: c.cartaPorte });
    }
    // Costos desde DepoSolicitud: solo cuentan las solicitudes VALIDADAS. Se validan las de c1 y c2 (y se restauran).
    const depos = await q(`SELECT Id_DepoSol, Validado, ISNULL(Casetas,0) Casetas, MontoDepositado, CartaPorte FROM Empresa2.DepoSolicitud
        WHERE LTRIM(RTRIM(CartaPorte)) IN (@a, @b)`, { a: c1.cartaPorte, b: c2.cartaPorte });
    // Los costos son lo DEPOSITADO, no lo solicitado: a c1 se le deposita 100 menos de lo solicitado (se restaura al final).
    for (const d of depos.filter(d => d.CartaPorte.trim() === c1.cartaPorte)) {
      montos.push({ id: d.Id_DepoSol, valor: d.MontoDepositado });
      d.MontoDepositado = Math.round((Number(d.Casetas) - 100) * 100) / 100;
      await pool.request().input('i', sql.Decimal(9, 0), d.Id_DepoSol).input('m', sql.Decimal(11, 2), d.MontoDepositado)
        .query('UPDATE Empresa2.DepoSolicitud SET MontoDepositado=@m WHERE Id_DepoSol=@i');
    }
    // con un solo rubro, lo depositado es el costo; sin monto depositado se toma lo solicitado
    const esperadoCasetas = (cp) => Math.round(depos.filter(d => d.CartaPorte.trim() === cp)
      .reduce((s, d) => s + Number(d.MontoDepositado != null ? d.MontoDepositado : d.Casetas), 0) * 100) / 100;
    // llamada directa a la API: una carta porte sin depósito validado NO se acepta (se des-validan para la prueba y se restauran)
    for (const d of depos) { validados.push({ id: d.Id_DepoSol, valor: d.Validado }); }
    const idsDepo = depos.map(d => Number(d.Id_DepoSol)).join(',');
    if (depos.length) await q(`UPDATE Empresa2.DepoSolicitud SET Validado=0 WHERE Id_DepoSol IN (${idsDepo})`);
    await rechaza(() => svc.agregarViaje(liq.id, c1, 'PRUEBA'), 409, 'carta porte sin depósito validado rechazada aunque se llame directo');
    if (depos.length) await q(`UPDATE Empresa2.DepoSolicitud SET Validado=1 WHERE Id_DepoSol IN (${depos.map(d => Number(d.Id_DepoSol)).join(',')})`);
    let r = await svc.agregarViaje(liq.id, c1, 'PRUEBA');
    assert.ok(esperadoCasetas(c1.cartaPorte) > 0, 'la carta porte de prueba debe tener casetas');
    assert.strictEqual(r.caseta.estimado, esperadoCasetas(c1.cartaPorte));
    assert.strictEqual(r.viajes[0].costos.caseta, esperadoCasetas(c1.cartaPorte));
    paso(`los costos son lo depositado, no lo solicitado (caseta ${r.caseta.estimado} vs solicitado ${depos.filter(d => d.CartaPorte.trim() === c1.cartaPorte).reduce((s, d) => s + Number(d.Casetas), 0)})`);
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
    // quitar o poner en 0 el IMSS recalcula la liquidación
    const conImss = await svc.obtener(liq.id);
    assert.ok(conImss.imss > 0, 'la liquidación de prueba debe traer IMSS');
    for (const vacio of [0, '', null]) {
      r = await svc.editar(liq.id, { imss: vacio }, 'PRUEBA');
      assert.strictEqual(r.imss, 0);
      assert.strictEqual(Math.round(r.totalLiquidacion * 100), Math.round((conImss.totalLiquidacion + conImss.imss) * 100));
      assert.strictEqual(Math.round(r.granTotalLiq * 100), Math.round((conImss.granTotalLiq + conImss.imss) * 100));
      r = await svc.editar(liq.id, { imss: conImss.imss }, 'PRUEBA');
      assert.strictEqual(Math.round(r.totalLiquidacion * 100), Math.round(conImss.totalLiquidacion * 100));
    }
    paso('IMSS en 0 o vacío: la liquidación se recalcula sin IMSS y al restituirlo vuelve al total');
    // vista previa (al teclear): calcula igual que guardar, pero NO guarda
    const prev = await svc.previsualizar(liq.id, { imss: '', extraComision: 100, real: { comidas: 7 } });
    assert.strictEqual(prev.imss, 0);
    assert.strictEqual((await svc.obtener(liq.id)).imss, conImss.imss, 'la vista previa no debe guardar');
    const guardado = await svc.editar(liq.id, { imss: '', extraComision: 100, real: { comidas: 7 } }, 'PRUEBA');
    for (const k of ['totalLiquidacion', 'granTotalLiq', 'totalViaje', 'totalDif', 'totalComision']) assert.strictEqual(prev[k], guardado[k], k);
    await svc.editar(liq.id, { imss: conImss.imss, extraComision: 0, real: { comidas: 10 } }, 'PRUEBA');
    await rechaza(() => svc.previsualizar(liq.id, { imss: -3 }), 400, 'vista previa valida los importes');
    paso('vista previa: mismo resultado que guardar y sin guardar nada');
    await rechaza(() => svc.editar(liq.id, { sueldoBase: -5 }, 'PRUEBA'), 400, 'valor negativo rechazado');
    await rechaza(() => svc.editar(liq.id, { real: { inexistente: 1 } }, 'PRUEBA'), 400, 'concepto desconocido rechazado');

    // el real capturado no se pisa al agregar/quitar viajes
    const antes = (await svc.obtener(liq.id)).comidas.real;
    assert.strictEqual(antes, 10);

    // Dif. aplicada: positiva (saldo en contra) se descuenta; negativa (a favor del operador) se paga.
    // No toca Extra comisión ni Extra descuento y se puede poner y quitar mientras no se guarde (vista previa).
    // el real que se llenó solo sigue al estimado cuando se agregan cartas porte (no deja diferencias falsas)
    const sinCapturar = await svc.obtener(liq.id);
    assert.strictEqual(sinCapturar.caseta.real, sinCapturar.caseta.estimado);
    assert.strictEqual(sinCapturar.caseta.dif, 0);
    paso(`el real automático sigue al estimado (casetas ${sinCapturar.caseta.estimado}, dif 0)`);
    // se captura un real de casetas 100 menor que el estimado: queda saldo en contra del operador
    await svc.editar(liq.id, { real: { caseta: sinCapturar.caseta.estimado - 100 } }, 'PRUEBA');
    const base = await svc.obtener(liq.id);
    const dif = base.totalDif;
    assert.ok(dif > 0, 'la liquidación de prueba debe tener diferencia positiva');
    assert.strictEqual(base.difAplicada, 0);
    const prevAplicada = await svc.previsualizar(liq.id, { aplicarDif: true });
    assert.strictEqual(prevAplicada.difAplicada, dif);
    assert.strictEqual(Math.round(prevAplicada.totalLiquidacion * 100), Math.round((base.totalLiquidacion - dif) * 100));
    assert.strictEqual((await svc.obtener(liq.id)).difAplicada, 0, 'la vista previa no debe guardar');
    r = await svc.aplicarDiferencias(liq.id, true, 'PRUEBA');
    assert.strictEqual(r.difAplicada, dif);
    assert.strictEqual(r.extraDescuento, base.extraDescuento);
    assert.strictEqual(r.extraComision, base.extraComision);
    assert.strictEqual(Math.round(r.totalLiquidacion * 100), Math.round((base.totalLiquidacion - dif) * 100));
    r = await svc.aplicarDiferencias(liq.id, true, 'PRUEBA');   // otra vez: no se duplica
    assert.strictEqual(Math.round(r.totalLiquidacion * 100), Math.round((base.totalLiquidacion - dif) * 100));
    r = await svc.aplicarDiferencias(liq.id, false, 'PRUEBA');   // quitarla
    assert.strictEqual(r.difAplicada, 0);
    assert.strictEqual(Math.round(r.totalLiquidacion * 100), Math.round(base.totalLiquidacion * 100));
    paso(`dif. aplicada positiva (${dif}) se descuenta, se puede quitar y no toca extras`);

    // diferencia NEGATIVA (saldo a favor del operador): se paga (sube el total) y la dif. aplicada queda negativa
    await svc.editar(liq.id, { real: { comidas: 500 } }, 'PRUEBA');
    const conNeg = await svc.obtener(liq.id);
    assert.ok(conNeg.totalDif < 0);
    r = await svc.editar(liq.id, { aplicarDif: true }, 'PRUEBA');
    assert.strictEqual(r.difAplicada, conNeg.totalDif);
    assert.ok(r.difAplicada < 0);
    assert.strictEqual(Math.round(r.totalLiquidacion * 100), Math.round((conNeg.totalLiquidacion - conNeg.totalDif) * 100));
    // si cambian las diferencias estando aplicada, la dif. aplicada sigue al total
    r = await svc.editar(liq.id, { real: { comidas: 800 } }, 'PRUEBA');
    assert.strictEqual(r.difAplicada, r.totalDif);
    r = await svc.editar(liq.id, { aplicarDif: false, real: { comidas: 10, caseta: 0 } }, 'PRUEBA');
    assert.strictEqual(r.difAplicada, 0);
    paso(`dif. aplicada negativa (${conNeg.totalDif}) se paga, sigue al total de diferencias y se quita`);

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
         WHERE ISNULL(c.FlagLiq,0)=0 AND UPPER(LTRIM(RTRIM(c.Status))) NOT LIKE 'CANCELAD%' AND c.Id_Operador>0
           AND EXISTS (SELECT 1 FROM Empresa2.DepoSolicitud${String(hist).slice(-2)} d WHERE d.Serie=c.Serie AND d.CartaPorte=c.CartaPorte AND ISNULL(d.FlagDeposito,0)=1)`))[0];
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
    for (const m of montos) await pool.request().input('i', sql.Decimal(9, 0), m.id).input('m', sql.Decimal(11, 2), m.valor)
      .query('UPDATE Empresa2.DepoSolicitud SET MontoDepositado=@m WHERE Id_DepoSol=@i');
    for (const v of validados) await pool.request().input('i', sql.Decimal(9, 0), v.id).input('v', v.valor == null ? sql.TinyInt : sql.TinyInt, v.valor)
      .query('UPDATE Empresa2.DepoSolicitud SET Validado=@v WHERE Id_DepoSol=@i');
    for (const f of flags) await pool.request().input('s', sql.VarChar(3), f.serie).input('c', sql.VarChar(30), f.cp)
      .query(`UPDATE ${f.tabla} SET FlagLiq=0 WHERE LTRIM(RTRIM(Serie))=@s AND LTRIM(RTRIM(CartaPorte))=@c`);
  }
  console.log(`\n${ok} pasos correctos.`);
  process.exit(0);
})().catch(e => { console.error('FALLÓ:', e); process.exit(1); });
