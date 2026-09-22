'use strict';

const { create } = require('xmlbuilder2');
const { sql } = require('../config/db');
const { serieFiscal } = require('../config/empresa-serie');
const { fmt, fmtDec, isoFechaHora, isoFecha } = require('./cfdi-utils');

// ── Complemento de Pagos 2.0 ────────────────────────────────────────────────
// Comprobante tipo "P": SubTotal/Total siempre en 0, sin FormaPago/MetodoPago
// a nivel comprobante, un solo Concepto fijo (84111506 "Pago"), sin
// CfdiRelacionados (las relaciones van dentro del complemento, por
// DoctoRelacionado). UsoCFDI del receptor SIEMPRE "CP01" -- regla fija del
// Anexo 20 para este tipo de comprobante, no depende de lo que capture el
// usuario en ningún lado.
//
// ADVERTENCIA (sin verificar contra un timbrado real, a diferencia del resto
// del módulo de timbrado ya probado en producción): el reparto del segundo
// nodo pago20:Pago para "Compensación" (código 17) y el manejo de
// DoctoRelacionado cuando MonedaDR difiere de MonedaP son best-effort según
// el Anexo 20 -- no había un XML real con compensación en los datos legado
// para verificar byte a byte. Probar contra el sandbox del PAC antes de
// confiar en un timbrado real con compensación activa.
const CLAVE_PRODSERV_PAGO = '84111506';
const CODIGO_COMPENSACION = '17';

function monedaDesdeTipoFacturas(tipoFacturas) {
  return fmt(tipoFacturas).toUpperCase() === 'DOLARES' ? 'USD' : 'MXN';
}

async function buildCFDIPago(idNoPago, centralOperativo, pool) {
  // 1. Cabecera
  const cabRes = await pool.request().input('id', sql.Decimal(9), idNoPago).query(`SELECT * FROM Empresa2.Pagos WHERE Id_NoPago=@id`);
  if (!cabRes.recordset.length) throw new Error(`Cobro ${idNoPago} no encontrado`);
  const cab = cabRes.recordset[0];

  // 2. Líneas
  const detRes = await pool.request().input('id', sql.Decimal(9), idNoPago).query(`SELECT * FROM Empresa2.PagFac WHERE ID_NOPAGO=@id ORDER BY ID_NOPAGFAC`);
  const lineas = detRes.recordset;
  if (!lineas.length) throw new Error(`El Cobro ${idNoPago} no tiene líneas`);

  // 3. Empresa emisora
  const empRes = await pool.request().input('serie', sql.VarChar(10), serieFiscal(centralOperativo)).query(`SELECT * FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE)) = @serie`);
  if (!empRes.recordset.length) throw new Error(`Empresa para serie ${centralOperativo} no encontrada`);
  const emp = empRes.recordset[0];

  // 4. Receptor (cliente facturado, cabecera del pago)
  const cliRes = await pool.request().input('id', sql.Decimal(18, 0), cab.Id_Cliente).query(`SELECT * FROM Empresa2.Clientes WHERE Id_Cliente = @id`);
  const cli = cliRes.recordset[0];
  if (!cli) throw new Error(`Cliente ${cab.Id_Cliente} del Cobro ${idNoPago} no encontrado`);

  const emisorRFC    = fmt(emp.RFC);
  const emisorNombre = fmt(emp.NOMBRECORTO);
  const emisorRegFis = fmt(emp.C_REGIMENFISCAL);
  const lugarExp     = fmt(emp.LUGAREXPEDICION) || fmt(emp.CP);
  const monedaP = monedaDesdeTipoFacturas(cab.TipoFacturas);
  // Regla real del Complemento de Pagos 2.0 (confirmada por rechazo del PAC
  // en un timbrado de prueba real): TipoCambioP es SIEMPRE obligatorio, nunca
  // se omite -- si MonedaP='MXN' debe ser literal "1" (sin decimales ni
  // punto), distinto de TipoCambio a nivel comprobante base, que sí se omite
  // en MXN. Con moneda extranjera, va el tipo de cambio real capturado.
  let tipoCambioP;
  if (monedaP === 'MXN') {
    tipoCambioP = '1';
  } else {
    const tc = parseFloat(cab.TipoCambio);
    if (!tc || tc <= 0) throw new Error(`El Cobro ${idNoPago} está en ${monedaP} pero no tiene un tipo de cambio válido capturado.`);
    tipoCambioP = String(tc);
  }
  const fechaPago    = isoFechaHora(cab.FechaPago || cab.Fecha, null);

  // 5. Datos por línea: saldo/UUID/parcialidad de cada documento relacionado.
  // NumParcialidad = # de pagos NO cancelados ya timbrados contra ese mismo
  // documento (incluyendo este) -- se cuenta contra PagFac/Pagos, excluyendo
  // el propio Pagos.Id_NoPago actual para el conteo de "previos" y sumando 1.
  const datosLinea = [];
  for (const l of lineas) {
    if (Number(l.NOFACTURA) > 0) {
      const facRes = await pool.request().input('id', sql.Decimal(9), l.NOFACTURA).input('serieFac', sql.VarChar(20), fmt(l.SERIEFAC) || null)
        .query(`SELECT UUID, TOTAL, SubTotal, IVA, Retencion, MonFactura, TipoCambio, ClaveMP FROM Empresa2.Factura WHERE Id_NoFactura=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'')`);
      const fac = facRes.recordset[0];
      if (!fac) throw new Error(`Factura ${l.NOFACTURA} de la línea ${l.ID_NOPAGFAC} no encontrada`);
      if (!fmt(fac.UUID)) throw new Error(`La Factura ${l.NOFACTURA} referenciada aún no está timbrada; no se puede generar el Complemento de Pago.`);

      // Saldo de la Factura ANTES de este Cobro. Se confía en PagFac.SALDOANT
      // (congelado al agregar la línea) SOLO cuando es consistente con lo que
      // esa misma línea aplicó (>= TOTALPAGO) -- si no, se asume que este
      // Cobro por sí solo liquidó el total declarado en sus propias columnas
      // (ImpSaldoInsoluto queda en 0), en vez de restar contra el
      // PagosReal/NotasCredito "en vivo" de la Factura, que en datos legado ya
      // vienen duplicados/corrompidos (confirmado: varias facturas reales con
      // PagosReal ≈ 2×TOTAL). Caso real que expuso el bug: Pago 3495, filas
      // legado (importadas del sistema anterior, nunca creadas por este
      // módulo) con SALDOANT=0, producían ImpSaldoAnt="-9920.28" (0-IMPRTE) en
      // el nodo de compensación; con este fallback da ImpSaldoAnt=TOTALPAGO,
      // que aquí coincide exactamente con el TOTAL de la factura (pago único).
      const totalPagoLinea = num(l.TOTALPAGO);
      const saldoBase = num(l.SALDOANT) >= totalPagoLinea - 0.005 ? num(l.SALDOANT) : totalPagoLinea;

      let numParcialidad = 1;
      if (fmt(fac.ClaveMP).toUpperCase() === 'PPD') {
        const prevRes = await pool.request()
          .input('nofac', sql.Decimal(9), l.NOFACTURA).input('serieFac', sql.VarChar(20), fmt(l.SERIEFAC) || null).input('idpago', sql.Decimal(9), idNoPago)
          .query(`SELECT COUNT(*) n FROM Empresa2.PagFac pf JOIN Empresa2.Pagos p ON p.Id_NoPago=pf.ID_NOPAGO
                  WHERE pf.NOFACTURA=@nofac AND ISNULL(LTRIM(RTRIM(pf.SERIEFAC)),'')=ISNULL(@serieFac,'')
                    AND LTRIM(RTRIM(ISNULL(p.Status,'')))<>'CANCELADO' AND p.Id_NoPago<>@idpago`);
        numParcialidad = Number(prevRes.recordset[0].n) + 1;
      }

      datosLinea.push({
        linea: l, esFactura: true, uuid: fmt(fac.UUID), monedaDR: fmt(fac.MonFactura) || 'MXN',
        tipoCambioDR: parseFloat(fac.TipoCambio) || 1, // 1 [MonedaDR] = tipoCambioDR MXN
        objetoImpDR: (num(fac.IVA) > 0.005 || num(fac.Retencion) > 0.005) ? '02' : '01',
        numParcialidad, saldoBase,
        serieDoc: fmt(l.SERIEFAC) || undefined, folioDoc: String(l.NOFACTURA),
      });
    } else if (Number(l.ID_NOTACREDITO) > 0) {
      const ndRes = await pool.request().input('id', sql.Decimal(7), l.ID_NOTACREDITO).input('serie', sql.VarChar(10), fmt(l.SERIEND) || null)
        .query(`SELECT UUID, IVA, Retencion, ImporteTotal FROM Empresa2.NotaCred WHERE Id_NotaCredito=@id AND LTRIM(RTRIM(Tipo))='ND' AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`);
      const nd = ndRes.recordset[0];
      if (!nd) throw new Error(`Nota de Débito ${l.ID_NOTACREDITO} de la línea ${l.ID_NOPAGFAC} no encontrada`);
      if (!fmt(nd.UUID)) throw new Error(`La Nota de Débito ${l.ID_NOTACREDITO} referenciada aún no está timbrada; no se puede generar el Complemento de Pago.`);
      // Todo o nada (confirmado con el usuario): siempre 1 sola parcialidad,
      // y el saldo base es siempre el total de la ND (no acumula un
      // PagosReal propio -- su Status es la única marca de si ya se pagó).
      datosLinea.push({
        linea: l, esFactura: false, uuid: fmt(nd.UUID), monedaDR: 'MXN', tipoCambioDR: 1,
        objetoImpDR: (num(nd.IVA) > 0.005 || num(nd.Retencion) > 0.005) ? '02' : '01',
        numParcialidad: 1, saldoBase: num(nd.ImporteTotal),
        serieDoc: fmt(l.SERIEND) || undefined, folioDoc: String(l.ID_NOTACREDITO),
      });
    }
  }

  // ── build XML ───────────────────────────────────────────────────────────
  const comprobanteAttrs = {
    'xmlns:cfdi': 'http://www.sat.gob.mx/cfd/4',
    'xmlns:pago20': 'http://www.sat.gob.mx/Pagos20',
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    'xsi:schemaLocation': [
      'http://www.sat.gob.mx/cfd/4', 'http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd',
      'http://www.sat.gob.mx/Pagos20', 'http://www.sat.gob.mx/sitio_internet/cfd/Pagos/Pagos20.xsd',
    ].join(' '),
    Version: '4.0',
    Fecha: isoFechaHora(cab.Fecha, cab.Hora),
    NoCertificado: '', Certificado: '', Sello: '',
    SubTotal: '0', Moneda: 'XXX', Total: '0',
    TipoDeComprobante: 'P', Exportacion: '01', LugarExpedicion: lugarExp,
  };
  comprobanteAttrs.Folio = String(cab.Id_NoPago);

  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('cfdi:Comprobante', comprobanteAttrs);

  doc.ele('cfdi:Emisor', { Rfc: emisorRFC, Nombre: emisorNombre, RegimenFiscal: emisorRegFis }).up();
  doc.ele('cfdi:Receptor', {
    Rfc: fmt(cli.RFC), Nombre: fmt(cli.NOMBRECOMUN) || fmt(cli.NOMBRECOM),
    DomicilioFiscalReceptor: fmt(cli.CP) || lugarExp,
    RegimenFiscalReceptor: fmt(cli.C_REGIMENFISCAL),
    UsoCFDI: 'CP01', // fijo por Anexo 20 para comprobantes tipo Pago
  }).up();

  doc.ele('cfdi:Conceptos').ele('cfdi:Concepto', {
    ClaveProdServ: CLAVE_PRODSERV_PAGO, Cantidad: '1', ClaveUnidad: 'ACT',
    Descripcion: 'Pago', ValorUnitario: '0', Importe: '0', ObjetoImp: '01',
  }).up().up();

  // ── Precálculo de ambos nodos pago20:Pago (antes de tocar xmlbuilder2) --
  // pago20:Totales debe ir ANTES de los pago20:Pago en el XML, pero sus
  // valores dependen de la suma de impuestos de ambos, así que se calcula
  // todo en JS puro primero y se construye el árbol ya en el orden correcto.
  function calcularDocsRelacionados(docs, campoMonto, campoSubtotal, campoIva, campoReten, esCompensacion) {
    let totRetISR = 0, totBaseIVA16 = 0, totImpIVA16 = 0;
    const relacionados = docs
      .filter(d => num(d.linea[campoMonto]) > 0.005)
      .map(d => {
        const l = d.linea;
        const montoAplicado = num(l[campoMonto]);
        const subtotalLinea = num(l[campoSubtotal]);
        const ivaLinea = num(l[campoIva]);
        const retLinea = num(l[campoReten]);
        // El nodo de compensación parte del saldo YA reducido por la porción
        // real de esta misma línea (si la hubo); el de pago real parte del
        // saldo base tal cual (ver saldoBase, calculado desde PagosReal/
        // NotasCredito reales de la Factura, no desde PagFac.SALDOANT).
        const impSaldoAnt = Math.max(0, esCompensacion ? (d.saldoBase - num(l.IMPRTE)) : d.saldoBase);
        const saldoInsoluto = impSaldoAnt - montoAplicado;
        const drAttrs = { IdDocumento: d.uuid };
        // Serie/Folio del documento relacionado (Factura o Nota de Débito),
        // tal como se capturaron en la línea del Pago -- a diferencia del
        // Folio del comprobante raíz (que siempre es el Id_NoPago y no
        // cambia), estos sí identifican el documento que se está pagando.
        if (d.serieDoc) drAttrs.Serie = d.serieDoc;
        drAttrs.Folio = d.folioDoc;
        Object.assign(drAttrs, {
          MonedaDR: d.monedaDR, NumParcialidad: String(d.numParcialidad),
          ImpSaldoAnt: fmtDec(impSaldoAnt, 2), ImpPagado: fmtDec(montoAplicado, 2),
          ImpSaldoInsoluto: fmtDec(Math.max(0, saldoInsoluto), 2), ObjetoImpDR: d.objetoImpDR,
        });
        // Regla real del Complemento de Pagos (confirmada por rechazo del PAC):
        // EquivalenciaDR es SIEMPRE obligatorio, nunca se omite. Si MonedaDR
        // es igual a MonedaP, debe ser literal "1". Si difieren, es cuántas
        // unidades de MonedaDR equivalen a 1 unidad de MonedaP -- derivado de
        // los dos tipos de cambio vs. MXN ya disponibles (el de la Factura y
        // el del propio Pago), sin dato histórico real con monedas cruzadas
        // para verificar esta rama contra un timbrado real.
        drAttrs.EquivalenciaDR = d.monedaDR === monedaP
          ? '1'
          : String(Math.round((parseFloat(tipoCambioP) / d.tipoCambioDR) * 1000000) / 1000000);
        let impuestos = null;
        if (d.objetoImpDR === '02' && (ivaLinea > 0.005 || retLinea > 0.005)) {
          impuestos = {};
          if (retLinea > 0.005) {
            impuestos.retencion = { BaseDR: fmtDec(subtotalLinea, 2), ImpuestoDR: '001', TipoFactorDR: 'Tasa', TasaOCuotaDR: '0.040000', ImporteDR: fmtDec(retLinea, 2) };
            totRetISR += retLinea;
          }
          if (ivaLinea > 0.005) {
            impuestos.traslado = { BaseDR: fmtDec(subtotalLinea, 2), ImpuestoDR: '002', TipoFactorDR: 'Tasa', TasaOCuotaDR: '0.160000', ImporteDR: fmtDec(ivaLinea, 2) };
            totBaseIVA16 += subtotalLinea; totImpIVA16 += ivaLinea;
          }
        }
        return { drAttrs, impuestos };
      });
    return { relacionados, totRetISR, totBaseIVA16, totImpIVA16 };
  }

  const montoReal = Math.round(lineas.reduce((acc, l) => acc + num(l.IMPRTE), 0) * 100) / 100;
  const montoComp = Math.round(lineas.reduce((acc, l) => acc + num(l.COMPESACION), 0) * 100) / 100;
  const hayCompensacion = Number(cab.FlagCompensacion) === 1 && montoComp > 0.005;

  const pagoReal = montoReal > 0.005
    ? calcularDocsRelacionados(datosLinea, 'IMPRTE', 'SUBTOTAL', 'IVA', 'RETENCION', false)
    : null;
  // El nodo de Compensación parte del saldo YA reducido por la porción real
  // de esa misma línea (si la hubo) -- no del saldo antes de todo el pago.
  const pagoComp = hayCompensacion
    ? calcularDocsRelacionados(datosLinea, 'COMPESACION', 'SUBTOTALCOMP', 'IVACOMP', 'RETENCIONCOMP', true)
    : null;

  const montoTotalPagos = montoReal + (hayCompensacion ? montoComp : 0);
  const totRetISR = (pagoReal?.totRetISR || 0) + (pagoComp?.totRetISR || 0);
  const totBaseIVA16 = (pagoReal?.totBaseIVA16 || 0) + (pagoComp?.totBaseIVA16 || 0);
  const totImpIVA16 = (pagoReal?.totImpIVA16 || 0) + (pagoComp?.totImpIVA16 || 0);

  // ── Construcción del XML, ya en el orden correcto ──────────────────────
  const complemento = doc.ele('cfdi:Complemento');
  const pagosNode = complemento.ele('pago20:Pagos', { Version: '2.0' });

  const totalesAttrs = { MontoTotalPagos: fmtDec(montoTotalPagos, 2) };
  if (totRetISR > 0.005) totalesAttrs.TotalRetencionesISR = fmtDec(totRetISR, 2);
  if (totBaseIVA16 > 0.005) { totalesAttrs.TotalTrasladosBaseIVA16 = fmtDec(totBaseIVA16, 2); totalesAttrs.TotalTrasladosImpuestoIVA16 = fmtDec(totImpIVA16, 2); }
  pagosNode.ele('pago20:Totales', totalesAttrs).up();

  function escribirNodoPago(pagoAttrs, calculo) {
    const pagoNode = pagosNode.ele('pago20:Pago', pagoAttrs);
    for (const { drAttrs, impuestos } of calculo.relacionados) {
      const drNode = pagoNode.ele('pago20:DoctoRelacionado', drAttrs);
      if (impuestos) {
        const impDR = drNode.ele('pago20:ImpuestosDR');
        if (impuestos.retencion) impDR.ele('pago20:RetencionesDR').ele('pago20:RetencionDR', impuestos.retencion).up().up();
        if (impuestos.traslado) impDR.ele('pago20:TrasladosDR').ele('pago20:TrasladoDR', impuestos.traslado).up().up();
        impDR.up();
      }
      drNode.up();
    }
    // pago20:ImpuestosP -- debe declarar EXACTAMENTE la suma de lo declarado
    // en los ImpuestosDR de este mismo pago20:Pago (rechazo real del PAC
    // cuando faltaba este nodo: "Diferencia en la cantidad de impuestos
    // declarados entre RetencionesDR y RetencionesP"). Con el esquema fiscal
    // fijo de este proyecto (ISR 001 retención, IVA 002 traslado 16%) alcanza
    // con un solo RetencionP/TrasladoP agregado.
    if (calculo.totRetISR > 0.005 || calculo.totBaseIVA16 > 0.005) {
      const impP = pagoNode.ele('pago20:ImpuestosP');
      if (calculo.totRetISR > 0.005) {
        impP.ele('pago20:RetencionesP').ele('pago20:RetencionP', { ImpuestoP: '001', ImporteP: fmtDec(calculo.totRetISR, 2) }).up().up();
      }
      if (calculo.totBaseIVA16 > 0.005) {
        impP.ele('pago20:TrasladosP').ele('pago20:TrasladoP', {
          BaseP: fmtDec(calculo.totBaseIVA16, 2), ImpuestoP: '002', TipoFactorP: 'Tasa', TasaOCuotaP: '0.160000', ImporteP: fmtDec(calculo.totImpIVA16, 2),
        }).up().up();
      }
      impP.up();
    }
    pagoNode.up();
  }

  if (pagoReal) {
    escribirNodoPago({
      FechaPago: fechaPago, FormaDePagoP: fmt(cab.c_FormaPago), MonedaP: monedaP,
      TipoCambioP: tipoCambioP,
      Monto: fmtDec(montoReal, 2), NumOperacion: fmt(cab.NoCheuqe) || undefined,
    }, pagoReal);
  }
  if (pagoComp) {
    escribirNodoPago({
      FechaPago: fechaPago, FormaDePagoP: CODIGO_COMPENSACION, MonedaP: monedaP,
      TipoCambioP: tipoCambioP,
      Monto: fmtDec(montoComp, 2),
    }, pagoComp);
  }

  pagosNode.up();
  complemento.up();

  return { xml: doc.end({ prettyPrint: true }) };
}

function num(v) { return parseFloat(v) || 0; }

module.exports = { buildCFDIPago };
