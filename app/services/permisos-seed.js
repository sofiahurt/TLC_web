// Asegura que existan en dbo.SegPermisos los permisos que el código usa, para que
// al desplegar en otra base (VPS) aparezcan solos en Seguridad sin SQL manual.
// Solo inserta los que faltan; nunca modifica ni borra los existentes.
const { getPool, sql } = require('../config/db');

const PERMISOS = [
  { clave: 'cartaporte.btn_desbloquear', modulo: 'cartaporte', descripcion: 'Botón Desbloquear edición de CP Emitida (Carta Porte)', orden: 5 },
  { clave: 'depositos.ver',              modulo: 'depositos',  descripcion: 'Ver módulo Autorizar Depósitos y exportar a Excel',      orden: 1 },
  { clave: 'depositos.autorizar',        modulo: 'depositos',  descripcion: 'Marcar/desmarcar autorización de depósitos',             orden: 2 },
  { clave: 'pagos.btn_ajustar_saldos',    modulo: 'pagos',      descripcion: 'Botón Ajustar saldos (Pagos)',                            orden: 5 },
  { clave: 'utilerias.conciliar',        modulo: 'utilerias',  descripcion: 'Conciliar Facturas contra Cobros y Notas de Crédito (revisar y ajustar saldos)', orden: 20 },
];

async function asegurarPermisos() {
  try {
    const pool = await getPool();
    for (const p of PERMISOS) {
      await pool.request()
        .input('c', sql.VarChar(80), p.clave).input('m', sql.VarChar(40), p.modulo)
        .input('d', sql.VarChar(200), p.descripcion).input('o', sql.Int, p.orden)
        .query(`IF NOT EXISTS (SELECT 1 FROM dbo.SegPermisos WHERE Clave=@c)
                  INSERT INTO dbo.SegPermisos(Clave, Modulo, Descripcion, Orden) VALUES(@c, @m, @d, @o)`);
    }
  } catch (err) {
    console.error('Permisos: no se pudieron asegurar los permisos base:', err.message);
  }
}

module.exports = { asegurarPermisos };
