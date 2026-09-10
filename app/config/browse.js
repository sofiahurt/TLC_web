// Shared helper for paginated, sorted, filtered browse queries
const { getPool } = require('./db');

// baseWhere/baseParams (opcionales): condición fija adicional que el propio
// módulo controla (ej. filtrar por Tipo en una pestaña) — no viene del
// usuario, se combina con AND junto a la búsqueda libre. baseParams es un
// objeto plano {nombre: valor}, sin tipo SQL explícito (mssql infiere).
async function browseQuery({ table, columns, searchableCols, req, baseWhere, baseParams }) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 20;
  const q = (req.query.q || '').trim();
  const col = req.query.col || '';
  const sort = req.query.sort || '';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

  const pool = await getPool();

  const validCols = new Set(searchableCols);
  const conds = [];
  let params = {};
  if (baseWhere) conds.push(baseWhere);
  if (q && col && validCols.has(col)) {
    conds.push(`LTRIM(RTRIM(CAST(${col} AS NVARCHAR(MAX)))) LIKE @q`);
    params.q = `%${q}%`;
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const validSort = searchableCols.includes(sort) ? sort : columns[0];
  const orderBy = `ORDER BY ${validSort} ${dir}`;

  const bindExtra = r => { if (baseParams) for (const k of Object.keys(baseParams)) r.input(k, baseParams[k]); return r; };

  const countReq = bindExtra(pool.request());
  if (params.q) countReq.input('q', params.q);
  const countRes = await countReq.query(`SELECT COUNT(*) AS total FROM ${table} ${where}`);
  const total = countRes.recordset[0].total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  const dataReq = bindExtra(pool.request());
  if (params.q) dataReq.input('q', params.q);
  const dataRes = await dataReq.query(
    `SELECT ${columns.join(', ')} FROM ${table} ${where} ${orderBy}
     OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`
  );

  return { rows: dataRes.recordset, page: safePage, totalPages, total };
}

module.exports = { browseQuery };
