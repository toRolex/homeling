import { test, expect } from 'bun:test';
import { createECDH } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushStore } from './push-store.ts';
import { handlePushRequest } from './push-api.ts';
import { SessionLock } from './session-lock.ts';
import { SessionController } from './session-controller.ts';
import { handleRequest } from './index.ts';
import { daemonConfigFromEnv } from './config.ts';

test('readonly push status exposes actual resolved and superseded tags for local worker retraction', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'homeling-push-retract-'));
  try {
    const store = new PushStore(join(dir, 'push.json'));
    const lock = new SessionLock(); const { token } = lock.unlock('alice');
    await store.mutate(state => ({ next: { ...state, pendingOccurrences: { old: { binding: 'main:old', identity: 'digest', occurrenceKey: 'old-uuid', active: false } }, retractTags: ['homeling-request-superseded'] }, result: undefined }), lock.admission(lock.admit(token, 'alice')));
    const runtime = { store, publicKey: 'public', transport: { send: async () => ({ status: 'sent' as const }) } };
    const response = await handlePushRequest(new Request('https://home.example/lite/api/push/status'), runtime, 'alice');
    expect((await response!.json()).retractTags).toEqual(['homeling-request-old-uuid', 'homeling-request-superseded']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('push JSON budget cancels an oversized stream before buffering the remaining body or mutating state', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'homeling-push-budget-'));
  try {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(10_000)); }, pull(controller) { controller.enqueue(new Uint8Array(10)); controller.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const req = new Request('https://home.example/lite/api/push/preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const store = new PushStore(join(dir, 'push.json'));
    const lock = new SessionLock(); const { token } = lock.unlock('alice');
    const result = await handlePushRequest(req, { store, publicKey: 'public', transport: { send: async () => ({ status: 'sent' }) } }, 'alice', lock.admission(lock.admit(token, 'alice')));
    expect(result?.status).toBe(413); expect(cancelled).toBe(true); expect((await store.load()).preferences.enabled).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('actual HTTP gate rejects every push business write while locked and cross-origin, then accepts an unlocked preference commit', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'homeling-push-http-'));
  try {
    const cfg = { ...daemonConfigFromEnv({}), tailscaleHost: 'home.example', publicOrigin: 'https://home.example', trustedUsers: ['alice'] };
    const sessions = new SessionController({ verify: () => secret => secret === 'a'.repeat(43) });
    const store = new PushStore(join(dir, 'push.json')); let sent = 0;
    const push = { store, publicKey: 'public', transport: { send: async () => { sent++; return { status: 'sent' as const }; } } };
    const request = (path: string, body: unknown, cookie?: string, origin = 'https://home.example') => Object.assign(new Request(`https://home.example/lite/api/${path}`, { method: 'POST', headers: { 'host': 'home.example', 'tailscale-user-login': 'alice', 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }), { remoteAddress: '127.0.0.1' });
    for (const action of ['subscribe', 'unsubscribe', 'preferences', 'test-send']) expect((await handleRequest(request(`push/${action}`, { enabled: false }), cfg, fetch, undefined, sessions, push)).status).toBe(423);
    expect((await handleRequest(request('push/preferences', { enabled: false }, undefined, 'https://evil.example'), cfg, fetch, undefined, sessions, push)).status).toBe(403);
    expect((await store.load()).preferences.enabled).toBe(true); expect(sent).toBe(0);
    const unlock = await handleRequest(request('session/unlock', { secret: 'a'.repeat(43) }), cfg, fetch, undefined, sessions, push);
    const cookie = unlock.headers.get('set-cookie')!.split(';')[0]!;
    const state = await unlock.json() as { epoch: number; generation: string };
    expect((await handleRequest(request('push/preferences', { enabled: false }, cookie), cfg, fetch, undefined, sessions, push)).status).toBe(423);
    const write = request('push/preferences', { enabled: false }, cookie);
    write.headers.set('x-homeling-session-epoch', String(state.epoch));
    const stale = request('push/preferences', { enabled: false }, cookie);
    stale.headers.set('x-homeling-session-epoch', String(state.epoch));
    stale.headers.set('x-homeling-session-generation', 'stale-boot');
    expect((await handleRequest(stale, cfg, fetch, undefined, sessions, push)).status).toBe(423);
    expect((await store.load()).preferences.enabled).toBe(true); expect(sent).toBe(0);
    write.headers.set('x-homeling-session-generation', state.generation);
    expect((await handleRequest(write, cfg, fetch, undefined, sessions, push)).status).toBe(200);
    expect((await store.load()).preferences.enabled).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('push enrollment fails closed while locked; enrollment, test-send and removal preserve user admission', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'homeling-push-api-'));
  try {
    const store = new PushStore(join(dir, 'push.json')); const sent: unknown[] = [];
    const runtime = { store, publicKey: 'public', transport: { send: async (_: unknown, payload: unknown) => { sent.push(payload); return { status: 'sent' as const }; } } };
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } };
    const request = (action: string, body: unknown) => new Request(`https://home.example/lite/api/push/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await handlePushRequest(request('subscribe', subscription), runtime, 'alice'))?.status).toBe(423);
    expect((await store.load()).subscriptions).toHaveLength(0);
    const lock = new SessionLock(); const { token } = lock.unlock('alice'); const admission = lock.admission(lock.admit(token, 'alice'));
    expect((await handlePushRequest(request('subscribe', subscription), runtime, 'alice', admission))?.status).toBe(201);
    expect((await handlePushRequest(request('test-send', { endpoint: subscription.endpoint }), runtime, 'alice', admission))?.status).toBe(200);
    expect(sent).toHaveLength(1);
    lock.lock(token, 'alice');
    expect((await handlePushRequest(request('unsubscribe', { endpoint: subscription.endpoint }), runtime, 'alice', admission))?.status).toBe(423);
    expect((await store.load()).subscriptions).toHaveLength(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
