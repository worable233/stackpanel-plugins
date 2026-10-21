import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

/**
 * 极简 SMTP 客户端（零外部依赖）。
 *
 * 内核插件包经 esbuild 打包、`node_modules` 由工作区共享，无法可靠引入
 * `nodemailer` 之类的重型依赖；因此这里用 Node 内置的 `node:net` / `node:tls`
 * 直接实现 SMTP 会话，覆盖真实邮件网关常见的三类接入：
 *
 *   - 隐式 TLS（465，`secure: true`）；
 *   - STARTTLS（587/25，连接后升级为 TLS）；
 *   - 明文（仅本地/内网测试，`secure: false` 且关闭 STARTTLS）。
 *
 * 认证：`AUTH PLAIN` 与 `AUTH LOGIN`（按服务端 EHLO 能力择优）。
 *
 * 传输可靠性：连接复用（池）、单消息并发上限、令牌桶限速、连接/命令超时；
 * 任一环节失败都会丢弃连接并抛出，交由内核投递记录做指数退避重试。
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** 隐式 TLS（SMTPS，通常 465）。 */
  secure: boolean;
  /** 使用 STARTTLS 升级明文连接（通常 587）。与 `secure` 互斥。 */
  requireStartTls?: boolean;
  /** 允许在服务端不支持 STARTTLS 时继续明文发送（默认 false，安全优先）。 */
  allowInsecure?: boolean;
  /** 校验证书（默认 true；仅测试用自签证书时才关闭）。 */
  rejectUnauthorized?: boolean;
  auth?: {
    user: string;
    pass: string;
    /** 强制认证方式；缺省按服务端能力自动选择。 */
    method?: 'plain' | 'login';
  };
  /** 发件人（信封与 From 头）。 */
  from: string;
  fromName?: string;
  /** 连接超时（毫秒）。 */
  connectionTimeoutMs?: number;
  /**
   * 单条命令/静默读超时（毫秒）。服务端在会话中途「安静掉」（不关连接也不回响应）
   * 时，据此主动断开并抛错，而**不是**永久挂起占用连接。
   */
  commandTimeoutMs?: number;
  /**
   * 一条消息从取连接起算的整体发送时限（毫秒）。作为命令级超时的兜底，
   * 且应**小于内核投递租约**（`NotificationDispatcher` 认领后 60s 可被重投），
   * 否则一次卡死的发送会被内核判为失败并重发，造成重复投递。
   */
  sendTimeoutMs?: number;
  /** 连接池上限（并发连接数）。 */
  maxConnections?: number;
  /**
   * 等待池的非阻塞排队上限（背压）。池满且排队数达到此值时**快速失败**，
   * 交由内核退避重试，而不是让请求在内存里无界堆积。
   */
  maxQueue?: number;
  /** 每分钟投递上限（令牌桶）；0/缺省表示不限速。 */
  ratePerMinute?: number;
}

export interface SmtpMessage {
  to: string | string[];
  /** 完整 RFC 5322 报文（含头部）。 */
  raw: string;
  from?: string;
}

/** SMTP 会话/协议错误。 */
export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 3;
const DEFAULT_MAX_QUEUE = 100;
/**
 * 整体发送时限默认值：恒定小于内核投递租约（`sweep` 认领后 60s 可重投），
 * 保证卡死的发送会在被内核重投前先自行失败。
 */
const DEFAULT_SEND_TIMEOUT_MS = 45_000;
/** 单连接上「读」操作的内部上限，防止 pool 等待与命令超时互相叠加。 */
const POOL_ACQUIRE_TIMEOUT_MS = 30_000;

/* ------------------------------- 连接池 -------------------------------- */

class SmtpPool {
  private readonly idle: SmtpConnection[] = [];
  private active = 0;
  private readonly waiters: Array<{
    resolve: (connection: SmtpConnection) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly maxConnections: number;
  private readonly maxQueue: number;
  private readonly ratePerMinute: number;
  private readonly sendTimeoutMs: number;
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly config: SmtpConfig,
    private readonly logger: { warn: (message: string) => void },
  ) {
    this.maxConnections = Math.max(1, config.maxConnections ?? DEFAULT_MAX_CONNECTIONS);
    this.maxQueue = Math.max(0, config.maxQueue ?? DEFAULT_MAX_QUEUE);
    this.ratePerMinute = Math.max(0, config.ratePerMinute ?? 0);
    this.sendTimeoutMs = Math.max(1, config.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
    this.tokens = this.ratePerMinute;
  }

  async send(message: SmtpMessage): Promise<void> {
    // 令牌桶限速（若开启）也纳入整体发送时限内。
    await this.withDeadline(
      this.sendTimeoutMs,
      async () => {
        await this.acquireRateToken();
        const connection = await this.acquire();
        try {
          await connection.send(message);
          this.idle.push(connection); // 成功：归还连接复用
        } catch (error) {
          connection.destroy(); // 失败：丢弃，避免污染后续会话
          throw error;
        } finally {
          this.active -= 1;
          this.wake();
        }
      },
      'SMTP 发送超时',
    );
  }

  /** 关闭所有空闲连接（插件停用/配置变更时调用）。 */
  close(): void {
    for (const connection of this.idle.splice(0)) connection.destroy();
    // 排队中的请求不再等待：立即失败，交由内核退避重试。
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new SmtpError('SMTP 连接池已关闭'));
    }
  }

  private async acquire(): Promise<SmtpConnection> {
    const reused = this.idle.pop();
    if (reused) {
      this.active += 1;
      return reused;
    }
    // 池未满：直接新建（建连本身受 connectionTimeoutMs 约束）。
    if (this.active < this.maxConnections) {
      return this.connectNew();
    }
    // 池已满：进入有界等待队列。队列也满则快速失败（背压），避免内存无界增长。
    if (this.waiters.length >= this.maxQueue) {
      throw new SmtpError(
        `SMTP 连接池繁忙（并发上限 ${this.maxConnections}，排队上限 ${this.maxQueue}）`,
      );
    }
    return new Promise<SmtpConnection>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 超时后把自己移出等待队列，避免占用名额。
        const index = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new SmtpError('等待 SMTP 连接超时'));
      }, POOL_ACQUIRE_TIMEOUT_MS);
      const wrapped = (connection: SmtpConnection): void => {
        if (settled) {
          // 已超时/关闭，但拿到一条空闲连接——归还而非泄漏。
          this.idle.push(connection);
          this.wake();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(connection);
      };
      this.waiters.push({ resolve: wrapped, reject });
    });
  }

  private async connectNew(): Promise<SmtpConnection> {
    this.active += 1;
    const connection = new SmtpConnection(this.config, this.logger);
    try {
      await connection.connect();
      return connection;
    } catch (error) {
      connection.destroy();
      this.active -= 1;
      this.wake();
      throw error;
    }
  }

  private wake(): void {
    // 优先把空闲连接交给等待者，否则放行一个等待者去新建连接。
    const waiter = this.waiters.shift();
    if (!waiter) return;
    const idle = this.idle.pop();
    if (idle) {
      this.active += 1;
      waiter.resolve(idle);
      return;
    }
    this.active += 1;
    const connection = new SmtpConnection(this.config, this.logger);
    connection
      .connect()
      .then(() => waiter.resolve(connection))
      .catch((error: unknown) => {
        connection.destroy();
        this.active -= 1;
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
        this.wake();
      });
  }

  /** 给一个操作套上整体时限；超时即抛错（底层 socket 由命令级超时自行断开）。 */
  private async withDeadline<T>(ms: number, fn: () => Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SmtpError(message)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async acquireRateToken(): Promise<void> {
    if (this.ratePerMinute <= 0) return;
    for (;;) {
      const now = Date.now();
      // 每分钟补满令牌桶。
      this.tokens = Math.min(
        this.ratePerMinute,
        this.tokens + ((now - this.lastRefill) / 60_000) * this.ratePerMinute,
      );
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) * (60_000 / this.ratePerMinute));
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 1000)));
    }
  }
}

/* ------------------------------- 单连接 -------------------------------- */

class SmtpConnection {
  private socket: Socket | TLSSocket | null = null;
  private buffer = '';
  private pending: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(
    private readonly config: SmtpConfig,
    _logger: { warn: (message: string) => void },
  ) {}

  async connect(): Promise<void> {
    const { host, port, secure } = this.config;
    const timeout = this.config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    const socket = secure
      ? tlsConnect({
          host,
          port,
          rejectUnauthorized: this.config.rejectUnauthorized ?? true,
        })
      : netConnect({ host, port });
    this.attachSocket(socket);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SmtpError('SMTP 连接超时')), timeout);
      const onReady = (): void => {
        clearTimeout(timer);
        resolve();
      };
      socket.once(secure ? 'secureConnect' : 'connect', onReady);
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const greeting = await this.readResponse();
    this.assertCode(greeting, [220]);

    const caps = await this.ehlo();
    if (!secure && this.config.requireStartTls && caps.has('STARTTLS')) {
      await this.startTls();
      caps.clear();
      caps.add('__done');
      await this.ehlo();
    } else if (
      !secure &&
      this.config.requireStartTls &&
      !caps.has('STARTTLS') &&
      !this.config.allowInsecure
    ) {
      throw new SmtpError('服务端不支持 STARTTLS，且未允许明文发送');
    }

    if (this.config.auth) {
      await this.authenticate(this.config.auth, caps);
    }
  }

  async send(message: SmtpMessage): Promise<void> {
    const from = message.from ?? this.config.from;
    const recipients = Array.isArray(message.to) ? message.to : [message.to];
    const mailFrom = await this.command(`MAIL FROM:<${from}>`);
    this.assertCode(mailFrom, [250]);
    for (const recipient of recipients) {
      const rcpt = await this.command(`RCPT TO:<${recipient}>`);
      this.assertCode(rcpt, [250, 251]);
    }
    const data = await this.command('DATA');
    this.assertCode(data, [354]);
    // 报文必须以 CRLF 结尾，且独立一行的 "." 结束；正文中的行首 "." 需转义。
    const body = `${dotStuff(message.raw).replace(/\r?\n/g, '\r\n')}\r\n.`;
    const accepted = await this.command(body);
    this.assertCode(accepted, [250]);
  }

  destroy(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }

  /* ----------------------------- 协议细节 ---------------------------- */

  /**
   * Wire a socket (initial or post-STARTTLS): data/error/close handlers **and** a
   * real read timeout. Node's `setTimeout` only *emits* `'timeout'`; without a
   * listener the promise would await forever. On timeout we destroy the socket
   * and reject the pending read, so a silently-stalling server cannot hold a
   * pool slot.
   */
  private attachSocket(socket: Socket | TLSSocket): void {
    this.socket = socket;
    this.buffer = '';
    this.pending = null;
    socket.setTimeout(this.config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    socket.on('timeout', () => {
      this.destroy();
      this.fail(new SmtpError('SMTP 读超时（服务端无响应）'));
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new SmtpError('连接已关闭')));
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  private async ehlo(): Promise<Set<string>> {
    const response = await this.command('EHLO stackpanel');
    this.assertCode(response, [250, 502]);
    // 解析多行能力（250-...），首行是域名，其余是能力。
    const caps = new Set<string>();
    for (const line of response.split('\n').slice(1)) {
      const capability = line.replace(/^\d{3}[- ]/, '').trim();
      const [keyword] = capability.split(' ');
      if (keyword) caps.add(keyword.toUpperCase());
    }
    return caps;
  }

  private async startTls(): Promise<void> {
    const response = await this.command('STARTTLS');
    this.assertCode(response, [220]);
    const plain = this.socket;
    if (!plain) throw new SmtpError('STARTTLS 时连接已断开');
    const { host } = this.config;
    const secureSocket = tlsConnect({
      socket: plain,
      servername: host,
      rejectUnauthorized: this.config.rejectUnauthorized ?? true,
    });
    this.attachSocket(secureSocket);
    await new Promise<void>((resolve, reject) => {
      secureSocket.once('secureConnect', () => resolve());
      secureSocket.once('error', reject);
    });
  }

  private async authenticate(
    auth: NonNullable<SmtpConfig['auth']>,
    caps: Set<string>,
  ): Promise<void> {
    const method = auth.method ?? (caps.has('AUTH') ? 'plain' : 'plain');
    const token = Buffer.from(`\0${auth.user}\0${auth.pass}`).toString('base64');
    if (method === 'plain') {
      const response = await this.command(`AUTH PLAIN ${token}`);
      this.assertCode(response, [235]);
      return;
    }
    // AUTH LOGIN：用户名/密码分两次 base64 往返。
    const start = await this.command('AUTH LOGIN');
    this.assertCode(start, [334]);
    const user = await this.command(Buffer.from(auth.user).toString('base64'));
    this.assertCode(user, [334]);
    const pass = await this.command(Buffer.from(auth.pass).toString('base64'));
    this.assertCode(pass, [235]);
  }

  private async command(payload: string): Promise<string> {
    if (!this.socket) throw new SmtpError('连接未建立');
    return this.roundtrip(`${payload}\r\n`);
  }

  private roundtrip(raw: string): Promise<string> {
    if (!this.socket) return Promise.reject(new SmtpError('连接未建立'));
    const pending = new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    if (raw) this.socket.write(raw);
    this.flushBuffer();
    return pending;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    this.flushBuffer();
  }

  /** Resolve the pending read if a complete response is already buffered. */
  private flushBuffer(): void {
    if (!this.pending) return;
    const lines = this.buffer.split('\r\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (/^\d{3} /.test(line)) {
        const response = lines.slice(0, index + 1).join('\n');
        this.buffer = lines.slice(index + 1).join('\r\n');
        const pending = this.pending;
        this.pending = null;
        pending.resolve(response);
        return;
      }
    }
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  private assertCode(response: string, expected: number[]): void {
    const match = /^(\d{3})/.exec(response);
    const code = match ? Number(match[1]) : 0;
    if (!expected.includes(code)) {
      throw new SmtpError(`SMTP 响应 ${code}：${response.replace(/\n/g, ' ')}`, code);
    }
  }

  private readResponse(): Promise<string> {
    if (!this.socket) throw new SmtpError('连接未建立');
    return this.roundtrip('');
  }
}

/** SMTP DATA 阶段的行首点转义（RFC 5321 §4.5.2）。 */
export function dotStuff(raw: string): string {
  return raw.replace(/\r?\n\./g, '\r\n..').replace(/^\./, '..');
}

/**
 * SMTP 传输：连接池 + 限速的门面。一个 transport 对应一份配置，
 * 配置变更时旧实例应 `close()` 并重建。
 */
export class SmtpTransport {
  private readonly pool: SmtpPool;

  constructor(
    config: SmtpConfig,
    logger: { warn: (message: string) => void } = { warn: () => {} },
  ) {
    this.pool = new SmtpPool(config, logger);
  }

  send(message: SmtpMessage): Promise<void> {
    return this.pool.send(message);
  }

  close(): void {
    this.pool.close();
  }
}
