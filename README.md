# Videojet 1620/1710 Control + Local WSI Emulator

This proof of concept can connect to Videojet 1620 and 1710 printers over WSI Simple Protocol or to a built-in local emulator.

There is no fixed printer-count limit. Emulator-mode printers each use independent in-memory state and a separate local TCP listener based on the printer's configured port. Printer deletion archives the configuration and removes active assignments while retaining historical audit, fault, and message-update records.

Admins can select an enabled user in Editor > Users and choose **Simulate user**. The application applies that user's permissions and printer assignments until **Return to admin** is selected; the original signed-in admin session is preserved throughout.

Set the correct model for every printer in the editor. A 1620 uses `Q` and `E`. A 1710 defaults to auto-detection: the server safely probes `Q`, remembers whether that printer accepts it, and continues `E` status polling if readback fails. The editor also provides explicit enabled and disabled overrides. A physical print check remains required after every message change.

## Run

```powershell
npm install
npm run migrate
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

## Schema commands

Create or update the schema:

```powershell
npm run migrate
```

An empty database is initialized with the current printer and message configuration. Historical users, faults and audit records are never imported from JSON.

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
<<<<<<< HEAD
<<<<<<< Updated upstream
    "schemaVersion": 12
=======
    "schemaVersion": 19
>>>>>>> Stashed changes
=======
    "schemaVersion": 18
>>>>>>> 0d7c9eaa13678d2e3a33365ea4836d59219d55c7
  }
}
```

## Split production deployment

Production supports a separate Printer Agent on the isolated printer network. The main server owns releases and queues immutable approved jobs; the outbound-polling agent is the only process that knows printer IP addresses or opens WSI connections.

See [Deployment and Operations](docs/DEPLOYMENT_AND_OPERATIONS.md) for the network topology, mTLS setup, firewall rules, service configuration, acceptance testing, backups, upgrades, credential rotation and recovery procedures.

Sessions are stored in SQLite, so logins survive a process restart. Expired sessions are cleaned up when read, logout deletes the session row, and disabled users are rejected even if an old session cookie remains.

## Production releases

Production coding is prepared through controlled releases. QA owns versioned product masters. Planners and packaging leaders create drafts from brew-sheet data. A different QA or Packaging Leader must review a submitted release before it becomes available for production.

Each product-master version defines its coding requirement separately for every permitted printer. A printer configuration selects one message assigned to that printer and maps each of that message's user fields to an approved release value. A single product run can therefore render different messages and layouts for can, bottle, and case coders. Editing a master creates a new immutable version; existing releases remain pinned to their reviewed version.

Logical messages are built in the editor rather than entered as JSON. Message IDs use lowercase kebab-case. Each user field defines its display name, printer field name, maximum length, uppercase handling, and whether it is required. Date and time tokens have explicit formats, and one to four expected-print lines can combine typed text with inserted or dragged field tokens. Optional blank fields are sent as empty WSI field updates and must be confirmed on each real printer model before production use.

Approval authorizes the release without assigning its run number. When the operator sends it for the first time, the system automatically reserves the next run number from that product's master sequence and renders the approved message fields. Operators do not choose or edit the run number. For example, `TBUNDRC` and `SMGOLD` maintain independent sequences, and an attempted number is never reused when printer delivery is uncertain. Every release stays pinned to the product-master version used when the draft was created.

Opening an independent review creates a renewable 45-second review claim. Other reviewers see who is active and cannot approve or reject the same release until that claim is released or expires.

Approved releases enter the assigned printer pages' execution queues. Each printer target requires an operator confirmation before the approved payload is sent, followed by printer readback and an explicit first-print check. A successful first-print check marks the release `running`. It remains running until the operator explicitly ends it or successfully sends another release to the same printer, which automatically ends the previous run. Failed first-print checks can be returned for correction and independent review. Completed releases remain available for a controlled reapply with a required reason.

The main dashboard is monitoring-only: printer cards show live state, expected output, and the current running release. Manual message changes and release send/verify/end/reapply controls are available only from the individual printer page. This keeps every state-changing action anchored to the physical printer being operated.

In local mode, if the server restarts during a send, the target is recovered as `failed`/attention required instead of remaining permanently locked. In agent mode, the agent durably records an in-flight job before contacting a printer. After a restart it reports the result if known, or reports an uncertain state and requires operator confirmation; it never silently sends the same job again.

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
- `POST /api/batch-releases/:id/approve` - approve without consuming the product run sequence
- `POST /api/batch-releases/:id/reject` - return with a required reason
- `POST /api/batch-releases/:id/targets/:printerId/apply` - send an approved target to its assigned printer
- `POST /api/batch-releases/:id/targets/:printerId/print-check` - record the operator's first-print verification
- `POST /api/batch-releases/:id/targets/:printerId/end-run` - explicitly end a running printer target
- `POST /api/batch-releases/:id/return-for-review` - return a failed or changed release for correction and review

## First run

If no users exist, provide bootstrap credentials or enable development identity:

```powershell
$env:BOOTSTRAP_ADMIN_USERNAME="admin"
$env:BOOTSTRAP_ADMIN_PASSWORD="change-this-password"
npm start
```

The bootstrap Admin is created only when the user table is empty.

For development UI testing, `npm run seed:releases` recreates its own seed records using the first enabled product master: 100 completed releases and 15 approved releases ready for execution. Set `SEED_MASTER_CODE`, `SEED_COMPLETED_RELEASES`, or `SEED_RELEASED_RELEASES` to override the defaults. The command deletes only releases whose notes start with `Development release seed:`.

For local development, omitting `SESSION_SECRET` uses a secret generated and stored in the local database. Production still requires an explicit strong `SESSION_SECRET` environment variable.

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
