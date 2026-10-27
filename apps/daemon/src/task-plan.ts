/** 第3.1节：阶段级依赖图与共享任务记录。时间单位统一为毫秒。 */
export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'unknown';
export interface Step {
  id: string;
  dependencies: string[];
  requirementIds: string[];
  questionIds: string[];
  resources: string[];
  authorized: boolean;
  durationMs: number;
  status: StepStatus;
  artifactVersion?: string;
}
export interface TaskRecord {
  runId: string;
  steps: Step[];
  requirements: Record<string, { value: string; version: number }>;
  events: { kind: string; detail: string }[];
}
export function validateGraph(steps: readonly Step[]): void {
  const byId = new Map(steps.map(step => [step.id, step]));
  if (byId.size !== steps.length) throw new Error('重复步骤标识');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error('依赖图存在环');
    if (visited.has(id)) return;
    const step = byId.get(id);
    if (!step) throw new Error(`缺少依赖步骤 ${id}`);
    if (!Number.isFinite(step.durationMs) || step.durationMs < 0) throw new Error('无效预计耗时');
    visiting.add(id);
    step.dependencies.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  steps.forEach(step => visit(step.id));
}
export function affectedSteps(steps: readonly Step[], roots: readonly string[]): Set<string> {
  const affected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (!affected.has(step.id) && step.dependencies.some(id => affected.has(id))) {
        affected.add(step.id);
        changed = true;
      }
    }
  }
  return affected;
}
/** 按单个底层执行智能体的实际顺序构造序列，不把并行耗时重复相加。
 * running/unknown 不推测完成；与待决操作资源相交的步骤整个排除。
 */
export function executableSequence(
  steps: readonly Step[], blockedQuestions: ReadonlySet<string>, reservedResources: ReadonlySet<string>,
): Step[] {
  validateGraph(steps);
  const completed = new Set(steps.filter(step => step.status === 'done').map(step => step.id));
  const sequence: Step[] = [];
  const busy = new Set(steps.filter(step => step.status === 'running' || step.status === 'unknown')
    .flatMap(step => step.resources));
  while (true) {
    const next = steps.find(step => !completed.has(step.id) &&
      (step.status === 'pending' || step.status === 'waiting') && step.authorized &&
      !step.questionIds.some(id => blockedQuestions.has(id)) &&
      !step.resources.some(resource => reservedResources.has(resource) || busy.has(resource)) &&
      step.dependencies.every(id => completed.has(id)));
    if (!next) break;
    sequence.push(next);
    completed.add(next.id);
  }
  return sequence;
}
