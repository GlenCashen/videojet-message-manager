# Videojet 1620/1710 Control + Local WSI Emulator

This proof of concept can connect to Videojet 1620 and 1710 printers over WSI Simple Protocol or to a built-in local emulator.

There is no fixed printer-count limit. Emulator-mode printers each use independent in-memory state and a separate local TCP listener based on the printer's configured port. Printer deletion archives the configuration and removes active assignments while retaining historical audit, fault, and message-update records.

Admins can select an enabled user in Editor > Users and choose **Simulate user**. The application applies that user's permissions and printer assignments until **Return to admin** is selected; the original signed-in admin session is preserved throughout.

Set the correct model for every printer in the editor. A 1620 uses `Q` and `E`. A 1710 defaults to auto-detection: the server safely probes `Q`, remembers whether that printer accepts it, and continues `E` status polling if readback fails. The editor also provides explicit enabled and disabled overrides. A physical print check remains required after every message change.

## Run

```powershell
npm install
npm run migrate
npm run migrate:json
npm start
```

Open `http://localhost:8080`.

## SQLite persistence

Persistent application data now lives in SQLite at `data/videojet.db`.

SQLite stores:

- printer configuration
- users, roles and printer assignments
- message definitions, fields and printer message assignments
- last expected printed output
- message update events
- fault transitions
- audit events
- login sessions

Live printer polling state is still rebuilt in memory after restart. This includes online/offline state, stale indicators, current queue activity, SSE clients, response time and the latest raw status.

The database is opened with foreign keys enabled, WAL journaling and a 5 second busy timeout.

## Migration commands

Create or update the schema:

```powershell
npm run migrate
```

Import existing JSON data once:

```powershell
npm run migrate:json
```

The JSON importer reads any existing files in `data/`, including `printers.json`, `messages.json`, `users.json`, `fault-history.json`, `audit-log.json` and `printer-state.json`. After a successful import it records a migration marker in SQLite, then copies source JSON files to `data/json-backup/<timestamp>/`. Later startup skips JSON import so stale JSON cannot overwrite database data.

## Backup and restore

Create a WAL-safe database backup:

```powershell
npm run db:backup
```

Backups are written to `backups/videojet-YYYYMMDD-HHmmss.db`.

Check database health:

```powershell
npm run db:check
npm run db:status
```

To restore, stop the application, copy the chosen backup over `data/videojet.db`, then start the app again. If `videojet.db-wal` or `videojet.db-shm` files exist from the previous database, remove those only while the app is stopped so SQLite recreates them for the restored database.

`GET /api/health` includes safe database status:

```json
{
  "ok": true,
  "database": {
    "connected": true,
    "journalMode": "wal",
    "foreignKeys": true,
    "schemaVersion": 7
  }
}
```

Sessions are stored in SQLite, so logins survive a process restart. Expired sessions are cleaned up when read, logout deletes the session row, and disabled users are rejected even if an old session cookie remains.

## Production releases

Production coding is prepared through controlled releases. QA owns versioned product masters. Planners and packaging leaders create drafts from brew-sheet data. A different QA or Packaging Leader must review a submitted release before it becomes available for production.

Approval atomically reserves the next run number for that product only. For example, `TBUNDRC` and `SMGOLD` maintain independent sequences. Cancelled or failed approvals never reuse an already reserved number. Every release stays pinned to the product-master version used when the draft was created.

Opening an independent review creates a renewable 45-second review claim. Other reviewers see who is active and cannot approve or reject the same release until that claim is released or expires.

Approved releases enter the assigned operators' dashboard queue. Each printer target requires an operator confirmation before the approved payload is sent, followed by printer readback and an explicit first-print check. Targets complete independently and failures remain available for controlled retry. The legacy message-job creation and execution endpoints return HTTP 410.

If the server restarts during a send, the target is recovered as `failed`/attention required instead of remaining permanently locked. The operator must confirm the printer state before choosing a controlled retry.

- `GET /api/product-masters` - list product specifications
- `POST /api/product-masters` - QA/Admin create a versioned master
- `PUT /api/product-masters/:id` - create the next immutable master version
- `GET /api/batch-releases` - list releases visible to the current role
- `POST /api/batch-releases` - create a draft
- `PUT /api/batch-releases/:id` - edit a draft or correct a rejected release
- `GET /api/batch-releases/:id/audit` - view the permanent audit history for one release
- `POST /api/batch-releases/:id/review-claim` - claim or renew an active independent review
- `DELETE /api/batch-releases/:id/review-claim` - release the current user's review claim
- `POST /api/batch-releases/:id/submit` - submit for independent review
- `POST /api/batch-releases/:id/approve` - approve and reserve the product run
- `POST /api/batch-releases/:id/reject` - return with a required reason
- `POST /api/batch-releases/:id/targets/:printerId/apply` - send an approved target to its assigned printer
- `POST /api/batch-releases/:id/targets/:printerId/print-check` - record the operator's first-print verification

## First run

If no users exist, provide bootstrap credentials or enable development identity:

```powershell
$env:BOOTSTRAP_ADMIN_USERNAME="admin"
$env:BOOTSTRAP_ADMIN_PASSWORD="change-this-password"
npm start
```

The bootstrap Admin is created only when the user table is empty.

## Troubleshooting

- Run `npm run db:check` if the app reports a database error.
- Run `npm run db:status` to confirm WAL mode, foreign keys and schema version.
- If migration fails, the transaction rolls back and the error message points to the invalid source data.
- JSON files remain as migration inputs and fixtures. Normal runtime updates write to SQLite.

## Emulator mode

Turn on **Use local printer emulator** in the web interface. The emulator listens on:

- IP: `127.0.0.1`
- TCP port: `3100`

It supports the WSI commands currently used by the interface:

- `Q` — selected message
- `E` — error/traffic-light status
- `M` — select an existing message
- `U` — update an existing text user field
- `D` — clear an existing user field
- `H` — software part number
- `GA` / `GB` — counters
- `O0` / `O1` — print off/on acknowledgement

Default emulator data:

- Messages: `9 MONTH`, `12 MONTH`
- Text field: `TEST`
- Status: `0000002`

The emulator panel can also simulate an offline printer, command failure, status changes, and response delays.

## Environment variables

- `PORT` — web app port, default `8080`
- `PRINTER_IP` — default real printer IP
- `PRINTER_PORT` — default real printer WSI port
- `EMULATOR_HOST` — default `127.0.0.1`
- `EMULATOR_PORT` — default `3100`
- `DB_PATH` — override SQLite path, default `data/videojet.db`
- `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` — create the first Admin user when no users exist
- `ENABLE_DEV_IDENTITY` — enable development identity switching
