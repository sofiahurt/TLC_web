<?xml version="1.0" encoding="UTF-8"?>
<!--
  Cadena original CFDI 4.0 + Complemento Pagos 2.0 — XSLT combinado
  Basado en la especificación oficial SAT (Anexo 20 CFDI 4.0) y el XSLT oficial
  Pagos20.xslt publicado por el SAT (mismo mecanismo que
  cadenaoriginal_cfdi40_cp31.xslt para Carta Porte: los templates base son
  IDÉNTICOS, solo cambia qué complemento se agrega al final -- el ciclo
  cfdi:Complemento/* ya despacha genéricamente por namespace).

  Convención de plantillas auxiliares:
    Requerido : siempre emite "valor|" (campo obligatorio)
    Opcional  : emite "valor|" sólo si el valor no está vacío

  El template raíz abre con "||" y cierra con "|" extra, de modo que
  el resultado final tiene la forma   ||campo1|campo2|...|campoN||
-->
<xsl:stylesheet version="2.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:fn="http://www.w3.org/2005/xpath-functions"
  xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
  xmlns:pago20="http://www.sat.gob.mx/Pagos20">

  <xsl:output method="text" encoding="UTF-8"/>

  <!-- ═══════════════════════════════════════════════════════════════════
       PLANTILLAS AUXILIARES
  ════════════════════════════════════════════════════════════════════ -->

  <xsl:template name="Requerido">
    <xsl:param name="valor"/>
    <xsl:value-of select="normalize-space($valor)"/>
    <xsl:text>|</xsl:text>
  </xsl:template>

  <xsl:template name="Opcional">
    <xsl:param name="valor"/>
    <xsl:if test="string-length(normalize-space($valor)) &gt; 0">
      <xsl:value-of select="normalize-space($valor)"/>
      <xsl:text>|</xsl:text>
    </xsl:if>
  </xsl:template>

  <!-- ═══════════════════════════════════════════════════════════════════
       RAÍZ
  ════════════════════════════════════════════════════════════════════ -->

  <xsl:template match="/">
    <xsl:apply-templates select="//cfdi:Comprobante"/>
  </xsl:template>

  <!-- ═══════════════════════════════════════════════════════════════════
       cfdi:Comprobante
  ════════════════════════════════════════════════════════════════════ -->

  <xsl:template match="cfdi:Comprobante">
    <xsl:text>||</xsl:text>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Version"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Serie"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Folio"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Fecha"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@FormaPago"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@NoCertificado"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@CondicionesDePago"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@SubTotal"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Descuento"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Moneda"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@TipoCambio"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Total"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@TipoDeComprobante"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Exportacion"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@MetodoPago"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@LugarExpedicion"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Confirmacion"/></xsl:call-template>
    <!-- InformacionGlobal -->
    <xsl:for-each select="./cfdi:InformacionGlobal">
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Periodicidad"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Meses"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Anio"/></xsl:call-template>
    </xsl:for-each>
    <!-- CfdiRelacionados -->
    <xsl:for-each select="./cfdi:CfdiRelacionados">
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@TipoRelacion"/></xsl:call-template>
      <xsl:for-each select="./cfdi:CfdiRelacionado">
        <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@UUID"/></xsl:call-template>
      </xsl:for-each>
    </xsl:for-each>
    <!-- Nodos hijo -->
    <xsl:apply-templates select="./cfdi:Emisor"/>
    <xsl:apply-templates select="./cfdi:Receptor"/>
    <xsl:for-each select="./cfdi:Conceptos/cfdi:Concepto">
      <xsl:apply-templates select="."/>
    </xsl:for-each>
    <xsl:for-each select="./cfdi:Impuestos">
      <xsl:apply-templates select="."/>
    </xsl:for-each>
    <xsl:for-each select="./cfdi:Complemento/*">
      <xsl:apply-templates select="."/>
    </xsl:for-each>
    <xsl:text>|</xsl:text>
  </xsl:template>

  <!-- ═══════════════════════════════════════════════════════════════════
       cfdi:Emisor
  ════════════════════════════════════════════════════════════════════ -->

  <xsl:template match="cfdi:Emisor">
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Rfc"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Nombre"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@RegimenFiscal"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@FacAtrAdquirente"/></xsl:call-template>
  </xsl:template>

  <!-- ═══════════════════════════════════════════════════════════════════
       cfdi:Receptor
  ════════════════════════════════════════════════════════════════════ -->

  <xsl:template match="cfdi:Receptor">
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Rfc"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Nombre"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@DomicilioFiscalReceptor"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@ResidenciaFiscal"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumRegIdTrib"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@RegimenFiscalReceptor"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@UsoCFDI"/></xsl:call-template>
  </xsl:template>

  <!-- ═══════════════════════════════════════════════════════════════════
       cfdi:Concepto
  ════════════════════════════════════════════════════════════════════ -->

  <xsl:template match="cfdi:Concepto">
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@ClaveProdServ"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NoIdentificacion"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Cantidad"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@ClaveUnidad"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Unidad"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Descripcion"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@ValorUnitario"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Importe"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Descuento"/></xsl:call-template>
    <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@ObjetoImp"/></xsl:call-template>
    <!-- Impuestos del concepto -->
    <xsl:for-each select="./cfdi:Impuestos/cfdi:Traslados/cfdi:Traslado">
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Base"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Impuesto"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@TipoFactor"/></xsl:call-template>
      <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@TasaOCuota"/></xsl:call-template>
      <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Importe"/></xsl:call-template>
    </xsl:for-each>
    <xsl:for-each select="./cfdi:Impuestos/cfdi:Retenciones/cfdi:Retencion">
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Base"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Impuesto"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@TipoFactor"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@TasaOCuota"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Importe"/></xsl:call-template>
    </xsl:for-each>
  </xsl:template>

  <!-- ═══════════════════════════════════════════════════════════════════
       cfdi:Impuestos (nivel comprobante)
       Orden ya verificado byte-por-byte contra el XSLT oficial del SAT en
       cadenaoriginal_cfdi40_cp31.xslt -- copiado tal cual, sin cambios.
  ════════════════════════════════════════════════════════════════════ -->

  <xsl:template match="cfdi:Impuestos">
    <xsl:for-each select="./cfdi:Retenciones/cfdi:Retencion">
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Impuesto"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Importe"/></xsl:call-template>
    </xsl:for-each>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@TotalImpuestosRetenidos"/></xsl:call-template>
    <xsl:for-each select="./cfdi:Traslados/cfdi:Traslado">
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Base"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Impuesto"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@TipoFactor"/></xsl:call-template>
      <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@TasaOCuota"/></xsl:call-template>
      <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Importe"/></xsl:call-template>
    </xsl:for-each>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@TotalImpuestosTrasladados"/></xsl:call-template>
  </xsl:template>

  <!-- ═══════════════════════════════════════════════════════════════════
       COMPLEMENTO PAGOS 2.0
       Templates copiados TAL CUAL del XSLT oficial SAT Pagos20.xslt
       (obtenido de phpcfdi/resources-sat-xml, espejo público del árbol
       oficial www.sat.gob.mx/sitio_internet/cfd/Pagos/Pagos20.xslt -- ya
       usa las mismas plantillas auxiliares Requerido/Opcional que este
       archivo, cero adaptación necesaria).
  ════════════════════════════════════════════════════════════════════ -->

  <xsl:template match="pago20:Pagos">
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@Version" />
    </xsl:call-template>
    <xsl:for-each select="./pago20:Totales">
      <xsl:apply-templates select="."/>
    </xsl:for-each>
    <xsl:for-each select="./pago20:Pago">
      <xsl:apply-templates select="."/>
    </xsl:for-each>
  </xsl:template>

  <xsl:template match="pago20:Totales">
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TotalRetencionesIVA" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TotalRetencionesISR" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TotalRetencionesIEPS" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TotalTrasladosBaseIVA16" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TotalTrasladosImpuestoIVA16" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TotalTrasladosBaseIVA8" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TotalTrasladosImpuestoIVA8" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TotalTrasladosBaseIVA0" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TotalTrasladosImpuestoIVA0" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TotalTrasladosBaseIVAExento" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@MontoTotalPagos" />
    </xsl:call-template>
  </xsl:template>

  <xsl:template match="pago20:Pago">
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@FechaPago" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@FormaDePagoP" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@MonedaP" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TipoCambioP" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@Monto" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@NumOperacion" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@RfcEmisorCtaOrd" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@NomBancoOrdExt" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@CtaOrdenante" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@RfcEmisorCtaBen" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@CtaBeneficiario" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TipoCadPago" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@CertPago" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@CadPago" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@SelloPago" />
    </xsl:call-template>
    <xsl:for-each select="./pago20:DoctoRelacionado">
      <xsl:apply-templates select="."/>
    </xsl:for-each>
    <xsl:for-each select="./pago20:ImpuestosP">
      <xsl:apply-templates select="."/>
    </xsl:for-each>
  </xsl:template>

  <xsl:template match="pago20:DoctoRelacionado">
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@IdDocumento" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@Serie" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@Folio" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@MonedaDR" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@EquivalenciaDR" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@NumParcialidad" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@ImpSaldoAnt" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@ImpPagado" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@ImpSaldoInsoluto" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@ObjetoImpDR" />
    </xsl:call-template>
    <xsl:for-each select="./pago20:ImpuestosDR/pago20:RetencionesDR/pago20:RetencionDR">
      <xsl:call-template name="Requerido">
        <xsl:with-param name="valor" select="./@BaseDR"/>
      </xsl:call-template>
      <xsl:call-template name="Requerido">
        <xsl:with-param name="valor" select="./@ImpuestoDR" />
      </xsl:call-template>
      <xsl:call-template name="Requerido">
        <xsl:with-param name="valor" select="./@TipoFactorDR" />
      </xsl:call-template>
      <xsl:call-template name="Requerido">
        <xsl:with-param name="valor" select="./@TasaOCuotaDR" />
      </xsl:call-template>
      <xsl:call-template name="Requerido">
        <xsl:with-param name="valor" select="./@ImporteDR" />
      </xsl:call-template>
    </xsl:for-each>
    <xsl:for-each select="./pago20:ImpuestosDR/pago20:TrasladosDR/pago20:TrasladoDR">
      <xsl:call-template name="Requerido">
        <xsl:with-param name="valor" select="./@BaseDR"/>
      </xsl:call-template>
      <xsl:call-template name="Requerido">
        <xsl:with-param name="valor" select="./@ImpuestoDR" />
      </xsl:call-template>
      <xsl:call-template name="Requerido">
        <xsl:with-param name="valor" select="./@TipoFactorDR" />
      </xsl:call-template>
      <xsl:call-template name="Opcional">
        <xsl:with-param name="valor" select="./@TasaOCuotaDR" />
      </xsl:call-template>
      <xsl:call-template name="Opcional">
        <xsl:with-param name="valor" select="./@ImporteDR" />
      </xsl:call-template>
    </xsl:for-each>
  </xsl:template>

  <xsl:template match="pago20:ImpuestosP">
    <xsl:apply-templates select="./pago20:RetencionesP"/>
    <xsl:apply-templates select="./pago20:TrasladosP"/>
  </xsl:template>

  <xsl:template match="pago20:RetencionesP">
    <xsl:for-each select="./pago20:RetencionP">
      <xsl:apply-templates select="."/>
    </xsl:for-each>
  </xsl:template>

  <xsl:template match="pago20:TrasladosP">
    <xsl:for-each select="./pago20:TrasladoP">
      <xsl:apply-templates select="."/>
    </xsl:for-each>
  </xsl:template>

  <xsl:template match="pago20:RetencionP">
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@ImpuestoP" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@ImporteP" />
    </xsl:call-template>
  </xsl:template>

  <xsl:template match="pago20:TrasladoP">
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@BaseP" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@ImpuestoP" />
    </xsl:call-template>
    <xsl:call-template name="Requerido">
      <xsl:with-param name="valor" select="./@TipoFactorP" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@TasaOCuotaP" />
    </xsl:call-template>
    <xsl:call-template name="Opcional">
      <xsl:with-param name="valor" select="./@ImporteP" />
    </xsl:call-template>
  </xsl:template>

</xsl:stylesheet>
