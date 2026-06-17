# Videojet 1620 Control + Local WSI Emulator

This proof of concept can connect to a real Videojet 1620 over WSI Simple Protocol or to a built-in local emulator.

## Run

```powershell
npm install
npm start
```

Open `http://localhost:8080`.

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
