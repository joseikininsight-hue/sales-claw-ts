// Managed AI Slot Pool (P1-4 並列化基盤 / Step 0)。
//
// 既存の dashboard-server にあったシングルトン state を「スロット配列」
// 越しに参照する抽象化レイヤー。
//
// Step 0 は 1 slot 構成 (size = 1)。Step 1 以降で size を最大 3 まで拡張する。
// 互換性のため、`getPrimary()` は従来のシングルトン参照と同等の slot[0] を返す。

export type SlotState = 'idle' | 'busy' | 'recovering';
export type SlotMode = 'default' | 'auto' | 'bypassPermissions' | string;
export type ProviderId = 'claude' | 'codex' | 'gemini' | string;

export interface Slot {
  id: number;
  pty: unknown | null;
  legacyProcess: unknown | null;
  mode: SlotMode;
  providerId: ProviderId;
  autoSendSafe: boolean;
  sessionState: unknown | null;
  batchController: { activeBatch?: unknown } | null;
  recoveryState: unknown | null;
  recoveryTimer: NodeJS.Timeout | null;
  suppressAutoRecovery: boolean;
  contextId: string | null;
  activeCompanyNos: Set<number>;
  state: SlotState;
  lastActivityAt: number;
}

export interface SlotSnapshot {
  id: number;
  providerId: ProviderId;
  mode: SlotMode;
  state: SlotState;
  hasPty: boolean;
  autoSendSafe: boolean;
  contextId: string | null;
  activeCompanyCount: number;
  hasBatch: boolean;
  recoveryArmed: boolean;
}

export interface SlotPoolOptions {
  size?: number;
  defaultProviderId?: ProviderId;
}

export interface SlotPool {
  readonly size: number;
  all(): Slot[];
  get(id: number | string): Slot | null;
  /** 互換用: 既存シングルトン参照と同じ。slot[0] を返す。 */
  getPrimary(): Slot;
  findByProvider(providerId: ProviderId): Slot | null;
  findByCompanyNo(no: number | string): Slot | null;
  countActive(): number;
  acquireIdle(): Slot | null;
  releaseSlot(id: number): boolean;
  anyWithPty(): Slot | null;
  forEach(fn: (slot: Slot, index: number) => void): void;
  markExited(id: number): void;
  snapshot(): SlotSnapshot[];
}

function createSlot(id: number): Slot {
  return {
    id,
    pty: null,
    legacyProcess: null,
    mode: 'default',
    providerId: 'claude',
    autoSendSafe: false,
    sessionState: null,
    batchController: null,
    recoveryState: null,
    recoveryTimer: null,
    suppressAutoRecovery: false,
    contextId: null,
    activeCompanyNos: new Set<number>(),
    state: 'idle',
    lastActivityAt: 0,
  };
}

export function createSlotPool(options: SlotPoolOptions = {}): SlotPool {
  const size = Math.max(1, Math.min(3, Number(options.size) || 1));
  const defaultProviderId = options.defaultProviderId ?? 'claude';
  const slots: Slot[] = [];
  for (let i = 0; i < size; i++) {
    const s = createSlot(i);
    s.providerId = defaultProviderId;
    slots.push(s);
  }

  const api: SlotPool = {
    get size() { return slots.length; },
    all() { return slots.slice(); },
    get(id) {
      const i = Number(id);
      if (!Number.isInteger(i) || i < 0 || i >= slots.length) return null;
      return slots[i];
    },
    getPrimary() {
      return slots[0];
    },
    findByProvider(providerId) {
      return slots.find((s: any) => s.pty && s.providerId === providerId) ?? null;
    },
    findByCompanyNo(no) {
      const n = Number(no);
      if (!Number.isFinite(n)) return null;
      return slots.find((s: any) => s.activeCompanyNos.has(n)) ?? null;
    },
    countActive() {
      return slots.filter((s: any) => s.pty).length;
    },
    acquireIdle() {
      const idle = slots.find((s: any) => s.state === 'idle');
      if (idle) {
        idle.state = 'busy';
        idle.lastActivityAt = Date.now();
        return idle;
      }
      return null;
    },
    releaseSlot(id) {
      const s = api.get(id);
      if (!s) return false;
      s.state = 'idle';
      s.activeCompanyNos.clear();
      s.lastActivityAt = Date.now();
      return true;
    },
    anyWithPty() {
      return slots.find((s: any) => s.pty) ?? null;
    },
    forEach(fn) { slots.forEach(fn); },
    markExited(id) {
      const s = api.get(id);
      if (!s) return;
      s.pty = null;
      s.legacyProcess = null;
      s.sessionState = null;
      s.batchController = null;
      s.suppressAutoRecovery = false;
      s.state = 'idle';
      s.activeCompanyNos.clear();
      s.lastActivityAt = Date.now();
    },
    snapshot() {
      return slots.map<SlotSnapshot>((s) => ({
        id: s.id,
        providerId: s.providerId,
        mode: s.mode,
        state: s.state,
        hasPty: Boolean(s.pty),
        autoSendSafe: s.autoSendSafe,
        contextId: s.contextId,
        activeCompanyCount: s.activeCompanyNos.size,
        hasBatch: Boolean(s.batchController?.activeBatch),
        recoveryArmed: Boolean(s.recoveryTimer),
      }));
    },
  };
  return api;
}

module.exports = {
  createSlotPool,
};
