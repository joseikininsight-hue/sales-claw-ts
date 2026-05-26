'use strict';

// IPC client for the sales-claw-form MCP server.
//
// Connects to the Electron main process via the named pipe (or unix socket)
// path provided by the SALES_CLAW_FORM_IPC_PIPE env var.
//
// Phase 1 skeleton: length-prefixed JSON frame, req/res mux via Map<id, {resolve, reject}>,
// reconnect 3秒間隔最大5回。詳細: docs/architecture/in-app-form-fill.md §3.

const net = require('net');
const crypto = require('crypto');

const FRAME_HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const RECONNECT_INTERVAL_MS = 3000;
const RECONNECT_MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;

class IpcClient {
  constructor(pipePath) {
    this._pipePath = pipePath;
    this._socket = null;
    this._buffer = Buffer.alloc(0);
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._eventListeners = new Set();
    this._reconnectAttempts = 0;
    this._connecting = null;
  }

  async connect() {
    if (this._socket && !this._socket.destroyed) return;
    if (this._connecting) return this._connecting;
    this._connecting = this._doConnect();
    try { await this._connecting; }
    finally { this._connecting = null; }
  }

  _doConnect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this._pipePath);
      const onError = (err) => {
        socket.removeListener('connect', onConnect);
        reject(err);
      };
      const onConnect = () => {
        socket.removeListener('error', onError);
        this._socket = socket;
        this._reconnectAttempts = 0;
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => this._onClose());
        socket.on('error', () => { /* close fires after */ });
        resolve();
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= FRAME_HEADER_BYTES) {
      const length = this._buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this._socket.destroy();
        return;
      }
      if (this._buffer.length < FRAME_HEADER_BYTES + length) break;
      const payload = this._buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length).toString('utf8');
      this._buffer = this._buffer.subarray(FRAME_HEADER_BYTES + length);
      this._dispatchMessage(payload);
    }
  }

  _dispatchMessage(payload) {
    let msg;
    try { msg = JSON.parse(payload); }
    catch (_) { return; }
    if (msg.event) {
      for (const fn of this._eventListeners) {
        try { fn(msg); } catch (_) { /* swallow */ }
      }
      return;
    }
    if (typeof msg.id === 'string' && this._pending.has(msg.id)) {
      const pending = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error((msg.error && msg.error.message) || 'IPC error'));
    }
  }

  async _onClose() {
    this._socket = null;
    // すべての in-flight をエラー化
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('IPC connection closed'));
    }
    this._pending.clear();

    if (this._reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
      this._reconnectAttempts++;
      setTimeout(() => {
        this.connect().catch(() => {
          if (this._reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            process.stderr.write(`[sales-claw-form-mcp] Electron との IPC が ${RECONNECT_MAX_ATTEMPTS} 回連続切断。終了します。\n`);
            process.exit(1);
          }
        });
      }, RECONNECT_INTERVAL_MS);
    } else {
      process.exit(1);
    }
  }

  async request(op, params = {}) {
    if (!this._socket || this._socket.destroyed) await this.connect();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`IPC ${op} timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      const json = JSON.stringify({ id, op, params });
      const payload = Buffer.from(json, 'utf8');
      const header = Buffer.alloc(FRAME_HEADER_BYTES);
      header.writeUInt32BE(payload.length, 0);
      this._socket.write(header);
      this._socket.write(payload);
    });
  }

  on(listener) {
    this._eventListeners.add(listener);
    return () => this._eventListeners.delete(listener);
  }
}

module.exports = { IpcClient };
