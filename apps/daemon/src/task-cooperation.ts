/** 中山大学高级人工智能课程项目：任务生命周期中的人机协作控制。 */
import { randomUUID } from 'node:crypto';
import type { PendingRequest, TaskOccurrence } from '@homeling/contracts';
import { affectedSteps, executableSequence, validateGraph } from './task-plan.ts';
import type { TaskRecord } from './task-plan.ts';
import { scoreQuestion } from './clarification-value.ts';
import type { Question } from './clarification-value.ts';
import { applyCorrection, applyFeedback, reconcileUnknown } from './task-feedback.ts';
import type { FeedbackRequest, OperationScope } from './task-feedback.ts';
import { currentCheck, finalAcceptance, recordCheck, stagePassed } from './task-validation.ts';
import type { CheckItem, CheckRecord } from './task-validation.ts';

export interface CooperationQuestion extends Omit<Question, 'loss'> {
  losses: Record<string, Record<string, number>>;
  kind: 'clarification' | 'approval';
  operation?: OperationScope;
  /** 必需信息不可被默认值绕过；只有可选偏好允许低分时采用此方案。 */
  defaultAnswerId?: string;
}
export interface CooperationRequest extends FeedbackRequest {
  questionId: string;
  createdAt: string;
  options: { id: string; label: string }[];
}
export interface CooperationState {
  revision: number;
  agentDone?: boolean;
  task: TaskRecord;
  questions: CooperationQuestion[];
  requests: CooperationRequest[];
  checks: CheckRecord[];
  checkItems: CheckItem[];
  budget: number;
  delayPenaltyPerMs: number;
  /** 阶段指令为文本，不作为 shell 命令执行。 */
  instructions: Record<string, string>;
  scores: { questionId: string; score: number; workMs: number; stallMs: number }[];
}
export class CooperationConflict extends Error {}
export class InvalidCooperation extends Error {}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvalidCooperation(message);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.every(text); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function scope(value: unknown): value is OperationScope {
  return object(value) && [value.target, value.modification, value.impact, value.artifactVersion].every(text);
}
function questionModel(question: CooperationQuestion): Question {
  return { ...question, loss: (action, theta) => question.losses[action]?.[theta] ?? NaN };
}
/** HTTP 与磁盘共同使用的边界校验，不接受函数或任意执行回调。 */
export function validateCooperation(value: unknown): asserts value is CooperationState {
  requireValue(object(value) && Number.isInteger(value.revision) && Number(value.revision) >= 0 &&
    Number.isInteger(value.budget) && Number(value.budget) >= 0 && finite(value.delayPenaltyPerMs), '无效协作状态');
  requireValue(value.agentDone === undefined || typeof value.agentDone === 'boolean', '无效完成标识');
  requireValue(object(value.task) && text(value.task.runId) && Array.isArray(value.task.steps) &&
    object(value.task.requirements) && Array.isArray(value.task.events), '无效任务记录');
  for (const requirement of Object.values(value.task.requirements)) {
    requireValue(object(requirement) && typeof requirement.value === 'string' &&
      Number.isInteger(requirement.version) && Number(requirement.version) >= 0, '无效要求版本');
  }
  for (const step of value.task.steps) {
    requireValue(object(step) && text(step.id) && stringList(step.dependencies) && stringList(step.requirementIds) &&
      stringList(step.questionIds) && stringList(step.resources) && typeof step.authorized === 'boolean' &&
      finite(step.durationMs) && ['pending', 'waiting', 'running', 'done', 'unknown'].includes(String(step.status)) &&
      (step.artifactVersion === undefined || text(step.artifactVersion)), '无效阶段');
  }
  requireValue(value.task.events.every(event => object(event) && text(event.kind) && typeof event.detail === 'string'), '无效任务事件');
  const state = value as unknown as CooperationState;
  validateGraph(state.task.steps);
  requireValue(Array.isArray(state.questions) && Array.isArray(state.requests) &&
    Array.isArray(state.checkItems) && Array.isArray(state.checks) && Array.isArray(state.scores) &&
    object(state.instructions) && Object.values(state.instructions).every(text), '无效协作集合');
  requireValue(state.questions.every(object) && state.checkItems.every(object), '无效问题或检查项');
  requireValue(new Set(state.questions.map(q => q.id)).size === state.questions.length &&
    new Set(state.questions.map(q => q.requirementId)).size === state.questions.length, '同一要求必须合并为一个问题');
  for (const q of state.questions) {
    requireValue(object(q) && text(q.id) && text(q.requirementId) && text(q.title) &&
      typeof q.progress === 'string' && stringList(q.details) && stringList(q.actions) && q.actions.length > 0 &&
      stringList(q.reservedResources) && typeof q.required === 'boolean' && typeof q.answerable === 'boolean' &&
      q.environmentResolvable === false && ['clarification', 'approval'].includes(q.kind) && object(q.losses),
    '问题须为用户可决定的未决要求；环境事实应先用工具查询');
    requireValue(Object.hasOwn(state.task.requirements, q.requirementId), '问题必须关联任务要求');
    requireValue(q.kind !== 'approval' || scope(q.operation), '审批必须提供精确操作范围');
    requireValue(Array.isArray(q.answers) && q.answers.length > 0 && q.answers.every(object) &&
      new Set(q.answers.map(a => a.id)).size === q.answers.length &&
      q.answers.every(a => text(a.id) && a.id !== '__free_text__' && text(a.consequence)), '无效候选回答');
    requireValue(q.kind !== 'approval' || q.answers.some(a => a.id === 'approve') && q.answers.some(a => a.id === 'deny'), '审批需有 approve / deny 选项');
    scoreQuestion(questionModel(q), 0, state.delayPenaltyPerMs);
    requireValue(q.required || q.kind === 'approval' || q.answers.some(a => a.id === q.defaultAnswerId), '可选偏好需声明默认回答');
  }
  const ids = new Set(state.task.steps.map(s => s.id));
  for (const step of state.task.steps) {
    requireValue(step.requirementIds.every(id => Object.hasOwn(state.task.requirements, id)) &&
      step.questionIds.every(id => state.questions.some(q => q.id === id)), '阶段引用不存在的要求或问题');
    requireValue(step.questionIds.every(id => step.requirementIds.includes(state.questions.find(q => q.id === id)!.requirementId)),
      '阶段须声明其待决问题对应的要求');
    requireValue(text(state.instructions[step.id]), '每个阶段须提供执行指令');
  }
  requireValue(new Set(state.checkItems.map(item => item.id)).size === state.checkItems.length, '重复检查标识');
  for (const item of state.checkItems) {
    requireValue(object(item) && text(item.id) && ids.has(item.stepId) && typeof item.required === 'boolean' &&
      Object.hasOwn(state.task.requirements, item.requirementId), '无效检查项');
  }
  requireValue(state.requests.every(object) && new Set(state.requests.map(r => r.id)).size === state.requests.length,
    '无效或重复协作请求');
  for (const request of state.requests) {
    const q = state.questions.find(q => q.id === request.questionId);
    requireValue(text(request.id) && request.runId === state.task.runId && q && request.kind === q.kind &&
      text(request.createdAt) && Number.isFinite(Date.parse(request.createdAt)) &&
      ['pending', 'resolved', 'expired'].includes(request.status) && object(request.requirementVersions) &&
      Object.hasOwn(request.requirementVersions, q.requirementId) &&
      Object.entries(request.requirementVersions).every(([id, version]) => Object.hasOwn(state.task.requirements, id) &&
        Number.isInteger(version) && version >= 0) &&
      Array.isArray(request.options) && request.options.length > 0 &&
      request.options.every(option => object(option) && text(option.id) && text(option.label) && q.answers.some(a => a.id === option.id)) &&
      new Set(request.options.map(option => option.id)).size === request.options.length &&
      (request.kind !== 'approval' || scope(request.operation)), '无效协作请求');
    requireValue(request.result === undefined || object(request.result) &&
      ['accepted', 'stale', 'reconfirm'].includes(request.result.status) && typeof request.result.detail === 'string', '无效回答结果');
    requireValue((request.status === 'resolved') === (request.result?.status === 'accepted') &&
      (request.status !== 'pending' || request.result === undefined), '请求状态与回答结果不一致');
  }
  for (const check of state.checks) {
    requireValue(object(check) && check.runId === state.task.runId && text(check.artifactVersion) &&
      Number.isInteger(check.requirementVersion) && check.requirementVersion >= 0 &&
      ['passed', 'failed', 'unknown'].includes(check.status) && typeof check.evidenceLocation === 'string' &&
      (check.missingEvidence === undefined || typeof check.missingEvidence === 'string') &&
      (check.status === 'unknown' ? !!check.missingEvidence?.trim() : !!check.evidenceLocation.trim()) &&
      state.checkItems.some(item => item.id === check.checkId), '无效检查记录');
  }
  requireValue(state.scores.every(score => object(score) && state.questions.some(q => q.id === score.questionId) &&
    typeof score.score === 'number' && Number.isFinite(score.score) && finite(score.workMs) && finite(score.stallMs)), '无效问题评分');
}
export function createCooperation(input: unknown, occurrence: TaskOccurrence): CooperationState {
  requireValue(object(input), '需要协作计划');
  const state = { ...input, revision: 0, agentDone: false, requests: [], checks: [], scores: [] } as unknown as CooperationState;
  requireValue(object(state.task) && state.task.runId === occurrence.occurrenceKey, '计划必须绑定当前任务运行标识');
  validateCooperation(state);
  requireValue(state.task.steps.length > 0 && state.task.steps.every(s => s.status === 'pending'), '初始阶段必须为 pending');
  return state;
}
function unresolved(state: CooperationState, question: CooperationQuestion): boolean {
  return state.task.steps.some(step => step.questionIds.includes(question.id) && step.status !== 'done');
}
function clearQuestion(state: CooperationState, question: CooperationQuestion, answer: string): void {
  const requirement = state.task.requirements[question.requirementId];
  state.task.requirements[question.requirementId] = { value: answer, version: (requirement?.version ?? 0) + 1 };
  for (const step of state.task.steps) {
    step.questionIds = step.questionIds.filter(id => id !== question.id);
    if (step.status === 'waiting') step.status = 'pending';
  }
}
function stageReady(state: CooperationState, stepId: string): boolean {
  const step = state.task.steps.find(s => s.id === stepId)!;
  return step.dependencies.every(id => stagePassed(state.task, state.checkItems.filter(item => item.stepId === id), state.checks));
}
export function runnableSteps(state: CooperationState) {
  const blocked = new Set(state.questions.filter(q => unresolved(state, q)).map(q => q.id));
  const reserved = new Set(state.requests.filter(r => r.status === 'pending').flatMap(r =>
    state.questions.find(q => q.id === r.questionId)?.reservedResources ?? []));
  return executableSequence(state.task.steps, blocked, reserved).filter(step =>
    step.dependencies.every(id => state.task.steps.find(parent => parent.id === id)?.status === 'done') &&
    stageReady(state, step.id));
}
/** 每次阶段、回答或证据变化后重算。所有未决问题均阻塞相关阶段。 */
export function planCooperation(state: CooperationState): void {
  const candidates = state.questions.filter(q => unresolved(state, q) && q.answerable &&
    !state.requests.some(r => r.questionId === q.id && r.status === 'pending'));
  state.scores = candidates.map(q => {
    const blocked = new Set(state.questions.filter(item => unresolved(state, item)).map(item => item.id));
    const resources = new Set([...q.reservedResources, ...state.requests.filter(r => r.status === 'pending')
      .flatMap(r => state.questions.find(item => item.id === r.questionId)?.reservedResources ?? [])]);
    const sequence = executableSequence(state.task.steps, blocked, resources);
    // 只计入检查条件已具备的可执行前缀，避免把未来验收时间算为可用工作。
    const prefix = sequence.slice(0, sequence.findIndex(step => !stageReady(state, step.id)) < 0
      ? sequence.length : sequence.findIndex(step => !stageReady(state, step.id)));
    const result = scoreQuestion(questionModel(q), prefix.reduce((sum, step) => sum + step.durationMs, 0), state.delayPenaltyPerMs);
    return { questionId: q.id, score: result.score, workMs: result.workMs, stallMs: result.stallMs };
  }).sort((a, b) => b.score - a.score);
  let selected = state.budget > 0 ? state.scores.find(item => item.score > 0) : undefined;
  if (!selected && runnableSteps(state).length === 0) selected = state.scores.find(item => {
    const q = state.questions.find(question => question.id === item.questionId)!;
    return q.required || q.kind === 'approval';
  });
  if (selected) {
    const q = state.questions.find(item => item.id === selected.questionId)!;
    const related = state.task.steps.filter(s => s.questionIds.includes(q.id));
    const requirements = new Set([q.requirementId, ...related.flatMap(s => s.requirementIds)]);
    const request: CooperationRequest = {
      id: `cooperation:${randomUUID()}`, runId: state.task.runId, questionId: q.id, kind: q.kind,
      status: 'pending', createdAt: new Date().toISOString(),
      requirementVersions: Object.fromEntries([...requirements].map(id => [id, state.task.requirements[id]?.version ?? 0])),
      ...(q.operation ? { operation: structuredClone(q.operation) } : {}),
      options: q.answers.map(a => ({ id: a.id, label: a.consequence })),
    };
    state.requests.push(request);
    state.budget = Math.max(0, state.budget - 1);
    const affected = affectedSteps(state.task.steps, related.map(s => s.id));
    state.task.steps.forEach(step => { if (affected.has(step.id) && step.status === 'pending') step.status = 'waiting'; });
  }
  // 可选低价值偏好使用模板给出的默认值；必需信息和审批始终等待。
  for (const q of candidates) {
    if (!q.required && q.kind !== 'approval' && q.defaultAnswerId &&
      !state.requests.some(r => r.questionId === q.id && r.status === 'pending')) {
      clearQuestion(state, q, q.defaultAnswerId);
    }
  }
}
export function cooperationRequests(state: CooperationState, occurrence: TaskOccurrence): PendingRequest[] {
  return state.requests.filter(r => r.status === 'pending').map(r => {
    const q = state.questions.find(item => item.id === r.questionId)!;
    return { id: r.id, paneId: occurrence.paneId, personaId: occurrence.personaId,
      taskOccurrenceKey: occurrence.occurrenceKey, createdAt: r.createdAt, status: r.status,
      kind: 'prompt-select' as const, payload: { question: q.title,
        subject: [q.progress, ...(q.operation ? [JSON.stringify(q.operation)] : [])],
        collaboration: { freeText: q.kind === 'clarification', details: q.details }, options: r.options } };
  });
}
export function answerCooperation(state: CooperationState, requestId: string, optionId: string, freeText?: string) {
  const request = state.requests.find(r => r.id === requestId);
  if (!request) throw new CooperationConflict('请求不存在');
  const q = state.questions.find(item => item.id === request.questionId)!;
  if (!request.options.some(option => option.id === optionId) && !(q.kind === 'clarification' && freeText?.trim())) {
    throw new InvalidCooperation('无效回答');
  }
  const duplicate = request.status !== 'pending';
  const result = applyFeedback(state.task, request, {
    runId: state.task.runId, requestId, value: freeText?.trim() || optionId, approved: optionId === 'approve',
  }, q.operation);
  if (result.status === 'accepted' && !duplicate) {
    if (q.kind === 'clarification') clearQuestion(state, q, freeText?.trim() || optionId);
    else if (optionId === 'approve') {
      for (const step of state.task.steps.filter(s => s.questionIds.includes(q.id))) {
        step.authorized = true;
        step.questionIds = step.questionIds.filter(id => id !== q.id);
        if (step.status === 'waiting') step.status = 'pending';
      }
    } else {
      state.task.steps.filter(s => s.questionIds.includes(q.id)).forEach(s => { s.authorized = false; });
      // 拒绝后保留阻塞，但不自动重新弹出同一审批。
      q.answerable = false;
    }
  }
  return { status: result.status === 'accepted' ? 'resolved' as const : 'expired' as const,
    outcome: result.status !== 'accepted' ? 'stale' as const : duplicate ? 'already-handled' as const : 'submitted' as const };
}
function invalidateChecks(state: CooperationState, affected: ReadonlySet<string>): void {
  const ids = new Set(state.checkItems.filter(item => affected.has(item.stepId)).map(item => item.id));
  // 检查事件仍保留审计历史，但即使复用产物版本，也不能恢复已废止的证据。
  state.checks = state.checks.filter(check => !ids.has(check.checkId));
}
function reopenApprovals(state: CooperationState, affected: ReadonlySet<string>): void {
  for (const q of state.questions.filter(item => item.kind === 'approval')) {
    const steps = state.task.steps.filter(step => affected.has(step.id) && step.requirementIds.includes(q.requirementId));
    if (!steps.length) continue;
    q.answerable = true;
    steps.forEach(step => {
      step.authorized = false;
      if (!step.questionIds.includes(q.id)) step.questionIds.push(q.id);
    });
    state.requests.filter(r => r.questionId === q.id && r.status === 'pending').forEach(r => { r.status = 'expired'; });
  }
}
export function acceptance(state: CooperationState) {
  return finalAcceptance(state.task, state.checkItems, state.checks,
    state.requests.filter(r => r.status === 'pending').map(r => r.id));
}
/** 结构化工具报告/用户纠错入口。外部执行结果不明不能被 done 报告直接覆盖。 */
export function updateCooperation(state: CooperationState, value: unknown): void {
  requireValue(object(value), '需要协作操作');
  if (value.revision !== state.revision) throw new CooperationConflict('计划版本冲突，请刷新后重试');
  if (value.kind === 'correction') {
    requireValue(object(value.changes) && Object.values(value.changes).every(v => typeof v === 'string'), '无效纠错');
    const affected = new Set(applyCorrection(state.task, value.changes as Record<string, string>, state.requests));
    invalidateChecks(state, affected);
    state.task.steps.filter(step => affected.has(step.id)).forEach(step => { delete step.artifactVersion; });
    reopenApprovals(state, affected);
    // 重开受影响要求的问题；旧授权不能沿用。
    for (const q of state.questions) if (Object.hasOwn(value.changes, q.requirementId) ||
      q.kind === 'approval' && state.task.steps.some(s => affected.has(s.id) && s.requirementIds.includes(q.requirementId))) {
      q.answerable = true;
      state.task.steps.filter(s => s.requirementIds.includes(q.requirementId)).forEach(s => {
        if (!s.questionIds.includes(q.id)) s.questionIds.push(q.id);
      });
    }
  } else if (value.kind === 'revise-operation') {
    const q = state.questions.find(item => item.id === value.questionId && item.kind === 'approval');
    requireValue(q && scope(value.operation) && object(value.instructions) &&
      Object.values(value.instructions).every(text), '需提供新操作范围与阶段指令');
    const affected = state.task.steps.filter(step => step.requirementIds.includes(q.requirementId));
    requireValue(affected.length > 0 && !affected.some(step => ['running', 'unknown'].includes(step.status)), '先停止并核查受影响阶段');
    q.operation = value.operation;
    q.answerable = true;
    for (const request of state.requests) if (request.questionId === q.id && request.status === 'pending') request.status = 'expired';
    const downstream = affectedSteps(state.task.steps, affected.map(step => step.id));
    requireValue(!state.task.steps.some(step => downstream.has(step.id) && ['running', 'unknown'].includes(step.status)), '先停止并核查下游阶段');
    state.task.steps.filter(step => downstream.has(step.id)).forEach(step => {
      step.status = 'pending'; step.authorized = false; delete step.artifactVersion;
    });
    invalidateChecks(state, downstream);
    reopenApprovals(state, downstream);
    for (const step of affected) {
      requireValue(text(value.instructions[step.id]), '每个受影响阶段须提供新指令');
      state.instructions[step.id] = value.instructions[step.id] as string;
      step.authorized = false;
      step.status = 'pending';
      delete step.artifactVersion;
      if (!step.questionIds.includes(q.id)) step.questionIds.push(q.id);
    }
  } else if (value.kind === 'step-result') {
    const step = state.task.steps.find(s => s.id === value.stepId);
    requireValue(step && step.status === 'running' && ['done', 'unknown'].includes(String(value.status)), '阶段未在执行或状态无效');
    requireValue(text(value.artifactVersion) && text(value.evidenceLocation), '需提供产物版本及结果证据');
    step.status = value.status as 'done' | 'unknown';
    step.artifactVersion = value.artifactVersion;
    state.task.events.push({ kind: 'step.result', detail: JSON.stringify(value) });
  } else if (value.kind === 'check') {
    const item = state.checkItems.find(c => c.id === value.checkId);
    requireValue(item && ['passed', 'failed', 'unknown'].includes(String(value.status)) &&
      typeof value.evidenceLocation === 'string' && (value.missingEvidence === undefined || typeof value.missingEvidence === 'string'), '无效检查报告');
    state.checks.push(recordCheck(state.task, item, { status: value.status as CheckRecord['status'],
      evidenceLocation: value.evidenceLocation, missingEvidence: value.missingEvidence as string | undefined }));
  } else if (value.kind === 'reconcile') {
    const step = state.task.steps.find(s => s.id === value.stepId);
    requireValue(step?.status === 'unknown' && text(value.evidenceLocation) && value.evidenceLocation.trim() &&
      ['completed', 'not-executed', 'insufficient'].includes(String(value.evidence)), '无效核查报告');
    requireValue(value.evidence !== 'completed' || text(value.artifactVersion) && value.artifactVersion.trim(), '需提供已核查的产物版本');
    reconcileUnknown(state.task, step.id, value.evidence as 'completed' | 'not-executed' | 'insufficient',
      value.evidenceLocation, value.evidence === 'completed' ? value.artifactVersion as string : undefined);
  } else if (value.kind === 'retry-step') {
    const step = state.task.steps.find(s => s.id === value.stepId);
    requireValue(step && step.status === 'done' && state.checkItems.some(item => item.stepId === step.id &&
      currentCheck(state.task, item, state.checks)?.status === 'failed'), '仅可修正验收失败的阶段');
    const affected = affectedSteps(state.task.steps, [step.id]);
    requireValue(!state.task.steps.some(s => affected.has(s.id) && ['running', 'unknown'].includes(s.status)), '先停止或核查受影响阶段');
    state.task.steps.filter(s => affected.has(s.id)).forEach(s => {
      s.status = 'pending'; s.authorized = false; delete s.artifactVersion;
    });
    invalidateChecks(state, affected);
    reopenApprovals(state, affected);
  } else if (value.kind === 'authorize') {
    const step = state.task.steps.find(s => s.id === value.stepId);
    requireValue(step && typeof value.authorized === 'boolean' && !step.questionIds.some(id =>
      state.questions.some(q => q.id === id && q.kind === 'approval')), '审批阶段必须通过对应请求授权');
    step.authorized = value.authorized;
  } else throw new InvalidCooperation('未知协作操作');
}
