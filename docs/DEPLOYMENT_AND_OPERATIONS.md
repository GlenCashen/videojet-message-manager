# Videojet Message Manager: Deployment and Operations

## 1. Production topology

Use two separate application processes and two separate network security zones.

```text
Printer VLAN (no route to site LAN)

  Videojet printers
        |
        | WSI TCP 3100 (or configured printer port)
        v
  Printer Agent
    NIC 1: printer VLAN, no default gateway
    NIC 2: restricted management/DMZ network
        |
        | outbound HTTPS 443, mutual TLS + agent bearer token
        v

Site application network

  Reverse proxy / mTLS endpoint
        |
        | loopback or protected application port
        v
  Main Server ---- SQLite database and backups
        |
        | HTTPS 443
        v
  Browser clients
```

The main server must not have an interface or route on the printer VLAN. The Printer Agent must have IP forwarding and network bridging disabled. Routable printer addresses are stored only in the agent's local printer configuration; any host value retained with main-server printer metadata is ignored in `agent` mode and should be a non-routable placeholder.

## 2. Component responsibilities

### Main Server

- Hosts the browser application, authentication, product masters and releases.
- Owns approval, audit history and the durable printer-job queue.
- Creates an immutable payload and SHA-256 hash when an operator starts an approved release.
- Never opens a WSI connection in `agent` mode.

### Printer Agent

- Makes outbound HTTPS requests to the main server; it exposes no inbound application port.
- Claims jobs only for its configured printer allowlist.
- Resolves printer IDs to local IP addresses from its own JSON configuration.
- Polls current printer status and sends status snapshots to the main dashboard in authenticated heartbeats.
- Verifies the job payload hash before using WSI.
- Serializes work per printer.
- Records the in-flight job before contacting a printer.
- After a restart, reports the interrupted job as uncertain and never automatically resends it.

## 3. Prerequisites

- A supported Node.js LTS release installed on both hosts.
- A dedicated service account on each host.
- Time synchronization on both hosts.
- A private certificate authority for the internal agent endpoint.
- A DNS name for the agent-facing main-server endpoint, for example `vmm-agent.site.internal`.
- A backup destination outside the main-server host.

Run the services as unprivileged accounts. Give the main-server account write access only to `data/` and `backups/`. Give the agent account write access only to its state directory and read access to its printer configuration and TLS private key.

## 4. Main Server installation

```powershell
git clone <repository-url> C:\Services\videojet-message-manager
cd C:\Services\videojet-message-manager
npm ci
npm run migrate
```

Configure these environment variables through the service manager, not in source control:

```text
NODE_ENV=production
PORT=8080
PRINTER_EXECUTION_MODE=agent
SESSION_SECRET=<at-least-32-random-bytes>
BOOTSTRAP_ADMIN_USERNAME=<first-install-only>
BOOTSTRAP_ADMIN_PASSWORD=<first-install-only-strong-password>
TRUST_PROXY=true
REQUIRE_AGENT_MTLS=true
PRINTER_AGENT_CREDENTIALS={"packaging-agent-1":{"token":"<random-agent-token>","printerIds":["coder-1","coder-2","coder-3"]}}
```

Generate secrets with a cryptographically secure password generator. Remove the bootstrap password from the service configuration after the first administrator has signed in and changed it.

Start the main server with:

```powershell
npm start
```

In production, firewall port 8080 so only the local reverse proxy can reach it.

## 5. Printer Agent installation

Install the same application release on the isolated communication host:

```powershell
git clone <repository-url> C:\Services\videojet-printer-agent
cd C:\Services\videojet-printer-agent
npm ci
```

Create a local printer file outside source control, for example `C:\ProgramData\VideojetAgent\printers.json`:

```json
[
  {
    "id": "coder-1",
    "name": "Can Coder",
    "location": "Can line",
    "host": "192.168.100.166",
    "port": 3100,
    "model": "1620",
    "readbackMode": "enabled",
    "mode": "real",
    "enabled": true
  }
]
```

The printer ID must exactly match the ID configured on the main server. Configure the agent service environment:

```text
MAIN_SERVER_URL=https://vmm-agent.site.internal
PRINTER_AGENT_ID=packaging-agent-1
PRINTER_AGENT_TOKEN=<same-random-agent-token-as-main-server>
PRINTER_AGENT_CONFIG=C:\ProgramData\VideojetAgent\printers.json
PRINTER_AGENT_STATE=C:\ProgramData\VideojetAgent\state.json
PRINTER_AGENT_CA_CERT=C:\ProgramData\VideojetAgent\tls\site-ca.pem
PRINTER_AGENT_CLIENT_CERT=C:\ProgramData\VideojetAgent\tls\agent.crt
PRINTER_AGENT_CLIENT_KEY=C:\ProgramData\VideojetAgent\tls\agent.key
PRINTER_AGENT_POLL_MS=500
PRINTER_AGENT_HEARTBEAT_MS=15000
COMMAND_TIMEOUT_MS=5000
BETWEEN_COMMAND_DELAY_MS=150
```

Start it with:

```powershell
npm run start:agent
```

`PRINTER_AGENT_ALLOW_HTTP=true` exists only for local testing. Never enable it in production.

## 6. Mutual TLS endpoint

Terminate agent mTLS on a dedicated internal reverse-proxy listener or hostname. Do not share this listener with browser clients. A representative Nginx server block is:

```nginx
server {
    listen 443 ssl;
    server_name vmm-agent.site.internal;

    ssl_certificate     /etc/nginx/tls/server.crt;
    ssl_certificate_key /etc/nginx/tls/server.key;
    ssl_client_certificate /etc/nginx/tls/site-agent-ca.crt;
    ssl_verify_client on;
    ssl_protocols TLSv1.2 TLSv1.3;

    location /api/printer-agent/ {
        proxy_set_header X-Client-Cert-Verified $ssl_client_verify;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Host $host;
        proxy_pass http://127.0.0.1:8080;
    }

    location / {
        return 404;
    }
}
```

The application token is required in addition to mTLS. Ensure the application port cannot be reached directly, otherwise a client could forge the certificate-verification header.

## 7. Firewall and host hardening

### Printer VLAN

- Allow printers to communicate only with the Printer Agent IP and required WSI ports.
- Deny printer access to DNS, Internet and the site LAN unless a documented printer requirement exists.
- Do not configure a default gateway on the agent's printer-facing NIC.

### Agent management NIC

- Allow outbound TCP 443 only to the agent-facing main-server endpoint.
- Allow required NTP and tightly controlled administration traffic.
- Deny inbound application traffic.
- Disable operating-system IP forwarding, Internet Connection Sharing and bridging.

### Main Server

- Allow browser HTTPS only from approved site networks.
- Allow the dedicated mTLS endpoint only from agent management addresses.
- Allow the reverse proxy to reach the application port; deny all other access to it.
- The main server must have no route to printer VLAN addresses.

## 8. Service management

Configure both processes for automatic restart with a delay, a dedicated working directory and environment variables held by the service manager.

On Linux, use separate systemd units with `User=`, `WorkingDirectory=`, `EnvironmentFile=` and `Restart=on-failure`. Protect the services with `NoNewPrivileges=true`, `PrivateTmp=true` and restrictive filesystem permissions.

On Windows, run each process through the site's approved service wrapper or service-management platform. Use dedicated non-administrator accounts, deny interactive logon where policy permits, and grant the **Log on as a service** right only to those accounts.

Do not run both local and agent execution against the same physical printers.

## 9. Initial acceptance test

1. Confirm `/api/health` on the main server reports `printerExecutionMode: "agent"` and schema version 19 or later.
2. Start the agent and confirm its heartbeat appears in `printerAgents` with a recent `seenAt` time.
3. Verify the main server cannot connect to any printer VLAN address.
4. Create and independently approve a test release.
5. Start the release from the individual printer page.
6. Confirm the HTTP response is queued and an agent job is claimed.
7. Confirm the agent sends the expected message and fields.
8. Compare the physical first print with the approved expected output.
9. Complete the first-print confirmation and end the test run.
10. Review the release audit log for queue, agent and verification events.

Perform this test independently for every configured printer model and readback mode.

## 10. Routine maintenance

### Daily

- Confirm the main-server health endpoint is healthy.
- Confirm each expected agent heartbeat is recent.
- Review releases in failed or uncertain state.
- Review disk space on the main server and agent.

### Weekly

- Run `npm run db:check` on the main server.
- Confirm backups have copied successfully to a separate host or protected storage.
- Review disabled users, printer assignments and administrator activity.
- Review agent and reverse-proxy authentication failures.

### Monthly

- Test restoring the latest backup on a non-production host.
- Review firewall rules and printer/agent allowlists.
- Check certificate and token expiry dates.
- Apply supported operating-system and Node.js security updates through change control.

## 11. Backup and restore

Create a consistent SQLite backup while the main server is running:

```powershell
npm run db:backup
npm run db:check
```

Copy the resulting file from `backups/` to protected external storage. The agent state file is not a substitute for a database backup; back it up only for forensic and recovery context.

To restore:

1. Stop the main server.
2. Preserve the failed database and WAL/SHM files for investigation.
3. Copy the selected backup to `data/videojet.db`.
4. Remove old `videojet.db-wal` and `videojet.db-shm` files only while the service is stopped.
5. Run `npm run migrate` and `npm run db:check`.
6. Start the main server, then confirm agents reconnect.
7. Treat every job that was applying during the failure as uncertain and physically inspect its printer before retrying.

## 12. Upgrade and rollback

1. Read release notes and back up the database.
2. Stop the Printer Agent so no new job can be claimed.
3. Wait for, or explicitly resolve, any job already applying.
4. Stop the main server.
5. Install dependencies with `npm ci` and run `npm run migrate`.
6. Start and health-check the main server.
7. Upgrade and start the Printer Agent.
8. Perform one controlled test release.

Upgrade the main server before agents when the printer-job protocol changes. The current protocol is version 1 and unsupported versions are rejected by the agent.

For rollback, restore both the prior application release and the pre-upgrade database backup. Do not run older code against a database that has already received newer migrations unless that rollback has been explicitly tested.

## 13. Credential and certificate rotation

### Agent token

1. Add a second temporary agent identity/token on the main server.
2. Restart the main server.
3. Update and restart the agent with the new identity/token.
4. Confirm a current heartbeat and a controlled test.
5. Remove the old credential and restart the main server.

### Client certificate

1. Issue a new certificate with the same agent identity and correct client-auth usage.
2. Install the new certificate and key with restrictive permissions.
3. Restart the agent and confirm mTLS authentication.
4. Revoke the old certificate after all agents have moved.

Never email or commit tokens, private keys, session secrets or production printer configurations.

## 14. Failure recovery

### Agent cannot reach main server

- No new job is received and printers remain unchanged.
- Check DNS, time, CA trust, client certificate, firewall and token configuration.
- Do not enable HTTP as a workaround.

### Main server cannot see an agent heartbeat

- Confirm the agent process is running and inspect its service log.
- Confirm the client certificate has not expired and system clocks agree.
- Confirm the reverse proxy forwards only verified certificate requests.

### Agent restarts during a send

- The agent reads its local state file and reports the job as uncertain.
- It does not resend the WSI commands.
- The operator must inspect the selected printer message and first print, then use the controlled retry path with a reason.

### Completion report cannot reach main server

- The result remains in the agent state file.
- The agent retries reporting that result before claiming another job.
- Do not delete the state file to clear the condition. Resolve connectivity or investigate the main-server job state.

### Printer timeout or NACK

- The agent reports the exact failure and any available readback.
- The release target becomes failed/attention required.
- Confirm physical printer state before retrying; never perform an automatic blind resend.

## 15. Development mode

The original single-process behavior remains available only as an explicit development configuration:

```powershell
$env:NODE_ENV="development"
$env:PRINTER_EXECUTION_MODE="local"
$env:ENABLE_DEV_IDENTITY="true"
npm start
```

To exercise the split locally, run the main server with `PRINTER_EXECUTION_MODE=agent`, set matching agent credentials, then run the agent with `PRINTER_AGENT_ALLOW_HTTP=true` and `MAIN_SERVER_URL=http://127.0.0.1:8080`. Printers marked `mode: "emulator"` in the agent configuration are hosted by the agent itself. The agent registers each claimed job's stored message and user fields before applying it, so no second local-mode main server should be run for emulator sockets.
