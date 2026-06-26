import net from 'node:net';
import tls from 'node:tls';

function encodeAddress(address) {
  return String(address || '').replace(/[<>\r\n]/g, '').trim();
}

function formatHeaders(headers) {
  return Object.entries(headers)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${String(value).replace(/\r?\n/g, ' ')}`)
    .join('\r\n');
}

function dotStuff(body) {
  return String(body || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function messageBody({ text, html }) {
  if (!html) return `Content-Type: text/plain; charset=utf-8\r\n\r\n${dotStuff(text)}`;
  const boundary = `vmm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    dotStuff(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    dotStuff(html),
    `--${boundary}--`
  ].join('\r\n');
}

function createReader(socket) {
  let buffer = '';
  const pending = [];

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    flush();
  });
  socket.on('error', (error) => {
    while (pending.length) pending.shift().reject(error);
  });
  socket.on('close', () => {
    while (pending.length) pending.shift().reject(new Error('SMTP connection closed.'));
  });

  function completeResponse(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return false;
    const last = lines[lines.length - 1];
    return /^\d{3} /.test(last);
  }

  function flush() {
    while (pending.length) {
      const index = buffer.search(/\r?\n/);
      if (index < 0) return;
      const lines = buffer.split(/\r?\n/);
      let endLine = -1;
      for (let i = 0; i < lines.length; i += 1) {
        if (/^\d{3} /.test(lines[i])) {
          endLine = i;
          break;
        }
      }
      if (endLine < 0) {
        if (!completeResponse(buffer)) return;
        endLine = lines.length - 1;
      }
      const response = lines.slice(0, endLine + 1).join('\n');
      buffer = lines.slice(endLine + 1).join('\r\n');
      pending.shift().resolve(response);
    }
  }

  function read() {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      flush();
    });
  }

  return { read };
}

function assertCode(response, expected) {
  const code = Number(String(response).slice(0, 3));
  const values = Array.isArray(expected) ? expected : [expected];
  if (!values.includes(code)) throw new Error(`SMTP command failed: ${response}`);
  return response;
}

async function writeCommand(socket, reader, command, expected) {
  socket.write(`${command}\r\n`);
  return assertCode(await reader.read(), expected);
}

async function connectSmtp(smtp) {
  const options = { host: smtp.host, port: smtp.port, timeout: smtp.timeoutMs };
  const socket = smtp.secure ? tls.connect(options) : net.connect(options);
  await new Promise((resolve, reject) => {
    socket.once(smtp.secure ? 'secureConnect' : 'connect', resolve);
    socket.once('timeout', () => reject(new Error('SMTP connection timed out.')));
    socket.once('error', reject);
  });
  return socket;
}

async function sendSmtpMail({ smtp, from, to, subject, text, html }) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length) throw new Error('At least one email recipient is required.');

  let socket = await connectSmtp(smtp);
  let reader = createReader(socket);
  try {
    assertCode(await reader.read(), 220);
    await writeCommand(socket, reader, 'EHLO videojet-message-manager', 250);

    if (!smtp.secure && smtp.requireTls) {
      await writeCommand(socket, reader, 'STARTTLS', 220);
      socket = tls.connect({ socket, servername: smtp.host });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      reader = createReader(socket);
      await writeCommand(socket, reader, 'EHLO videojet-message-manager', 250);
    }

    if (smtp.user || smtp.pass) {
      const token = Buffer.from(`\0${smtp.user}\0${smtp.pass}`).toString('base64');
      await writeCommand(socket, reader, `AUTH PLAIN ${token}`, 235);
    }

    await writeCommand(socket, reader, `MAIL FROM:<${encodeAddress(from)}>`, 250);
    for (const recipient of recipients) {
      await writeCommand(socket, reader, `RCPT TO:<${encodeAddress(recipient)}>`, [250, 251]);
    }
    await writeCommand(socket, reader, 'DATA', 354);

    const headers = formatHeaders({
      From: from,
      To: recipients.join(', '),
      Subject: subject,
      Date: new Date().toUTCString(),
      'MIME-Version': '1.0'
    });
    socket.write(`${headers}\r\n${messageBody({ text, html })}\r\n.\r\n`);
    assertCode(await reader.read(), 250);
    await writeCommand(socket, reader, 'QUIT', 221).catch(() => null);
    return { accepted: recipients };
  } finally {
    socket.end();
  }
}

export { sendSmtpMail };
