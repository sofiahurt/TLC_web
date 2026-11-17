/* ============================================================================
   SERIES POR DEFAULT  (Facturas = FTLC, Notas de Credito = NCTLC, Notas de Debito = NDTLC, Cobros = PTLC)

   Pone la serie a los documentos que hoy NO la tienen (SerieFac / Serie vacia o NULL) y a todo lo que
   los referencia, SIN cambiar ningun folio/consecutivo. Los documentos que ya tienen serie (F, FE, TLCEI,
   CHE, ND, ...) NO se tocan.

   Que actualiza
     Facturas ........ Factura.SerieFac y sus referencias: FacDeta.SerieFac, NotaCredDeta.SerieFac
                       (solo renglones de factura), PagFac.SERIEFAC (solo renglones de factura)
     Notas de Credito  NotaCred.Serie (Tipo NC) y NotaCredDeta.SERIE de sus renglones
     Notas de Debito . NotaCred.Serie (Tipo ND), NotaCredDeta.SERIE de sus renglones y las referencias
                       a la ND: NotaCredDeta.SerieND, PagFac.SERIEND (solo renglones de ND)
     Cobros .......... Pagos.Serie

   Los XML/PDF ya timbrados NO cambian (el XML timbrado es inmutable); el sistema los sigue encontrando
   porque, ademas de FAC_{serie}{folio}, busca FAC_{folio} (igual NC_/ND_).

   COMO USARLO (en este orden)
     1. Respaldo de la base:  BACKUP DATABASE [<base>] TO DISK = N'<ruta>\antes_series.bak' WITH INIT;
     2. Con el sistema DETENIDO o sin usuarios capturando, y ANTES de publicar la version nueva
        (la version nueva crea documentos con serie FTLC/NCTLC/NDTLC/PTLC: si se publica antes y alguien
        captura, esos folios empezarian en 1 y chocarian con los migrados).
     3. Ejecutarlo con @Confirmar = 0 (simulacion: muestra cuantos renglones cambiaria y hace ROLLBACK).
     4. Si los conteos son los esperados, cambiar @Confirmar = 1 y ejecutarlo de nuevo.
     5. Publicar/arrancar la version nueva.

   Cambiar las series: editar las 4 variables de abajo (deben coincidir con app/config/series-default.js).
   ============================================================================ */
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Confirmar     BIT         = 0;          -- 0 = simulacion (ROLLBACK), 1 = aplicar (COMMIT)
DECLARE @SerieFactura  VARCHAR(20) = 'FTLC';
DECLARE @SerieNC       VARCHAR(10) = 'NCTLC';
DECLARE @SerieND       VARCHAR(10) = 'NDTLC';
DECLARE @SeriePago     VARCHAR(20) = 'PTLC';

BEGIN TRY
  BEGIN TRAN;

  -- >>> CAMBIOS ------------------------------------------------------------
  -- Seguridad: si ya existen documentos con la serie nueva y comparten folio con los que se van a
  -- migrar (p. ej. alguien capturo con la version nueva antes de correr este script), se aborta.
  IF EXISTS (SELECT 1 FROM Empresa2.Factura a JOIN Empresa2.Factura b ON b.Id_NoFactura = a.Id_NoFactura
              WHERE ISNULL(LTRIM(RTRIM(a.SerieFac)),'') = '' AND LTRIM(RTRIM(b.SerieFac)) = @SerieFactura)
    THROW 50001, 'Ya existen facturas con la serie nueva y folios que chocan con las facturas sin serie. No se aplico nada.', 1;
  IF EXISTS (SELECT 1 FROM Empresa2.NotaCred a JOIN Empresa2.NotaCred b ON b.Id_NotaCredito = a.Id_NotaCredito AND LTRIM(RTRIM(b.Tipo)) = LTRIM(RTRIM(a.Tipo))
              WHERE ISNULL(LTRIM(RTRIM(a.Serie)),'') = ''
                AND LTRIM(RTRIM(b.Serie)) = CASE WHEN LTRIM(RTRIM(a.Tipo)) = 'ND' THEN @SerieND ELSE @SerieNC END)
    THROW 50002, 'Ya existen notas con la serie nueva y folios que chocan con las notas sin serie. No se aplico nada.', 1;

  -- 1. Facturas ---------------------------------------------------------------
  UPDATE Empresa2.Factura SET SerieFac = @SerieFactura WHERE ISNULL(LTRIM(RTRIM(SerieFac)),'') = '';
  PRINT 'Factura.SerieFac            : ' + CAST(@@ROWCOUNT AS VARCHAR(12)) + ' filas';
  UPDATE Empresa2.FacDeta SET SerieFac = @SerieFactura WHERE ISNULL(LTRIM(RTRIM(SerieFac)),'') = '';
  PRINT 'FacDeta.SerieFac            : ' + CAST(@@ROWCOUNT AS VARCHAR(12)) + ' filas';
  UPDATE Empresa2.NotaCredDeta SET SerieFac = @SerieFactura WHERE ISNULL(LTRIM(RTRIM(SerieFac)),'') = '' AND ID_NOFACTURA > 0;
  PRINT 'NotaCredDeta.SerieFac       : ' + CAST(@@ROWCOUNT AS VARCHAR(12)) + ' filas (renglones de factura)';
  UPDATE Empresa2.PagFac SET SERIEFAC = @SerieFactura WHERE ISNULL(LTRIM(RTRIM(SERIEFAC)),'') = '' AND NOFACTURA > 0;
  PRINT 'PagFac.SERIEFAC             : ' + CAST(@@ROWCOUNT AS VARCHAR(12)) + ' filas (renglones de factura)';

  -- 2. Referencias a Notas de Debito sin serie (antes de cambiar la serie de las propias notas) ----
  UPDATE Empresa2.NotaCredDeta SET SerieND = @SerieND WHERE ISNULL(LTRIM(RTRIM(SerieND)),'') = '' AND Id_NotaDebito > 0;
  PRINT 'NotaCredDeta.SerieND        : ' + CAST(@@ROWCOUNT AS VARCHAR(12)) + ' filas (renglones de ND)';
  UPDATE Empresa2.PagFac SET SERIEND = @SerieND WHERE ISNULL(LTRIM(RTRIM(SERIEND)),'') = '' AND ID_NOTACREDITO > 0;
  PRINT 'PagFac.SERIEND              : ' + CAST(@@ROWCOUNT AS VARCHAR(12)) + ' filas (renglones de ND)';

  -- 3. Notas de Credito / Debito: primero sus renglones (se ligan a la nota todavia sin serie), luego la nota ----
  UPDATE d SET d.SERIE = CASE WHEN LTRIM(RTRIM(d.TIPO)) = 'ND' THEN @SerieND ELSE @SerieNC END
    FROM Empresa2.NotaCredDeta d
    JOIN Empresa2.NotaCred n ON n.Id_NotaCredito = d.ID_NOTACREDITO AND LTRIM(RTRIM(n.Tipo)) = LTRIM(RTRIM(d.TIPO))
   WHERE ISNULL(LTRIM(RTRIM(n.Serie)),'') = '' AND ISNULL(LTRIM(RTRIM(d.SERIE)),'') = '';
  PRINT 'NotaCredDeta.SERIE          : ' + CAST(@@ROWCOUNT AS VARCHAR(12)) + ' filas';
  UPDATE Empresa2.NotaCred SET Serie = CASE WHEN LTRIM(RTRIM(Tipo)) = 'ND' THEN @SerieND ELSE @SerieNC END
   WHERE ISNULL(LTRIM(RTRIM(Serie)),'') = '' AND LTRIM(RTRIM(Tipo)) IN ('NC','ND');
  PRINT 'NotaCred.Serie              : ' + CAST(@@ROWCOUNT AS VARCHAR(12)) + ' filas';

  -- 4. Cobros --------------------------------------------------------------------
  UPDATE Empresa2.Pagos SET Serie = @SeriePago WHERE ISNULL(LTRIM(RTRIM(Serie)),'') = '';
  PRINT 'Pagos.Serie                 : ' + CAST(@@ROWCOUNT AS VARCHAR(12)) + ' filas';
  -- <<< CAMBIOS ------------------------------------------------------------

  -- Verificacion: no debe haber (serie, folio) repetidos que antes no existieran, ni documentos sin serie.
  PRINT '--- Verificacion ---';
  SELECT 'Facturas sin serie' AS Concepto, COUNT(*) AS Filas FROM Empresa2.Factura WHERE ISNULL(LTRIM(RTRIM(SerieFac)),'') = ''
  UNION ALL SELECT 'Notas sin serie', COUNT(*) FROM Empresa2.NotaCred WHERE ISNULL(LTRIM(RTRIM(Serie)),'') = ''
  UNION ALL SELECT 'Cobros sin serie', COUNT(*) FROM Empresa2.Pagos WHERE ISNULL(LTRIM(RTRIM(Serie)),'') = ''
  UNION ALL SELECT 'Renglones de factura sin serie (FacDeta)', COUNT(*) FROM Empresa2.FacDeta WHERE ISNULL(LTRIM(RTRIM(SerieFac)),'') = ''
  UNION ALL SELECT 'Facturas con folio repetido en la misma serie', COUNT(*) FROM (SELECT SerieFac, Id_NoFactura FROM Empresa2.Factura GROUP BY SerieFac, Id_NoFactura HAVING COUNT(*) > 1) x
  UNION ALL SELECT 'Notas con folio repetido en la misma serie', COUNT(*) FROM (SELECT Tipo, Serie, Id_NotaCredito FROM Empresa2.NotaCred GROUP BY Tipo, Serie, Id_NotaCredito HAVING COUNT(*) > 1) x;
  SELECT LTRIM(RTRIM(SerieFac)) AS SerieFactura, COUNT(*) AS Facturas, MIN(Id_NoFactura) AS FolioMin, MAX(Id_NoFactura) AS FolioMax
    FROM Empresa2.Factura GROUP BY LTRIM(RTRIM(SerieFac)) ORDER BY 1;
  SELECT LTRIM(RTRIM(Tipo)) AS Tipo, LTRIM(RTRIM(Serie)) AS SerieNota, COUNT(*) AS Notas, MIN(Id_NotaCredito) AS FolioMin, MAX(Id_NotaCredito) AS FolioMax
    FROM Empresa2.NotaCred GROUP BY LTRIM(RTRIM(Tipo)), LTRIM(RTRIM(Serie)) ORDER BY 1, 2;

  IF @Confirmar = 1
  BEGIN
    COMMIT;
    PRINT 'APLICADO (COMMIT).';
  END
  ELSE
  BEGIN
    ROLLBACK;
    PRINT 'SIMULACION: no se guardo nada (ROLLBACK). Cambie @Confirmar = 1 para aplicar.';
  END
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  PRINT 'ERROR, no se aplico nada: ' + ERROR_MESSAGE();
  THROW;
END CATCH
