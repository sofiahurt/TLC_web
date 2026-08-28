'use strict';

const { create } = require('xmlbuilder2');
const { sql }    = require('../config/db');
const { getSatDb } = require('../config/sat-db');
const { serieFiscal } = require('../config/empresa-serie');
const crypto     = require('crypto');

// ── helpers ─────────────────────────────────────────────────────────────────

function generarIdCCP() {
  const dict = 'abcdef1234567890ABCDEF';
  const seg  = (n) => Array.from({ length: n }, () => dict[crypto.randomInt(0, dict.length)]).join('');
  return `CCC${seg(5)}-${seg(4)}-${seg(4)}-${seg(4)}-${seg(12)}`;
}

function isoFecha(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().replace(/\.\d{3}Z$/, '');
}

function fmtDec(v, dec = 2) {
  const n = parseFloat(v) || 0;
  return n.toFixed(dec);
}

function normPais(p) {
  if (!p) return 'MEX';
  const up = String(p).trim().toUpperCase();
  if (up === 'MEX' || up === 'MX') return 'MEX';
  if (up.includes('MEX') || up.includes('MEXIC')) return 'MEX';
  return up.slice(0, 3);
}

function fmt(v) { return v ? String(v).trim() : ''; }

// Catálogo SAT c_ClaveProdServCP: columna "Materia Peligroso" = "0" (nunca
// peligroso), "1" (siempre peligroso) o "0,1" (a criterio del contribuyente).
// El catálogo manda cuando es "0" o "1"; con "0,1" o clave no catalogada se
// respeta lo que el usuario capturó en PedMercancias.
function flagMaterialPeligrosoCatalogo(bienesTransp) {
  const clave = fmt(bienesTransp);
  if (!clave) return null;
  const db = getSatDb();
  const row = db.prepare('SELECT "Materia Peligroso" AS flag FROM sat_c_ClaveProdServCP WHERE c_ClaveProdServ = ?').get(clave);
  return row ? fmt(row.flag) : null;
}

function domAttrs(dom) {
  if (!dom) return {};
  const attrs = {};
  if (fmt(dom.CALLE))   attrs.Calle   = fmt(dom.CALLE);
  if (fmt(dom.NOEXT))   attrs.NumeroExterior = fmt(dom.NOEXT);
  if (fmt(dom.NOINT))   attrs.NumeroInterior = fmt(dom.NOINT);
  // Colonia, Localidad y Municipio no se declaran (todos opcionales en el XSD)
  if (fmt(dom.ESTADO))  attrs.Estado   = fmt(dom.ESTADO);
  if (fmt(dom.CP))      attrs.CodigoPostal = fmt(dom.CP);
  attrs.Pais = normPais(dom.PAIS || 'MEX');
  return attrs;
}

// ── main builder ─────────────────────────────────────────────────────────────

async function buildCFDITraslado(serie, cartaporte, pool) {

  // 1. CartaPorte record
  const cpRes = await pool.request()
    .input('serie',      sql.VarChar(10),  serie)
    .input('cartaporte', sql.VarChar(30),  cartaporte)
    .query(`SELECT * FROM Empresa2.CartaPorte
            WHERE LTRIM(RTRIM(Serie)) = @serie
              AND LTRIM(RTRIM(CartaPorte)) = @cartaporte`);
  if (!cpRes.recordset.length) throw new Error(`CartaPorte ${cartaporte} no encontrado`);
  const cp = cpRes.recordset[0];

  // 2. Empresa (emisor/receptor) — varios centrales comparten la misma razón
  // social/CSD (ver config/empresa-serie.js), por eso se resuelve la serie
  // fiscal antes de consultar dbo.Empresas.
  const empRes = await pool.request()
    .input('serie', sql.VarChar(10), serieFiscal(serie))
    .query(`SELECT * FROM dbo.Empresas WHERE LTRIM(RTRIM(SERIE)) = @serie`);
  if (!empRes.recordset.length) throw new Error(`Empresa para serie ${serie} no encontrada`);
  const emp = empRes.recordset[0];

  // 3. Cliente principal (receptor físico)
  const cliRes = await pool.request()
    .input('id', sql.Decimal(18,0), cp.Id_Cliente)
    .query(`SELECT * FROM Empresa2.Clientes WHERE Id_Cliente = @id`);
  const cli = cliRes.recordset[0] || null;

  // 4. Cliente carga (origen) – si difiere
  let cliCarga = null;
  if (cp.Id_ClienteCarga && parseInt(cp.Id_ClienteCarga) !== parseInt(cp.Id_Cliente)) {
    const ccRes = await pool.request()
      .input('id', sql.Decimal(18,0), cp.Id_ClienteCarga)
      .query(`SELECT * FROM Empresa2.Clientes WHERE Id_Cliente = @id`);
    cliCarga = ccRes.recordset[0] || null;
  }

  // 5. Domicilios
  const domCargaRes = await pool.request()
    .input('idCliente',   sql.Decimal(18,0), cp.Id_ClienteCarga || cp.Id_Cliente)
    .input('idDomicilio', sql.Decimal(18,0), cp.Id_DomCarga)
    .query(`SELECT * FROM Empresa2.DomCarDes
            WHERE ID_CLIENTE = @idCliente AND ID_DOMICILIO = @idDomicilio`);
  const domCarga = domCargaRes.recordset[0] || null;

  const domDescRes = await pool.request()
    .input('idCliente',   sql.Decimal(18,0), cp.Id_Cliente)
    .input('idDomicilio', sql.Decimal(18,0), cp.Id_DomDescarga1)
    .query(`SELECT * FROM Empresa2.DomCarDes
            WHERE ID_CLIENTE = @idCliente AND ID_DOMICILIO = @idDomicilio`);
  const domDesc = domDescRes.recordset[0] || null;

  // 6. Camión (Id_Camion en CartaPorte es varchar; ID_CAMION en Camiones es char)
  const camRes = await pool.request()
    .input('id', sql.VarChar(10), fmt(cp.Id_Camion))
    .query(`SELECT * FROM Empresa2.Camiones WHERE LTRIM(RTRIM(ID_CAMION)) = LTRIM(RTRIM(@id))`);
  const cam = camRes.recordset[0] || null;

  // 6b. Remolques (NoCaja/NoCaja2 en CartaPorte apuntan a Camiones con TIPO='Remolque';
  // ahí es donde viven SubTipoRem (columna C_SUBTIPO, no SUBTIPOREM) y la Placa
  // del remolque, no en el tracto/Id_Camion)
  async function buscarRemolque(idCaja) {
    if (!fmt(idCaja)) return null;
    const r = await pool.request()
      .input('id', sql.VarChar(10), fmt(idCaja))
      .query(`SELECT PLACA, C_SUBTIPO FROM Empresa2.Camiones WHERE LTRIM(RTRIM(ID_CAMION)) = LTRIM(RTRIM(@id))`);
    const row = r.recordset[0];
    return (row && fmt(row.C_SUBTIPO) && fmt(row.PLACA)) ? row : null;
  }
  const remolques = (await Promise.all([buscarRemolque(cp.NoCaja), buscarRemolque(cp.NoCaja2)])).filter(Boolean);

  // 7. Operador
  const opRes = await pool.request()
    .input('id', sql.Int, cp.Id_Operador)
    .query(`SELECT * FROM Empresa2.Operadores WHERE Id_Operador = @id`);
  const op = opRes.recordset[0] || null;

  // 8. Mercancias
  const mercRes = await pool.request()
    .input('serie',      sql.VarChar(10), serie)
    .input('cartaporte', sql.VarChar(30), cartaporte)
    .query(`SELECT * FROM Empresa2.PedMercancias
            WHERE LTRIM(RTRIM(Serie)) = @serie
              AND LTRIM(RTRIM(CartaPorte)) = @cartaporte`);
  const mercs = mercRes.recordset;

  // ── build XML ───────────────────────────────────────────────────────────────

  const fechaEmision = isoFecha(cp.FechaPedido || new Date());
  const idCCP        = generarIdCCP();

  // Emisor y Receptor son la misma empresa (autotraslado)
  const emisorRFC    = fmt(emp.RFC);
  // El SAT valida que Nombre coincida con el registrado para ese RFC — EMPRESA
  // trae la razón social completa (con "S.A. DE C.V.") pero lo que el SAT tiene
  // registrado es NOMBRECORTO.
  const emisorNombre = fmt(emp.NOMBRECORTO);
  const emisorRegFis = fmt(emp.C_REGIMENFISCAL);
  const lugarExp     = fmt(emp.LUGAREXPEDICION) || fmt(emp.CP);

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('cfdi:Comprobante', {
      'xmlns:cfdi':  'http://www.sat.gob.mx/cfd/4',
      'xmlns:cartaporte31': 'http://www.sat.gob.mx/CartaPorte31',
      'xmlns:xsi':   'http://www.w3.org/2001/XMLSchema-instance',
      'xsi:schemaLocation': [
        'http://www.sat.gob.mx/cfd/4',
        'http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd',
        'http://www.sat.gob.mx/CartaPorte31',
        'http://www.sat.gob.mx/sitio_internet/cfd/CartaPorte/CartaPorte31.xsd'
      ].join(' '),
      'Version':          '4.0',
      'Serie':            'CP',
      'Folio':            fmt(cp.CartaPorte),
      'Fecha':            fechaEmision,
      'NoCertificado':    '',
      'Certificado':      '',
      'Sello':            '',
      'SubTotal':         '0',
      'Moneda':           'XXX',
      'Total':            '0',
      'TipoDeComprobante': 'T',
      'Exportacion':      '01',
      'LugarExpedicion':  lugarExp,
    });

  // cfdi:Emisor
  doc.ele('cfdi:Emisor', {
    Rfc:              emisorRFC,
    Nombre:           emisorNombre,
    RegimenFiscal:    emisorRegFis,
  }).up();

  // cfdi:Receptor (autotraslado = misma empresa)
  doc.ele('cfdi:Receptor', {
    Rfc:                     emisorRFC,
    Nombre:                  emisorNombre,
    DomicilioFiscalReceptor: lugarExp,
    RegimenFiscalReceptor:   emisorRegFis,
    UsoCFDI:                 'S01',
  }).up();

  // cfdi:Conceptos → 1 concepto fijo
  const conceptos = doc.ele('cfdi:Conceptos');
  conceptos.ele('cfdi:Concepto', {
    ClaveProdServ: '01010101',
    Cantidad:      '1',
    ClaveUnidad:   'ACT',
    Descripcion:   'TRASLADO',
    ValorUnitario: '0',
    Importe:       '0',
    ObjetoImp:     '01',
  }).up();

  // cfdi:Complemento
  const complemento = doc.ele('cfdi:Complemento');

  // cartaporte31:CartaPorte
  // PesoBrutoTotal/UnidadPeso/NumTotalMercancias NO son atributos de este nodo
  // raíz según el XSD de Carta Porte 3.1 — solo existen en cartaporte31:Mercancias
  // (ver más abajo). Ponerlos aquí causa "attribute is not declared" en el PAC.
  const cpNode = complemento.ele('cartaporte31:CartaPorte', {
    'Version':            '3.1',
    'IdCCP':              idCCP,
    'TranspInternac':     'No',
    'TotalDistRec':       fmtDec(cp.KilometrosTar, 2),
  });

  // ── Ubicaciones ─────────────────────────────────────────────────────────────

  const ubicaciones = cpNode.ele('cartaporte31:Ubicaciones');

  // Origen
  const origenOp = cliCarga || cli;
  const origenAttrs = {
    TipoUbicacion:      'Origen',
    IDUbicacion:        'OR000001',
    RFCRemitenteDestinatario: origenOp ? fmt(origenOp.RFC) : emisorRFC,
    NombreRemitenteDestinatario: origenOp ? fmt(origenOp.NOMBRECOMUN) : emisorNombre,
    FechaHoraSalidaLlegada: isoFecha(cp.FehcaCarga),
  };
  if (origenOp && parseInt(origenOp.FLAGEXTRANJERO)) {
    origenAttrs.NumRegIdTrib = fmt(origenOp.CLAVEIDFISCAL);
    origenAttrs.ResidenciaFiscal = normPais(domCarga ? domCarga.PAIS : null);
  }
  const origenNode = ubicaciones.ele('cartaporte31:Ubicacion', origenAttrs);
  if (domCarga) {
    origenNode.ele('cartaporte31:Domicilio', domAttrs(domCarga)).up();
  }

  // Destino
  const destinoAttrs = {
    TipoUbicacion:      'Destino',
    IDUbicacion:        'DE000001',
    RFCRemitenteDestinatario: cli ? fmt(cli.RFC) : emisorRFC,
    NombreRemitenteDestinatario: cli ? fmt(cli.NOMBRECOMUN) : emisorNombre,
    FechaHoraSalidaLlegada: isoFecha(cp.FechaDesCarta),
    DistanciaRecorrida:  fmtDec(cp.KilometrosTar, 2),
  };
  if (cli && parseInt(cli.FLAGEXTRANJERO)) {
    destinoAttrs.NumRegIdTrib = fmt(cli.CLAVEIDFISCAL);
    destinoAttrs.ResidenciaFiscal = normPais(domDesc ? domDesc.PAIS : null);
  }
  const destinoNode = ubicaciones.ele('cartaporte31:Ubicacion', destinoAttrs);
  if (domDesc) {
    destinoNode.ele('cartaporte31:Domicilio', domAttrs(domDesc)).up();
  }

  // ── Mercancias ───────────────────────────────────────────────────────────────

  const mercsNode = cpNode.ele('cartaporte31:Mercancias', {
    PesoBrutoTotal:     fmtDec(cp.PesoBrutoTotal, 3),
    UnidadPeso:         fmt(cp.UnidadPeso) || 'KGM',
    NumTotalMercancias: String(parseInt(cp.TotalMercancias) || mercs.length),
  });

  mercs.forEach((m, i) => {
    const desc = fmt(m.DesManual) || fmt(m.Descripcion) || 'MERCANCIA';

    // Réplica de la regla del sistema legado (Clarion): el atributo
    // MaterialPeligroso NO siempre se declara.
    //   - Si se capturó "Si" -> se declara "Sí" SIEMPRE, con sus subatributos.
    //   - Si se capturó "No" -> solo se declara "No" cuando el catálogo
    //     c_ClaveProdServCP dice "0,1" (a criterio del contribuyente).
    //   - En cualquier otro caso (catálogo "0" o "1" con "No", o clave no
    //     catalogada con "No") el atributo se OMITE por completo.
    const capturado = fmt(m.MaterialPeligroso);
    const flagCatalogo = flagMaterialPeligrosoCatalogo(m.BienesTransp);
    let matPel = null;
    if (capturado === 'Si') matPel = 'Sí';
    else if (flagCatalogo === '0,1' && capturado === 'No') matPel = 'No';

    const mercAttrs = {
      BienesTransp:       fmt(m.BienesTransp),
      Descripcion:        desc,
      Cantidad:           fmtDec(m.Cantidad, 4),
      ClaveUnidad:        fmt(m.ClaveUnidad),
      Unidad:             fmt(m.Unidad),
    };
    if (matPel) {
      mercAttrs.MaterialPeligroso = matPel;
      if (matPel === 'Sí') {
        if (fmt(m.CveMaterialPeligroso)) mercAttrs.CveMaterialPeligroso = fmt(m.CveMaterialPeligroso);
        if (fmt(m.cve_Embalaje))        mercAttrs.Embalaje              = fmt(m.cve_Embalaje);
        if (fmt(m.DescripEmbalaje))     mercAttrs.DescripEmbalaje       = fmt(m.DescripEmbalaje);
      }
    }
    mercAttrs.PesoEnKg       = fmtDec(m.PesoEnKg, 3);
    mercAttrs.ValorMercancia = fmtDec(m.ValorMercancia, 2);
    mercAttrs.Moneda         = fmt(m.Moneda) || 'MXN';
    // PesoUnidad NO es un atributo válido de cartaporte31:Mercancia (no existe
    // en el XSD) — es solo un dato interno para calcular PesoEnKg = Cantidad×PesoUnidad.

    mercsNode.ele('cartaporte31:Mercancia', mercAttrs).up();
  });

  // AutoTransporte
  const autoTrans = mercsNode.ele('cartaporte31:Autotransporte', {
    PermSCT:       fmt(cam ? cam.PERMSCT : emp.PERMSCT) || 'TPAF01',
    NumPermisoSCT: fmt(cam ? cam.NUMPERMISOSCT : emp.NUMPERMISOSCT),
  });

  autoTrans.ele('cartaporte31:IdentificacionVehicular', {
    ConfigVehicular:    fmt(cam ? cam.CONFIGVEHICULAR : ''),
    PesoBrutoVehicular: fmtDec(cam ? cam.PESOBRUTOVEHICULAR : 0, 3),
    PlacaVM:            fmt(cam ? cam.PLACA : ''),
    AnioModeloVM:       String(parseInt(cam ? cam.ANIOMODELO : 0) || ''),
  }).up();

  autoTrans.ele('cartaporte31:Seguros', {
    AseguraRespCivil: fmt(cam ? cam.NOMASEG  : emp.NOMASEG),
    PolizaRespCivil:  fmt(cam ? cam.NUMPOLIZA : emp.NUMPOLIZA),
  }).up();

  if (remolques.length) {
    const remolquesNode = autoTrans.ele('cartaporte31:Remolques');
    remolques.forEach(r => {
      remolquesNode.ele('cartaporte31:Remolque', {
        SubTipoRem: fmt(r.C_SUBTIPO),
        Placa:      fmt(r.PLACA),
      }).up();
    });
    remolquesNode.up();
  }

  // TiposFigura – Operador
  if (op) {
    const figuras = cpNode.ele('cartaporte31:FiguraTransporte');
    figuras.ele('cartaporte31:TiposFigura', {
      TipoFigura:   '01',
      RFCFigura:    fmt(op.RFC),
      NumLicencia:  fmt(op.NOLICENCIA),
      NombreFigura: fmt(op.OPERADOR),
    }).up();
  }

  return { xml: doc.end({ prettyPrint: true }), idCCP };
}

module.exports = { buildCFDITraslado, generarIdCCP };
