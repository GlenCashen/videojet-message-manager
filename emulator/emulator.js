#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STX = 0x02;
const ETX = 0x03;
const ACK = Buffer.from('$8D', 'ascii');
const NAK = Buffer.from('!51', 'ascii');

const WSI_LIGHT_DEFAULTS = {
  green: '0000002',
  amber: '0000004',
  yellow: '0000004',
  blue: '0000004',
  red: '0000006',
  off: '0000000',
};

const NGPCL_PACKML_DEFAULTS = {
  green: '06',
  amber: '05',
  yellow: '05',
  blue: '09',
  red: '04',
  off: '11',
};

function parseArgs(argv) {
  const args = { config: 'config.json' };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];

    if (arg === '--config' && value) {
      args.config = value;
      i += 1;
    } else if (arg === '--ui-host' && value) {
      args.uiHost = value;
      i += 1;
    } else if (arg === '--ui-port' && value) {
      args.uiPort = Number.parseInt(value, 10);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node emulator/emulator.js [--config emulator/config.json] [--ui-host 0.0.0.0] [--ui-port 8098]');
      process.exit(0);
    }
  }

  return args;
}

function sameText(left, right) {
  return String(left || '').trim().toUpperCase() === String(right || '').trim().toUpperCase();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeJsonFile(filePath, data, { backup = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (backup && fs.existsSync(filePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(filePath, `${filePath}.${stamp}.bak`);
  }

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('Config must be a JSON object.');
  for (const key of ['printers', 'messages', 'fields']) {
    if (!Array.isArray(cfg[key])) throw new Error(`Config must include a ${key} array.`);
  }

  const printerIds = new Set();
  for (const printer of cfg.printers) {
    if (!printer.printer_id) throw new Error('Every printer needs printer_id.');
    if (printerIds.has(printer.printer_id)) throw new Error(`Duplicate printer_id: ${printer.printer_id}`);
    printerIds.add(printer.printer_id);
    if (!['wsi', 'ngpcl'].includes(String(printer.protocol || '').toLowerCase())) throw new Error(`Printer ${printer.printer_id} protocol must be wsi or ngpcl.`);
    if (!Number.isInteger(Number(printer.port)) || Number(printer.port) < 1) throw new Error(`Printer ${printer.printer_id} needs a valid port.`);
  }

  const messageIds = new Set();
  for (const message of cfg.messages) {
    if (!message.message_id) throw new Error('Every message needs message_id.');
    if (messageIds.has(message.message_id)) throw new Error(`Duplicate message_id: ${message.message_id}`);
    messageIds.add(message.message_id);
    if (!printerIds.has(message.printer_id)) throw new Error(`Message ${message.message_id} refers to unknown printer_id ${message.printer_id}.`);
    if (!message.printer_message_name) throw new Error(`Message ${message.message_id} needs printer_message_name.`);
  }

  for (const field of cfg.fields) {
    if (!field.message_id || !messageIds.has(field.message_id)) throw new Error(`Field ${field.printer_field_name || field.field_key || '(unnamed)'} refers to an unknown message_id.`);
    if (!field.field_key) throw new Error(`Field for message ${field.message_id} needs field_key.`);
    if (!field.printer_field_name) throw new Error(`Field ${field.field_key} needs printer_field_name.`);
  }
}

class PrinterState {
  constructor(printer, messages, fieldsByMessage, initialState = {}) {
    this.printerId = printer.printer_id;
    this.protocol = String(printer.protocol || 'wsi').trim().toLowerCase();
    this.host = printer.host || '0.0.0.0';
    this.port = Number.parseInt(printer.port, 10);
    this.description = printer.description || '';
    this.messages = messages;
    this.fieldsByMessage = fieldsByMessage;
    this.light = initialState.light || 'green';
    this.errorCode = initialState.error_code || '';
    this.errorText = initialState.error_text || '';
    this.userFields = {};

    const first = messages[0];
    const configuredId = initialState.current_message_id || first?.message_id;
    const current = messages.find((message) => message.message_id === configuredId) || first;
    this.currentMessageId = current?.message_id || '';
    this.currentMessageName = current?.printer_message_name || '';

    for (const [messageId, fields] of Object.entries(fieldsByMessage)) {
      if (!messages.some((message) => message.message_id === messageId)) continue;
      this.userFields[messageId] = this.userFields[messageId] || {};

      for (const field of fields) {
        this.userFields[messageId][field.printer_field_name] = field.default_value || '';
      }
    }

    for (const [messageId, values] of Object.entries(initialState.user_fields || {})) {
      this.userFields[messageId] = {
        ...(this.userFields[messageId] || {}),
        ...values,
      };
    }
  }

  activeFields() {
    return this.fieldsByMessage[this.currentMessageId] || [];
  }

  validMessageNames() {
    return this.messages.map((message) => message.printer_message_name);
  }

  messageByNameOrId(value) {
    const clean = String(value || '').trim();
    return this.messages.find((message) => clean === message.message_id || sameText(clean, message.printer_message_name)) || null;
  }

  fieldActualName(name) {
    const clean = String(name || '').trim();

    for (const field of this.activeFields()) {
      if (sameText(clean, field.field_key) || sameText(clean, field.printer_field_name)) {
        return field.printer_field_name;
      }
    }

    return null;
  }

  getField(name) {
    const actual = this.fieldActualName(name);
    if (!actual) return null;
    return (this.userFields[this.currentMessageId] || {})[actual] || '';
  }

  setField(name, value, allowUnknown = false) {
    let actual = this.fieldActualName(name);

    if (!actual) {
      if (!allowUnknown) return false;
      actual = String(name || '').trim();
    }

    if (!actual) return false;
    this.userFields[this.currentMessageId] = this.userFields[this.currentMessageId] || {};
    this.userFields[this.currentMessageId][actual] = String(value ?? '');
    return true;
  }

  selectMessage(value) {
    const message = this.messageByNameOrId(value);
    if (!message) return false;
    this.currentMessageId = message.message_id;
    this.currentMessageName = message.printer_message_name;
    return true;
  }
}

function buildStates(cfg) {
  validateConfig(cfg);
  const messagesByPrinter = new Map();
  const fieldsByMessage = {};

  for (const message of cfg.messages || []) {
    const list = messagesByPrinter.get(message.printer_id) || [];
    list.push(message);
    messagesByPrinter.set(message.printer_id, list);
  }

  for (const field of cfg.fields || []) {
    fieldsByMessage[field.message_id] = fieldsByMessage[field.message_id] || [];
    fieldsByMessage[field.message_id].push(field);
  }

  const states = [];

  for (const printer of cfg.printers || []) {
    const messages = messagesByPrinter.get(printer.printer_id) || [];
    if (!messages.length) continue;

    const initialStateKey = Object.keys(cfg.initial_state || {}).find((key) => sameText(key, printer.printer_id));
    const initialState = initialStateKey ? cfg.initial_state[initialStateKey] : {};
    states.push(new PrinterState(printer, messages, fieldsByMessage, initialState));
  }

  return states;
}

function loadConfig(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { cfg, states: buildStates(cfg) };
}

function captureRuntimeState(app, backup = false) {
  app.cfg.initial_state = app.cfg.initial_state || {};

  for (const state of app.statesById.values()) {
    app.cfg.initial_state[state.printerId] = {
      current_message_id: state.currentMessageId,
      light: state.light,
      error_code: state.errorCode,
      error_text: state.errorText,
      user_fields: clone(state.userFields),
    };
  }

  writeJsonFile(app.configPath, app.cfg, { backup });
}

function trimBytes(data) {
  let start = 0;
  let end = data.length;
  while (start < end && [0x00, 0x0d, 0x0a].includes(data[start])) start += 1;
  while (end > start && [0x00, 0x0d, 0x0a].includes(data[end - 1])) end -= 1;
  return data.subarray(start, end);
}

function clean(data) {
  let raw = trimBytes(data);
  const framed = raw[0] === STX && raw[raw.length - 1] === ETX;

  if (framed) raw = raw.subarray(1, raw.length - 1);
  raw = Buffer.from([...raw].filter((byte) => ![0x01, 0x12, 0x13].includes(byte)));

  return { text: raw.toString('ascii').trim(), framed };
}

function wsiFrame(text) {
  return Buffer.concat([Buffer.from([STX]), Buffer.from(String(text), 'ascii'), Buffer.from([ETX])]);
}

function ngpclParts(text) {
  let cleanText = String(text || '').trim();
  if (cleanText.startsWith('{') && cleanText.endsWith('}')) cleanText = cleanText.slice(1, -1);
  return cleanText.split('|');
}

function ngpclStatus(state, cfg) {
  const key = String(state.light || 'red').toLowerCase();
  const packmlStates = cfg.packml_states || {};
  const code = packmlStates[key] || NGPCL_PACKML_DEFAULTS[key] || NGPCL_PACKML_DEFAULTS.red;

  const templates = {
    green: `{~DS0|0|1|0|0|0|2|0|000000000|${code}|1|}`,
    off: `{~DS0|0|0|0|0|0|2|0|000000000|${code}|1|}`,
    yellow: `{~DS0|0|0|0|1|0|2|0|000000000|${code}|1|}`,
    amber: `{~DS0|0|0|0|1|0|2|0|000000000|${code}|1|}`,
    blue: `{~DS0|0|0|1|1|0|2|0|000000000|${code}|1|}`,
    red: `{~DS0|0|0|0|0|0|2|0|000000000|${code}|1|}`,
  };

  return templates[key] || templates.red;
}

function handleNgpcl(state, text, cfg) {
  const parts = ngpclParts(text);
  const head = String(parts[0] || '').toUpperCase();

  if (head === '~JR') return Buffer.from(`{~JN0|${state.currentMessageName}|}\r\n`, 'ascii');
  if (head === '~DR') return Buffer.from(`${ngpclStatus(state, cfg)}\r\n`, 'ascii');

  if (head === '~FR') {
    const field = parts[1] || '';
    const value = state.getField(field);
    if (value === null) return Buffer.from('{~FC1|}\r\n', 'ascii');
    return Buffer.from(`{~FC0|${state.fieldActualName(field) || field}|${value}|}\r\n`, 'ascii');
  }

  if (head === '~JS0') {
    return state.selectMessage(parts[1] || '') ? Buffer.from('{~JS0|}\r\n', 'ascii') : Buffer.from('{~JS1|}\r\n', 'ascii');
  }

  if (head === '~JU0') {
    let values = parts.slice(parts.length >= 3 ? 3 : 1);
    if (values[values.length - 1] === '') values = values.slice(0, -1);

    for (let i = 0; i < values.length - 1; i += 2) {
      state.setField(values[i], values[i + 1]);
    }

    return Buffer.from('{~JU0|}\r\n', 'ascii');
  }

  return Buffer.from('{~NK1|}\r\n', 'ascii');
}

function handleAdmin(state, text) {
  const [commandRaw, ...rest] = String(text || '').trim().split(/\s+/);
  const command = String(commandRaw || '').toLowerCase();
  const arg = rest.join(' ');

  if (command === 'json') return Buffer.from(`${JSON.stringify(stateDict(state), null, 2)}\n`, 'utf8');
  if (command === 'list') return Buffer.from(`${state.validMessageNames().join('\n')}\n`, 'utf8');

  if (command === 'light') {
    state.light = arg.toLowerCase().trim();
    return Buffer.from('OK\n', 'ascii');
  }

  if (command === 'error') {
    state.errorText = arg;
    state.light = 'red';
    return Buffer.from('OK\n', 'ascii');
  }

  if (command === 'clear') {
    state.errorCode = '';
    state.errorText = '';
    state.light = 'green';
    return Buffer.from('OK\n', 'ascii');
  }

  if (command === 'setmsg') {
    return state.selectMessage(arg) ? Buffer.from('OK\n', 'ascii') : Buffer.from('Message not found\n', 'ascii');
  }

  return Buffer.from('?\n', 'ascii');
}

function handleWsi(state, text, framed, cfg) {
  const up = String(text || '').toUpperCase().trim();

  if (up === 'Q' || up === 'GETMSG') return framed ? wsiFrame(state.currentMessageName) : Buffer.from(`${state.currentMessageName}\n`, 'ascii');

  if (up === 'E' || up === 'S' || up === 'STATUS') {
    const lightStates = cfg.light_states || WSI_LIGHT_DEFAULTS;
    const status = lightStates[String(state.light || 'off').toLowerCase()] || WSI_LIGHT_DEFAULTS.off;
    return framed ? wsiFrame(status) : Buffer.from(`${status}\n`, 'ascii');
  }

  if (up === 'F' || up === 'FAULT' || up === 'ERROR') {
    const value = `${state.errorCode}${state.errorCode && state.errorText ? ' ' : ''}${state.errorText}`.trim();
    return Buffer.from(`${value}\n`, 'ascii');
  }

  if (up.startsWith('M') && text.length > 1) return state.selectMessage(text.slice(1).trim()) ? ACK : NAK;

  if (up.startsWith('G') && text.length > 1) {
    const value = state.getField(text.slice(1).trim());
    return Buffer.from(`${value ?? ''}\n`, 'ascii');
  }

  if (up.startsWith('U') && text.length > 1) {
    const payload = text.slice(1);
    let key = '';
    let value = '';

    if (payload.includes('\n')) [key, value] = payload.split(/\n/, 2);
    else if (payload.includes('=')) [key, value] = payload.split(/=/, 2);
    else return NAK;

    key = key.trim();
    value = value.trim();
    if (!key || !value) return NAK;

    return state.setField(key, value) ? ACK : NAK;
  }

  return handleAdmin(state, text);
}

function stateDict(state) {
  return {
    printer_id: state.printerId,
    protocol: state.protocol,
    host: state.host,
    port: state.port,
    description: state.description,
    current_message_id: state.currentMessageId,
    current_message_name: state.currentMessageName,
    light: state.light,
    error_code: state.errorCode,
    error_text: state.errorText,
    fields: state.userFields[state.currentMessageId] || {},
    active_fields: state.activeFields().map((field) => field.printer_field_name),
    valid_messages: state.validMessageNames(),
  };
}

function commandComplete(buffer) {
  if (!buffer.length) return false;
  const text = buffer.toString('ascii').trimStart();
  if (buffer[0] === STX) return buffer[buffer.length - 1] === ETX;
  if (text.startsWith('{')) return buffer.includes('}'.charCodeAt(0));
  return buffer[buffer.length - 1] === 0x0a || buffer[buffer.length - 1] === 0x0d || buffer.length > 4096;
}

function hex(buffer) {
  return buffer.toString('hex').match(/.{1,2}/g)?.join(' ') || '';
}

function startPrinterServer(state, app) {
  const server = net.createServer((socket) => {
    const chunks = [];
    let done = false;
    let timer = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);

      const data = Buffer.concat(chunks);
      if (!data.length) {
        socket.end();
        return;
      }

      const { text, framed } = clean(data);
      const response = state.protocol === 'ngpcl' || text.startsWith('{')
        ? handleNgpcl(state, text, app.cfg)
        : handleWsi(state, text, framed, app.cfg);

      try {
        captureRuntimeState(app);
      } catch (error) {
        console.error(`Could not persist emulator state: ${error.message}`);
      }

      socket.write(response, () => socket.end());
      console.log(`${new Date().toLocaleTimeString()} ${state.printerId}(${state.protocol}):${state.port} <= ${hex(data)} / ${JSON.stringify(text)} => ${hex(response)}`);
    };

    const scheduleTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, 2000);
    };

    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (commandComplete(buffer)) finish();
      else scheduleTimeout();
    });

    socket.on('end', finish);
    socket.on('error', (error) => console.error(`Client error ${state.printerId}:${state.port}: ${error.message}`));
    scheduleTimeout();
  });

  server.listen(state.port, state.host, () => {
    console.log(`${state.printerId.padEnd(12)} ${state.protocol.toUpperCase().padEnd(5)} listening on ${state.host}:${state.port} current='${state.currentMessageName}' fields=${JSON.stringify(state.activeFields().map((field) => field.printer_field_name))}`);
  });

  return server;
}

const html = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Printer Emulator</title>
<style>
:root{color-scheme:dark}body{font-family:Arial,sans-serif;background:#101317;color:#eef2f5;margin:20px}.tabs{display:flex;gap:8px;margin:10px 0 18px}.tab{background:#17202a;border:1px solid #415165}.tab.active{background:#294057}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px}.card,.panel{background:#1a2028;border:1px solid #33404f;border-radius:12px;padding:14px}.top{display:flex;justify-content:space-between;gap:8px}.dot{display:inline-block;width:16px;height:16px;border-radius:50%;vertical-align:middle;margin-right:8px}.green{background:#20c261}.red{background:#e33}.amber,.yellow{background:#e5b927}.blue{background:#3182ff}.off{background:#777}button,input,select,textarea{margin:3px;padding:7px;border-radius:8px;border:1px solid #526173;background:#111820;color:#eef2f5}button{cursor:pointer}textarea{width:100%;min-height:360px;font-family:Consolas,monospace}.fields,.form-grid{display:grid;gap:6px}.form-grid{grid-template-columns:repeat(auto-fit,minmax(180px,1fr));align-items:end}.field-row{display:grid;grid-template-columns:minmax(90px,160px) 1fr;gap:6px;align-items:center}.muted{color:#9caabb;font-size:12px}.warn{color:#ffd166}.ok{color:#62d087}.bad{color:#ff7b7b}pre{background:#070a0f;padding:8px;border-radius:8px;overflow:auto;max-height:260px}.list{display:grid;gap:8px}.item{border:1px solid #33404f;background:#121923;border-radius:10px;padding:10px}.hidden{display:none}.actions{display:flex;gap:8px;flex-wrap:wrap}.pill{display:inline-block;padding:2px 7px;border-radius:999px;background:#283548;color:#c9d5e2;font-size:12px}.small-input{max-width:140px}
</style>
</head>
<body>
<h1>Printer Emulator</h1>
<p class="muted" id="status">Loading...</p>
<div class="tabs"><button id="liveTab" class="tab active" onclick="showTab('live')">Live State</button><button id="configTab" class="tab" onclick="showTab('config')">Configurator</button></div>
<section id="livePanel"><div id="app" class="grid"></div></section>
<section id="configPanel" class="hidden">
  <div class="panel">
    <h2>Configurator</h2>
    <p class="muted">Changes here are saved to <code>emulator/config.json</code>. Message and field changes are available after save; new listener ports need an emulator restart.</p>
    <p id="configStatus" class="muted"></p>
    <div class="actions"><button onclick="loadConfigEditor()">Reload config</button><button onclick="saveConfigEditor()">Save config.json</button><button onclick="formatConfigEditor()">Format JSON</button></div>
  </div>
  <div class="grid">
    <div class="panel">
      <h3>Add printer</h3>
      <div class="form-grid">
        <label>ID<input id="printerId" placeholder="coder-7"></label>
        <label>Protocol<select id="printerProtocol"><option>wsi</option><option>ngpcl</option></select></label>
        <label>Host<input id="printerHost" value="0.0.0.0"></label>
        <label>Port<input id="printerPort" type="number" placeholder="3107"></label>
        <label>Description<input id="printerDescription" placeholder="Line printer"></label>
        <button onclick="addPrinter()">Add printer</button>
      </div>
    </div>
    <div class="panel">
      <h3>Add message</h3>
      <div class="form-grid">
        <label>Printer<select id="messagePrinter"></select></label>
        <label>Message ID<input id="messageId" placeholder="coder-7-12m"></label>
        <label>Stored message name<input id="messageName" placeholder="12 Months.job"></label>
        <button onclick="addMessage()">Add message</button>
      </div>
    </div>
    <div class="panel">
      <h3>Add field</h3>
      <div class="form-grid">
        <label>Message<select id="fieldMessage"></select></label>
        <label>Field key<input id="fieldKey" placeholder="batch"></label>
        <label>Label<input id="fieldLabel" placeholder="Batch number"></label>
        <label>Printer field<input id="fieldPrinterName" placeholder="Batch"></label>
        <label>Default value<input id="fieldDefault" placeholder=""></label>
        <button onclick="addField()">Add field</button>
      </div>
    </div>
  </div>
  <div class="grid">
    <div class="panel"><h3>Printers</h3><div id="printerList" class="list"></div></div>
    <div class="panel"><h3>Messages</h3><div id="messageList" class="list"></div></div>
    <div class="panel"><h3>Fields</h3><div id="fieldList" class="list"></div></div>
  </div>
  <div class="panel"><h3>Raw JSON</h3><textarea id="configText" spellcheck="false"></textarea></div>
</section>
<script>
let editing=false;
let configDoc=null;
async function api(path,opts){const res=await fetch(path,opts);const text=await res.text();if(!res.ok)throw new Error(text);return text?JSON.parse(text):{};}
async function setv(id,k,v){editing=false;await api('/api/set',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({printer_id:id,[k]:v})});await load(true);}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function showTab(name){livePanel.classList.toggle('hidden',name!=='live');configPanel.classList.toggle('hidden',name!=='config');liveTab.classList.toggle('active',name==='live');configTab.classList.toggle('active',name==='config');if(name==='config'&&!configDoc)loadConfigEditor();}
function messageOptions(p){return p.valid_messages.map(m=>'<option '+(m===p.current_message_name?'selected':'')+'>'+esc(m)+'</option>').join('');}
function fields(p){const entries=Object.entries(p.fields||{});if(!entries.length)return '<p class="muted">No active user fields for this message.</p>';return '<div class="fields">'+entries.map(([k,v])=>'<label class="field-row"><span>'+esc(k)+'</span><input value="'+esc(v)+'" onfocus="editing=true" onblur="editing=false" onchange="setv(\''+esc(p.printer_id)+'\',\'field:'+esc(k)+'\',this.value)"></label>').join('')+'</div>';}
async function load(force=false){const active=document.activeElement;const isEditing=active&&['INPUT','SELECT','TEXTAREA'].includes(active.tagName);if(!force&&(editing||isEditing))return;const s=await api('/api/state');status.textContent='Last refresh: '+new Date().toLocaleTimeString();app.innerHTML=s.map(p=>'<section class="card"><div class="top"><h2><span class="dot '+esc(p.light)+'"></span>'+esc(p.printer_id)+'</h2><span class="muted">'+esc(p.protocol).toUpperCase()+' '+esc(p.host)+':'+esc(p.port)+'</span></div><p class="muted">'+esc(p.description||'')+'</p><p><b>Message:</b> '+esc(p.current_message_name)+'</p><p><b>Light:</b> '+esc(p.light)+'</p><p><b>Fields:</b></p>'+fields(p)+'<p><select onfocus="editing=true" onblur="editing=false" onchange="setv(\''+esc(p.printer_id)+'\',\'message\',this.value)">'+messageOptions(p)+'</select></p><p>'+['green','off','yellow','blue','red'].map(l=>'<button onclick="setv(\''+esc(p.printer_id)+'\',\'light\',\''+l+'\')">'+l+'</button>').join('')+'</p><pre>'+esc(JSON.stringify(p,null,2))+'</pre></section>').join('');}
async function loadConfigEditor(){configDoc=await api('/api/config');renderConfigEditor('Loaded config.');}
function syncFromText(){configDoc=JSON.parse(configText.value);}
function syncText(){configText.value=JSON.stringify(configDoc,null,2);}
function renderConfigEditor(message){syncText();configStatus.textContent=message||'';configStatus.className='muted ok';messagePrinter.innerHTML=(configDoc.printers||[]).map(p=>'<option value="'+esc(p.printer_id)+'">'+esc(p.printer_id)+'</option>').join('');fieldMessage.innerHTML=(configDoc.messages||[]).map(m=>'<option value="'+esc(m.message_id)+'">'+esc(m.message_id)+' — '+esc(m.printer_message_name)+'</option>').join('');printerList.innerHTML=(configDoc.printers||[]).map((p,i)=>'<div class="item"><b>'+esc(p.printer_id)+'</b> <span class="pill">'+esc(p.protocol)+'</span><br><span class="muted">'+esc(p.host)+':'+esc(p.port)+' '+esc(p.description||'')+'</span><br><button onclick="removePrinter('+i+')">Remove</button></div>').join('');messageList.innerHTML=(configDoc.messages||[]).map((m,i)=>'<div class="item"><b>'+esc(m.printer_message_name)+'</b><br><span class="muted">'+esc(m.message_id)+' / '+esc(m.printer_id)+'</span><br><button onclick="removeMessage('+i+')">Remove</button></div>').join('');fieldList.innerHTML=(configDoc.fields||[]).map((f,i)=>'<div class="item"><b>'+esc(f.printer_field_name)+'</b> <span class="pill">'+esc(f.field_key)+'</span><br><span class="muted">'+esc(f.message_id)+' '+esc(f.label||'')+'</span><br><button onclick="removeField('+i+')">Remove</button></div>').join('');}
function formatConfigEditor(){try{syncFromText();renderConfigEditor('JSON formatted.');}catch(e){configStatus.textContent=e.message;configStatus.className='bad';}}
async function saveConfigEditor(){try{syncFromText();const result=await api('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(configDoc)});renderConfigEditor(result.message||'Saved.');}catch(e){configStatus.textContent=e.message;configStatus.className='bad';}}
function addPrinter(){try{syncFromText();configDoc.printers=configDoc.printers||[];configDoc.printers.push({printer_id:printerId.value.trim(),protocol:printerProtocol.value,host:printerHost.value.trim()||'0.0.0.0',port:Number(printerPort.value),description:printerDescription.value.trim()});renderConfigEditor('Printer added. Save to persist.');}catch(e){configStatus.textContent=e.message;configStatus.className='bad';}}
function addMessage(){try{syncFromText();configDoc.messages=configDoc.messages||[];configDoc.messages.push({message_id:messageId.value.trim(),printer_id:messagePrinter.value,printer_message_name:messageName.value.trim()});renderConfigEditor('Message added. Save to persist.');}catch(e){configStatus.textContent=e.message;configStatus.className='bad';}}
function addField(){try{syncFromText();configDoc.fields=configDoc.fields||[];const field={message_id:fieldMessage.value,field_key:fieldKey.value.trim(),label:fieldLabel.value.trim(),printer_field_name:fieldPrinterName.value.trim()};if(fieldDefault.value)field.default_value=fieldDefault.value;configDoc.fields.push(field);renderConfigEditor('Field added. Save to persist.');}catch(e){configStatus.textContent=e.message;configStatus.className='bad';}}
function removePrinter(i){syncFromText();const id=configDoc.printers[i].printer_id;configDoc.printers.splice(i,1);configDoc.messages=(configDoc.messages||[]).filter(m=>m.printer_id!==id);const msgIds=new Set(configDoc.messages.map(m=>m.message_id));configDoc.fields=(configDoc.fields||[]).filter(f=>msgIds.has(f.message_id));renderConfigEditor('Printer and linked messages/fields removed. Save to persist.');}
function removeMessage(i){syncFromText();const id=configDoc.messages[i].message_id;configDoc.messages.splice(i,1);configDoc.fields=(configDoc.fields||[]).filter(f=>f.message_id!==id);renderConfigEditor('Message and linked fields removed. Save to persist.');}
function removeField(i){syncFromText();configDoc.fields.splice(i,1);renderConfigEditor('Field removed. Save to persist.');}
load();setInterval(()=>load(false),1000);
</script>
</body>
</html>`;

function send(res, statusCode, contentType, body) {
  const payload = Buffer.from(String(body), 'utf8');
  res.writeHead(statusCode, { 'content-type': contentType, 'content-length': payload.length, connection: 'close' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startUiServer(app, host, port) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', html);
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify([...app.statesById.values()].map(stateDict)));
      if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(app.cfg, null, 2));

      if (req.method === 'POST' && url.pathname === '/api/config') {
        const nextConfig = JSON.parse(await readBody(req) || '{}');
        validateConfig(nextConfig);
        writeJsonFile(app.configPath, nextConfig, { backup: true });
        app.cfg = nextConfig;
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, message: 'Saved config.json. Restart emulator to apply listener/port changes.' }));
      }

      if (req.method === 'POST' && url.pathname === '/api/set') {
        const data = JSON.parse(await readBody(req) || '{}');
        const state = app.statesById.get(data.printer_id);
        if (!state) return send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: 'Printer not found' }));

        for (const [key, value] of Object.entries(data)) {
          if (key === 'printer_id') continue;
          if (key === 'light') state.light = String(value).toLowerCase();
          else if (key === 'message') state.selectMessage(value);
          else if (key.startsWith('field:')) state.setField(key.slice('field:'.length), value, true);
          else if (key === 'error_code') state.errorCode = String(value || '');
          else if (key === 'error_text') state.errorText = String(value || '');
        }

        captureRuntimeState(app);
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, persisted: true }));
      }

      return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (error) {
      return send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: error.message }));
    }
  });

  server.listen(port, host, () => console.log(`Dashboard    HTTP  listening on http://${host}:${port}`));
  return server;
}

function resolveConfigPath(configArg, emulatorDir) {
  if (path.isAbsolute(configArg)) return configArg;

  const cwdPath = path.resolve(process.cwd(), configArg);
  if (fs.existsSync(cwdPath)) return cwdPath;

  return path.resolve(emulatorDir, configArg);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const emulatorDir = path.dirname(fileURLToPath(import.meta.url));
  const configPath = resolveConfigPath(args.config, emulatorDir);
  const { cfg, states } = loadConfig(configPath);
  const app = {
    cfg,
    configPath,
    statesById: new Map(states.map((state) => [state.printerId, state])),
  };
  const uiHost = args.uiHost || cfg.ui?.host || '0.0.0.0';
  const uiPort = args.uiPort || Number.parseInt(cfg.ui?.port || 8098, 10);
  const servers = [startUiServer(app, uiHost, uiPort), ...states.map((state) => startPrinterServer(state, app))];

  captureRuntimeState(app);

  console.log(`\nUI:          open http://127.0.0.1:${uiPort}`);
  console.log("WSI test:    printf '\\x02Q\\x03' | nc -w 2 127.0.0.1 3101 | xxd");
  console.log("WSI update:  printf '\\x02UBATCH\\nTBUNDRC-55\\x03' | nc -w 2 127.0.0.1 3101 | xxd");
  console.log("NGPCL test:  printf '{~JR|}\\r' | nc -w 2 127.0.0.1 21000 | xxd");
  console.log("Status:      printf '{~DR|}\\r' | nc -w 2 127.0.0.1 21000 | xxd");
  console.log('Stop:        Ctrl+C\n');

  const stop = () => {
    console.log('\nStopping emulator...');
    for (const server of servers) server.close();
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
