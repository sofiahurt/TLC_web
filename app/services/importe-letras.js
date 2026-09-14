'use strict';

// ── Conversión de un importe numérico a su representación en letras ────────
// Formato y ortografía verificados byte-por-byte contra ImporteLetras real ya
// guardado por el sistema legado en Empresa2.Factura (30+ filas de muestra):
// sin acentos ("VEINTITRES", "DIECISEIS", "VEINTIDOS"), "MIL" a secas para el
// grupo de miles == 1 (nunca "UN MIL"), apócope de "UNO"->"UN" antes de "MIL"
// o "MILLON" en cualquier otro grupo (ej. 141 -> "CIENTO CUARENTA Y UN MIL").
// Pesos: "<letras> PESOS NN/100". Dólares: "<letras> DOLARES NN CENT".

const UNIDADES = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
const DIECIS = ['DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE'];
const VEINTIS = ['VEINTE', 'VEINTIUNO', 'VEINTIDOS', 'VEINTITRES', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISEIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
const DECENAS = ['', 'DIEZ', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

function convertirDecenas(n) {
  if (n < 10) return UNIDADES[n];
  if (n < 20) return DIECIS[n - 10];
  if (n < 30) return VEINTIS[n - 20];
  const d = Math.floor(n / 10), u = n % 10;
  if (u === 0) return DECENAS[d];
  return `${DECENAS[d]} Y ${UNIDADES[u]}`;
}

// Grupo de 0-999.
function convertirGrupo(n) {
  if (n === 0) return '';
  if (n === 100) return 'CIEN';
  const c = Math.floor(n / 100), resto = n % 100;
  let out = c > 0 ? CENTENAS[c] : '';
  if (resto > 0) out += (out ? ' ' : '') + convertirDecenas(resto);
  return out;
}

function apocopeUno(s) {
  return s.replace(/UNO$/, 'UN');
}

// Entero >= 0, hasta 999,999,999.
function numeroALetras(nEntero) {
  if (nEntero === 0) return '';
  const millones = Math.floor(nEntero / 1000000);
  const miles = Math.floor((nEntero % 1000000) / 1000);
  const unidades = nEntero % 1000;

  const partes = [];
  if (millones > 0) {
    partes.push(millones === 1 ? 'UN MILLON' : `${apocopeUno(convertirGrupo(millones))} MILLONES`);
  }
  if (miles > 0) {
    partes.push(miles === 1 ? 'MIL' : `${apocopeUno(convertirGrupo(miles))} MIL`);
  }
  if (unidades > 0) {
    partes.push(convertirGrupo(unidades));
  }
  return partes.join(' ');
}

// moneda: 'USD' -> "... DOLARES NN CENT"; cualquier otro valor (incluido
// null/MXN) -> "... PESOS NN/100".
function importeALetras(monto, moneda) {
  const centavosTotales = Math.round(Math.abs(Number(monto) || 0) * 100);
  const enteros = Math.floor(centavosTotales / 100);
  const centavos = centavosTotales % 100;
  const palabras = numeroALetras(enteros);
  const centavosStr = String(centavos).padStart(2, '0');
  const prefijo = palabras ? `${palabras} ` : '';
  return (moneda || '').trim().toUpperCase() === 'USD'
    ? `${prefijo}DOLARES ${centavosStr} CENT`
    : `${prefijo}PESOS ${centavosStr}/100`;
}

module.exports = { importeALetras };
