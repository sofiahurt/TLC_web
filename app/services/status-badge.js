'use strict';

// Estatus de documentos en los browses como etiqueta (badge), igual que en Liquidaciones:
// cancelado en rojo, cobrado/facturado en verde, con adeudo en amarillo y el resto en gris.
// Se compara en mayúsculas; CANCELAD0 (con cero) es el typo legado de las Cartas Porte.

const CLASE = (st) => {
  if (st.startsWith('CANCELAD')) return 'bg-danger';
  if (['PAGADA', 'FACTURADO', 'REALIZADO', 'APLICADA', 'APLICADO'].includes(st)) return 'bg-success';
  if (['PAGO PARCIAL', 'VENCIDA'].includes(st)) return 'bg-warning text-dark';
  return 'bg-secondary';
};

const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function badgeStatus(status) {
  const txt = String(status == null ? '' : status).trim();
  if (!txt) return '';
  return `<span class="badge ${CLASE(txt.toUpperCase())}">${esc(txt)}</span>`;
}

module.exports = { badgeStatus };
