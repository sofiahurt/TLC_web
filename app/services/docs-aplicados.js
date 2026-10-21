// Documentos vigentes que ya aplican sobre una Factura o Nota de Débito: Cobros
// REALIZADO y Notas de Crédito EMITIDA. Sirve para decir "ya está en el documento X"
// cuando una copia omite una línea.
const { sql } = require('../config/db');

const sk = v => { const t = (v == null ? '' : String(v)).trim(); return t || null; };

async function quienAplica(tx, { esFactura, id, serie }) {
  const out = [];
  const r = () => new sql.Request(tx).input('id', sql.Decimal(9), id).input('serie', sql.VarChar(20), sk(serie));
  const cobros = await r().query(esFactura
    ? `SELECT DISTINCT pf.ID_NOPAGO AS n FROM Empresa2.PagFac pf JOIN Empresa2.Pagos p ON p.Id_NoPago=pf.ID_NOPAGO
       WHERE pf.NOFACTURA=@id AND ISNULL(LTRIM(RTRIM(pf.SERIEFAC)),'')=ISNULL(@serie,'') AND LTRIM(RTRIM(p.Status))='REALIZADO'`
    : `SELECT DISTINCT pf.ID_NOPAGO AS n FROM Empresa2.PagFac pf JOIN Empresa2.Pagos p ON p.Id_NoPago=pf.ID_NOPAGO
       WHERE pf.ID_NOTACREDITO=@id AND ISNULL(LTRIM(RTRIM(pf.SERIEND)),'')=ISNULL(@serie,'') AND LTRIM(RTRIM(p.Status))='REALIZADO'`);
  for (const x of cobros.recordset) out.push(`Cobro ${x.n}`);
  const notas = await r().query(esFactura
    ? `SELECT DISTINCT d.ID_NOTACREDITO AS n, LTRIM(RTRIM(d.SERIE)) AS s FROM Empresa2.NotaCredDeta d
       JOIN Empresa2.NotaCred c ON c.Id_NotaCredito=d.ID_NOTACREDITO AND LTRIM(RTRIM(c.Tipo))=LTRIM(RTRIM(d.TIPO)) AND ISNULL(LTRIM(RTRIM(c.Serie)),'')=ISNULL(LTRIM(RTRIM(d.SERIE)),'')
       WHERE d.ID_NOFACTURA=@id AND ISNULL(LTRIM(RTRIM(d.SerieFac)),'')=ISNULL(@serie,'') AND LTRIM(RTRIM(c.Status))='EMITIDA'`
    : `SELECT DISTINCT d.ID_NOTACREDITO AS n, LTRIM(RTRIM(d.SERIE)) AS s FROM Empresa2.NotaCredDeta d
       JOIN Empresa2.NotaCred c ON c.Id_NotaCredito=d.ID_NOTACREDITO AND LTRIM(RTRIM(c.Tipo))=LTRIM(RTRIM(d.TIPO)) AND ISNULL(LTRIM(RTRIM(c.Serie)),'')=ISNULL(LTRIM(RTRIM(d.SERIE)),'')
       WHERE d.Id_NotaDebito=@id AND ISNULL(LTRIM(RTRIM(d.SerieND)),'')=ISNULL(@serie,'') AND LTRIM(RTRIM(c.Status))='EMITIDA'`);
  for (const x of notas.recordset) out.push(`Nota de Crédito ${x.s ? x.s + '-' : ''}${x.n}`);
  return out;
}

module.exports = { quienAplica };
