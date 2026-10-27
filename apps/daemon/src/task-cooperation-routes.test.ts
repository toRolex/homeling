import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityLedger } from "./activity-ledger.ts";
import { daemonConfigFromEnv } from "./config.ts";
import { PersonaRegistry } from "./persona-registry.ts";
import type { PersonaRuntime } from "./persona-service.ts";
import { fixtureAdmission, handleUnlockedRequest } from "./session-test-fixture.ts";
import { createDaemonSystemAdmissions } from "./system-admission.ts";
import type { CooperationQuestion } from "./task-cooperation.ts";

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
  let delivery: "submitted" | "unknown" = "submitted";
  let busy = false;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(init.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : String(init.body)).text);
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
  return { call, path, plan, change, writes, activity, occurrence, observer, setDelivery(value: typeof delivery) { delivery = value; }, setBusy(value: boolean) { busy = value; } };
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
