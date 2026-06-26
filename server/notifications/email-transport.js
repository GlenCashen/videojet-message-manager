import { sendSmtpMail } from './smtp-client.js';

function booleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function numberEnv(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function emailConfigFromEnv(env = process.env) {
  const transport = String(env.EMAIL_TRANSPORT || 'disabled').trim().toLowerCase();
  return {
    enabled: booleanEnv(env.EMAIL_ENABLED, false),
    transport,
    from: env.EMAIL_FROM || '',
    baseUrl: env.EMAIL_BASE_URL || env.APP_BASE_URL || '',
    smtp: {
      host: env.SMTP_HOST || '',
      port: numberEnv(env.SMTP_PORT, booleanEnv(env.SMTP_SECURE, false) ? 465 : 587),
      secure: booleanEnv(env.SMTP_SECURE, false),
      requireTls: booleanEnv(env.SMTP_REQUIRE_TLS, false),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      timeoutMs: numberEnv(env.SMTP_TIMEOUT_MS, 10000)
    }
  };
}

function createEmailTransport(config = emailConfigFromEnv()) {
  if (!config.enabled || config.transport === 'disabled') {
    return {
      name: 'disabled',
      async send(message) {
        return { skipped: true, reason: 'Email notifications are disabled.', message };
      }
    };
  }

  if (config.transport === 'log') {
    return {
      name: 'log',
      async send(message) {
        console.info('[notification:email]', JSON.stringify({
          to: message.to,
          subject: message.subject,
          text: message.text
        }));
        return { logged: true };
      }
    };
  }

  if (config.transport === 'smtp') {
    return {
      name: 'smtp',
      async send(message) {
        if (!config.from) throw new Error('EMAIL_FROM is required when EMAIL_TRANSPORT=smtp.');
        if (!config.smtp.host) throw new Error('SMTP_HOST is required when EMAIL_TRANSPORT=smtp.');
        return sendSmtpMail({
          ...message,
          from: message.from || config.from,
          smtp: config.smtp
        });
      }
    };
  }

  throw new Error(`Unsupported EMAIL_TRANSPORT: ${config.transport}`);
}

export { createEmailTransport, emailConfigFromEnv };
