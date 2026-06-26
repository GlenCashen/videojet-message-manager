# Configuration

The app loads environment variables from `.env` through `dotenv` for local development. In production, set these values through the service manager or deployment platform instead of committing secrets.

Use [.env.example](../.env.example) as the local template.

## Common Settings

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | main server, tests | Set to `production` for production behavior. Tests set `test`. |
| `PORT` | `8080` | main server | HTTP port for the web app. |
| `DB_PATH` | `data/videojet.db` | main server | SQLite database path. |
| `SESSION_SECRET` | database-managed local secret in development | main server | Required in production unless development identity is enabled. Use a long random secret. |
| `TRUST_PROXY` | `false` | main server | Set to `true` when the app is behind a trusted reverse proxy that terminates HTTPS. |

## First-Run Admin

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOOTSTRAP_ADMIN_USERNAME` | none | Creates the first admin user only when no users exist. |
| `BOOTSTRAP_ADMIN_PASSWORD` | none | Initial password for the first admin. The user must change it on first login. |
| `BOOTSTRAP_ADMIN_DISPLAY_NAME` | username | Optional display name for the bootstrap admin. |

Remove bootstrap credentials from the service configuration after the first admin has signed in and changed the password.

## Printer Defaults And Timing

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRINTER_IP` | `192.168.100.2` | Default real printer IP used when creating/configuring printers. |
| `PRINTER_PORT` | `3100` | Default real printer TCP port. |
| `EMULATOR_HOST` | `127.0.0.1` | Host used by local emulator printers. |
| `EMULATOR_PORT` | `3100` | Base emulator port. Additional emulator printers offset from this port. |
| `COMMAND_TIMEOUT_MS` | `5000` | Per-command printer timeout for WSI/NGPCL commands. |
| `BETWEEN_COMMAND_DELAY_MS` | `150` | Delay between commands sent to one printer. |
| `BETWEEN_CODER_DELAY_MS` | `300` | Delay between fleet polling of different printers in local mode. |
| `POLL_INTERVAL_MS` | `5000` | Status polling interval. `STATUS_POLL_MS` is accepted as a legacy alias. |
| `STATUS_POLL_MS` | none | Legacy alias used only when `POLL_INTERVAL_MS` is not set. Prefer `POLL_INTERVAL_MS` for new config. |
| `STALE_AFTER_MS` | `15000` | Age after the last successful poll before UI marks printer data as stale. |
| `OFFLINE_AFTER_FAILURES` | `3` | Failed polls before the printer is marked offline. With the defaults, offline appears after roughly `POLL_INTERVAL_MS * OFFLINE_AFTER_FAILURES`, around 15 seconds. |
| `SSE_HEARTBEAT_MS` | `20000` | Server-sent-events heartbeat interval for live browser updates. |

For the offline warning timing you were looking for earlier, tune `POLL_INTERVAL_MS` and `OFFLINE_AFTER_FAILURES`. `STALE_AFTER_MS` controls the stale-data warning, not the offline threshold.

## Release Execution Mode

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRINTER_EXECUTION_MODE` | `local` in development, `agent` in production | `local` lets the main server talk directly to printers. `agent` queues work for `printer-agent.js`. |

In production `agent` mode, at least one printer-agent credential is required.

## Main Server Agent Credentials

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRINTER_AGENT_CREDENTIALS` | none | JSON map of agent IDs to `{ "token": "...", "printerIds": ["coder-1"] }`. Preferred for multiple agents. |
| `PRINTER_AGENT_ID` | `printer-agent-1` | Single-agent ID when `PRINTER_AGENT_CREDENTIALS` is not used. |
| `PRINTER_AGENT_TOKEN` | none | Single-agent token when `PRINTER_AGENT_CREDENTIALS` is not used. |
| `PRINTER_AGENT_PRINTER_IDS` | `*` | Comma-separated printer IDs for the single-agent shortcut. |
| `REQUIRE_AGENT_MTLS` | `false` | Require trusted mTLS headers from the reverse proxy for printer-agent API calls. |

Tokens are stored by the main server as SHA-256 hashes in memory and compared against the agent request token.

## Printer Agent Process

These are used by `npm run start:agent`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAIN_SERVER_URL` | none | Main server base URL. Must be HTTPS unless `PRINTER_AGENT_ALLOW_HTTP=true`. |
| `PRINTER_AGENT_ID` | none | Agent identity. Must match the main server credential config. |
| `PRINTER_AGENT_TOKEN` | none | Agent shared token. Must match the main server credential config. |
| `PRINTER_AGENT_STATE` | `data/printer-agent-state.json` | Durable local state file for in-flight jobs. |
| `PRINTER_AGENT_POLL_MS` | `500` | Interval for claiming pending printer jobs. Minimum 250 ms. |
| `PRINTER_AGENT_HEARTBEAT_MS` | `15000` | Interval for sending printer status heartbeats to the main server. Minimum 1000 ms. |
| `PRINTER_AGENT_CONFIG_REFRESH_MS` | `30000` | Interval for refreshing assigned printer configuration. Minimum 1000 ms. |
| `COMMAND_TIMEOUT_MS` | `5000` | Per-command timeout used by the agent printer clients. Minimum 500 ms. |
| `BETWEEN_COMMAND_DELAY_MS` | `150` | Delay between printer commands in the agent. |
| `PRINTER_AGENT_CA_CERT` | none | Optional CA certificate path for the main server/reverse proxy. |
| `PRINTER_AGENT_CLIENT_CERT` | none | Optional client certificate path for mTLS. Must be set with `PRINTER_AGENT_CLIENT_KEY`. |
| `PRINTER_AGENT_CLIENT_KEY` | none | Optional client private key path for mTLS. Must be set with `PRINTER_AGENT_CLIENT_CERT`. |
| `PRINTER_AGENT_ALLOW_HTTP` | `false` | Development-only escape hatch for `MAIN_SERVER_URL=http://...`. Do not enable in production. |

## Development And Test Controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENABLE_DEV_IDENTITY` | `false` | Enables development identity switching when no users exist. Keep disabled in production. |
| `DEV_USER_ROLE` | `viewer` | Role for development identity. |
| `DEV_USER_PRINTER_IDS` | none | Comma-separated printer IDs available to the development identity. |
| `ENABLE_UNSAFE_DEVELOPMENT_TOOLS` | `false` | Enables explicitly unsafe development endpoints/tools. Keep disabled in production. |
| `ENABLE_TEST_ENDPOINTS` | `false`, or true when `NODE_ENV=test` | Enables test-only endpoints. Keep disabled in production. |

## Faults, Diagnostics, And Seeds

| Variable | Default | Purpose |
| --- | --- | --- |
| `FAULT_HISTORY_LIMIT` | `1000` | Maximum fault history retained by the fault store. |
| `FAULT_HISTORY_PATH` | none | Optional legacy/alternate fault history path. |
| `NGPCL_TRACE` | `false` | Set `true`, `1`, or `yes` to trace NGPCL traffic in logs. |
| `SEED_MASTER_CODE` | first enabled master | Product master code used by `npm run seed:releases`. |
| `SEED_COMPLETED_RELEASES` | `100` | Number of completed seed releases. |
| `SEED_RELEASED_RELEASES` | `15` | Number of approved/ready seed releases. |

## Legacy Paths

| Variable | Default | Purpose |
| --- | --- | --- |
| `USERS_PATH` | `data/users.json` | Legacy JSON user path still accepted by `server/user-store.js`; normal runtime users are persisted in SQLite. |
