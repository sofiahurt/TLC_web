# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TLC_Web is a Mexican transportation/logistics web application (currently in early development). The database is SQL Server with all business tables under the `Empresa2` schema and web-user management under `dbo`.

## Database

**Engine:** SQL Server (T-SQL), collation `Modern_Spanish_CI_AS` (case-insensitive, Spanish locale)

**Key schemas:**
- `Empresa2` — all business domain tables
- `dbo` — web user management (`UsuariosWeb`)

**Core domain tables:**

| Table | Purpose |
|---|---|
| `Camiones` | Trucks/vehicles — links to `Operadores`, tracks insurance, permit (SCT), payload |
| `Operadores` | Truck drivers with personal/address data |
| `Clientes` | Clients — full fiscal/tax data for Mexican CFDI invoicing (RFC, régimen fiscal, CFDI use, payment form) |
| `Transport` | Third-party carriers (transportistas) |
| `Tarifas` | Freight rate matrix — cost/sale price per origin city, destination city, freight type, carrier, and client |
| `TipoFlete` | Freight type catalog |
| `Ciudades` | City catalog |
| `DomCarDes` | Per-client cargo/delivery addresses (national and international) |
| `Contacto` | Per-client contacts |
| `ColCP` | Neighborhood / postal code catalog |
| `ProdServ` | Products/services catalog with SAT product codes and units (for CFDI) |
| `DieselPre` | Historical diesel price per liter (with IEPS tax) |
| `TarKilomts` | Per-kilometer rate history |
| `ParamTimbre` | CFDI stamp (timbre) quota tracking — series, folio range, active/expired |
| `ParamTimbreDeta` | Per-stamp detail log — UUID, series, folio, errors |
| `UsuariosWeb` | Web users with role flags per module (carta porte, factura, mantenimiento, liquidación, etc.) |

**Key design notes:**
- Most text columns use `char` (fixed-width) rather than `varchar` — pad with spaces when comparing.
- `Clientes` and `Transport` store year-opening balances (`SALDOANIOANT*`) for both MXN and USD.
- `UsuariosWeb.SERIE` restricts which invoice series a user may work with.
- `Camiones.FLAGRENTA` distinguishes owned trucks from rented ones.
- Mexican fiscal compliance (SAT CFDI) is a first-class concern: every client carries RFC, régimen fiscal, c_UsoCFDI, c_FormaPago, and addenda configuration.
