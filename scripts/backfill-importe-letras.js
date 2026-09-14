'use strict';

// ── Backfill único de ImporteLetras para registros ya existentes ───────────
// Recalcula y sobreescribe Empresa2.Factura.ImporteLetras (a partir de TOTAL +
// MonFactura) y Empresa2.NotaCred.ImporteLetras (a partir de ImporteTotal,
// siempre pesos -- NotaCred no tiene columna de moneda propia; ImporteTotal ya
// es el campo autoritativo tanto en modo resumen como detallado, ver
// recalcularCabecera en app/routes/notacred.js).
//
// Uso: node scripts/backfill-importe-letras.js
//
// Sobreescribe SIEMPRE (no solo filas en blanco) para corregir también los
// pocos casos legado detectados como obsoletos (ImporteLetras no coincidía
// con el TOTAL actual, por cambios posteriores a como quedó guardado).
//
// GOTCHA REAL (encontrado en la primera corrida de este script, corregido
// aquí): (Id_NoFactura, SerieFac) NO es una clave única -- hay 9 pares de
// folios con SerieFac en blanco que en realidad son DOS FACTURAS DISTINTAS
// (distinto cliente/UUID/total) colisionando en el mismo número. El UPDATE
// original, sin más filtro, escribía en AMBAS filas el valor calculado de
// la que se procesara al final, dejando mal la otra mitad de cada par. Se
// agrega UUID a la condición para desambiguar (único por fila salvo un caso
// de duplicado exacto real, donde ambas copias ya comparten el mismo total).

const { getPool, sql } = require('../app/config/db');
const { importeALetras } = require('../app/services/importe-letras');

async function main() {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const facturas = await new sql.Request(tx).query(`SELECT Id_NoFactura, SerieFac, UUID, TOTAL, MonFactura FROM Empresa2.Factura`);
    console.log(`Facturas a procesar: ${facturas.recordset.length}`);
    let cambiadas = 0;
    for (const f of facturas.recordset) {
      const letras = importeALetras(f.TOTAL, f.MonFactura);
      const r = await new sql.Request(tx)
        .input('id', sql.Decimal(9), f.Id_NoFactura)
        .input('serieFac', sql.VarChar(20), (f.SerieFac || '').trim() || null)
        .input('uuid', sql.VarChar(149), (f.UUID || '').trim() || null)
        .input('letras', sql.VarChar(150), letras)
        .query(`UPDATE Empresa2.Factura SET ImporteLetras=@letras
                WHERE Id_NoFactura=@id AND ISNULL(LTRIM(RTRIM(SerieFac)),'')=ISNULL(@serieFac,'')
                  AND ISNULL(LTRIM(RTRIM(UUID)),'')=ISNULL(@uuid,'')`);
      cambiadas += r.rowsAffected[0];
    }
    console.log(`Facturas actualizadas: ${cambiadas}`);

    const notas = await new sql.Request(tx).query(`SELECT Tipo, Serie, Id_NotaCredito, ImporteTotal FROM Empresa2.NotaCred`);
    console.log(`Notas de Crédito/Débito a procesar: ${notas.recordset.length}`);
    let cambiadasNC = 0;
    for (const n of notas.recordset) {
      const letras = importeALetras(n.ImporteTotal, 'MXN');
      const r = await new sql.Request(tx)
        .input('tipo', sql.VarChar(3), (n.Tipo || '').trim())
        .input('serie', sql.VarChar(10), (n.Serie || '').trim() || null)
        .input('id', sql.Decimal(7), n.Id_NotaCredito)
        .input('letras', sql.VarChar(200), letras)
        .query(`UPDATE Empresa2.NotaCred SET ImporteLetras=@letras
                WHERE Id_NotaCredito=@id AND LTRIM(RTRIM(Tipo))=@tipo AND ISNULL(LTRIM(RTRIM(Serie)),'')=ISNULL(@serie,'')`);
      cambiadasNC += r.rowsAffected[0];
    }
    console.log(`Notas de Crédito/Débito actualizadas: ${cambiadasNC}`);

    await tx.commit();
    console.log('Backfill completado y confirmado (commit).');
  } catch (err) {
    await tx.rollback();
    console.error('Backfill abortado, se revirtió todo:', err.message);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
}

main();
