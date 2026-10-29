'use strict';

// Pruebas de la importación de facturas desde XML CFDI.
//   node scripts/test-importar-facturas.js
//
// Casos: 1 concepto, varios conceptos con IVA y retención, duplicado y tipo "T".
// Las altas usan SerieFac "ZZT" (no existe en producción) y la limpieza borra
// solo esa serie, tanto en BD como los FAC_ZZT*.xml de la carpeta de XML.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getPool, sql } = require('../app/config/db');
const { RUTA_XML } = require('../app/config/storage');
const imp = require('../app/services/importar-facturas-xml');

const SERIE = 'ZZT';

function xmlCfdi({ tipo = 'I', folio, serie = SERIE, rfc = 'ZZZ010101AAA', nombre = 'CLIENTE DE PRUEBA ZZT', subtotal, iva, ret, total, conceptos, cartaPorte = false }) {
  const imps = (c) => (c.iva || c.ret) ? `<cfdi:Impuestos>
        ${c.iva ? `<cfdi:Traslados><cfdi:Traslado Base="${c.importe}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${c.iva}"/></cfdi:Traslados>` : ''}
        ${c.ret ? `<cfdi:Retenciones><cfdi:Retencion Base="${c.importe}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.040000" Importe="${c.ret}"/></cfdi:Retenciones>` : ''}
      </cfdi:Impuestos>` : '';
  const totImp = (iva || ret) ? `<cfdi:Impuestos${ret ? ` TotalImpuestosRetenidos="${ret}"` : ''}${iva ? ` TotalImpuestosTrasladados="${iva}"` : ''}/>` : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" xmlns:cartaporte31="http://www.sat.gob.mx/CartaPorte31"
  Version="4.0" Serie="${serie}" Folio="${folio}" Fecha="2026-03-15T10:25:43" FormaPago="99" MetodoPago="PPD" NoCertificado="30001000000500003416"
  SubTotal="${subtotal}" Moneda="MXN" Total="${total}" TipoDeComprobante="${tipo}" Exportacion="01" LugarExpedicion="31000">
  <cfdi:Emisor Rfc="EKU9003173C9" Nombre="EMISOR" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${rfc}" Nombre="${nombre}" DomicilioFiscalReceptor="31000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>${conceptos.map(c => `
    <cfdi:Concepto ClaveProdServ="${c.clave || '78101800'}" Cantidad="${c.cant || 1}" ClaveUnidad="E48" Descripcion="${c.desc}" ValorUnitario="${c.importe}" Importe="${c.importe}" ObjetoImp="02">${imps(c)}</cfdi:Concepto>`).join('')}
  </cfdi:Conceptos>
  ${totImp}
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="ZZT00000-0000-4000-8000-${String(folio).padStart(12, '0')}" FechaTimbrado="2026-03-15T10:26:01" RfcProvCertif="SPR190613I52" SelloCFD="x" NoCertificadoSAT="30001000000500003456" SelloSAT="y"/>
    ${cartaPorte ? '<cartaporte31:CartaPorte Version="3.1" IdCCP="CCCCCCCC-1111-2222-3333-444444444444"/>' : ''}
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

const XML_1 = xmlCfdi({ folio: 9990001, subtotal: '1000.00', iva: '160.00', total: '1160.00', conceptos: [{ desc: 'SERVICIO DE FLETE', importe: '1000.00', iva: '160.00' }] });
const XML_N = xmlCfdi({
  folio: 9990002, subtotal: '3000.00', iva: '480.00', ret: '40.00', total: '3440.00', cartaPorte: true,
  conceptos: [
    { desc: 'FLETE 1', importe: '1000.00', iva: '160.00', ret: '40.00' },
    { desc: 'MANIOBRAS', importe: '500.00', iva: '80.00' },
    { desc: 'FLETE 3', importe: '1500.00', iva: '240.00' },
  ],
});
const XML_T = xmlCfdi({ tipo: 'T', folio: 9990003, subtotal: '0', total: '0', conceptos: [{ desc: 'TRASLADO', importe: '0' }] });
const XML_TOTAL_MAL = xmlCfdi({ folio: 9990004, subtotal: '100.00', iva: '16.00', total: '999.00', conceptos: [{ desc: 'X', importe: '100.00', iva: '16.00' }] });

const pruebas = [];
const prueba = (nombre, fn) => pruebas.push({ nombre, fn });

async function limpiar(pool) {
  await pool.request().input('s', sql.VarChar(20), SERIE).query(`DELETE FROM Empresa2.FacDeta WHERE LTRIM(RTRIM(SerieFac))=@s AND ID_NOFACTURA BETWEEN 9990001 AND 9990009`);
  await pool.request().input('s', sql.VarChar(20), SERIE).query(`DELETE FROM Empresa2.Factura WHERE LTRIM(RTRIM(SerieFac))=@s AND Id_NoFactura BETWEEN 9990001 AND 9990009`);
  for (const f of fs.readdirSync(RUTA_XML)) if (/^FAC_ZZT999000\d_Timbrada\.xml$/.test(f)) fs.unlinkSync(path.join(RUTA_XML, f));
}

// ── parser (sin BD) ──────────────────────────────────────────────────────────
prueba('parser: 1 concepto', async () => {
  const d = imp.parsearFacturaXml(XML_1);
  assert.strictEqual(d.tipo, 'I');
  assert.strictEqual(d.folio, 9990001);
  assert.strictEqual(d.serie, SERIE);
  assert.strictEqual(d.fecha, '2026-03-15');
  assert.strictEqual(d.hora, '10:25:43');
  assert.deepStrictEqual([d.subTotal, d.iva, d.retencion, d.total], [1000, 160, 0, 1160]);
  assert.strictEqual(d.conceptos.length, 1);
  assert.deepStrictEqual([d.conceptos[0].subtotal, d.conceptos[0].iva, d.conceptos[0].reten, d.conceptos[0].total], [1000, 160, 0, 1160]);
  assert.strictEqual(d.uuid, 'ZZT00000-0000-4000-8000-000009990001');
  assert.strictEqual(d.idCCP, '');
  assert.deepStrictEqual(d.advertencias, []);
});
prueba('parser: varios conceptos con IVA y retención (Impuestos del comprobante, no de los conceptos)', async () => {
  const d = imp.parsearFacturaXml(XML_N);
  assert.deepStrictEqual([d.subTotal, d.iva, d.retencion, d.total], [3000, 480, 40, 3440]);
  assert.deepStrictEqual(d.conceptos.map(c => c.id), [1, 2, 3]);
  assert.deepStrictEqual(d.conceptos.map(c => [c.subtotal, c.iva, c.reten, c.total]), [[1000, 160, 40, 1120], [500, 80, 0, 580], [1500, 240, 0, 1740]]);
  assert.strictEqual(d.idCCP, 'CCCCCCCC-1111-2222-3333-444444444444');
});
prueba('parser: tipo T se reporta sin parsear el resto', async () => {
  assert.deepStrictEqual(imp.parsearFacturaXml(XML_T), { tipo: 'T' });
});
prueba('parser: total que no cuadra genera advertencia', async () => {
  assert.strictEqual(imp.parsearFacturaXml(XML_TOTAL_MAL).advertencias.length, 1);
});
prueba('parser: XML inválido lanza error', async () => {
  assert.throws(() => imp.parsearFacturaXml('esto no es xml'), /no es un XML CFDI válido/);
});

// ── con BD ───────────────────────────────────────────────────────────────────
const SQ = (pool, folio) => pool.request().input('id', sql.Decimal(9), folio).input('s', sql.VarChar(20), SERIE);

prueba('BD: 1 concepto se importa con cabecera, detalle y XML guardado', async (pool) => {
  const r = await imp.importarXml(pool, 'f1.xml', XML_1);
  assert.strictEqual(r.estado, 'importada', r.motivo);
  assert.ok(r.clienteNoEncontrado, 'RFC inexistente debe reportarse como cliente no encontrado');
  const h = (await SQ(pool, 9990001).query(`SELECT * FROM Empresa2.Factura WHERE Id_NoFactura=@id AND LTRIM(RTRIM(SerieFac))=@s`)).recordset;
  assert.strictEqual(h.length, 1);
  const f = h[0];
  assert.strictEqual(Number(f.Id_Cliente), 0);
  assert.strictEqual(f.Status.trim(), 'EMITIDA');
  assert.strictEqual(f.TipoCFDI.trim(), 'CFDI40');
  assert.strictEqual(f.ClaveMP.trim(), 'PPD');
  assert.strictEqual(f.c_FormaPago.trim(), '99');
  assert.strictEqual(f.UUID.trim(), 'ZZT00000-0000-4000-8000-000009990001');
  assert.strictEqual(f.FechaTimbrado, '2026-03-15T10:26:01');
  assert.strictEqual(f.RfcProvCertif.trim(), 'SPR190613I52');
  assert.deepStrictEqual([Number(f.SubTotal), Number(f.IVA), Number(f.Retencion), Number(f.TOTAL)], [1000, 160, 0, 1160]);
  assert.strictEqual(Number(f.IncluirCP), 0);
  const l = (await SQ(pool, 9990001).query(`SELECT * FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND LTRIM(RTRIM(SerieFac))=@s ORDER BY ID_NODETAFAC`)).recordset;
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].DESCOMOTRO.trim(), 'SERVICIO DE FLETE');
  assert.strictEqual(l[0].DESFLETE.trim(), 'SERVICIO DE FLETE');
  assert.strictEqual(l[0].NOTACARGO.trim(), 'Otro');
  assert.ok(fs.existsSync(path.join(RUTA_XML, 'FAC_ZZT9990001_Timbrada.xml')));
});

prueba('BD: varios conceptos con IVA y retención', async (pool) => {
  const r = await imp.importarXml(pool, 'f2.xml', XML_N);
  assert.strictEqual(r.estado, 'importada', r.motivo);
  const f = (await SQ(pool, 9990002).query(`SELECT * FROM Empresa2.Factura WHERE Id_NoFactura=@id AND LTRIM(RTRIM(SerieFac))=@s`)).recordset[0];
  assert.deepStrictEqual([Number(f.SubTotal), Number(f.IVA), Number(f.Retencion), Number(f.TOTAL)], [3000, 480, 40, 3440]);
  assert.strictEqual(Number(f.IncluirCP), 1);
  assert.strictEqual(f.IdCCP.trim(), 'CCCCCCCC-1111-2222-3333-444444444444');
  const l = (await SQ(pool, 9990002).query(`SELECT ID_NODETAFAC, SUBTOTAL, IVA, RETEN, TOTAL, FLAGIVA, FLAGRETMAN FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND LTRIM(RTRIM(SerieFac))=@s ORDER BY ID_NODETAFAC`)).recordset;
  assert.deepStrictEqual(l.map(x => Number(x.ID_NODETAFAC)), [1, 2, 3]);
  assert.deepStrictEqual(l.map(x => [Number(x.SUBTOTAL), Number(x.IVA), Number(x.RETEN), Number(x.TOTAL)]), [[1000, 160, 40, 1120], [500, 80, 0, 580], [1500, 240, 0, 1740]]);
  assert.ok(l.every(x => Number(x.FLAGIVA) === 0 && Number(x.FLAGRETMAN) === 0));
});

prueba('BD: duplicado (misma Serie + Folio) no se inserta', async (pool) => {
  const r = await imp.importarXml(pool, 'f1-dup.xml', XML_1);
  assert.strictEqual(r.estado, 'existente');
  const n = (await SQ(pool, 9990001).query(`SELECT COUNT(*) n FROM Empresa2.Factura WHERE Id_NoFactura=@id AND LTRIM(RTRIM(SerieFac))=@s`)).recordset[0].n;
  const nd = (await SQ(pool, 9990001).query(`SELECT COUNT(*) n FROM Empresa2.FacDeta WHERE ID_NOFACTURA=@id AND LTRIM(RTRIM(SerieFac))=@s`)).recordset[0].n;
  assert.strictEqual(n, 1);
  assert.strictEqual(nd, 1);
});

prueba('BD: tipo T se omite y no inserta nada', async (pool) => {
  const r = await imp.importarXml(pool, 'f3-T.xml', XML_T);
  assert.strictEqual(r.estado, 'omitida');
  assert.match(r.motivo, /omitido: tipo T/);
  const n = (await SQ(pool, 9990003).query(`SELECT COUNT(*) n FROM Empresa2.Factura WHERE Id_NoFactura=@id AND LTRIM(RTRIM(SerieFac))=@s`)).recordset[0].n;
  assert.strictEqual(n, 0);
  assert.ok(!fs.existsSync(path.join(RUTA_XML, 'FAC_ZZT9990003_Timbrada.xml')));
});

prueba('BD: error en un concepto hace rollback completo y no guarda el XML', async (pool) => {
  // Importe fuera de rango de decimal(9,2) en FacDeta -> falla al insertar el concepto
  const malo = xmlCfdi({ folio: 9990005, subtotal: '99999999999.00', total: '99999999999.00', conceptos: [{ desc: 'X', importe: '99999999999.00' }] });
  const r = await imp.importarXml(pool, 'f5.xml', malo);
  assert.strictEqual(r.estado, 'error');
  const n = (await SQ(pool, 9990005).query(`SELECT COUNT(*) n FROM Empresa2.Factura WHERE Id_NoFactura=@id AND LTRIM(RTRIM(SerieFac))=@s`)).recordset[0].n;
  assert.strictEqual(n, 0);
  assert.ok(!fs.existsSync(path.join(RUTA_XML, 'FAC_ZZT9990005_Timbrada.xml')));
});

prueba('BD: cliente existente se enlaza por RFC', async (pool) => {
  const c = (await pool.request().query(`SELECT TOP 1 ID_CLIENTE, LTRIM(RTRIM(RFC)) RFC, LTRIM(RTRIM(NOMBRECOM)) N FROM Empresa2.Clientes
    WHERE RFC IS NOT NULL AND LTRIM(RTRIM(RFC))<>'' AND RFC NOT LIKE 'XAXX%' AND RFC IN (SELECT RFC FROM Empresa2.Clientes GROUP BY RFC HAVING COUNT(*)=1)`)).recordset[0];
  assert.ok(c, 'no hay cliente con RFC único para probar');
  const xml = xmlCfdi({ folio: 9990006, rfc: c.RFC, nombre: c.N, subtotal: '10.00', total: '10.00', conceptos: [{ desc: 'X', importe: '10.00' }] });
  const r = await imp.importarXml(pool, 'f6.xml', xml);
  assert.strictEqual(r.estado, 'importada', r.motivo);
  assert.ok(!r.clienteNoEncontrado);
  const f = (await SQ(pool, 9990006).query(`SELECT Id_Cliente FROM Empresa2.Factura WHERE Id_NoFactura=@id AND LTRIM(RTRIM(SerieFac))=@s`)).recordset[0];
  assert.strictEqual(Number(f.Id_Cliente), Number(c.ID_CLIENTE));
});

prueba('BD: lote desde carpeta (progreso y contadores)', async (pool) => {
  await limpiar(pool);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impfac-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.xml'), XML_1);
    fs.writeFileSync(path.join(dir, 'b.xml'), XML_N);
    fs.writeFileSync(path.join(dir, 'c.xml'), XML_1);       // duplicado de a
    fs.writeFileSync(path.join(dir, 'd.xml'), XML_T);
    fs.writeFileSync(path.join(dir, 'e.xml'), 'basura');
    fs.writeFileSync(path.join(dir, 'ignorar.txt'), 'x');
    const archivos = imp.listarXml(dir);
    assert.deepStrictEqual(archivos, ['a.xml', 'b.xml', 'c.xml', 'd.xml', 'e.xml']);
    const resumen = imp.resumenVacio(archivos.length);
    await imp.importarLote(pool, dir, archivos, {}, resumen);
    assert.strictEqual(resumen.terminado, true);
    assert.deepStrictEqual(
      [resumen.total, resumen.procesados, resumen.importadas, resumen.existentes, resumen.omitidas, resumen.errores, resumen.clientesNoEncontrados],
      [5, 5, 2, 1, 1, 1, 2]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

(async () => {
  const pool = await getPool();
  const previos = (await pool.request().input('s', sql.VarChar(20), SERIE)
    .query(`SELECT COUNT(*) n FROM Empresa2.Factura WHERE LTRIM(RTRIM(SerieFac))=@s AND Id_NoFactura BETWEEN 9990001 AND 9990009`)).recordset[0].n;
  if (previos) { console.error(`Hay ${previos} facturas ${SERIE} 99900xx previas; revisar antes de correr las pruebas.`); process.exit(2); }

  let fallos = 0;
  try {
    for (const p of pruebas) {
      try { await p.fn(pool); console.log('  ok  ' + p.nombre); }
      catch (err) { fallos++; console.log('FALLA ' + p.nombre + '\n      ' + (err.message || err)); }
    }
  } finally { await limpiar(pool); }
  console.log(fallos ? `\n${fallos} prueba(s) fallaron` : `\nTodas las pruebas pasaron (${pruebas.length})`);
  process.exit(fallos ? 1 : 0);
})();
