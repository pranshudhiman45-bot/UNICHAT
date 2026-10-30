const nodemailer = require('nodemailer');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function localDelivery() { return process.env.EMAIL_TRANSPORT === 'file' && process.env.NODE_ENV !== 'production'; }

function configured() {
  return localDelivery() || Boolean(process.env.SMTP_HOST);
}

function createTransporter() {
  if (!process.env.SMTP_HOST) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
    requireTLS: port !== 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 8000,
  });
}

async function sendEmail(message) {
  message = { from: process.env.SMTP_FROM || 'Unichat <no-reply@localhost>', ...message };
  if (localDelivery()) {
    const directory = path.resolve(process.env.DEV_EMAIL_DIR || '../.local/mail');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${Date.now()}-${crypto.randomUUID()}.json`;
    await fs.writeFile(path.join(directory, filename), JSON.stringify({ ...message, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    console.log(`Development email saved to ${path.join(directory, filename)}`);
    return { messageId: filename, accepted: [message.to] };
  }
  const transporter = createTransporter();
  if (!transporter) throw new Error('SMTP is not configured');
  return transporter.sendMail(message);
}

module.exports = { configured, createTransporter, sendEmail, localDelivery };
