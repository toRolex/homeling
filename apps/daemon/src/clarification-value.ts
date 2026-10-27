/** 第3.2节：贝叶斯任务损失、回答信息价值和有效等待成本。 */
export interface Weighted<T> { value: T; probability: number }
export interface AnswerModel {
  id: string;
  probability: number;
  posterior: readonly Weighted<string>[];
  consequence: string;
}
export interface Question {
  id: string;
  requirementId: string;
  title: string;
  progress: string;
  details: string[];
  actions: string[];
  belief: readonly Weighted<string>[];
  answers: readonly AnswerModel[];
  loss: (action: string, theta: string) => number;
  humanCost: number;
  delay: readonly Weighted<number>[];
  reservedResources: string[];
  required: boolean;
  /** 工具可确定的事实应先查询；无查询器时不得退化为询问用户。 */
  environmentResolvable: boolean;
  answerable: boolean;
}
export function distribution<T>(values: readonly Weighted<T>[]): void {
  if (!values.length || values.some(item => !Number.isFinite(item.probability) || item.probability < 0) ||
    Math.abs(values.reduce((sum, item) => sum + item.probability, 0) - 1) > 1e-6) {
    throw new Error('概率分布必须非负且总和为1');
  }
}
export function minimumLoss(
  belief: readonly Weighted<string>[], actions: readonly string[], loss: Question['loss'],
): number {
  distribution(belief);
  if (!actions.length) throw new Error('候选方案为空');
  return Math.min(...actions.map(action => belief.reduce((sum, item) => {
    const cost = loss(action, item.value);
    if (!Number.isFinite(cost) || cost < 0) throw new Error('损失必须为有限非负数');
    return sum + item.probability * cost;
  }, 0)));
}
export function scoreQuestion(question: Question, workMs: number, delayPenaltyPerMs: number) {
  if ([workMs, delayPenaltyPerMs, question.humanCost].some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('成本及耗时必须为有限非负数');
  }
  distribution(question.answers.map(answer => ({ value: answer.id, probability: answer.probability })));
  distribution(question.delay);
  const gain = minimumLoss(question.belief, question.actions, question.loss) -
    question.answers.reduce((sum, answer) => sum + answer.probability *
      minimumLoss(answer.posterior, question.actions, question.loss), 0);
  const stallMs = question.delay.reduce((sum, delay) => {
    if (!Number.isFinite(delay.value) || delay.value < 0) throw new Error('回复时延无效');
    return sum + delay.probability * Math.max(delay.value - workMs, 0);
  }, 0);
  return { gain, workMs, stallMs, score: gain - question.humanCost - delayPenaltyPerMs * stallMs };
}
