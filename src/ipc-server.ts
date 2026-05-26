// IPC server (named pipe on Windows, unix domain socket on macOS/Linux) for
// bridging the internal MCP server process to Electron main.
//
// Phase 1 skeleton (v2.1.0-pre). 設計: docs/architecture/in-app-form-fill.md §3.
//
// Wire format: length-prefixed JSON
//   [4 bytes uint32 BE: payload length] [N bytes UTF-8 JSON]
//
// Message shapes:
//   Request:  { id, op, params }
//   Response: { id, ok: true,  result } | { id, ok: false, error: { code, message } }
//   Event:    { event, params }  (no id, server → client only)

import { createServer, type Server, type Socket } from 'net';
import { randomBytes } from 'crypto';

const FRAME_HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16MB; screenshots can exceed plain payloads

export interface IpcRequest {
  id: string;
  op: string;
  params: Record<string, unknown>;
}

export interface IpcEvent {
  event: string;
  params: Record<string, unknown>;
}

export type IpcHandler = (req: IpcRequest, ctx: IpcConnection) => Promise<unknown>;

export interface IpcConnection {
  sendEvent(event: IpcEvent): void;
  close(): void;
}

export interface IpcServer {
  pipePath: string;
  on(op: string, handler: IpcHandler): void;
  broadcastEvent(event: IpcEvent): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Phase 1 skeleton: 1 接続のみ accept、length-prefixed JSON frame の req/res mux。
 * 本実装 (Phase 2) では reconnect / multi-client / ACL を強化。
 */
export function createIpcServer(): IpcServer {
  const pipePath = generatePipePath();
  const handlers = new Map<string, IpcHandler>();
  const connections = new Set<IpcConnection>();
  let server: Server | null = null;

  function on(op: string, handler: IpcHandler): void {
    handlers.set(op, handler);
  }

  function broadcastEvent(event: IpcEvent): void {
    for (const conn of connections) {
      try { conn.sendEvent(event); }
      catch (_) { /* swallow; conn close handler cleans up */ }
    }
  }

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      server = createServer((socket) => {
        handleConnection(socket, handlers, connections);
      });
      server.once('error', reject);
      server.listen(pipePath, () => {
        server!.removeListener('error', reject);
        resolve();
      });
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const conn of connections) {
        try { conn.close(); } catch (_) { /* ignore */ }
      }
      connections.clear();
      if (server) {
        server.close(() => resolve());
        server = null;
      } else {
        resolve();
      }
    });
  }

  return { pipePath, on, broadcastEvent, start, stop };
}

function handleConnection(
  socket: Socket,
  handlers: Map<string, IpcHandler>,
  connections: Set<IpcConnection>,
): void {
  let buffer = Buffer.alloc(0);

  const conn: IpcConnection = {
    sendEvent(event: IpcEvent) { writeFrame(socket, JSON.stringify(event)); },
    close() { try { socket.end(); socket.destroy(); } catch (_) {} },
  };
  connections.add(conn);

  socket.on('data', (chunk: Buffer | string) => {
    const chunkBuf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    buffer = Buffer.concat([buffer, chunkBuf]);
    while (buffer.length >= FRAME_HEADER_BYTES) {
      const length = buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        // protocol violation
        conn.close();
        return;
      }
      if (buffer.length < FRAME_HEADER_BYTES + length) break;
      const payload = buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length).toString('utf8');
      buffer = buffer.subarray(FRAME_HEADER_BYTES + length);
      dispatchRequest(payload, conn, handlers, socket);
    }
  });

  socket.on('close', () => { connections.delete(conn); });
  socket.on('error', () => { connections.delete(conn); });
}

async function dispatchRequest(
  payload: string,
  conn: IpcConnection,
  handlers: Map<string, IpcHandler>,
  socket: Socket,
): Promise<void> {
  let req: IpcRequest;
  try {
    req = JSON.parse(payload) as IpcRequest;
  } catch (e) {
    writeFrame(socket, JSON.stringify({
      id: '_parse_error',
      ok: false,
      error: { code: 'invalid_json', message: e instanceof Error ? e.message : String(e) },
    }));
    return;
  }
  if (!req || typeof req.id !== 'string' || typeof req.op !== 'string') {
    writeFrame(socket, JSON.stringify({
      id: (req as { id?: string })?.id ?? '_unknown',
      ok: false,
      error: { code: 'invalid_request', message: 'id and op required' },
    }));
    return;
  }
  const handler = handlers.get(req.op);
  if (!handler) {
    writeFrame(socket, JSON.stringify({
      id: req.id,
      ok: false,
      error: { code: 'unknown_op', message: `No handler for op: ${req.op}` },
    }));
    return;
  }
  try {
    const result = await handler(req, conn);
    writeFrame(socket, JSON.stringify({ id: req.id, ok: true, result }));
  } catch (e) {
    writeFrame(socket, JSON.stringify({
      id: req.id,
      ok: false,
      error: {
        code: 'handler_error',
        message: e instanceof Error ? e.message : String(e),
      },
    }));
  }
}

function writeFrame(socket: Socket, json: string): void {
  const payload = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  socket.write(header);
  socket.write(payload);
}

function generatePipePath(): string {
  const suffix = randomBytes(8).toString('hex');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\sales-claw-form-mcp-${suffix}`;
  }
  // unix domain socket; OS の temp dir 配下に置く
  return `/tmp/sales-claw-form-mcp-${suffix}.sock`;
}

export default { createIpcServer };
