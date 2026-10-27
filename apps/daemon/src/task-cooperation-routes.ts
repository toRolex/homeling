import type { SnapshotResponse } from '@homeling/contracts';
import type { PersonaRuntime } from './persona-service.ts';
import type { MutationAdmission } from './session-lock.ts';
import type { BridgeFetch } from './bridge-proxy.ts';
import { proxyBridgeRequest, proxyTargetUrl } from './bridge-proxy.ts';
import { controlKeyBlocksText } from './control-key.ts';
import { detectPendingRequest, readPaneText } from './requests.ts';
import { CooperationConflict, InvalidCooperation } from './task-cooperation.ts';
import { TaskOccurrenceUnavailable } from './activity-ledger.ts';
import { SessionLocked } from './session-lock.ts';

/** 使用现有 pane reply 通道，遵守任务身份、会话许可和取消屏障。
 * 一次调用仅派发一个阶段；后续阶段由结果报告或 advance 触发，绝不盲跑旧计划。
 */
export async function advanceCooperation(
  req: Request, runtime: PersonaRuntime, admission: MutationAdmission, fetcher: BridgeFetch,
) {
  const match = new URL(req.url).pathname.match(/\/activity\/task\/([^/]+)/);
  if (!match || !runtime.activity) throw new TaskOccurrenceUnavailable();
  return advanceCooperationTask(decodeURIComponent(match[1]!), req, runtime, admission, fetcher);
}
export async function advanceCooperationTask(
  key: string, req: Request, runtime: PersonaRuntime, admission: MutationAdmission, fetcher: BridgeFetch,
) {
  const ledger = runtime.activity;
  if (!ledger) throw new TaskOccurrenceUnavailable();
  const task = await ledger.assertCurrent(key);
  if (controlKeyBlocksText(runtime.cfg, task.paneId)) return { dispatched: false, reason: 'cancellation-pending' };
  const headers = new Headers({ accept: 'application/json' });
  const login = req.headers.get('tailscale-user-login');
  if (login) headers.set('tailscale-user-login', login);
  // 不把新指令输入到原生权限提示、尚在运行的 agent 或未知终端中。
  const snapshotResponse = await fetcher(proxyTargetUrl('/lite/api/snapshot', runtime.cfg), { headers });
  if (!snapshotResponse.ok) return { dispatched: false, reason: 'snapshot-unavailable' };
  const snapshot = await snapshotResponse.json() as SnapshotResponse;
  const pane = snapshot.agents.find(item => item.paneId === task.paneId);
  if (!pane || !['idle', 'done'].includes(pane.status)) return { dispatched: false, reason: 'agent-not-idle' };
  const screen = await readPaneText(runtime.cfg, fetcher, task.paneId, login);
  if (detectPendingRequest(screen)) return { dispatched: false, reason: 'native-request-pending' };
  const dispatch = await ledger.beginCooperationStep(key, admission);
  if (!dispatch) return { dispatched: false, reason: 'waiting-for-answer-evidence-or-execution' };
  let outcome: 'submitted' | 'not-submitted' | 'unknown' = 'unknown';
  try {
    const url = new URL(req.url);
    url.pathname = `/lite/api/pane/${encodeURIComponent(dispatch.paneId)}/reply`;
    url.search = '';
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('content-type', 'application/json');
    requestHeaders.delete('content-length');
    const response = await proxyBridgeRequest(new Request(url, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ text: dispatch.text, submit: true }),
    }), runtime.cfg, (target, init) => ledger.dispatchCooperationStep(key, dispatch.stepId, admission, bound => {
      if (bound.paneId !== dispatch.paneId || controlKeyBlocksText(runtime.cfg, bound.paneId)) {
        throw new CooperationConflict('任务或取消状态已变化');
      }
      return fetcher(target, init);
    }));
    const result = await response.json().catch(() => null) as {
      ok?: boolean; textDelivered?: boolean; executed?: boolean; deliveryUnknown?: boolean;
    } | null;
    if (response.ok && result?.ok === true) outcome = 'submitted';
    else if (result?.textDelivered === false && result?.deliveryUnknown !== true && result?.executed === false) outcome = 'not-submitted';
  } finally {
    // 如果许可已失效，running 保留为待人工核查；不会自动重复输入。
    await ledger.finishCooperationDelivery(key, dispatch.stepId, outcome, admission);
  }
  return { dispatched: outcome === 'submitted', stepId: dispatch.stepId, outcome };
}
export async function handleCooperationRequest(
  req: Request, runtime: PersonaRuntime, admission: MutationAdmission | undefined, fetcher: BridgeFetch,
): Promise<Response | undefined> {
  const match = new URL(req.url).pathname.match(/^\/lite\/api\/activity\/task\/([^/]+)\/cooperation(?:\/(advance))?$/);
  if (!match) return undefined;
  if (!runtime.activity) return Response.json({ error: 'Activity unavailable' }, { status: 503 });
  try {
    const key = decodeURIComponent(match[1]!);
    if (req.method === 'GET' && !match[2]) {
      return Response.json(await runtime.activity.cooperation(key), { headers: { 'cache-control': 'no-store' } });
    }
    if (!['POST', 'PATCH'].includes(req.method) || match[2] && req.method !== 'POST') {
      return Response.json({ error: 'method not allowed' }, { status: 405 });
    }
    if (!admission) throw new SessionLocked();
    if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      return Response.json({ error: 'application/json required' }, { status: 415 });
    }
    const body: unknown = await req.json();
    if (match[2]) {
      return Response.json(await advanceCooperation(req, runtime, admission, fetcher));
    }
    if (req.method === 'POST') await runtime.activity.configureCooperation(key, body, admission);
    else await runtime.activity.changeCooperation(key, body, admission);
    // 已完成的任务只交付检查记录，不再尝试发送文本。
    const view = await runtime.activity.cooperation(key);
    let dispatch: unknown;
    if (!view?.acceptance.complete) {
      try { dispatch = await advanceCooperation(req, runtime, admission, fetcher); }
      catch (error) {
        if (error instanceof SessionLocked) throw error;
        dispatch = { dispatched: false, reason: 'inspect-task-before-advance' };
      }
    }
    return Response.json({ cooperation: await runtime.activity.cooperation(key), dispatch }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof SessionLocked) throw error;
    const status = error instanceof TaskOccurrenceUnavailable || error instanceof CooperationConflict ? 409 :
      error instanceof InvalidCooperation || error instanceof SyntaxError || error instanceof URIError ? 400 : 502;
    return Response.json({ error: status === 502 ? 'Cooperation unavailable' : (error as Error).message }, { status });
  }
}
