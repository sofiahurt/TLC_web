<?xml version="1.0" encoding="UTF-8"?>
<!--
  Cadena original CFDI 4.0 + Complemento CartaPorte 3.1 — XSLT combinado
  Basado en la especificación oficial SAT (Anexo 20 CFDI 4.0) y el XSLT oficial
  CartaPorte31.xslt publicado por el SAT.

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
  xmlns:cartaporte31="http://www.sat.gob.mx/CartaPorte31">

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
  ════════════════════════════════════════════════════════════════════ -->

  <xsl:template match="cfdi:Impuestos">
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@TotalImpuestosRetenidos"/></xsl:call-template>
    <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@TotalImpuestosTrasladados"/></xsl:call-template>
    <xsl:for-each select="./cfdi:Retenciones/cfdi:Retencion">
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Impuesto"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Importe"/></xsl:call-template>
    </xsl:for-each>
    <xsl:for-each select="./cfdi:Traslados/cfdi:Traslado">
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Impuesto"/></xsl:call-template>
      <xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@TipoFactor"/></xsl:call-template>
      <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@TasaOCuota"/></xsl:call-template>
      <xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Importe"/></xsl:call-template>
    </xsl:for-each>
  </xsl:template>

  <!-- ═══════════════════════════════════════════════════════════════════
       COMPLEMENTO CARTAPORTE 3.1
       Templates copiados del XSLT oficial SAT CartaPorte31.xslt
  ════════════════════════════════════════════════════════════════════ -->

	<xsl:template match="cartaporte31:CartaPorte">
		<!--Manejador de nodos tipo CartaPorte-->
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Version"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@IdCCP"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@TranspInternac"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@EntradaSalidaMerc"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@PaisOrigenDestino"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@ViaEntradaSalida"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@TotalDistRec"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@RegistroISTMO"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@UbicacionPoloOrigen"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@UbicacionPoloDestino"/></xsl:call-template>
		<xsl:for-each select="./cartaporte31:RegimenesAduaneros"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:Ubicaciones"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:Mercancias"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:FiguraTransporte"><xsl:apply-templates select="."/></xsl:for-each>
	</xsl:template>
	<xsl:template match="cartaporte31:RegimenesAduaneros">
		<xsl:for-each select="./cartaporte31:RegimenAduaneroCCP"><xsl:apply-templates select="."/></xsl:for-each>
	</xsl:template>
	<xsl:template match="cartaporte31:RegimenAduaneroCCP">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@RegimenAduanero"/></xsl:call-template>
	</xsl:template>
	<xsl:template match="cartaporte31:Ubicaciones">
		<xsl:for-each select="./cartaporte31:Ubicacion"><xsl:apply-templates select="."/></xsl:for-each>
	</xsl:template>
	<xsl:template match="cartaporte31:Ubicacion">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@TipoUbicacion"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@IDUbicacion"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@RFCRemitenteDestinatario"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NombreRemitenteDestinatario"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumRegIdTrib"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@ResidenciaFiscal"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumEstacion"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NombreEstacion"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NavegacionTrafico"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@FechaHoraSalidaLlegada"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@TipoEstacion"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@DistanciaRecorrida"/></xsl:call-template>
		<xsl:for-each select="./cartaporte31:Domicilio">
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Calle"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumeroExterior"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumeroInterior"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Colonia"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Localidad"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Referencia"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Municipio"/></xsl:call-template>
			<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Estado"/></xsl:call-template>
			<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Pais"/></xsl:call-template>
			<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@CodigoPostal"/></xsl:call-template>
		</xsl:for-each>
	</xsl:template>
	<xsl:template match="cartaporte31:Mercancias">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@PesoBrutoTotal"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@UnidadPeso"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@PesoNetoTotal"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@NumTotalMercancias"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@CargoPorTasacion"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@LogisticaInversaRecoleccionDevolucion"/></xsl:call-template>
		<xsl:for-each select="./cartaporte31:Mercancia"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:Autotransporte"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:TransporteMaritimo"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:TransporteAereo"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:TransporteFerroviario"><xsl:apply-templates select="."/></xsl:for-each>
	</xsl:template>
	<xsl:template match="cartaporte31:Mercancia">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@BienesTransp"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@ClaveSTCC"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Descripcion"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Cantidad"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@ClaveUnidad"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Unidad"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Dimensiones"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@MaterialPeligroso"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@CveMaterialPeligroso"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Embalaje"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@DescripEmbalaje"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@SectorCOFEPRIS"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NombreIngredienteActivo"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NomQuimico"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@DenominacionGenericaProd"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@DenominacionDistintivaProd"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Fabricante"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@FechaCaducidad"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@LoteMedicamento"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@FormaFarmaceutica"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@CondicionesEspTransp"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@RegistroSanitarioFolioAutorizacion"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@PermisoImportacion"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@FolioImpoVUCEM"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumCAS"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@RazonSocialEmpImp"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumRegSanPlagCOFEPRIS"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@DatosFabricante"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@DatosFormulador"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@DatosMaquilador"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@UsoAutorizado"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@PesoEnKg"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@ValorMercancia"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Moneda"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@FraccionArancelaria"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@UUIDComercioExt"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@TipoMateria"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@DescripcionMateria"/></xsl:call-template>
		<xsl:for-each select="./cartaporte31:DocumentacionAduanera"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:GuiasIdentificacion"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:CantidadTransporta"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:DetalleMercancia"><xsl:apply-templates select="."/></xsl:for-each>
	</xsl:template>
	<xsl:template match="cartaporte31:DocumentacionAduanera">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@TipoDocumento"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumPedimento"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@IdentDocAduanero"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@RFCImpo"/></xsl:call-template>
	</xsl:template>
	<xsl:template match="cartaporte31:GuiasIdentificacion">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@NumeroGuiaIdentificacion"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@DescripGuiaIdentificacion"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@PesoGuiaIdentificacion"/></xsl:call-template>
	</xsl:template>
	<xsl:template match="cartaporte31:CantidadTransporta">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Cantidad"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@IDOrigen"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@IDDestino"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@CvesTransporte"/></xsl:call-template>
	</xsl:template>
	<xsl:template match="cartaporte31:DetalleMercancia">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@UnidadPesoMerc"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@PesoBruto"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@PesoNeto"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@PesoTara"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumPiezas"/></xsl:call-template>
	</xsl:template>
	<xsl:template match="cartaporte31:Autotransporte">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@PermSCT"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@NumPermisoSCT"/></xsl:call-template>
		<xsl:for-each select="./cartaporte31:IdentificacionVehicular"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:Seguros"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:Remolques"><xsl:apply-templates select="."/></xsl:for-each>
	</xsl:template>
	<xsl:template match="cartaporte31:IdentificacionVehicular">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@ConfigVehicular"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@PesoBrutoVehicular"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@PlacaVM"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@AnioModeloVM"/></xsl:call-template>
	</xsl:template>
	<xsl:template match="cartaporte31:Seguros">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@AseguraRespCivil"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@PolizaRespCivil"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@AseguraMedAmbiente"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@PolizaMedAmbiente"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@AseguraCarga"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@PolizaCarga"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@PrimaSeguro"/></xsl:call-template>
	</xsl:template>
	<xsl:template match="cartaporte31:Remolques">
		<xsl:for-each select="./cartaporte31:Remolque"><xsl:apply-templates select="."/></xsl:for-each>
	</xsl:template>
	<xsl:template match="cartaporte31:Remolque">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@SubTipoRem"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Placa"/></xsl:call-template>
	</xsl:template>
	<xsl:template match="cartaporte31:FiguraTransporte">
		<xsl:for-each select="./cartaporte31:TiposFigura"><xsl:apply-templates select="."/></xsl:for-each>
	</xsl:template>
	<xsl:template match="cartaporte31:TiposFigura">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@TipoFigura"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@RFCFigura"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumLicencia"/></xsl:call-template>
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@NombreFigura"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumRegIdTribFigura"/></xsl:call-template>
		<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@ResidenciaFiscalFigura"/></xsl:call-template>
		<xsl:for-each select="./cartaporte31:PartesTransporte"><xsl:apply-templates select="."/></xsl:for-each>
		<xsl:for-each select="./cartaporte31:Domicilio">
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Calle"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumeroExterior"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@NumeroInterior"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Colonia"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Localidad"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Referencia"/></xsl:call-template>
			<xsl:call-template name="Opcional"><xsl:with-param name="valor" select="./@Municipio"/></xsl:call-template>
			<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Estado"/></xsl:call-template>
			<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@Pais"/></xsl:call-template>
			<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@CodigoPostal"/></xsl:call-template>
		</xsl:for-each>
	</xsl:template>
	<xsl:template match="cartaporte31:PartesTransporte">
		<xsl:call-template name="Requerido"><xsl:with-param name="valor" select="./@ParteTransporte"/></xsl:call-template>
	</xsl:template>

</xsl:stylesheet>
