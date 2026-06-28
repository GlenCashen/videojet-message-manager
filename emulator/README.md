# WSI + Markem NGPCL Emulator

This folder contains the printer emulator used for local testing. The active version is the Node emulator in `emulator.js`; the older Python version is kept as a reference in `emulator.py`.

## Run

From the repo root:

```bash
npm run emulator
```

Or directly:

```bash
node emulator/emulator.js
```

Optional overrides:

```bash
node emulator/emulator.js --config emulator/config.json --ui-host 0.0.0.0 --ui-port 8098
```

Open UI:

```text
http://localhost:8098
```

## Configuration

You can configure the emulator from the browser UI or by editing `emulator/config.json` directly.

In the browser, open the **Configurator** tab to add/remove printers, messages, and fields. Click **Save config.json** to persist the changes. The save endpoint validates the config and creates a timestamped `.bak` file before overwriting `config.json`.

Live runtime changes from the **Live State** tab are also persistent. When you change the selected message, light/status, or a field value, the emulator updates `initial_state` in `config.json`, so the same state is restored after restart.

Notes:

- Message, field, and status changes are saved immediately.
- New printer listeners, port changes, host changes, or protocol changes require restarting the emulator.
- The raw JSON editor is available at the bottom of the Configurator tab for bulk edits.

Top-level sections:

- `printers` controls each TCP listener: `printer_id`, `protocol`, `host`, `port`, and `description`.
- `messages` assigns stored printer message names to a printer.
- `fields` assigns editable user fields to a message.
- `initial_state` sets the starting selected message, light state, and default field values.
- `light_states` controls WSI status values returned by `E`, `S`, or `STATUS`.
- `packml_states` controls the Markem/NGPCL PackML state value returned inside `{~DR|}` responses.

Example printer:

```json
{
  "printer_id": "coder-1",
  "protocol": "wsi",
  "host": "0.0.0.0",
  "port": 3101,
  "description": "Cans Videojet WSI emulator"
}
```

Example message:

```json
{
  "message_id": "catalog-cans-12m-e6d4f991",
  "printer_id": "coder-1",
  "printer_message_name": "CAT CAN 12M E6D4F9"
}
```

Example field:

```json
{
  "message_id": "catalog-cans-12m-e6d4f991",
  "field_key": "batch",
  "label": "Batch code",
  "printer_field_name": "BATCH",
  "default_value": "TEST123"
}
```

## Browser UI

The UI lets you change:

- Selected message
- Light/status state
- Active user field values

API endpoints:

```text
GET  /
GET  /api/state
GET  /api/config
POST /api/config
POST /api/set
```

Example `/api/set` payload:

```json
{
  "printer_id": "coder-1",
  "message": "CAT CAN 12M E6D4F9",
  "light": "green",
  "field:BATCH": "TBUNDRC-55"
}
```

## WSI tests

```bash
printf '\x02Q\x03' | nc -w 2 127.0.0.1 3101 | xxd
printf '\x02E\x03' | nc -w 2 127.0.0.1 3101 | xxd
printf '\x02MCAT CAN 12M E6D4F9\x03' | nc -w 2 127.0.0.1 3101 | xxd
printf '\x02UBATCH\nTBUNDRC-55\x03' | nc -w 2 127.0.0.1 3101 | xxd
printf '\x02GBATCH\x03' | nc -w 2 127.0.0.1 3101 | xxd
```

## Markem / NGPCL tests

```bash
printf '{~JR|}\r' | nc -w 2 127.0.0.1 21000 | xxd
printf '{~DR|}\r' | nc -w 2 127.0.0.1 21000 | xxd
printf '{~FR|Batch1|}\r' | nc -w 2 127.0.0.1 21000 | xxd
printf '{~FR|Batch|}\r' | nc -w 2 127.0.0.1 21000 | xxd
printf '{~JS0|Bundy 15 Month.job|0|}\r' | nc -w 2 127.0.0.1 21000 | xxd
printf '{~JU0||0|Batch1|T0067|Batch|TBUNDRC-51|}\r' | nc -w 2 127.0.0.1 21000 | xxd
```

Expected text examples:

```text
{~JN0|Bundy 15 Month.job|}
{~DS0|0|1|0|0|0|2|0|000000000|06|1|}
{~FC0|Batch1|T0067|}
{~FC0|Batch|TBUNDRC-51|}
{~JS0|}
{~JU0|}
```

## Legacy Python version

The old Python emulator can still be run from the emulator folder:

```bash
python3 emulator.py --ui-port 8098
```
