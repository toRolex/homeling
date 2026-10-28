import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActivityEvent, ActivityResponse, ActivityTaskResponse, TaskOccurrence } from "@homeling/contracts";
import type { MutationAdmission } from "./session-lock.ts";
import type { SystemAdmission } from "./system-admission.ts";
import type { TaskResultAdmission } from "./mutation-result.ts";

import { acceptance, answerCooperation, cooperationRequests, createCooperation, planCooperation, runnableSteps,
  updateCooperation, validateCooperation, CooperationConflict } from "./task-cooperation.ts";
import type { CooperationState } from "./task-cooperation.ts";

interface LedgerState {
  version: 1;
  cooperation?: Record<string, CooperationState>;
  events: ActivityEvent[];
  occurrences: TaskOccurrence[];
  worked?: string[];
  workEpochs?: Record<string, string>;
  completionEpochs?: Record<string, string>;
}

function validatedLedger(value: unknown): LedgerState {
  const invalid = (): never => { throw new Error("Invalid activity ledger"); };
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const text = (item: unknown): item is string => typeof item === "string" && item.length > 0;
  const date = (item: unknown): boolean => text(item) && Number.isFinite(Date.parse(item));
  if (!object(value) || value.version !== 1 || !Array.isArray(value.events) || !Array.isArray(value.occurrences)) return invalid();
  const occurrences = new Map<string, Record<string, unknown>>();
  const paneBindings = new Map<string, Record<string, unknown>>();
  for (const item of value.occurrences) {
    if (!object(item) || !text(item.occurrenceKey) || !text(item.personaId) || !text(item.spaceId) || !text(item.paneId) || !text(item.title) || !date(item.createdAt) || !["active", "completed", "failed", "unknown"].includes(String(item.status)) || occurrences.has(item.occurrenceKey)) return invalid();
    const previous = paneBindings.get(item.paneId);
    if (previous && (previous.personaId !== item.personaId || previous.spaceId !== item.spaceId || previous.status === "active")) return invalid();
    paneBindings.set(item.paneId, item);
    occurrences.set(item.occurrenceKey, item);
  }
  const ids = new Set<string>(); const keys = new Set<string>();
  const kinds = new Map<string, Set<string>>();
  let sequence = 0;
  for (const item of value.events) {
    if (!object(item) || !text(item.id) || !text(item.occurrenceKey) || !text(item.kind) || !text(item.dedupeKey) || !date(item.occurredAt) || !["task.created", "task.completed", "task.failed", "task.unknown", "observation.gap"].includes(item.kind) || !["daemon.launch", "herdr.event", "daemon.observer"].includes(String(item.source)) || (item.detail !== undefined && typeof item.detail !== "string") || item.sequence !== sequence + 1 || ids.has(item.id) || keys.has(item.dedupeKey)) return invalid();
    const occurrence = occurrences.get(item.occurrenceKey);
    const baseKey = `${item.occurrenceKey}:${item.kind}`;
    if (!occurrence || occurrence.paneId !== item.paneId || occurrence.personaId !== item.personaId || !(item.dedupeKey === baseKey || item.kind === "observation.gap" && item.dedupeKey.startsWith(`${baseKey}:`) && item.dedupeKey.length > baseKey.length + 1)) return invalid();
    ids.add(item.id); keys.add(item.dedupeKey); sequence++;
    const found = kinds.get(item.occurrenceKey) ?? new Set<string>(); found.add(item.kind); kinds.set(item.occurrenceKey, found);
  }
  for (const [key, occurrence] of occurrences) {
    const found = kinds.get(key);
    if (!found?.has("task.created")) return invalid();
    const terminal = ["task.completed", "task.failed", "task.unknown"].filter((kind) => found.has(kind));
    if (terminal.length > 1 || (occurrence.status === "active" ? terminal.length !== 0 : terminal[0] !== `task.${occurrence.status}`)) return invalid();
  }
  if (value.worked !== undefined && (!Array.isArray(value.worked) || value.worked.some((key) => typeof key !== "string" || !occurrences.has(key)))) return invalid();
  for (const epochs of [value.workEpochs, value.completionEpochs]) {
    if (epochs !== undefined && (!object(epochs) || Object.entries(epochs).some(([key, epoch]) => !occurrences.has(key) || !text(epoch)))) return invalid();
  }
  if (value.cooperation !== undefined) {
    if (!object(value.cooperation)) return invalid();
    for (const [key, cooperation] of Object.entries(value.cooperation)) {
      if (!occurrences.has(key)) return invalid();
      validateCooperation(cooperation);
      if (cooperation.task.runId !== key) return invalid();
    }
  }
  return value as unknown as LedgerState;
}

function latestOccurrence(occurrences: readonly TaskOccurrence[], paneId: string): TaskOccurrence | undefined {
  for (let index = occurrences.length - 1; index >= 0; index--) {
    const occurrence = occurrences[index]!;
    if (occurrence.paneId === paneId) return occurrence;
  }
  return undefined;
}

type ObservedEvent = { kind: "status"; paneId: string; spaceId: string; status: "idle" | "working" | "blocked" | "done" | "unknown" } | { kind: "exit"; paneId: string; spaceId: string };

/** Only fields actually supported by the Herdr wire contract are consumed. */
export function normalizeHerdrActivityEvent(event: string, data: unknown): ObservedEvent | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const body = data as Record<string, unknown>;
  if (typeof body.pane_id !== "string" || !/^[A-Za-z0-9:._~-]{1,256}$/.test(body.pane_id) || typeof body.workspace_id !== "string" || !/^[A-Za-z0-9:._~-]{1,256}$/.test(body.workspace_id)) return null;
  const name = event.replaceAll(".", "_");
  if (body.type !== undefined && body.type !== name && body.type !== event) return null;
  if (name === "pane_exited" || name === "pane_closed") return { kind: "exit", paneId: body.pane_id, spaceId: body.workspace_id };
  if (name !== "pane_agent_status_changed" || !["idle", "working", "blocked", "done", "unknown"].includes(String(body.agent_status))) return null;
  return { kind: "status", paneId: body.pane_id, spaceId: body.workspace_id, status: body.agent_status as Extract<ObservedEvent, { kind: "status" }>["status"] };
}

export class TaskOccurrenceUnavailable extends Error {
  constructor() { super("Task occurrence is historical, unknown, or cannot be reliably bound to the live pane"); }
}

export class ActivityLedger {
  private tail: Promise<void> = Promise.resolve();
  private listeners = new Set<(event: ActivityEvent) => void>();
  private observation: ActivityResponse["observation"] = "starting";
  private observationEpoch = randomUUID();
  constructor(readonly path: string) {}

  private async read(): Promise<LedgerState> {
    try {
      return validatedLedger(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, events: [], occurrences: [] };
    }
  }

  private commit<T>(admission: MutationAdmission, change: (state: LedgerState) => { result: T; changed: boolean }): Promise<T> {
    const result = this.tail.then(async () => {
      admission.assert();
      const state = await this.read();
      const previous = state.events.length;
      const { result: value, changed } = change(state);
      if (!changed) return structuredClone(value);
      validatedLedger(state);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
        await admission.dispatch(() => rename(temporary, this.path));
      } finally { await rm(temporary, { force: true }); }
      for (const event of state.events.slice(previous)) for (const listener of this.listeners) {
        try { listener(structuredClone(event)); }
        catch { console.error("[homeling-daemon] activity subscriber failed"); }
      }
      return structuredClone(value);
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async list(personaId?: string, afterSequence = 0): Promise<ActivityResponse> {
    await this.tail;
    const state = await this.read();
    return {
      events: state.events.filter((event) => (!personaId || event.personaId === personaId) && event.sequence > afterSequence),
      occurrences: state.occurrences.filter((occurrence) => !personaId || occurrence.personaId === personaId),
      observation: this.observation,
    };
  }

  async ownership(paneId: string): Promise<TaskOccurrence | undefined> {
    const { occurrences } = await this.list();
    return latestOccurrence(occurrences, paneId);
  }

  private lookup(state: LedgerState, occurrenceKey: string): ActivityTaskResponse | undefined {
    const occurrence = state.occurrences.find((item) => item.occurrenceKey === occurrenceKey);
    if (!occurrence) return undefined;
    const current = latestOccurrence(state.occurrences, occurrence.paneId)?.occurrenceKey === occurrenceKey;
    const launchBound = state.events.some((event) => event.occurrenceKey === occurrenceKey && event.kind === "task.created" && event.source === "daemon.launch");
    return { occurrence, current, observation: this.observation, liveAvailable: current && occurrence.status === "active" && this.observation === "live" && launchBound };
  }

  async task(occurrenceKey: string): Promise<ActivityTaskResponse | undefined> {
    await this.tail;
    return this.lookup(await this.read(), occurrenceKey);
  }

  private current(state: LedgerState, occurrenceKey: string): TaskOccurrence {
    const task = this.lookup(state, occurrenceKey);
    if (!task?.liveAvailable) throw new TaskOccurrenceUnavailable();
    return task.occurrence;
  }

  async assertCurrent(occurrenceKey: string): Promise<TaskOccurrence> {
    await this.tail;
    return this.current(await this.read(), occurrenceKey);
  }

  async dispatchCurrent<T>(occurrenceKey: string, admission: MutationAdmission, effect: (occurrence: TaskOccurrence) => T): Promise<Awaited<T>> {
    if ("scope" in admission) throw new Error("Live task controls require original user admission");
    const dispatched = this.tail.then(async () => {
      admission.assert();
      const occurrence = this.current(await this.read(), occurrenceKey);
      return { result: admission.dispatch(() => effect(occurrence)) };
    });
    // Release serialization after actual dispatch, not after network completion; the observer stays live.
    this.tail = dispatched.then(() => undefined, () => undefined);
    return await dispatched.then(({ result }) => result);
  }

  register(input: { personaId: string; spaceId: string; paneId: string; title: string }, admission: MutationAdmission | TaskResultAdmission): Promise<TaskOccurrence> {
    if ("scope" in admission && (admission.scope !== "task.result" || !("resourceId" in admission) || admission.resourceId !== input.paneId)) return Promise.reject(new Error("Task registration requires user admission or its exact dispatched pane result"));
    return this.commit(admission, (state) => {
      const current = latestOccurrence(state.occurrences, input.paneId);
      if (current && (current.personaId !== input.personaId || current.spaceId !== input.spaceId)) throw new Error("Task ownership cannot be reassigned");
      if (current?.status === "active") return { result: current, changed: false };
      const occurrence: TaskOccurrence = { ...input, occurrenceKey: randomUUID(), createdAt: new Date().toISOString(), status: "active" };
      state.occurrences.push(occurrence);
      this.append(state, occurrence, "task.created", "daemon.launch");
      return { result: occurrence, changed: true };
    });
  }

  observe(event: string, data: unknown, admission: SystemAdmission<"activity.observe">): Promise<void> {
    if (admission.scope !== "activity.observe") return Promise.reject(new Error("activity.observe scope required"));
    const raw = normalizeHerdrActivityEvent(event, data);
    if (!raw) return Promise.resolve();
    return this.commit(admission, (state) => {
      let occurrence = latestOccurrence(state.occurrences, raw.paneId);
      if (!occurrence || occurrence.spaceId !== raw.spaceId) return { result: undefined, changed: false };
      if (raw.kind === "exit") {
        if (occurrence.status !== "active") return { result: undefined, changed: false };
        this.settle(state, occurrence, "unknown", "herdr.event", "Pane exited/closed; Herdr provides no exit outcome");
        return { result: undefined, changed: true };
      }
      if (occurrence.status === "completed" && state.completionEpochs?.[occurrence.occurrenceKey] === this.observationEpoch && raw.status === "working") {
        occurrence = { ...occurrence, occurrenceKey: randomUUID(), createdAt: new Date().toISOString(), status: "active" };
        state.occurrences.push(occurrence);
        this.append(state, occurrence, "task.created", "herdr.event", "New work cycle observed after explicit completion");
      }
      if (occurrence.status !== "active") return { result: undefined, changed: false };
      if (raw.status === "working") {
        const cooperation = state.cooperation?.[occurrence.occurrenceKey];
        const wasDone = cooperation?.agentDone === true;
        if (cooperation) cooperation.agentDone = false;
        if (state.workEpochs?.[occurrence.occurrenceKey] === this.observationEpoch) return { result: undefined, changed: wasDone };
        state.workEpochs ??= {};
        state.workEpochs[occurrence.occurrenceKey] = this.observationEpoch;
        return { result: undefined, changed: true };
      }
      if (raw.status !== "done" || state.workEpochs?.[occurrence.occurrenceKey] !== this.observationEpoch) return { result: undefined, changed: false };
      const cooperation = state.cooperation?.[occurrence.occurrenceKey];
      if (cooperation) {
        cooperation.agentDone = true;
        if (!acceptance(cooperation).complete) return { result: undefined, changed: true };
      }
      this.settle(state, occurrence, "completed", "herdr.event");
      state.completionEpochs ??= {};
      state.completionEpochs[occurrence.occurrenceKey] = this.observationEpoch;
      return { result: undefined, changed: true };
    });
  }

  degrade(admission: SystemAdmission<"activity.observe">): void {
    if (admission.scope !== "activity.observe") throw new Error("activity.observe scope required");
    admission.assert();
    this.observation = "gap";
    this.observationEpoch = randomUUID();
  }

  async gap(reason: string, admission: SystemAdmission<"activity.observe">): Promise<void> {
    this.degrade(admission);
    await this.commit(admission, (state) => {
      this.observationEpoch = randomUUID();
      const latest = new Map(state.occurrences.map((item) => [item.paneId, item]));
      for (const occurrence of latest.values()) {
        const cooperation = state.cooperation?.[occurrence.occurrenceKey];
        if (cooperation) {
          cooperation.task.steps.filter(step => step.status === "running").forEach(step => { step.status = "unknown"; });
        }
        this.append(state, occurrence, "observation.gap", "daemon.observer", reason, `${occurrence.occurrenceKey}:observation.gap:${this.observationEpoch}`);
        this.settle(state, occurrence, "unknown", "daemon.observer", "Observation gap: completion/failure cannot be recovered from snapshots");
      }
      return { result: undefined, changed: latest.size > 0 };
    });
  }

  live(admission: SystemAdmission<"activity.observe">): void {
    if (admission.scope !== "activity.observe") throw new Error("activity.observe scope required");
    admission.assert();
    this.observation = "live";
  }

  fail(occurrenceKey: string, reason: string, admission: MutationAdmission): Promise<void> {
    if ("scope" in admission) return Promise.reject(new Error("Launch failure registration requires the original user admission"));
    return this.commit(admission, (state) => {
      const occurrence = state.occurrences.find((item) => item.occurrenceKey === occurrenceKey);
      if (!occurrence || occurrence.status !== "active") return { result: undefined, changed: false };
      this.settle(state, occurrence, "failed", "daemon.launch", reason);
      return { result: undefined, changed: true };
    });
  }

  /** 协作计划与 Activity 共用串行提交和原子文件替换，不引入第二套任务身份。 */
  async cooperation(occurrenceKey: string) {
    await this.tail;
    const state = await this.read();
    if (!this.lookup(state, occurrenceKey)) throw new TaskOccurrenceUnavailable();
    const cooperation = state.cooperation?.[occurrenceKey];
    return cooperation ? { ...structuredClone(cooperation), acceptance: acceptance(cooperation),
      runnableStepIds: runnableSteps(cooperation).map(step => step.id) } : null;
  }

  async cooperationPending() {
    await this.tail;
    const state = await this.read();
    return state.occurrences.filter(occurrence => this.lookup(state, occurrence.occurrenceKey)?.liveAvailable)
      .flatMap(occurrence => {
        const cooperation = state.cooperation?.[occurrence.occurrenceKey];
        return cooperation ? cooperationRequests(cooperation, occurrence) : [];
      });
  }

  configureCooperation(key: string, input: unknown, admission: MutationAdmission) {
    return this.commit(admission, state => {
      const occurrence = this.current(state, key);
      if (state.cooperation?.[key]) throw new CooperationConflict("任务已配置协作计划；请使用版本化更新");
      const cooperation = createCooperation(input, occurrence);
      planCooperation(cooperation);
      state.cooperation ??= {};
      state.cooperation[key] = cooperation;
      return { result: cooperation, changed: true };
    });
  }

  changeCooperation(key: string, input: unknown, admission: MutationAdmission) {
    return this.commit(admission, state => {
      const occurrence = this.current(state, key);
      const cooperation = state.cooperation?.[key];
      if (!cooperation) throw new CooperationConflict("任务没有协作计划");
      updateCooperation(cooperation, input);
      planCooperation(cooperation);
      cooperation.revision++;
      if (cooperation.agentDone && acceptance(cooperation).complete) {
        this.settle(state, occurrence, "completed", "daemon.observer", "All required versioned checks passed");
        state.completionEpochs ??= {};
        state.completionEpochs[key] = this.observationEpoch;
      }
      return { result: cooperation, changed: true };
    });
  }

  answerCooperationRequest(id: string, optionId: string, key: string | undefined,
    admission: MutationAdmission, freeText?: string) {
    return this.commit(admission, state => {
      const entry = Object.entries(state.cooperation ?? {}).find(([, c]) => c.requests.some(r => r.id === id));
      if (!entry || key !== undefined && key !== entry[0]) throw new TaskOccurrenceUnavailable();
      this.current(state, entry[0]);
      const cooperation = entry[1];
      const result = answerCooperation(cooperation, id, optionId, freeText);
      planCooperation(cooperation);
      cooperation.revision++;
      return { result: { ...result, occurrenceKey: entry[0] }, changed: true };
    });
  }

  /** 派发前先持久登记 running；重复 advance 不会再次派发该阶段。 */
  beginCooperationStep(key: string, admission: MutationAdmission) {
    return this.commit<{ paneId: string; stepId: string; text: string } | null>(admission, state => {
      const occurrence = this.current(state, key);
      const cooperation = state.cooperation?.[key];
      if (!cooperation) throw new CooperationConflict("任务没有协作计划");
      if (cooperation.task.steps.some(step => step.status === "running" || step.status === "unknown")) {
        return { result: null, changed: false };
      }
      const step = runnableSteps(cooperation)[0];
      if (!step) return { result: null, changed: false };
      step.status = "running";
      cooperation.agentDone = false;
      cooperation.revision++;
      const text = ["[Homeling collaboration step]", `runId: ${key}`, `stepId: ${step.id}`,
        `revision: ${cooperation.revision}`, cooperation.instructions[step.id],
        "Confirmed requirements:", JSON.stringify(Object.fromEntries(Object.entries(cooperation.task.requirements).filter(([id]) =>
          !cooperation.questions.some(q => q.requirementId === id && cooperation.task.steps.some(s => s.questionIds.includes(q.id)))))),
        "Execute only this stage. Keep versioned output and evidence for stage checks.",
        "[End Homeling collaboration step]"].join("\n");
      return { result: { paneId: occurrence.paneId, stepId: step.id, text }, changed: true };
    });
  }

  async dispatchCooperationStep<T>(key: string, stepId: string, admission: MutationAdmission,
    effect: (occurrence: TaskOccurrence) => T): Promise<Awaited<T>> {
    const dispatched = this.tail.then(async () => {
      admission.assert();
      const state = await this.read();
      const occurrence = this.current(state, key);
      if (state.cooperation?.[key]?.task.steps.find(step => step.id === stepId)?.status !== "running") {
        throw new CooperationConflict("阶段状态已改变，取消派发");
      }
      return { result: admission.dispatch(() => effect(occurrence)) };
    });
    this.tail = dispatched.then(() => undefined, () => undefined);
    return await dispatched.then(({ result }) => result);
  }

  finishCooperationDelivery(key: string, stepId: string, outcome: "submitted" | "not-submitted" | "unknown",
    admission: MutationAdmission) {
    return this.commit(admission, state => {
      this.current(state, key);
      const cooperation = state.cooperation?.[key];
      const step = cooperation?.task.steps.find(item => item.id === stepId);
      if (!cooperation || !step || step.status !== "running") throw new CooperationConflict("阶段派发状态已改变");
      if (outcome === "not-submitted") step.status = "pending";
      if (outcome === "unknown") step.status = "unknown";
      cooperation.task.events.push({ kind: "step.dispatched", detail: JSON.stringify({ stepId, outcome }) });
      cooperation.revision++;
      return { result: undefined, changed: true };
    });
  }

  private settle(state: LedgerState, occurrence: TaskOccurrence, status: "completed" | "failed" | "unknown", source: ActivityEvent["source"], detail?: string): void {
    if (occurrence.status !== "active") return;
    state.occurrences[state.occurrences.indexOf(occurrence)] = { ...occurrence, status };
    this.append(state, occurrence, `task.${status}`, source, detail);
  }

  private append(state: LedgerState, occurrence: TaskOccurrence, kind: ActivityEvent["kind"], source: ActivityEvent["source"], detail?: string, dedupeKey = `${occurrence.occurrenceKey}:${kind}`): void {
    if (state.events.some((event) => event.dedupeKey === dedupeKey)) return;
    state.events.push({ id: randomUUID(), sequence: (state.events.at(-1)?.sequence ?? 0) + 1, dedupeKey, kind, source, personaId: occurrence.personaId, paneId: occurrence.paneId, occurrenceKey: occurrence.occurrenceKey, occurredAt: new Date().toISOString(), ...(detail ? { detail } : {}) });
  }
}
