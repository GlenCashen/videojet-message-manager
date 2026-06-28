# Linux deployment test run

These helper files are for a full test deployment of Videojet Message Manager using:

- one main server process
- one printer-agent process
- HTTPS for browser access
- a separate HTTPS/mTLS endpoint for the printer agent
- systemd service management
- nginx as the reverse proxy

They are designed for a lab or site acceptance test before production hardening. Review every path, hostname, token and firewall rule before using them on a live line.

## Assumed hosts

| Host | Purpose | Example path |
| --- | --- | --- |
| Main server | Web app, database, approvals, agent job queue | `/opt/videojet-message-manager` |
| Printer-agent PC | Talks to printers, calls main server outbound over HTTPS | `/opt/videojet-printer-agent` |

The main server should not be able to reach the printer VLAN. The agent should have a printer-facing NIC with no default gateway and a management/DMZ NIC that can reach only the agent HTTPS endpoint.

## 1. Generate secrets

On a trusted admin machine:

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # PRINTER_AGENT_TOKEN
```

Keep these out of git.

## 2. Create TLS files

From the repo on a Windows machine with PowerShell 7+:

```powershell
pwsh .\tls\create-vmm-tls.ps1 `
  -OutDir "C:\ProgramData\VideojetAgent\tls" `
  -AgentId "packaging-agent-1" `
  -ServerDns "vmm-agent.site.internal"
```

Copy these to the main server reverse proxy:

```text
site-ca.pem
server.crt
server.key
```

Copy these to the agent PC:

```text
site-ca.pem
agent.crt
agent.key
```

Keep private keys readable only by root or the service account.

## 3. Install the main server

On the main server:

```bash
sudo deploy/linux/install-main-server.sh \
  --repo-url git@github.com:GlenCashen/videojet-message-manager.git \
  --app-dir /opt/videojet-message-manager
```

Then create the environment file from the example:

```bash
sudo cp deploy/linux/main-server.env.example /etc/videojet-message-manager/main.env
sudo nano /etc/videojet-message-manager/main.env
```

Set at least:

```text
SESSION_SECRET=...
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=...
PRINTER_AGENT_TOKEN=...
PRINTER_AGENT_CREDENTIALS={"packaging-agent-1":{"token":"same-token","printerIds":["coder-1","coder-2","coder-3"]}}
```

Run migrations and start the service:

```bash
cd /opt/videojet-message-manager
sudo -u vmm npm run migrate
sudo systemctl enable --now vmm-main.service
sudo systemctl status vmm-main.service
```

After the first admin login and password change, remove `BOOTSTRAP_ADMIN_PASSWORD` from `/etc/videojet-message-manager/main.env` and restart the service.

## 4. Configure nginx

Install nginx and copy the example config:

```bash
sudo cp deploy/nginx/vmm-agent-mtls.conf /etc/nginx/sites-available/vmm-agent-mtls.conf
sudo ln -s /etc/nginx/sites-available/vmm-agent-mtls.conf /etc/nginx/sites-enabled/vmm-agent-mtls.conf
sudo nginx -t
sudo systemctl reload nginx
```

This repo includes only the agent mTLS listener. Configure your normal browser-facing HTTPS site separately, pointing it to `http://127.0.0.1:8080`.

## 5. Install the printer agent

On the agent PC:

```bash
sudo deploy/linux/install-printer-agent.sh \
  --repo-url git@github.com:GlenCashen/videojet-message-manager.git \
  --app-dir /opt/videojet-printer-agent
```

Create the environment file from the example:

```bash
sudo cp deploy/linux/printer-agent.env.example /etc/videojet-printer-agent/agent.env
sudo nano /etc/videojet-printer-agent/agent.env
```

Set:

```text
MAIN_SERVER_URL=https://vmm-agent.site.internal
PRINTER_AGENT_ID=packaging-agent-1
PRINTER_AGENT_TOKEN=same-token-as-main-server
```

Start it:

```bash
sudo systemctl enable --now vmm-printer-agent.service
sudo systemctl status vmm-printer-agent.service
```

## 6. Test the mTLS endpoint before starting the agent

From the agent PC:

```bash
curl --cacert /etc/videojet-printer-agent/tls/site-ca.pem \
  --cert /etc/videojet-printer-agent/tls/agent.crt \
  --key /etc/videojet-printer-agent/tls/agent.key \
  -H 'X-Printer-Agent-Id: packaging-agent-1' \
  -H 'Authorization: Bearer replace-with-token' \
  https://vmm-agent.site.internal/api/printer-agent/v1/config
```

Expected result: JSON with `ok: true` and the printer list assigned to that agent.

Without the client certificate, the request should fail.

## 7. App acceptance test

1. Check browser HTTPS login.
2. Confirm `/api/health` reports `printerExecutionMode: "agent"`.
3. Configure printers in the web app with the correct IDs, host, port, protocol, model and readback mode.
4. Confirm the agent heartbeat appears in the health payload.
5. Create and independently approve a test release.
6. Start the release from the individual printer page.
7. Confirm the response is queued, not directly sent by the main server.
8. Watch the agent logs with `journalctl -u vmm-printer-agent.service -f`.
9. Verify the physical first print, then complete the first-print check.
10. Review the release audit log for queue, agent completion and verification events.

## 8. Useful commands

```bash
# Main server logs
journalctl -u vmm-main.service -f

# Agent logs
journalctl -u vmm-printer-agent.service -f

# Check health locally on main server
curl http://127.0.0.1:8080/api/health

# Database check
cd /opt/videojet-message-manager && sudo -u vmm npm run db:check

# Backup
cd /opt/videojet-message-manager && sudo -u vmm npm run db:backup
```
