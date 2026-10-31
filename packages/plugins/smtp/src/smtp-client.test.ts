import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpError, SmtpTransport, dotStuff } from '../src/smtp-client.js';

/**
 * 极简内存 SMTP 服务器：只实现测试需要的握手/认证/投递，用于端到端验证
 * 客户端的命令序列、点转义、认证与错误传播，无需真实网络。
 */
interface FakeServer {
  server: Server;
  port: number;
  mails: Array<{ from: string; to: string[]; raw: string }>;
  commands: string[];
  close: () => Promise<void>;
}

async function startFakeSmtp(
  options: {
    auth?: boolean;
    failRcpt?: boolean;
    rejectAuth?: boolean;
    /** Drop the connection right after accepting a message (idle-close like Exmail). */
    closeAfterMail?: boolean;
  } = {},
) {
  const mails: FakeServer['mails'] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let inData = false;
    let dataLines: string[] = [];
    let from = '';
    let to: string[] = [];
    const write = (line: string) => socket.write(`${line}\r\n`);

    write('220 fake ESMTP ready');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mails.push({ from, to, raw: dataLines.join('\n') });
            dataLines = [];
            from = '';
            to = [];
            write('250 OK queued');
            if (options.closeAfterMail) socket.end();
          } else {
            dataLines.push(line.replace(/^\.\./, '.'));
          }
          continue;
        }
        commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-fake\r\n');
          if (options.auth) socket.write('250-AUTH PLAIN LOGIN\r\n');
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          if (options.rejectAuth) write('535 认证失败');
          else write('235 认证成功');
        } else if (upper.startsWith('AUTH LOGIN')) {
          write('334 VXNlcm5hbWU6');
        } else if (upper.startsWith('MAIL FROM:')) {
          from = line.slice(line.indexOf('<') + 1, line.indexOf('>'));
          write('250 OK');
        } else if (upper.startsWith('RCPT TO:')) {
          if (options.failRcpt) {
            write('550 收件人被拒绝');
          } else {
            to.push(line.slice(line.indexOf('<') + 1, line.indexOf('>')));
            write('250 OK');
          }
        } else if (upper === 'DATA') {
          inData = true;
          write('354 开始发送数据');
        } else if (upper === 'QUIT') {
          write('221 Bye');
          socket.end();
        } else {
          write('250 OK');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    server,
    port: address.port,
    mails,
    commands,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  } satisfies FakeServer;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('SmtpTransport', () => {
  it('reconnects when the server closed the pooled connection', async () => {
    // Real behaviour: the provider closes an idle connection; the pool kept the
    // dead object and the next send threw 「连接未建立」 without trying.
    const fake = await startFakeSmtp({ closeAfterMail: true });
    cleanups.push(fake.close);
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: fake.port,
      secure: false,
      allowInsecure: true,
      from: 'noreply@example.com',
      commandTimeoutMs: 500,
    });
    cleanups.push(async () => transport.close());

    await transport.send({ to: 'a@example.com', raw: 'Subject: a\r\n\r\n1' });
    // Let the server's FIN land so the pooled connection is dead before reuse.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await transport.send({ to: 'b@example.com', raw: 'Subject: b\r\n\r\n2' });
    expect(fake.mails.map((mail) => mail.to)).toEqual([['a@example.com'], ['b@example.com']]);
  });

  it('delivers a message end to end, dot-stuffing the body', async () => {
    const fake = await startFakeSmtp();
    cleanups.push(fake.close);
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: fake.port,
      secure: false,
      allowInsecure: true,
      from: 'noreply@example.com',
    });
    cleanups.push(async () => transport.close());

    await transport.send({
      to: 'user@example.com',
      raw: 'Subject: Hi\r\n\r\nline1\r\n.\r\nline2',
    });

    expect(fake.mails).toHaveLength(1);
    expect(fake.mails[0]!.from).toBe('noreply@example.com');
    expect(fake.mails[0]!.to).toEqual(['user@example.com']);
    // The literal "." line was re-escaped and restored by the server.
    expect(fake.mails[0]!.raw).toContain('\n.\nline2');
    expect(fake.commands.some((c) => c.startsWith('MAIL FROM:'))).toBe(true);
    expect(fake.commands).toContain('DATA');
  });

  it('authenticates with AUTH PLAIN when the server advertises AUTH', async () => {
    const fake = await startFakeSmtp({ auth: true });
    cleanups.push(fake.close);
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: fake.port,
      secure: false,
      allowInsecure: true,
      from: 'noreply@example.com',
      auth: { user: 'me', pass: 'secret' },
    });
    cleanups.push(async () => transport.close());

    await transport.send({
      to: 'user@example.com',
      raw: 'Subject: Hi\r\n\r\nbody',
    });

    const auth = fake.commands.find((c) => c.toUpperCase().startsWith('AUTH PLAIN'));
    expect(auth).toBeDefined();
    const token = auth!.split(' ')[2];
    expect(Buffer.from(token!, 'base64').toString('utf8')).toBe('\0me\0secret');
  });

  it('rejects the delivery when the recipient is refused (no silent success)', async () => {
    const fake = await startFakeSmtp({ failRcpt: true });
    cleanups.push(fake.close);
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: fake.port,
      secure: false,
      allowInsecure: true,
      from: 'noreply@example.com',
    });
    cleanups.push(async () => transport.close());

    await expect(
      transport.send({
        to: 'user@example.com',
        raw: 'Subject: Hi\r\n\r\nbody',
      }),
    ).rejects.toBeInstanceOf(SmtpError);
    expect(fake.mails).toHaveLength(0);
  });

  it('surfaces an authentication failure', async () => {
    const fake = await startFakeSmtp({ auth: true, rejectAuth: true });
    cleanups.push(fake.close);
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: fake.port,
      secure: false,
      allowInsecure: true,
      from: 'noreply@example.com',
      auth: { user: 'me', pass: 'wrong' },
    });
    cleanups.push(async () => transport.close());

    await expect(
      transport.send({
        to: 'user@example.com',
        raw: 'Subject: Hi\r\n\r\nbody',
      }),
    ).rejects.toBeInstanceOf(SmtpError);
  });

  it('requires TLS by default and refuses a plaintext-only server', async () => {
    const fake = await startFakeSmtp();
    cleanups.push(fake.close);
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: fake.port,
      secure: false,
      requireStartTls: true,
      from: 'noreply@example.com',
    });
    cleanups.push(async () => transport.close());

    await expect(
      transport.send({
        to: 'user@example.com',
        raw: 'Subject: Hi\r\n\r\nbody',
      }),
    ).rejects.toBeInstanceOf(SmtpError);
  });

  it('reuses a pooled connection across sequential sends', async () => {
    const fake = await startFakeSmtp();
    cleanups.push(fake.close);
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: fake.port,
      secure: false,
      allowInsecure: true,
      from: 'noreply@example.com',
      maxConnections: 1,
    });
    cleanups.push(async () => transport.close());

    await transport.send({ to: 'a@example.com', raw: 'Subject: one\r\n\r\n1' });
    await transport.send({ to: 'b@example.com', raw: 'Subject: two\r\n\r\n2' });

    expect(fake.mails).toHaveLength(2);
    // Greeting/EHLO exchanged once: the second send reused the connection.
    expect(fake.commands.filter((c) => c.toUpperCase().startsWith('EHLO'))).toHaveLength(1);
  });

  it('times out instead of hanging forever when the server goes silent mid-DATA', async () => {
    // A server that accepts DATA then never replies: without a real read
    // timeout the client would await forever and hold a pool slot.
    const silent = await startSilentDataServer();
    cleanups.push(silent.close);
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: silent.port,
      secure: false,
      allowInsecure: true,
      from: 'noreply@example.com',
      commandTimeoutMs: 200,
      sendTimeoutMs: 500,
    });
    cleanups.push(async () => transport.close());

    await expect(
      transport.send({
        to: 'user@example.com',
        raw: 'Subject: Hi\r\n\r\nbody',
      }),
    ).rejects.toBeInstanceOf(SmtpError);
  });

  it('does not hang a later send when an earlier one stalls (slot is reclaimed)', async () => {
    const silent = await startSilentDataServer();
    cleanups.push(silent.close);
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: silent.port,
      secure: false,
      allowInsecure: true,
      from: 'noreply@example.com',
      maxConnections: 1,
      commandTimeoutMs: 200,
      sendTimeoutMs: 500,
    });
    cleanups.push(async () => transport.close());

    // Both serial sends must each time out and settle; neither may hang.
    await expect(
      transport.send({ to: 'a@example.com', raw: 'Subject: a\r\n\r\n1' }),
    ).rejects.toBeInstanceOf(SmtpError);
    await expect(
      transport.send({ to: 'b@example.com', raw: 'Subject: b\r\n\r\n2' }),
    ).rejects.toBeInstanceOf(SmtpError);
  });

  it('fails fast with backpressure once the pending queue is full', async () => {
    const silent = await startSilentDataServer();
    cleanups.push(silent.close);
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: silent.port,
      secure: false,
      allowInsecure: true,
      from: 'noreply@example.com',
      maxConnections: 1,
      maxQueue: 1,
      commandTimeoutMs: 400,
      sendTimeoutMs: 1_200,
    });
    cleanups.push(async () => transport.close());

    const first = transport.send({
      to: 'a@example.com',
      raw: 'Subject: a\r\n\r\n1',
    });
    // Let the first send occupy the only connection and reach DATA.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = transport.send({
      to: 'b@example.com',
      raw: 'Subject: b\r\n\r\n2',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = transport.send({
      to: 'c@example.com',
      raw: 'Subject: c\r\n\r\n3',
    });

    // Third exceeds (maxConnections=1 + maxQueue=1): must reject, not queue forever.
    await expect(third).rejects.toBeInstanceOf(SmtpError);
    // The other two settle (timeout) rather than hanging the test.
    await expect(first).rejects.toBeInstanceOf(SmtpError);
    await expect(second).rejects.toBeInstanceOf(SmtpError);
  });

  it('dotStuff is exported and idempotent for safe content', () => {
    expect(dotStuff('hello\r\nworld')).toBe('hello\r\nworld');
  });
});

/** A server that accepts DATA then stays silent, to exercise read timeouts. */
async function startSilentDataServer() {
  const sockets = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let inData = false;
    let buffer = '';
    socket.write('220 silent ESMTP ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) continue; // swallow the body and never answer
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) socket.write('250 silent\r\n');
        else if (upper.startsWith('MAIL FROM:')) socket.write('250 OK\r\n');
        else if (upper.startsWith('RCPT TO:')) socket.write('250 OK\r\n');
        else if (upper === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    server,
    port: address.port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
