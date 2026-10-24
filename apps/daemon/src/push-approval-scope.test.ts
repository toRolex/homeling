import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLedger } from './activity-ledger.ts';
import { PersonaRegistry } from './persona-registry.ts';
import { HerdrSocketClient } from './herdr-client.ts';
import { daemonConfigFromEnv } from './config.ts';
import { fixtureAdmission, handleUnlockedRequest } from './session-test-fixture.ts';
import { createDaemonSystemAdmissions } from './system-admission.ts';

const screen = 'Bash command\n\n  mkfifo fixture-fifo\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel · Tab to amend';
test('a current real colon-bearing pane ID approves through the exact normalized bridge keys URL', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'homeling-push-colon-'));
  try {
    const cfg = { ...daemonConfigFromEnv({}), tailscaleHost: 'home.example', publicOrigin: 'https://home.example', trustedUsers: ['alice'] };
    const activity = new ActivityLedger(join(dir, 'activity.json'));
    const task = await activity.register({ personaId: 'persona-real', spaceId: 'w1', paneId: 'w1:p2', title: 'Approve FIFO' }, fixtureAdmission());
    activity.live(createDaemonSystemAdmissions().activityObserve);
    const registry = new PersonaRegistry('/unused/registry.json', async () => JSON.stringify({ version: 1, personas: [{ id: 'persona-real', spaceId: 'w1', mainPaneId: 'w1:main', name: 'Work' }], archivedSpaces: [], orphans: [] }));
    const writes: unknown[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { writes.push(String(input)); return Response.json({ ok: true }); }
      if (String(input).endsWith('/snapshot')) return Response.json({ bridge: 'connected', agents: [{ paneId: 'w1:p2', workspaceId: 'w1', status: 'blocked', agent: 'claude' }], shellPanes: [], workspaces: [], tabs: [], sessions: [], ts: Date.now() });
      return Response.json({ paneId: 'w1:p2', text: screen, truncated: false });
    };
    const runtime = { cfg, activity, registry, fetcher, herdr: new HerdrSocketClient({ socketPath: '/unused/herdr.sock' }) };
    const request = (path: string, body?: unknown) => Object.assign(new Request(`https://home.example/lite/api/${path}`, { method: body ? 'POST' : 'GET', headers: { host: 'home.example', 'tailscale-user-login': 'alice', origin: 'https://home.example', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), { remoteAddress: '127.0.0.1' });
    const response = await handleUnlockedRequest(request(`activity/task/${task.occurrenceKey}/requests`), cfg, fetcher, runtime);
    const [pending] = await response.json();
    const approval = await handleUnlockedRequest(request(`requests/${encodeURIComponent(pending.id)}/approve`, { optionId: '1', occurrenceKey: task.occurrenceKey }), cfg, fetcher, runtime);
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({ status: 'resolved', outcome: 'submitted' });
    expect(writes).toEqual([`${cfg.bridgeOrigin}/api/pane/w1:p2/keys`]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('task approval deep-link reads only current scoped pending; a gap during approval validation prevents all key dispatch', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'homeling-push-approval-'));
  try {
    const cfg = { ...daemonConfigFromEnv({}), tailscaleHost: 'home.example', publicOrigin: 'https://home.example', trustedUsers: ['alice'] };
    const activity = new ActivityLedger(join(dir, 'activity.json'));
    const caps = createDaemonSystemAdmissions();
    const task = await activity.register({ personaId: 'persona-real', spaceId: 'w1', paneId: 'task', title: 'Approve FIFO' }, fixtureAdmission());
    activity.live(caps.activityObserve);
    const registry = new PersonaRegistry('/unused/registry.json', async () => JSON.stringify({ version: 1, personas: [{ id: 'persona-real', spaceId: 'w1', mainPaneId: 'main', name: 'Work' }], archivedSpaces: [], orphans: [] }));
    let writes = 0; let gapOnScreen = false;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { writes++; return Response.json({ ok: true }); }
      if (String(input).endsWith('/snapshot')) return Response.json({ bridge: 'connected', agents: [{ paneId: 'task', workspaceId: 'w1', status: 'blocked', agent: 'claude', kind: 'agent' }], shellPanes: [], workspaces: [], tabs: [], sessions: [], ts: Date.now() });
      if (gapOnScreen) { gapOnScreen = false; await activity.gap('test observation gap', caps.activityObserve); }
      return Response.json({ paneId: 'task', text: screen, truncated: false });
    };
    const runtime = { cfg, activity, registry, fetcher, herdr: new HerdrSocketClient({ socketPath: '/unused/herdr.sock' }) };
    const request = (path: string, body?: unknown) => Object.assign(new Request(`https://home.example/lite/api/${path}`, { method: body ? 'POST' : 'GET', headers: { host: 'home.example', 'tailscale-user-login': 'alice', origin: 'https://home.example', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), { remoteAddress: '127.0.0.1' });
    const get = await handleUnlockedRequest(request(`activity/task/${task.occurrenceKey}/requests`), cfg, fetcher, runtime);
    expect(get.status).toBe(200);
    const [pending] = await get.json();
    expect(pending).toMatchObject({ paneId: 'task', personaId: 'persona-real', taskOccurrenceKey: task.occurrenceKey });
    gapOnScreen = true;
    const approval = await handleUnlockedRequest(request(`requests/${encodeURIComponent(pending.id)}/approve`, { optionId: '1', occurrenceKey: task.occurrenceKey }), cfg, fetcher, runtime);
    expect(approval.status).toBe(409); expect(writes).toBe(0);
    const stale = await handleUnlockedRequest(request(`activity/task/${task.occurrenceKey}/requests`), cfg, fetcher, runtime);
    expect(stale.status).toBe(409); expect(writes).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
