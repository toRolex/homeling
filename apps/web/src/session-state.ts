export type SessionMode = "local-unlock" | "tailscale-identity";

export interface SessionSnapshot {
  readonly mode?: SessionMode;
  readonly locked: boolean;
  /** Local fail-closed masking is not proof that the server accepted a lock. */
  readonly lockConfirmed?: boolean;
  readonly ready?: boolean;
  readonly available?: boolean;
  readonly epoch?: number;
  readonly generation?: string;
  readonly idleDeadline?: number;
  readonly absoluteDeadline?: number;
  readonly serverNow?: number;
}
export class ClientSessionLocked extends Error {
  constructor() { super("session.locked"); }
}
export class SessionStateStore {
  private snapshot: SessionSnapshot = { locked: true, ready: false };
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  get = (): SessionSnapshot => this.snapshot;
  version = (): number => this.revision;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(): void { for (const listener of this.listeners) listener(); }
  apply(next: SessionSnapshot): void {
    const changed = next.epoch !== this.snapshot.epoch || next.generation !== this.snapshot.generation || next.locked !== this.snapshot.locked || next.mode !== this.snapshot.mode;
    if (changed) this.revision++;
    this.snapshot = { ...next, lockConfirmed: next.locked, ready: !next.locked && !changed && this.snapshot.ready === true };
    this.emit();
  }
  lock(): void {
    this.revision++;
    this.snapshot = { ...this.snapshot, locked: true, lockConfirmed: false, ready: false }; this.emit();
  }
  caughtUp(): void {
    if (this.snapshot.locked) return;
    this.snapshot = { ...this.snapshot, ready: true }; this.emit();
  }
  admit = (): (() => void) => {
    const revision = this.revision;
    const check = () => { if (this.snapshot.locked || !this.snapshot.ready || revision !== this.revision) throw new ClientSessionLocked(); };
    check(); return check;
  };
}
export const sessionState = new SessionStateStore();
