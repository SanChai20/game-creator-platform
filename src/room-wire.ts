// The wire format and flood protection shared by realtime rooms (src/room.ts) and the SDK (web/public/sdk/gcp.js
// mirrors the frame layout). Pure: tests/room-wire.mjs imports it directly.
//
// Binary frames let a game send packed data (positions as Float32Array, bit-packed inputs) instead of JSON text.
//
//   player -> room   [1][target][len][id bytes...][at: float64 LE][payload...]
//                    target 0 = everyone else, 1 = the host, 2 = one peer (len and id bytes only for 2)
//   room -> player   [1][len][from id bytes...][at: float64 LE][payload...]
//
// `at` is the sender's clock in ms (NaN when it did not say), the same meta.at text messages carry.

export const WIRE_VERSION = 1;
const enc = new TextEncoder(), dec = new TextDecoder();

export interface ClientFrame { to: string | null; at: number | undefined; payload: Uint8Array }

/** Reads a binary frame a player sent. Null when it is not a valid version-1 frame. */
export function decodeClientFrame(buf: ArrayBuffer): ClientFrame | null {
  const u = new Uint8Array(buf);
  if (u.length < 10 || u[0] !== WIRE_VERSION) return null;
  let i = 2, to: string | null = null;
  if (u[1] === 1) to = 'host';
  else if (u[1] === 2) {
    const n = u[2];
    if (!n || u.length < 3 + n + 8) return null;
    try { to = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(u.subarray(3, 3 + n)); } catch { return null; }
    i = 3 + n;
  } else if (u[1] !== 0) return null;
  if (u.length < i + 8) return null;
  const at = new DataView(buf, i, 8).getFloat64(0, true);
  return { to, at: Number.isFinite(at) ? at : undefined, payload: u.subarray(i + 8) };
}

/** Builds the frame the room sends to the other players. */
export function encodeRelayFrame(from: string, at: number | undefined, payload: Uint8Array): ArrayBuffer {
  const id = enc.encode(from).subarray(0, 255);
  const out = new Uint8Array(2 + id.length + 8 + payload.length);
  out[0] = WIRE_VERSION; out[1] = id.length; out.set(id, 2);
  new DataView(out.buffer, 2 + id.length, 8).setFloat64(0, typeof at === 'number' && Number.isFinite(at) ? at : NaN, true);
  out.set(payload, 2 + id.length + 8);
  return out.buffer;
}

/** Builds a frame as a player would send it (the SDK does the same; tests use this). */
export function encodeClientFrame(to: string | null, at: number | undefined, payload: Uint8Array): ArrayBuffer {
  const id = to && to !== 'host' ? enc.encode(to).subarray(0, 255) : new Uint8Array(0);
  const head = to === 'host' ? 2 : id.length ? 3 + id.length : 2;
  const out = new Uint8Array(head + 8 + payload.length);
  out[0] = WIRE_VERSION; out[1] = to === 'host' ? 1 : id.length ? 2 : 0;
  if (id.length) { out[2] = id.length; out.set(id, 3); }
  new DataView(out.buffer, head, 8).setFloat64(0, typeof at === 'number' && Number.isFinite(at) ? at : NaN, true);
  out.set(payload, head + 8);
  return out.buffer;
}

/** Reads a frame the room relayed (the SDK does the same; tests use this). */
export function decodeRelayFrame(buf: ArrayBuffer): { from: string; at: number | undefined; payload: Uint8Array } | null {
  const u = new Uint8Array(buf);
  if (u.length < 2 || u[0] !== WIRE_VERSION || u.length < 2 + u[1] + 8) return null;
  const from = dec.decode(u.subarray(2, 2 + u[1])), at = new DataView(buf, 2 + u[1], 8).getFloat64(0, true);
  return { from, at: Number.isFinite(at) ? at : undefined, payload: u.subarray(2 + u[1] + 8) };
}

/**
 * A token bucket per socket, for messages and for bytes. A player may burst to twice the rate (a reconnect flushing
 * queued input, a frame hitch), but not keep it up. Over budget, messages are dropped and the sender is told once a
 * second ('warn'); a sender that stays over budget for `closeAfterMs` is disconnected ('close').
 */
export class RateBudget {
  private rate: number; private byteRate: number; private closeAfterMs: number;
  private msgs: number; private bytes: number; private last = -1; private overSince = 0; private warnedAt = 0; private droppedAt = 0;
  constructor(rate: number, byteRate: number, closeAfterMs = 10_000) {
    this.rate = rate; this.byteRate = byteRate; this.closeAfterMs = closeAfterMs;
    this.msgs = rate * 2; this.bytes = byteRate * 2;
  }
  take(size: number, now: number): 'ok' | 'drop' | 'warn' | 'close' {
    if (this.last >= 0) {
      const dt = Math.max(0, Math.min(now - this.last, 10_000)) / 1000;
      this.msgs = Math.min(this.rate * 2, this.msgs + dt * this.rate);
      this.bytes = Math.min(this.byteRate * 2, this.bytes + dt * this.byteRate);
    }
    this.last = now;
    if (this.msgs >= 1 && this.bytes >= size) {
      this.msgs -= 1; this.bytes -= size;
      // a sender that keeps flooding gets a message through now and then as the bucket refills: only a clean stretch of
      // two seconds counts as having stopped
      if (now - this.droppedAt > 2000) this.overSince = 0;
      return 'ok';
    }
    this.droppedAt = now;
    if (!this.overSince) this.overSince = now;
    if (now - this.overSince >= this.closeAfterMs) return 'close';
    if (now - this.warnedAt >= 1000) { this.warnedAt = now; return 'warn'; }
    return 'drop';
  }
}
