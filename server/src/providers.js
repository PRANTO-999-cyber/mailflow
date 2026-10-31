import nodemailer from 'nodemailer';
import crypto from 'node:crypto';

const asText = value => String(value ?? '');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => crypto.createHmac('sha256', key).update(value).digest(encoding);

function awsCredentials() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for Amazon SES API.');
  return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN || '' };
}

// Minimal AWS Signature Version 4 signer for the SESv2 HTTPS API. Credentials stay server-side.
async function sesRequest(method, path, payload = undefined) {
  const region = process.env.AWS_REGION || 'us-east-1';
  const { accessKeyId, secretAccessKey, sessionToken } = awsCredentials();
  const host = `email.${region}.amazonaws.com`;
  const url = `https://${host}${path}`;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    host,
    'x-amz-date': amzDate,
    'content-type': 'application/json',
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {})
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${String(headers[k]).trim()}\n`).join('');
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const scope = `${dateStamp}/${region}/ses/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 'ses');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) {
    const error = new Error(data.message || data.Message || `Amazon SES API request failed (${response.status}).`);
    error.statusCode = response.status;
    error.code = response.status === 429 ? 'RATE_LIMIT' : (data.name || data.code || 'SES_API');
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }
  return data;
}


function mimeBase64(value) {
  return Buffer.from(value).toString('base64').replace(/.{1,76}/g, '$&\r\n').trim();
}
function safeHeader(value) { return String(value || '').replace(/[\r\n]+/g, ' ').trim(); }
function buildRawMime(mail, from) {
  const mixed = `mixed-${crypto.randomUUID()}`;
  const alternative = `alt-${crypto.randomUUID()}`;
  const subject = `=?UTF-8?B?${Buffer.from(safeHeader(mail.subject)).toString('base64')}?=`;
  const headers = [
    `From: ${safeHeader(mail.from || from.email)}`,
    `To: ${safeHeader(mail.to)}`,
    `Subject: ${subject}`,
    ...(mail.replyTo ? [`Reply-To: ${safeHeader(mail.replyTo)}`] : []),
    ...Object.entries(mail.headers || {}).filter(([k]) => /^[A-Za-z0-9-]+$/.test(k)).map(([k,v]) => `${k}: ${safeHeader(v)}`),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    ''
  ];
  const parts = [];
  if (mail.text) parts.push(`--${alternative}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${mimeBase64(mail.text)}\r\n`);
  if (mail.html) parts.push(`--${alternative}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${mimeBase64(mail.html)}\r\n`);
  parts.push(`--${alternative}--\r\n`);
  for (const attachment of mail.attachments || []) {
    const filename = safeHeader(attachment.filename || 'attachment.pdf').replace(/[\"\\]/g, '_');
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.contentType || '') ? attachment.contentType : 'application/octet-stream';
    parts.push(`--${mixed}\r\nContent-Type: ${type}; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${mimeBase64(attachment.content)}\r\n`);
  }
  parts.push(`--${mixed}--\r\n`);
  return Buffer.from([...headers, ...parts].join('\r\n'), 'utf8').toString('base64');
}

function parseFrom(mail, sender) {
  const match = /<([^>]+)>/.exec(mail.from || '');
  const email = match?.[1] || sender.fromEmail || sender.user;
  const name = String(mail.from || '').replace(/<[^>]+>/, '').replaceAll('"', '').trim();
  return { email, name };
}

/** API providers: Brevo and Amazon SES v2. SMTP remains for Gmail and approved SMTP relays. */
export async function sendThroughProvider({ provider = 'smtp', sender, mail }) {
  if (provider === 'ses') {
    const from = parseFrom(mail, sender);
    const content = mail.attachments?.length
      ? { Raw: { Data: buildRawMime(mail, from) } }
      : { Simple: { Subject: { Data: asText(mail.subject), Charset: 'UTF-8' }, Body: { ...(mail.text ? { Text: { Data: asText(mail.text), Charset: 'UTF-8' } } : {}), ...(mail.html ? { Html: { Data: asText(mail.html), Charset: 'UTF-8' } } : {}) } } };
    const payload = { FromEmailAddress: from.name ? `${from.name} <${from.email}>` : from.email, Destination: { ToAddresses: [mail.to] }, Content: content, ...(mail.replyTo ? { ReplyToAddresses: [mail.replyTo] } : {}), ...(process.env.SES_CONFIGURATION_SET ? { ConfigurationSetName: process.env.SES_CONFIGURATION_SET } : {}) };
    const data = await sesRequest('POST', '/v2/email/outbound-emails', payload);
    return { messageId: data.MessageId || '', response: 'Accepted by Amazon SES API', accepted: true };
  }
  if (provider === 'brevo') {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) throw new Error('BREVO_API_KEY is required for the Brevo API provider.');
    const from = parseFrom(mail, sender);
    const payload = { sender: from, to: [{ email: mail.to }], subject: asText(mail.subject), textContent: asText(mail.text), htmlContent: asText(mail.html), replyTo: mail.replyTo ? { email: mail.replyTo } : undefined, headers: mail.headers, attachment: mail.attachments?.map(a => ({ name: a.filename, content: Buffer.from(a.content).toString('base64') })) };
    const response = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.message || `Brevo API request failed (${response.status}).`); error.statusCode = response.status; error.code = response.status === 429 ? 'RATE_LIMIT' : 'BREVO_API'; error.retryAfter = response.headers.get('retry-after'); throw error; }
    return { messageId: data.messageId || '', response: 'Accepted by Brevo API', accepted: true };
  }
  const transport = nodemailer.createTransport({ host: sender.host, port: sender.port, secure: sender.port === 465, auth: { user: sender.user, pass: sender.pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  try { return await transport.sendMail(mail); } finally { transport.close(); }
}

export async function verifyProvider({ provider = 'smtp', sender }) {
  if (provider === 'ses') { await sesRequest('GET', '/v2/email/account'); return true; }
  if (provider === 'brevo') {
    if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY is required for the Brevo API provider.');
    const response = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': process.env.BREVO_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Brevo API verification failed (${response.status}).`);
    return true;
  }
  const transport = nodemailer.createTransport({ host: sender.host, port: sender.port, secure: sender.port === 465, auth: { user: sender.user, pass: sender.pass }, connectionTimeout: 15000, greetingTimeout: 15000 });
  try { await transport.verify(); return true; } finally { transport.close(); }
}
