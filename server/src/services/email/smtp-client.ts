import net from 'net';
import tls, { type TLSSocket } from 'tls';
import { once } from 'events';
import type { ResolvedEmailRelay } from '../../db/queries/email.js';
import type { EmailSenderProfile } from '../../types/email.js';

interface SendSmtpMailInput {
  relay: ResolvedEmailRelay;
  sender: EmailSenderProfile;
  to: string;
  subject: string;
  text: string;
  html?: string | null;
}

interface SmtpResponse {
  code: number;
  message: string;
}

export interface SmtpSendResult {
  accepted: boolean;
  response?: string;
  error?: string;
  retryable: boolean;
}

export async function sendSmtpMail(input: SendSmtpMailInput): Promise<SmtpSendResult> {
  if (!input.relay.smtpHost || !input.relay.smtpPort) {
    return { accepted: false, error: 'SMTP host and port are required', retryable: false };
  }

  const client = new SmtpSession(input.relay);
  try {
    await client.connect();
    await client.ehlo();
    if (input.relay.smtpSecurity === 'starttls') {
      await client.startTls();
      await client.ehlo();
    }
    if (input.relay.username) {
      await client.auth(input.relay.username, input.relay.password ?? '');
    }
    const envelopeFrom = input.sender.envelopeFrom || input.sender.fromEmail;
    await client.command(`MAIL FROM:<${envelopeFrom}>`, [250]);
    await client.command(`RCPT TO:<${input.to}>`, [250, 251]);
    await client.command('DATA', [354]);
    await client.writeData(renderMessage(input));
    const accepted = await client.readResponse([250]);
    await client.quit();
    return { accepted: true, response: accepted.message, retryable: false };
  } catch (error) {
    client.close();
    const message = error instanceof Error ? error.message : 'SMTP delivery failed';
    return { accepted: false, error: message, retryable: isRetryableSmtpError(message) };
  }
}

class SmtpSession {
  private socket: net.Socket | TLSSocket | null = null;
  private buffer = '';

  constructor(private readonly relay: ResolvedEmailRelay) {}

  async connect(): Promise<void> {
    const host = this.relay.smtpHost!;
    const port = this.relay.smtpPort!;
    const implicitTls = this.relay.smtpSecurity === 'tls';
    this.socket = implicitTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: this.relay.tlsMode === 'strict' })
      : net.connect({ host, port });
    this.socket.setTimeout(15000);
    this.socket.on('timeout', () => this.socket?.destroy(new Error('SMTP connection timed out')));
    await once(this.socket, implicitTls ? 'secureConnect' : 'connect');
    await this.readResponse([220]);
  }

  async ehlo(): Promise<void> {
    try {
      await this.command('EHLO robin-admin.local', [250]);
    } catch {
      await this.command('HELO robin-admin.local', [250]);
    }
  }

  async startTls(): Promise<void> {
    await this.command('STARTTLS', [220]);
    const socket = this.requireSocket();
    this.socket = tls.connect({
      socket,
      servername: this.relay.smtpHost ?? undefined,
      rejectUnauthorized: this.relay.tlsMode === 'strict',
    });
    await once(this.socket, 'secureConnect');
    this.buffer = '';
  }

  async auth(username: string, password: string): Promise<void> {
    const token = Buffer.from(`\0${username}\0${password}`).toString('base64');
    try {
      await this.command(`AUTH PLAIN ${token}`, [235]);
      return;
    } catch {
      await this.command('AUTH LOGIN', [334]);
      await this.command(Buffer.from(username).toString('base64'), [334]);
      await this.command(Buffer.from(password).toString('base64'), [235]);
    }
  }

  async command(command: string, expected: number[]): Promise<SmtpResponse> {
    this.write(`${command}\r\n`);
    return this.readResponse(expected);
  }

  async writeData(message: string): Promise<void> {
    const escaped = message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    this.write(`${escaped}\r\n.\r\n`);
  }

  async quit(): Promise<void> {
    try {
      await this.command('QUIT', [221]);
    } finally {
      this.close();
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  async readResponse(expected: number[]): Promise<SmtpResponse> {
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        const code = Number(line.slice(0, 3));
        const message = lines.join('\n');
        if (!expected.includes(code)) {
          throw new Error(`SMTP ${code}: ${message.slice(0, 450)}`);
        }
        return { code, message };
      }
    }
  }

  private async readLine(): Promise<string> {
    while (!this.buffer.includes('\n')) {
      const socket = this.requireSocket();
      const [chunk] = await once(socket, 'data') as [Buffer];
      this.buffer += chunk.toString('utf8');
    }
    const index = this.buffer.indexOf('\n');
    const line = this.buffer.slice(0, index).replace(/\r$/, '');
    this.buffer = this.buffer.slice(index + 1);
    return line;
  }

  private write(data: string): void {
    this.requireSocket().write(data);
  }

  private requireSocket(): net.Socket | TLSSocket {
    if (!this.socket) throw new Error('SMTP socket is not connected');
    return this.socket;
  }
}

export function renderMessage(input: SendSmtpMailInput): string {
  const messageId = `<${Date.now()}.${Math.random().toString(16).slice(2)}@robin-admin.local>`;
  const headers = [
    `From: ${formatAddress(input.sender.fromName, input.sender.fromEmail)}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];
  if (input.sender.replyTo) headers.push(`Reply-To: ${input.sender.replyTo}`);
  if (input.html) {
    const boundary = `robin-admin-${Date.now().toString(16)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.text,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.html,
      `--${boundary}--`,
      '',
    ].join('\r\n');
  }
  headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit');
  return [...headers, '', input.text, ''].join('\r\n');
}

function formatAddress(name: string, email: string): string {
  const escaped = name.replace(/"/g, '\\"');
  return `"${escaped}" <${email}>`;
}

function encodeHeader(value: string): string {
  return /^[\x00-\x7F]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
}

function isRetryableSmtpError(message: string): boolean {
  if (/SMTP 4\d\d/.test(message)) return true;
  return /timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/i.test(message);
}
