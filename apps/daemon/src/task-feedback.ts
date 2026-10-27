/** 第3.4节：回复相关性校验、幂等处理、纠错传播及未知执行结果核查。 */
import { affectedSteps } from './task-plan.ts';
import type { TaskRecord } from './task-plan.ts';
export interface OperationScope {
  target: string;
  modification: string;
  impact: string;
  artifactVersion: string;
}
export interface FeedbackRequest {
  id: string;
  runId: string;
  kind: 'clarification' | 'approval';
  status: 'pending' | 'resolved' | 'expired';
  requirementVersions: Record<string, number>;
  operation?: OperationScope;
  result?: FeedbackResult;
}
export interface FeedbackResult {
  status: 'accepted' | 'stale' | 'reconfirm';
  detail: string;
}
function sameOperation(a: OperationScope | undefined, b: OperationScope | undefined): boolean {
  return !!a && !!b && a.target === b.target && a.modification === b.modification &&
    a.impact === b.impact && a.artifactVersion === b.artifactVersion;
}
/** 在同一任务的串行事务/锁内调用，并将记录原子持久化。
 * 审批仅登记精确操作的许可，不在这里执行外部副作用。
 */
export function applyFeedback(
  task: TaskRecord, request: FeedbackRequest, reply: {
    runId: string; requestId: string; value: string; approved?: boolean;
  }, currentOperation?: OperationScope,
): FeedbackResult {
  if (reply.runId !== task.runId || request.runId !== task.runId || reply.requestId !== request.id) {
    return { status: 'stale', detail: '任务运行或请求标识不匹配' };
  }
  if (request.result) return request.result;
  if (request.status !== 'pending') return { status: 'stale', detail: '请求已被替代' };
  const changed = Object.entries(request.requirementVersions)
    .some(([id, version]) => (task.requirements[id]?.version ?? 0) !== version);
  if (changed || (request.kind === 'approval' && !sameOperation(request.operation, currentOperation))) {
    request.status = 'expired';
    request.result = { status: 'reconfirm', detail: '相关要求或操作发生变化，需要生成新请求' };
    return request.result;
  }
  request.status = 'resolved';
  request.result = { status: 'accepted', detail: reply.value };
  task.events.push({ kind: request.kind === 'approval'
    ? (reply.approved === true ? 'approval.granted' : 'approval.denied') : 'clarification.accepted',
    detail: JSON.stringify({ requestId: request.id, value: reply.value, operation: request.operation }) });
  // 回答映射到哪些要求及步骤由调用方显式提交，不能将自由文本当作授权。
  return request.result;
}
export function applyCorrection(
  task: TaskRecord, changes: Record<string, string>, requests: FeedbackRequest[],
) {
  const ids = new Set(Object.keys(changes));
  const affected = affectedSteps(task.steps,
    task.steps.filter(step => step.requirementIds.some(id => ids.has(id))).map(step => step.id));
  if (task.steps.some(step => affected.has(step.id) && step.status === 'running')) {
    throw new Error('先停止受影响的运行步骤并核查其结果，再应用纠错');
  }
  for (const [id, value] of Object.entries(changes)) {
    task.requirements[id] = { value, version: (task.requirements[id]?.version ?? 0) + 1 };
  }
  for (const step of task.steps) {
    if (!affected.has(step.id)) continue;
    if (step.status !== 'unknown') step.status = 'pending';
    // 旧产物保留供核查；不自动覆盖或撤销，重新获取操作许可。
    step.authorized = false;
  }
  for (const request of requests) {
    if (request.runId === task.runId && request.status === 'pending' &&
      Object.keys(request.requirementVersions).some(id => ids.has(id))) request.status = 'expired';
  }
  task.events.push({ kind: 'requirements.corrected', detail: JSON.stringify(changes) });
  return [...affected];
}
export function reconcileUnknown(
  task: TaskRecord, stepId: string, evidence: 'completed' | 'not-executed' | 'insufficient',
  evidenceLocation: string,
): void {
  const step = task.steps.find(item => item.id === stepId);
  if (!step || step.status !== 'unknown') throw new Error('步骤不处于待核查状态');
  if (!evidenceLocation.trim()) throw new Error('必须提供核查证据位置');
  if (evidence === 'completed') step.status = 'done';
  if (evidence === 'not-executed') step.status = 'pending';
  task.events.push({ kind: 'execution.reconciled', detail: JSON.stringify({ stepId, evidence, evidenceLocation }) });
}
