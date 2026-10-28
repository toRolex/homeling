import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityLedger } from "./activity-ledger.ts";
import { daemonConfigFromEnv } from "./config.ts";
import { PersonaRegistry } from "./persona-registry.ts";
import type { PersonaRuntime } from "./persona-service.ts";
import { fixtureAdmission, handleUnlockedRequest } from "./session-test-fixture.ts";
import { createDaemonSystemAdmissions } from "./system-admission.ts";
import { acceptance, createCooperation, InvalidCooperation, planCooperation, updateCooperation, validateCooperation } from "./task-cooperation.ts";
import type { CooperationQuestion } from "./task-cooperation.ts";
import { currentCheck } from "./task-validation.ts";
import { handleRequest } from "./index.ts";
import { SessionController } from "./session-controller.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "homeling-cooperation-")); roots.push(root);
  const cfg = { ...daemonConfigFromEnv({ HOMELING_REGISTRY_PATH: join(root, "registry.json") }), trustedUsers: ["me"], tailscaleHost: "home.tail.test" };
  const activity = new ActivityLedger(join(root, "activity.json"));
  const observer = createDaemonSystemAdmissions().activityObserve;
  const occurrence = await activity.register({ personaId: "a", spaceId: "s", paneId: "p", title: "Build" }, fixtureAdmission());
  activity.live(observer);
  const writes: string[] = [];
  let delivery: "submitted" | "unknown" | "throw" | "not-submitted" = "submitted";
  let busy = false;
  let snapshotFailure: "throw" | "http" | undefined;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/snapshot')) {
      if (snapshotFailure === 'throw') throw new Error('injected snapshot failure');
      if (snapshotFailure === 'http') return Response.json({ error: 'injected snapshot failure' }, { status: 503 });
    }
    if (init?.method === "POST") {
      writes.push(JSON.parse(init.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : String(init.body)).text);
      if (delivery === 'throw') throw new Error('injected delivery failure');
      if (delivery === 'not-submitted') return Response.json({ textDelivered: false, executed: false }, { status: 502 });
      return delivery === "unknown" ? Response.json({ deliveryUnknown: true }, { status: 502 }) : Response.json({ ok: true });
    }
    return String(input).endsWith("/snapshot")
      ? Response.json({ bridge: "connected", agents: [{ paneId: "p", status: busy ? "working" : "idle" }], shellPanes: [] })
      : Response.json({ paneId: "p", text: "Ready", truncated: false });
  };
  const unavailable = (): never => { throw new Error("Herdr must not be used"); };
  const runtime: PersonaRuntime = { cfg, activity, fetcher, registry: new PersonaRegistry(cfg.registryPath), herdr: { createSpace: unavailable, createTab: unavailable, readPane: unavailable, sendText: unavailable, sendKeys: unavailable, closePane: unavailable, renameSpace: unavailable, snapshot: unavailable, subscribe: unavailable } };
  const path = `/lite/api/activity/task/${occurrence.occurrenceKey}/cooperation`;
  const call = (route: string, method = "GET", body?: unknown) => handleUnlockedRequest(Object.assign(new Request(`https://home.tail.test${route}`, {
    method, headers: { host: "home.tail.test", origin: "https://home.tail.test", "tailscale-user-login": "me", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { remoteAddress: "127.0.0.1" }), cfg, fetcher, runtime);
  const plan = () => ({
    task: { runId: occurrence.occurrenceKey, requirements: { output: { value: "report", version: 0 } }, events: [], steps: [
      { id: "prepare", dependencies: [], requirementIds: ["output"], questionIds: [] as string[], resources: [], authorized: true, durationMs: 10, status: "pending" },
      { id: "deliver", dependencies: ["prepare"], requirementIds: ["output"], questionIds: [] as string[], resources: [], authorized: true, durationMs: 10, status: "pending" },
    ] }, instructions: { prepare: "Prepare report", deliver: "Deliver report" }, questions: [] as CooperationQuestion[],
    checkItems: [{ id: "prepared", stepId: "prepare", requirementId: "output", required: true }, { id: "delivered", stepId: "deliver", requirementId: "output", required: true }], budget: 1, delayPenaltyPerMs: 0,
  });
  const change = async (body: Record<string, unknown>) => {
    const state = await (await call(path)).json();
    return call(path, "PATCH", { ...body, revision: state.revision });
  };
  return { call, path, plan, change, writes, activity, occurrence, observer, cfg, fetcher, runtime, ledgerPath: join(root, 'activity.json'),
    setSnapshotFailure(value: typeof snapshotFailure) { snapshotFailure = value; },
    setDelivery(value: typeof delivery) { delivery = value; }, setBusy(value: boolean) { busy = value; } };
}

function question(kind: "clarification" | "approval"): CooperationQuestion {
  return { id: "question", requirementId: "output", title: "Choose output", progress: "Ready to prepare", details: ["Report destination"], actions: ["report"],
    belief: [{ value: "report", probability: 1 }], losses: { report: { report: 0 } },
    answers: (kind === "approval" ? ["approve", "deny"] : ["report"]).map(id => ({ id, consequence: id, probability: kind === "approval" ? 0.5 : 1, posterior: [{ value: "report", probability: 1 }] })),
    humanCost: 0, delay: [{ value: 0, probability: 1 }], reservedResources: [], required: true, environmentResolvable: false, answerable: true, kind,
    ...(kind === "approval" ? { operation: { target: "report", modification: "replace", impact: "local file", artifactVersion: "report-v1" } } : {}),
  };
}

test("unknown delivery reconciles a versioned result and advances its dependent without redelivery", async () => {
  const f = await fixture(); f.setDelivery("unknown");
  expect((await f.call(f.path, "POST", f.plan())).status).toBe(200);
  expect(f.writes).toHaveLength(1);
  expect((await (await f.call(f.path)).json()).task.steps[0]).toMatchObject({ id: "prepare", status: "unknown" });
  f.setDelivery("submitted");
  const reconciled = await f.change({ kind: "reconcile", stepId: "prepare", evidence: "completed", evidenceLocation: "file:///evidence/prepare", artifactVersion: "prepared-v1" });
  expect(reconciled.status).toBe(200);
  expect(f.writes).toHaveLength(1);
  const checked = await f.change({ kind: "check", checkId: "prepared", status: "passed", evidenceLocation: "file:///checks/prepare" });
  expect(checked.status).toBe(200);
  const view = await (await f.call(f.path)).json();
  expect(view.task.steps[0]).toMatchObject({ status: "done", artifactVersion: "prepared-v1" });
  expect(view.checks).toMatchObject([{ checkId: "prepared", artifactVersion: "prepared-v1", requirementVersion: 0, status: "passed" }]);
  expect(view.task.steps[1]).toMatchObject({ id: "deliver", status: "running" });
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]).toContain("stepId: prepare");
  expect(f.writes[1]).toContain("stepId: deliver");
  await f.call(`${f.path}/advance`, "POST", {});
  expect(f.writes).toHaveLength(2);
  await f.activity.observe("pane_agent_status_changed", { pane_id: "p", workspace_id: "s", agent_status: "working" }, f.observer);
  await f.activity.observe("pane_agent_status_changed", { pane_id: "p", workspace_id: "s", agent_status: "done" }, f.observer);
  expect((await f.activity.ownership("p"))?.status).toBe("active");
  expect((await f.change({ kind: "step-result", stepId: "deliver", status: "done", artifactVersion: "delivered-v1", evidenceLocation: "file:///evidence/deliver" })).status).toBe(200);
  expect((await f.change({ kind: "check", checkId: "delivered", status: "passed", evidenceLocation: "file:///checks/deliver" })).status).toBe(200);
  expect((await f.activity.ownership("p"))?.status).toBe("completed");
  expect((await (await f.call(f.path)).json()).acceptance.complete).toBe(true);
  expect(f.writes).toHaveLength(2);
});

test("explicit advance refuses a locked session before any stage delivery", async () => {
  const f = await fixture(); f.setBusy(true);
  await f.call(f.path, "POST", f.plan());
  f.setBusy(false);
  const response = await handleRequest(Object.assign(new Request(`https://home.tail.test${f.path}/advance`, {
    method: "POST", headers: { host: "home.tail.test", origin: "https://home.tail.test", "tailscale-user-login": "me", "content-type": "application/json" }, body: "{}",
  }), { remoteAddress: "127.0.0.1" }), f.cfg, f.fetcher, f.runtime, new SessionController({ verify: () => () => false }));
  expect(response.status).toBe(423);
  expect(f.writes).toHaveLength(0);
  expect((await (await f.call(f.path)).json()).task.steps[0].status).toBe("pending");
  expect((await (await f.call(`${f.path}/advance`, "POST", {})).json()).dispatched).toBe(true);
  expect(f.writes).toHaveLength(1);
});

test("completed reconciliation requires a checked version and leaves unknown execution untouched on rejection", async () => {
  const f = await fixture(); f.setDelivery("unknown");
  expect((await f.call(f.path, "POST", f.plan())).status).toBe(200);
  for (const artifactVersion of [undefined, "", "   ", 1]) {
    expect((await f.change({ kind: "reconcile", stepId: "prepare", evidence: "completed", evidenceLocation: "file:///evidence/prepare", artifactVersion })).status).toBe(400);
    expect((await (await f.call(f.path)).json()).task.steps[0].status).toBe("unknown");
  }
  expect((await f.change({ kind: "reconcile", stepId: "prepare", evidence: "insufficient", evidenceLocation: "file:///evidence/incomplete" })).status).toBe(200);
  expect((await (await f.call(f.path)).json()).task.steps[0].status).toBe("unknown");
  expect(f.writes).toHaveLength(1);
});

test("duplicate answers never repeat dispatch and free text persists as the requirement", async () => {
  const f = await fixture(); const plan = f.plan(); plan.questions = [question("clarification")]; plan.task.steps[0]!.questionIds = ["question"];
  expect((await f.call(f.path, "POST", plan)).status).toBe(200);
  const requests = await (await f.call("/lite/api/requests")).json();
  expect(requests).toHaveLength(1);
  const route = `/lite/api/requests/${encodeURIComponent(requests[0].id)}/approve`;
  const answer = { optionId: "__free_text__", freeText: "  Plain text report  ", occurrenceKey: f.occurrence.occurrenceKey };
  expect(await (await f.call(route, "POST", answer)).json()).toMatchObject({ status: "resolved", outcome: "submitted" });
  expect(await (await f.call(route, "POST", answer)).json()).toMatchObject({ status: "resolved", outcome: "already-handled" });
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toContain("Plain text report");
  expect((await (await f.call(f.path)).json()).task.requirements.output).toEqual({ value: "Plain text report", version: 1 });
});

test("requirement correction invalidates old approval and requires a new answer", async () => {
  const f = await fixture(); f.setBusy(true); const plan = f.plan(); plan.questions = [question("approval")]; plan.task.steps[0]!.questionIds = ["question"]; plan.task.steps[0]!.authorized = false;
  expect((await f.call(f.path, "POST", plan)).status).toBe(200);
  const [old] = await (await f.call("/lite/api/requests")).json();
  const route = `/lite/api/requests/${encodeURIComponent(old.id)}/approve`;
  expect((await f.call(route, "POST", { optionId: "approve" })).status).toBe(200);
  expect((await f.change({ kind: "correction", changes: { output: "corrected report" } })).status).toBe(200);
  f.setBusy(false);
  expect(await (await f.call(route, "POST", { optionId: "approve" })).json()).toMatchObject({ outcome: "already-handled" });
  await f.call(`${f.path}/advance`, "POST", {});
  expect(f.writes).toHaveLength(0);
  const view = await (await f.call(f.path)).json();
  expect(view.task.steps[0].authorized).toBe(false);
  const [fresh] = await (await f.call("/lite/api/requests")).json();
  expect(fresh.id).not.toBe(old.id);
  expect((await f.call(`/lite/api/requests/${encodeURIComponent(fresh.id)}/approve`, "POST", { optionId: "approve" })).status).toBe(200);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toContain("corrected report");
});

for (const failure of ['throw', 'http'] as const) {
  test(`native request ${failure} failure is not hidden by cooperation requests for another task`, async () => {
    const f = await fixture();
    const plan = f.plan(); plan.questions = [question('clarification')]; plan.task.steps[0]!.questionIds = ['question'];
    expect((await f.call(f.path, 'POST', plan)).status).toBe(200);
    const other = await f.activity.register({ personaId: 'b', spaceId: 's', paneId: 'other', title: 'Other' }, fixtureAdmission());
    f.setSnapshotFailure(failure);
    expect((await f.call('/lite/api/requests')).status).toBe(502);
    expect((await f.call(`/lite/api/activity/task/${other.occurrenceKey}/requests`)).status).toBe(502);
    f.setSnapshotFailure(undefined);
    expect(await (await f.call(`/lite/api/activity/task/${other.occurrenceKey}/requests`)).json()).toEqual([]);
    expect(await (await f.call('/lite/api/requests')).json()).toHaveLength(1);
  });
}

for (const failure of ['throw', 'http', 'delivery-throw', 'not-submitted'] as const) {
  test(`answer survives ${failure} dispatch failure and exposes a guarded advance path`, async () => {
    const f = await fixture(); const plan = f.plan();
    plan.questions = [question('clarification')]; plan.task.steps[0]!.questionIds = ['question'];
    await f.call(f.path, 'POST', plan);
    const [pending] = await (await f.call('/lite/api/requests')).json();
    if (failure === 'delivery-throw') f.setDelivery('throw');
    else if (failure === 'not-submitted') f.setDelivery('not-submitted');
    else f.setSnapshotFailure(failure);
    const route = `/lite/api/requests/${encodeURIComponent(pending.id)}/approve`;
    const reply = await f.call(route, 'POST', { optionId: 'report' });
    expect(reply.status).toBe(200);
    const result = await reply.json();
    expect(result).toMatchObject({ status: 'resolved', outcome: 'submitted', dispatch: { dispatched: false }, advancePath: `${f.path}/advance` });
    if (failure === 'throw') expect(result.dispatch.error).toBe('Cooperation advance failed');
    if (failure === 'delivery-throw') expect(result.dispatch.outcome).toBe('unknown');
    const view = await (await f.call(f.path)).json();
    expect(view.requests[0].status).toBe('resolved');
    expect(view.task.requirements.output).toEqual({ value: 'report', version: 1 });
    expect(view.task.steps[0].status).toBe(failure === 'delivery-throw' ? 'unknown' : 'pending');
    f.setSnapshotFailure(undefined); f.setDelivery('submitted');
    const writes = f.writes.length;
    expect(await (await f.call(route, 'POST', { optionId: 'report' })).json()).toMatchObject({ outcome: 'already-handled', advancePath: result.advancePath });
    expect(f.writes).toHaveLength(writes);
    await f.call(result.advancePath, 'POST', {});
    expect(f.writes).toHaveLength(writes + (failure === 'delivery-throw' ? 0 : 1));
    await f.call(result.advancePath, 'POST', {});
    expect(f.writes).toHaveLength(writes + (failure === 'delivery-throw' ? 0 : 1));
  });
}

for (const kind of ['correction', 'revise-operation', 'retry-step'] as const) {
  test(`${kind} retires affected checks even when artifact versions are reused`, async () => {
    const f = await fixture(); const plan = f.plan();
    const state = createCooperation(plan, f.occurrence);
    state.questions = [question('approval')];
    state.task.requirements.downstream = { value: 'separate requirement', version: 0 };
    state.task.steps[1]!.requirementIds = ['downstream'];
    state.checkItems[1]!.requirementId = 'downstream';
    state.task.steps.push({ ...structuredClone(state.task.steps[0]!), id: 'unrelated' });
    state.instructions.unrelated = 'Independent work';
    state.checkItems.push({ id: 'unrelated', requirementId: 'output', stepId: 'unrelated', required: true });
    // unrelated is deliberately independent of the corrected requirement.
    state.task.steps[2]!.requirementIds = ['downstream'];
    state.checkItems[2]!.requirementId = 'downstream';
    for (const step of state.task.steps) { step.status = 'done'; step.artifactVersion = 'same-version'; }
    for (const item of state.checkItems) updateCooperation(state, { revision: 0, kind: 'check', checkId: item.id,
      status: kind === 'retry-step' && item.id === 'prepared' ? 'failed' : 'passed', evidenceLocation: `file:///old/${item.id}` });
    const operation = kind === 'correction' ? { kind, changes: { output: 'corrected' } } : kind === 'retry-step'
      ? { kind, stepId: 'prepare' } : { kind, questionId: 'question', operation: { ...state.questions[0]!.operation!, modification: 'revise' }, instructions: { prepare: 'Revised preparation' } };
    updateCooperation(state, { revision: 0, ...operation });
    expect(state.checks.map(check => check.checkId)).toEqual(['unrelated']);
    expect(state.task.events.filter(event => event.kind === 'check.recorded')).toHaveLength(3);
    for (const step of state.task.steps) { step.status = 'done'; step.artifactVersion = 'same-version'; }
    expect(currentCheck(state.task, state.checkItems[0]!, state.checks)).toBeUndefined();
    expect(currentCheck(state.task, state.checkItems[1]!, state.checks)).toBeUndefined();
    expect(currentCheck(state.task, state.checkItems[2]!, state.checks)?.status).toBe('passed');
    expect(acceptance(state).complete).toBe(false);
    validateCooperation(state);
    for (const item of state.checkItems.slice(0, 2)) updateCooperation(state, { revision: 0, kind: 'check', checkId: item.id, status: 'passed', evidenceLocation: `file:///fresh/${item.id}` });
    expect(acceptance(state).complete).toBe(true);
  });
}

for (const field of ['options', 'kind'] as const) {
  test(`persisted request missing ${field} fails closed without rewriting disk`, async () => {
    const f = await fixture(); const plan = f.plan(); plan.questions = [question('approval')]; plan.task.steps[0]!.questionIds = ['question'];
    await f.call(f.path, 'POST', plan);
    const disk = JSON.parse(await readFile(f.ledgerPath, 'utf8'));
    delete disk.cooperation[f.occurrence.occurrenceKey].requests[0][field];
    const corrupted = JSON.stringify(disk);
    await writeFile(f.ledgerPath, corrupted);
    expect((await f.call('/lite/api/requests')).status).toBe(502);
    expect(await readFile(f.ledgerPath, 'utf8')).toBe(corrupted);
  });
}

test('disk boundary rejects malformed requests and evidence before consumption', async () => {
  const f = await fixture(); const plan = f.plan(); plan.questions = [question('approval')]; plan.task.steps[0]!.questionIds = ['question'];
  const state = createCooperation(plan, f.occurrence); planCooperation(state);
  validateCooperation(JSON.parse(JSON.stringify(state)));
  const mutations: ((state: any) => void)[] = [
    s => { delete s.requests[0].options; }, s => { delete s.requests[0].kind; },
    s => { s.requests[0].kind = 'clarification'; }, s => { s.requests[0].options = [null]; },
    s => { s.requests[0].options = []; }, s => { s.requests[0].options[0].label = 42; },
    s => { s.requests[0].options[0].id = 'arbitrary'; }, s => { s.requests[0].createdAt = 'invalid'; },
    s => { s.requests[0].requirementVersions = {}; }, s => { s.requests[0].requirementVersions.output = -1; },
    s => { s.requests[0].requirementVersions.missing = 0; }, s => { delete s.requests[0].operation; },
    s => { s.requests[0].result = { status: 'bogus', detail: '' }; }, s => { s.requests[0].status = 'resolved'; },
    s => { s.requests[0].result = { status: 'accepted', detail: 'approve' }; },
    s => { s.requests[0].status = 'expired'; s.requests[0].result = { status: 'accepted', detail: 'approve' }; },
    s => { s.requests.push(s.requests[0]); }, s => { s.questions = [null]; },
    s => { s.questions[0].answers = [null]; }, s => { s.checkItems = [null]; },
    s => { s.agentDone = 'yes'; }, s => { s.scores = [null]; }, s => { s.task.events = [null]; },
    s => { s.checks = [{ checkId: 'prepared', runId: s.task.runId, artifactVersion: 'v1', status: 'passed', evidenceLocation: 'file:///check' }]; },
    s => { s.checks = [{ checkId: 'prepared', runId: s.task.runId, requirementVersion: 0, artifactVersion: 'v1', status: 'unknown', evidenceLocation: '' }]; },
  ];
  for (const mutate of mutations) {
    const corrupted = structuredClone(state); mutate(corrupted);
    expect(() => validateCooperation(corrupted)).toThrow(InvalidCooperation);
  }
});
