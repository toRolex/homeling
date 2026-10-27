/** 第3.5节：版本化阶段检查、检查失效和最终验收。 */
import type { TaskRecord } from './task-plan.ts';
export interface CheckItem {
  id: string;
  requirementId: string;
  stepId: string;
  required: boolean;
}
export interface CheckRecord {
  checkId: string;
  runId: string;
  requirementVersion: number;
  artifactVersion: string;
  status: 'passed' | 'failed' | 'unknown';
  evidenceLocation: string;
  missingEvidence?: string;
}
export function recordCheck(
  task: TaskRecord, item: CheckItem, result: Omit<CheckRecord,
    'checkId' | 'runId' | 'requirementVersion' | 'artifactVersion'>,
): CheckRecord {
  const step = task.steps.find(candidate => candidate.id === item.stepId);
  const requirement = task.requirements[item.requirementId];
  if (!step?.artifactVersion || !requirement) throw new Error('检查缺少产物版本或已确认要求');
  if (result.status !== 'unknown' && !result.evidenceLocation.trim()) throw new Error('判定必须有证据');
  if (result.status === 'unknown' && !result.missingEvidence?.trim()) throw new Error('注明待补充证据');
  const record: CheckRecord = { ...result, checkId: item.id, runId: task.runId,
    requirementVersion: requirement.version, artifactVersion: step.artifactVersion };
  task.events.push({ kind: 'check.recorded', detail: JSON.stringify(record) });
  return record;
}
export function currentCheck(task: TaskRecord, item: CheckItem, records: readonly CheckRecord[]) {
  const step = task.steps.find(candidate => candidate.id === item.stepId);
  const latest = [...records].reverse().find(record => record.checkId === item.id && record.runId === task.runId);
  return latest && latest.requirementVersion === task.requirements[item.requirementId]?.version &&
    latest.artifactVersion === step?.artifactVersion ? latest : undefined;
}
/** 下阶段必须在前阶段必需检查通过之后，才允许派发。 */
export function stagePassed(task: TaskRecord, items: readonly CheckItem[], records: readonly CheckRecord[]): boolean {
  return items.filter(item => item.required).every(item => currentCheck(task, item, records)?.status === 'passed');
}
export function finalAcceptance(
  task: TaskRecord, items: readonly CheckItem[], records: readonly CheckRecord[], pendingRequestIds: readonly string[],
) {
  const missingCoverage = Object.keys(task.requirements)
    .filter(id => !items.some(item => item.required && item.requirementId === id));
  const checks = items.filter(item => item.required).map(item => ({
    id: item.id, status: currentCheck(task, item, records)?.status ?? 'unknown',
  }));
  const unfinished = task.steps.filter(step => step.status !== 'done').map(step => step.id);
  const complete = missingCoverage.length === 0 && checks.length > 0 &&
    checks.every(check => check.status === 'passed') && unfinished.length === 0 && pendingRequestIds.length === 0;
  return { complete, checks, missingCoverage, unfinished, pendingRequestIds,
    deliverableVersions: task.steps.flatMap(step => step.artifactVersion
      ? [{ stepId: step.id, version: step.artifactVersion }] : []) };
}
