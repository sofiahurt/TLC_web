'use strict';

const path = require('path');
const Database = require('better-sqlite3');

// El archivo .sqlite vive dentro del proyecto en storage/catalogos/.
// SAT_CATALOGOS_DB_PATH puede sobreescribir la ruta si en el VPS el archivo
// está en otra ubicación.
const DB_PATH = process.env.SAT_CATALOGOS_DB_PATH ||
  path.join(__dirname, '../../storage/catalogos/sat_catalogos.sqlite');

let _db = null;

function getSatDb() {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
  }
  return _db;
}

module.exports = { getSatDb, DB_PATH };
