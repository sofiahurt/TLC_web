'use strict';

// Pruebas unitarias de calcularTotales (función pura, sin base de datos).
// Ejecutar: node scripts/test-liquidaciones-calc.js
const assert = require('assert');
const { calcularTotales, comisionRenglon } = require('../app/services/liquidaciones-calc');

let ok = 0;
const prueba = (nombre, fn) => { fn(); ok++; console.log('  ok  ' + nombre); };
const cerca = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg || ''} esperado ${b}, obtenido ${a}`);

prueba('sin renglones: todo en 0 salvo sueldo/IMSS/Infonavit', () => {
  const r = calcularTotales({ sueldoBase: 2000, imss: 1777, infonavit: 0 }, []);
  assert.strictEqual(r.totalComision, 0);
  assert.strictEqual(r.totalFlete, 0);
  assert.strictEqual(r.totalLiquidacion, 2000 - 1777);
  assert.strictEqual(r.totalViaje, 0);
  assert.strictEqual(r.granTotalLiq, 223);
  assert.strictEqual(r.totalUtilidad, -223);
  assert.strictEqual(r.totalDif, 0);
});

prueba('comisión por kilómetro cuando hay pagoKilometro (ignora pagoViaje)', () => {
  const rg = { kilometros: 100.5, pagoKilometro: 4, pagoViaje: 999 };
  assert.strictEqual(comisionRenglon(rg), 402);
  assert.strictEqual(calcularTotales({}, [rg]).totalComision, 402);
});

prueba('comisión por viaje cuando pagoKilometro es 0', () => {
  const rg = { kilometros: 100, pagoKilometro: 0, pagoViaje: 1000 };
  assert.strictEqual(comisionRenglon(rg), 1000);
  assert.strictEqual(calcularTotales({}, [rg]).totalComision, 1000);
});

prueba('sin pagoKilometro ni pagoViaje no hay comisión', () => {
  assert.strictEqual(calcularTotales({}, [{ kilometros: 50, pagoKilometro: 0, pagoViaje: 0 }]).totalComision, 0);
});

prueba('diesel excedido: se descuenta lo que pasa de lo permitido', () => {
  const r = calcularTotales({ dieselRellenado: 1200 }, [{ dieselPermitido: 700 }, { dieselPermitido: 400 }]);
  assert.strictEqual(r.dieselPermitido, 1100);
  assert.strictEqual(r.desDiesel, 100);
  assert.strictEqual(r.totalDesc, 100);
});

prueba('diesel no excedido: desDiesel queda en 0 (nunca negativo)', () => {
  const r = calcularTotales({ dieselRellenado: 500, desDiesel: 77 }, [{ dieselPermitido: 700 }]);
  assert.strictEqual(r.desDiesel, 0);
  assert.strictEqual(r.totalDesc, 0);
});

prueba('real = 0 toma el estimado y la diferencia es 0', () => {
  const r = calcularTotales({ comidas: { real: 0 } }, [{ costos: { comidas: 150.25 } }]);
  assert.strictEqual(r.comidas.estimado, 150.25);
  assert.strictEqual(r.comidas.real, 150.25);
  assert.strictEqual(r.comidas.dif, 0);
});

prueba('un real ya capturado NO se sobrescribe al recalcular los estimados', () => {
  const r = calcularTotales({ comidas: { real: 100 } }, [{ costos: { comidas: 150 } }, { costos: { comidas: 50 } }]);
  assert.strictEqual(r.comidas.estimado, 200);
  assert.strictEqual(r.comidas.real, 100);
  assert.strictEqual(r.comidas.dif, 100);
  assert.strictEqual(r.totalDif, 100);
});

prueba('caseta con IVA: sinIva = real / 1.16 y es lo que entra a totalViaje', () => {
  const r = calcularTotales({}, [{ costos: { caseta: 1160 } }]);
  assert.strictEqual(r.caseta.sinIva, 1000);
  assert.strictEqual(r.totalViaje, 1000);
  const r2 = calcularTotales({ caseta: { real: 1000 } }, [{ costos: { caseta: 1740 } }]);
  cerca(r2.caseta.sinIva, 862.07, 'sinIva');
  assert.strictEqual(r2.caseta.dif, 740);
});

prueba('el IVA es configurable', () => {
  const r = calcularTotales({}, [{ costos: { caseta: 1100 } }], { ivaTasa: 0.10 });
  assert.strictEqual(r.caseta.sinIva, 1000);
});

prueba('el adelanto se descuenta al operador y también cuenta en totalViaje', () => {
  const r = calcularTotales({ sueldoBase: 2000, totalAdelanto: 300 }, []);
  assert.strictEqual(r.totalDesc, 300);
  assert.strictEqual(r.totalLiquidacion, 1700);
  assert.strictEqual(r.totalViaje, 300);
});

prueba('no hay error de punto flotante al sumar centavos', () => {
  const r = calcularTotales({}, [0.1, 0.2, 0.3].map(c => ({ costoFlete: c, costos: { otros: c } })));
  assert.strictEqual(r.totalFlete, 0.6);
  assert.strictEqual(r.otros.estimado, 0.6);
});

prueba('estadías y demoras (DepoSolicitud) entran a totalViaje y a las diferencias', () => {
  const r = calcularTotales({ demoras: { real: 50 } }, [{ costos: { estadias: 300, demoras: 120 } }]);
  assert.strictEqual(r.estadias.real, 300);
  assert.strictEqual(r.demoras.dif, 70);
  assert.strictEqual(r.totalViaje, 350);   // 300 + 50
  assert.strictEqual(r.totalDif, 70);
});

prueba('no muta los argumentos', () => {
  const liq = { sueldoBase: 100, comidas: { real: 5 } };
  const copia = JSON.stringify(liq);
  calcularTotales(liq, [{ costos: { comidas: 9 } }]);
  assert.strictEqual(JSON.stringify(liq), copia);
});

prueba('caso completo (calculado a mano)', () => {
  const liq = { sueldoBase: 2000, imss: 1777, infonavit: 500, extraComision: 100, extraDescuento: 50,
    dieselRellenado: 1200, totalAdelanto: 300 };
  const renglones = [
    { costoFlete: 15000, kilometros: 100, pagoKilometro: 5, pagoViaje: 1000, dieselPermitido: 600,
      costos: { maniobras: 200, caseta: 580, comidas: 100, otros: 50 } },
    { costoFlete: 10000, kilometros: 80, pagoKilometro: 0, pagoViaje: 1000, dieselPermitido: 500,
      costos: { caseta: 1160, pension: 150 } },
  ];
  const r = calcularTotales(liq, renglones);
  assert.strictEqual(r.totalFlete, 25000);
  assert.strictEqual(r.dieselPermitido, 1100);
  assert.strictEqual(r.totalComision, 500 + 1000);          // 100*5 por km + 1000 por viaje
  assert.strictEqual(r.desDiesel, 100);                     // 1200 - 1100
  assert.strictEqual(r.totalDesc, 400);                     // 100 + adelanto 300
  assert.strictEqual(r.totalLiquidacion, 873);              // (1500+100+2000) - (400+50+500+1777)
  assert.strictEqual(r.caseta.estimado, 1740);
  assert.strictEqual(r.caseta.sinIva, 1500);                // 1740 / 1.16
  assert.strictEqual(r.totalViaje, 3500);                   // 1200+300+200+100+150+1500+50
  assert.strictEqual(r.granTotalLiq, 4373);                 // 873 + 3500
  assert.strictEqual(r.totalUtilidad, 20627);               // 25000 - 4373
  assert.strictEqual(r.totalDif, 0);
});

console.log(`\n${ok} pruebas correctas.`);
