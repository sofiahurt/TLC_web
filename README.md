# TLC Web

Sistema web de gestión de transporte de carga desarrollado con **Node.js**, **Express**, **EJS** y **Bootstrap 5**, conectado a una base de datos **SQL Server**.

---

## Tecnologías

| Capa | Tecnología |
|---|---|
| Servidor | Node.js + Express.js |
| Vistas | EJS + Bootstrap 5 |
| Base de datos | SQL Server (`mssql`) |
| Sesiones | express-session |
| Estilos | Bootstrap 5 + Bootstrap Icons + CSS propio |

---

## Funcionalidades

- **Login** con autenticación contra `dbo.UsuariosWeb`
- **Sidebar** responsivo con navegación por módulos
- **Browse** con paginación (20 registros/página), búsqueda en tiempo real y ordenamiento por columnas
- **CRUD completo** (alta, edición, eliminación) mediante modales Bootstrap
- **Lookups** — ventanas de selección para campos relacionados entre tablas
- **Soporte para campos fiscales mexicanos** (RFC, régimen fiscal, CFDI, SAT)

---

## Módulos

### Catálogos
| Módulo | Ruta |
|---|---|
| Ciudades | `/ciudades` |
| Colonias / C.P. | `/colonias` |
| Tipos de Flete | `/tipoflete` |
| Operadores | `/operadores` |
| Productos y Servicios (SAT) | `/prodserv` |

### Clientes y Transportistas
| Módulo | Ruta |
|---|---|
| Clientes | `/clientes` |
| Contactos | `/contacto` |
| Domicilios de carga/descarga | `/domicilios` |
| Transportistas | `/transport` |

### Flota
| Módulo | Ruta |
|---|---|
| Camiones | `/camiones` |

### Tarifas
| Módulo | Ruta |
|---|---|
| Tarifas | `/tarifas` |
| Tarifas por Kilómetro | `/tarkilomts` |
| Precios Diesel | `/dieselpre` |

---

## Requisitos

- **Node.js** 18 o superior
- **SQL Server** con el esquema `Empresa2` y la tabla `dbo.UsuariosWeb` creados

---

## Instalación

```bash
# 1. Clonar el repositorio
git clone https://github.com/sofiahurt/TLC_web.git
cd TLC_web

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
copy .env.example .env
```

Edita el archivo `.env` con tus datos de conexión:

```env
DB_SERVER=localhost
DB_DATABASE=TLC_ELCEDRO
DB_USER=sa
DB_PASSWORD=tu_password
DB_PORT=1433
SESSION_SECRET=un_string_secreto_largo
PORT=3000
```

---

## Arranque

```bash
# Producción
npm start

# Desarrollo (recarga automática con nodemon)
npm run dev
```

La aplicación queda disponible en `http://localhost:3000`.

---

## Estructura del proyecto

```
TLC_web/
├── app/
│   ├── config/
│   │   ├── db.js          # Conexión a SQL Server (pool reutilizable)
│   │   └── browse.js      # Helper de paginación, búsqueda y ordenamiento
│   ├── routes/            # Una ruta por módulo (Express Router)
│   └── views/
│       ├── partials/      # header.ejs, sidebar.ejs, footer.ejs
│       └── *.ejs          # Vista por módulo
├── public/
│   ├── css/main.css       # Estilos del sidebar y tablas
│   └── js/main.js         # initBrowse(), lookups, selección de fila
├── .env.example           # Plantilla de variables de entorno
├── app.js                 # Punto de entrada
└── package.json
```

---

## Base de datos

Las tablas del negocio viven en el esquema **`Empresa2`**:

`Camiones` · `Ciudades` · `Clientes` · `ColCP` · `Contacto` · `DieselPre` · `DomCarDes` · `Operadores` · `ProdServ` · `Tarifas` · `TarKilomts` · `TipoFlete` · `Transport`

La gestión de usuarios está en **`dbo.UsuariosWeb`**.

---

## Seguridad

- Las contraseñas se almacenan y comparan en texto plano tal como las gestiona el sistema origen.
- El archivo `.env` está en `.gitignore` — **nunca se sube al repositorio**.
- Todas las consultas usan parámetros (`@param`) — protegido contra SQL Injection.
- Todas las rutas (excepto `/login`) requieren sesión activa.
