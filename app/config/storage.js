'use strict';

const path = require('path');

// Detecta la unidad del disco donde vive el proyecto a partir de __dirname,
// independientemente de en qué subcarpeta del código esté este archivo.
// En desarrollo: __dirname = E:\Developments10\TLC_Web\app\config → root = 'E:\'
// En VPS:        __dirname = C:\TLC_Web\app\config              → root = 'C:\'
// La ruta de almacenamiento siempre queda en la raíz de la unidad, sin incluir
// subdirectorios intermedios del entorno (ej. 'Developments10').
const unidad   = path.parse(__dirname).root;         // 'E:\' | 'C:\' | etc.
const RUTA_XML = path.join(unidad, 'TLC_Web', 'Empresa2', 'XML');

module.exports = { RUTA_XML };
