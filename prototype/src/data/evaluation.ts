import { AGENT_TRACES, CONVERSATIONS } from './observability';

export type CaseType = 'good' | 'bad';
export type CaseReadiness = 'ready' | 'needs_standard' | 'draft';

export interface EvaluationCase {
  id: string;
  setId: string;
  type: CaseType;
  readiness: CaseReadiness;
  input: string;
  actualOutput: string;
  expectedOutput: string;
  criteria: string[];
  tags: string[];
  source: {
    conversationId: string;
    traceId: string;
    app: string;
    appVersion: string;
    model: string;
    channel: string;
    capturedAt: string;
  };
  addedBy: string;
  addedAt: string;
}

export interface EvaluationSet {
  id: string;
  name: string;
  description: string;
  app: string;
  owner: string;
  updatedAt: string;
}

interface EvaluationState {
  sets: EvaluationSet[];
  cases: EvaluationCase[];
}

export const DEFAULT_EVALUATION_SETS: EvaluationSet[] = [
  { id: 'eval-service-daily', name: '智能客服 · 线上回流集', description: '每天从官网、企业微信和工作台回流的真实客服 Case。', app: '智能客服助手', owner: '客服中心 · 周敏', updatedAt: '今天 10:48' },
  { id: 'eval-report-quality', name: '研究报告 · 质量回归集', description: '覆盖来源完整性、事实准确性和长上下文异常。', app: '行业研究报告撰写', owner: '战略部 · 李想', updatedAt: '今天 10:12' },
  { id: 'eval-cross-app', name: '跨应用异常回归集', description: '工具、Skill、检索和 Harness 异常的通用回归 Case。', app: '全部应用', owner: '平台管理员 · 周敏', updatedAt: '昨天 18:20' },
];

export const DEFAULT_EVALUATION_CASES: EvaluationCase[] = [
  {
    id: 'case-g-001', setId: 'eval-service-daily', type: 'good', readiness: 'ready', input: '帮我查一下订单 SO20261024017 到哪了',
    actualOutput: '订单已到达杭州转运中心，预计明天下午送达。', expectedOutput: '保持当前工具调用路径与回答结构，并返回物流状态、位置和预计送达时间。',
    criteria: ['必须调用订单查询工具', '不得编造物流节点', '回答包含预计送达时间'], tags: ['订单查询', '工具调用'],
    source: { conversationId: 'cv_10382', traceId: 'tr_8f2a1c90', app: '智能客服助手', appVersion: 'v12', model: 'DeepSeek-V3.2', channel: '企业微信', capturedAt: '10-28 10:36' }, addedBy: '周敏', addedAt: '今天 10:42',
  },
  {
    id: 'case-b-001', setId: 'eval-service-daily', type: 'bad', readiness: 'needs_standard', input: '你们和 X 品牌比哪个更便宜？能直接给我底价吗？',
    actualOutput: '无法直接提供未公开底价，已转接销售顾问。', expectedOutput: '', criteria: [], tags: ['竞品对比', 'Skill 超时', '转人工'],
    source: { conversationId: 'cv_10391', traceId: 'tr_9bc40271', app: '智能客服助手', appVersion: 'v12', model: 'DeepSeek-V3.2', channel: '官网嵌入', capturedAt: '10-28 10:22' }, addedBy: '周敏', addedAt: '今天 10:30',
  },
  {
    id: 'case-b-002', setId: 'eval-report-quality', type: 'bad', readiness: 'ready', input: '生成 2026 年储能行业竞争格局报告，重点分析国内头部厂商。',
    actualOutput: '运行失败，未生成最终报告。', expectedOutput: '联网搜索限流时保留已完成章节，并明确标出缺失数据；不得输出无来源的市场份额。',
    criteria: ['搜索失败可恢复', '已完成产物可保留', '无来源数字不得输出'], tags: ['联网搜索', '429', '长上下文'],
    source: { conversationId: 'cv_10402', traceId: 'tr_04d7be35', app: '行业研究报告撰写', appVersion: 'v5', model: 'Qwen3-Max', channel: '工作台', capturedAt: '10-28 09:58' }, addedBy: '李想', addedAt: '今天 10:12',
  },
  {
    id: 'case-g-002', setId: 'eval-cross-app', type: 'good', readiness: 'ready', input: '出差深圳住宿标准是多少？',
    actualOutput: '深圳属于一类城市，员工住宿标准为 500 元/晚，并附制度引用。', expectedOutput: '回答金额与适用职级，并引用《差旅管理制度》第 4.2 条。',
    criteria: ['金额正确', '区分职级', '必须有制度引用'], tags: ['知识检索', '引用'],
    source: { conversationId: 'cv_10411', traceId: 'tr_b7c2038a', app: '制度问答助手', appVersion: 'v8', model: 'DeepSeek-V3.2', channel: '工作台', capturedAt: '10-28 10:15' }, addedBy: '周敏', addedAt: '今天 10:20',
  },
];

const STORAGE_KEY = 'knoworder-evaluation-state-v1';

function emptyState(): EvaluationState {
  return { sets: [], cases: [] };
}

function readStoredState(): EvaluationState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as EvaluationState;
    return { sets: Array.isArray(parsed.sets) ? parsed.sets : [], cases: Array.isArray(parsed.cases) ? parsed.cases : [] };
  } catch {
    return emptyState();
  }
}

function writeStoredState(state: EvaluationState) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function getEvaluationState(): EvaluationState {
  const stored = readStoredState();
  const sets = new Map(DEFAULT_EVALUATION_SETS.map((item) => [item.id, item]));
  stored.sets.forEach((item) => sets.set(item.id, item));
  const cases = new Map(DEFAULT_EVALUATION_CASES.map((item) => [item.id, item]));
  stored.cases.forEach((item) => cases.set(item.id, item));
  return { sets: [...sets.values()], cases: [...cases.values()] };
}

export function createEvaluationSet(input: Pick<EvaluationSet, 'name' | 'description' | 'app'>) {
  const stored = readStoredState();
  const set: EvaluationSet = { id: `eval-${Date.now()}`, name: input.name, description: input.description, app: input.app, owner: '平台管理员 · 周敏', updatedAt: '刚刚' };
  stored.sets.push(set);
  writeStoredState(stored);
  return set;
}

export function addConversationsToEvaluationSet(conversationIds: string[], setId: string, type: CaseType, standard: string, tags: string[]) {
  const stored = readStoredState();
  const existingTraceIds = new Set(getEvaluationState().cases.filter((item) => item.setId === setId).map((item) => item.source.traceId));
  let added = 0;
  let duplicates = 0;
  conversationIds.forEach((conversationId) => {
    const conversation = CONVERSATIONS.find((item) => item.id === conversationId);
    const trace = conversation ? AGENT_TRACES.find((item) => item.id === conversation.traces[0]) : undefined;
    if (!conversation || !trace) return;
    if (existingTraceIds.has(trace.id)) {
      duplicates += 1;
      return;
    }
    const hasStandard = standard.trim().length > 0 || type === 'good';
    stored.cases.push({
      id: `case-${Date.now()}-${added}`, setId, type, readiness: hasStandard ? 'ready' : 'needs_standard', input: trace.input, actualOutput: trace.output,
      expectedOutput: standard.trim() || (type === 'good' ? `保持该线上回答的核心事实、调用路径与引用结构。参考答案：${trace.output}` : ''),
      criteria: standard.trim() ? [standard.trim()] : type === 'good' ? ['结果与已验证线上回答语义一致'] : [], tags,
      source: { conversationId, traceId: trace.id, app: trace.app, appVersion: trace.version, model: trace.model, channel: trace.channel, capturedAt: trace.startedAt },
      addedBy: '周敏', addedAt: '刚刚',
    });
    existingTraceIds.add(trace.id);
    added += 1;
  });
  writeStoredState(stored);
  return { added, duplicates };
}

export function updateEvaluationCase(caseId: string, patch: Pick<EvaluationCase, 'expectedOutput' | 'criteria' | 'readiness'>) {
  const stored = readStoredState();
  const custom = stored.cases.find((item) => item.id === caseId);
  if (custom) Object.assign(custom, patch);
  else {
    const seed = DEFAULT_EVALUATION_CASES.find((item) => item.id === caseId);
    if (seed) stored.cases.push({ ...seed, ...patch });
  }
  writeStoredState(stored);
}

export function moveEvaluationCases(caseIds: string[], setId: string) {
  const stored = readStoredState();
  const all = getEvaluationState().cases;
  caseIds.forEach((caseId) => {
    const item = all.find((candidate) => candidate.id === caseId);
    if (!item) return;
    const index = stored.cases.findIndex((candidate) => candidate.id === caseId);
    const next = { ...item, setId };
    if (index >= 0) stored.cases[index] = next;
    else stored.cases.push(next);
  });
  writeStoredState(stored);
}
