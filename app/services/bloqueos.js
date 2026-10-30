'use strict';

// ── Bloqueo de registros en edición ─────────────────────────────────────────
// Evita que dos usuarios editen a la vez el mismo registro (y que se guarde lo del último).
// Los bloqueos viven en memoria del servidor: cada pantalla abierta los renueva con un
// latido y los libera al cerrar; si el navegador se cierra sin avisar, caducan solos.
//
// Dueño = sesión (sessionID) + pestaña (X-Tab-Id): el mismo usuario en dos pestañas también
// se bloquea a sí mismo. Si una petición no trae pestaña, basta con que coincida la sesión.

const TTL_MS = 90 * 1000;
const bloqueos = new Map();   // clave -> { sid, tab, quien, desde, vence }

const claveCP = (serie, cp) => `CP|${String(serie || '').trim()}|${String(cp || '').trim()}`;

function dueno(req) {
  const u = req.session && req.session.usuario;
  const quien = u ? [u.nombre, u.apellido].filter(Boolean).map(s => String(s).trim()).join(' ') : '';
  const tab = String((req.get && req.get('X-Tab-Id')) || (req.body && req.body.tab) || '').slice(0, 40);
  return { sid: req.sessionID, tab, quien: quien || 'otro usuario' };
}

function vigente(clave) {
  const b = bloqueos.get(clave);
  if (b && b.vence <= Date.now()) { bloqueos.delete(clave); return null; }
  return b || null;
}
const esDe = (b, d) => b.sid === d.sid && (!d.tab || !b.tab || b.tab === d.tab);
const hora = t => new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
const mensaje = (clave, b) => {
  const [, serie, cp] = clave.split('|');
  return `La Carta Porte ${serie}-${cp} la está editando ${b.quien} (desde las ${hora(b.desde)}). Intente de nuevo cuando termine.`;
};

// Toma o renueva el bloqueo. { ok:true } o { ok:false, error }
function adquirir(clave, d) {
  const b = vigente(clave);
  if (b && !esDe(b, d)) return { ok: false, error: mensaje(clave, b), quien: b.quien };
  bloqueos.set(clave, { sid: d.sid, tab: d.tab, quien: d.quien, desde: b ? b.desde : Date.now(), vence: Date.now() + TTL_MS });
  return { ok: true };
}

// Solo renueva si sigue siendo suyo (si caducó y otro lo tomó, avisa).
function renovar(clave, d) {
  const b = vigente(clave);
  if (b && !esDe(b, d)) return { ok: false, error: mensaje(clave, b), quien: b.quien };
  return adquirir(clave, d);
}

function liberar(clave, d) {
  const b = bloqueos.get(clave);
  if (b && esDe(b, d)) bloqueos.delete(clave);
}

// Mensaje si OTRO usuario tiene el registro; null si está libre o es de quien pregunta.
function conflicto(clave, d) {
  const b = vigente(clave);
  return b && !esDe(b, d) ? mensaje(clave, b) : null;
}

module.exports = { claveCP, dueno, adquirir, renovar, liberar, conflicto };
