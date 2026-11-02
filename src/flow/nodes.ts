import {
  Bot, Braces, CircleDot, Combine, Database, FormInput, GitFork, ListChecks, MessageSquareReply, Repeat, Split, Wrench, type LucideIcon,
} from 'lucide-react';
import type { AppManifest, FlowEdgeSpec, FlowGraph, FlowNodeConfig, FlowNodeKind, FlowNodeSpec, InputField } from '../api/fde';
import { C } from '../theme';

export type NodeDef = { kind: FlowNodeKind; name: string; icon: LucideIcon; color: string; cat: string; desc: string };

export const NODE_DEFS: NodeDef[] = [
  { kind: 'start', name: '流程开始', icon: CircleDot, color: C.primary, cat: '基础', desc: '用户的问题和开始表单' },
  { kind: 'answer', name: '指定回复', icon: MessageSquareReply, color: C.success, cat: '基础', desc: '把内容回复给用户，可拼接变量' },
  { kind: 'template', name: '文本拼接', icon: Combine, color: C.slate, cat: '基础', desc: '用模板把多个变量组合成一段文本' },
  { kind: 'llm', name: 'AI 对话', icon: Bot, color: C.violet, cat: 'AI 能力', desc: '调用大模型生成内容' },
  { kind: 'classify', name: '问题分类', icon: Split, color: C.violet, cat: 'AI 能力', desc: '按语义分到不同分支' },
  { kind: 'extract', name: '信息提取', icon: Braces, color: C.violet, cat: 'AI 能力', desc: '从文本中抽取结构化字段' },
  { kind: 'loop', name: '批量生成', icon: Repeat, color: C.violet, cat: 'AI 能力', desc: '对列表逐项调用模型，如逐章撰写' },
  { kind: 'kb', name: '知识库搜索', icon: Database, color: C.success, cat: '知识', desc: '语义 / 全文 / 混合检索，结果带引用' },
  { kind: 'ifelse', name: '条件判断', icon: GitFork, color: C.warning, cat: '逻辑', desc: '按条件进入不同分支' },
  { kind: 'form', name: '表单输入', icon: FormInput, color: C.rose, cat: '交互', desc: '暂停流程，让用户填写表单' },
  { kind: 'choice', name: '用户选择', icon: ListChecks, color: C.rose, cat: '交互', desc: '暂停流程，让用户确认或选择' },
  { kind: 'tool', name: '调用工具', icon: Wrench, color: C.primary, cat: '外部', desc: '调用工具库中的 HTTP 工具' },
];

export const DEF = Object.fromEntries(NODE_DEFS.map((item) => [item.kind, item])) as Record<FlowNodeKind, NodeDef>;
export const BRANCH_KINDS: FlowNodeKind[] = ['classify', 'ifelse', 'choice'];
export const MODEL_KINDS: FlowNodeKind[] = ['llm', 'classify', 'extract', 'loop'];

export const OPERATORS: Record<string, string> = {
  contains: '包含', not_contains: '不包含', equals: '等于', not_equals: '不等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', empty: '为空', not_empty: '不为空',
};

export function defaultConfig(kind: FlowNodeKind): FlowNodeConfig {
  switch (kind) {
    case 'llm': return { model_id: null, system_prompt: '', prompt: '{{start.query}}', temperature: null, max_tokens: null, history: false };
    case 'kb': return { knowledge_base_ids: [], query: '{{start.query}}', mode: 'hybrid', top_k: 8, rerank_top_n: 3, score_threshold: 0.35, max_context_chars: 8000 };
    case 'classify': return { model_id: null, input: '{{start.query}}', categories: ['分类 1', '分类 2'], instruction: '' };
    case 'extract': return { model_id: null, input: '{{start.query}}', fields: [] };
    case 'ifelse': return { conditions: [{ left: '', operator: 'contains', right: '' }], logic: 'and' };
    case 'template': return { template: '' };
    case 'loop': return { items: '', model_id: null, system_prompt: '', prompt: '{{item}}', max_items: 10, parallel: 3, separator: '\n\n' };
    case 'form': return { prompt: '', fields: [] };
    case 'choice': return { prompt: '', options: ['确认', '取消'] };
    case 'tool': return { tool_id: null, arguments: {} };
    case 'answer': return { template: '' };
    default: return {};
  }
}

/** 分支节点每个出口的名称，顺序与 source_handle b0、b1… 一致。 */
export function branchLabels(node: Pick<FlowNodeSpec, 'kind' | 'config'>): string[] {
  if (node.kind === 'ifelse') return ['条件成立', '否则'];
  if (node.kind === 'classify') return node.config.categories ?? [];
  if (node.kind === 'choice') return node.config.options ?? [];
  return [];
}

/** 节点可被下游引用的输出：字段 → 显示名。 */
export function outputFields(node: FlowNodeSpec, manifest: AppManifest): Array<[string, string]> {
  const fields = (node.config.fields ?? []) as Array<{ key: string; label: string }>;
  switch (node.kind) {
    case 'start': return [['query', '用户问题'], ...manifest.input_fields.map((field) => [field.key, field.label] as [string, string])];
    case 'llm': return [['text', '回复']];
    case 'kb': return [['context', '检索结果'], ['count', '命中数量']];
    case 'classify': return [['category', '分类结果']];
    case 'extract': return [...fields.map((field) => [field.key, field.label] as [string, string]), ['json', '全部字段']];
    case 'ifelse': return [['result', '判断结果']];
    case 'template': return [['text', '结果']];
    case 'loop': return [['text', '合并结果'], ['results', '逐项结果'], ['count', '数量']];
    case 'form': return fields.map((field) => [field.key, field.label]);
    case 'choice': return [['choice', '用户选择']];
    case 'tool': return [['result', '返回结果'], ['json', '返回 JSON']];
    case 'answer': return [['text', '回复内容']];
    default: return [];
  }
}

export function upstreamIds(graph: FlowGraph, nodeId: string): Set<string> {
  const result = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const current = stack.pop()!;
    for (const edge of graph.edges) if (edge.target === current && !result.has(edge.source)) { result.add(edge.source); stack.push(edge.source); }
  }
  return result;
}

export function nextNodeId(graph: FlowGraph, kind: FlowNodeKind) {
  const used = new Set(graph.nodes.map((node) => node.id));
  let index = 1;
  while (used.has(`${kind}_${index}`)) index += 1;
  return `${kind}_${index}`;
}

function n(id: string, kind: FlowNodeKind, x: number, y: number, title: string, config: FlowNodeConfig = {}): FlowNodeSpec {
  return { id, kind, title, position: { x, y }, config: { ...defaultConfig(kind), ...config } };
}

function e(source: string, target: string, handle?: string): FlowEdgeSpec {
  return { id: `${source}-${handle ?? 'o'}-${target}`, source, target, source_handle: handle ?? null };
}

const field = (key: string, label: string, extra: Partial<InputField> = {}): InputField => ({ key, label, type: 'text', required: true, options: [], placeholder: '', description: '', ...extra });

/** 新建 Chat Flow 时的起始流程：报告撰写、合同审校有专门的多步骤流程，其他场景从「检索 → 回答」开始。 */
export function starterFlow(templateKey: string, needsKnowledge: boolean): { graph: FlowGraph; input_fields: InputField[] } {
  if (templateKey === 'report') {
    return {
      input_fields: [],
      graph: {
        nodes: [
          n('start', 'start', 0, 40, '流程开始'),
          n('brief', 'form', 300, 20, '收集报告需求', {
            prompt: '先确认几项报告需求：',
            fields: [field('topic', '报告主题'), field('audience', '读者', { type: 'select', options: ['公司管理层', '业务部门', '客户'] }), field('length', '篇幅', { type: 'select', options: ['约 3000 字', '约 6000 字', '约 10000 字'] })],
          }),
          n('research', 'kb', 600, 20, '检索参考资料', { query: '{{brief.topic}}' }),
          n('outline', 'llm', 900, 20, '生成大纲', {
            system_prompt: '你是资深行业分析师。',
            prompt: '基于参考资料，为「{{brief.topic}}」写一份面向{{brief.audience}}的报告大纲，篇幅{{brief.length}}。\n只输出 4–6 个一级章节标题，每行一个，不要其他内容。\n\n参考资料：\n{{research.context}}',
          }),
          n('confirm', 'choice', 1200, 20, '确认大纲', { prompt: '报告大纲如下：\n\n{{outline.text}}\n\n确认后开始逐章撰写。', options: ['确认，开始撰写', '先不写了'] }),
          n('chapters', 'loop', 600, 300, '逐章撰写', {
            items: '{{outline.text}}', max_items: 8,
            prompt: '报告主题：{{brief.topic}}（读者：{{brief.audience}}）\n完整大纲：\n{{outline.text}}\n\n请撰写第 {{index}} 章「{{item}}」，以「## {{item}}」开头，引用资料时标注 [资料 n]。\n\n参考资料：\n{{research.context}}',
          }),
          n('merge', 'template', 900, 300, '合并全文', { template: '# {{brief.topic}}\n\n{{chapters.text}}' }),
          n('report', 'answer', 1200, 300, '输出报告', { template: '{{merge.text}}' }),
          n('stopped', 'answer', 1500, 160, '取消撰写', { template: '好的，已取消撰写。补充要求后可以重新发起。' }),
        ],
        edges: [e('start', 'brief'), e('brief', 'research'), e('research', 'outline'), e('outline', 'confirm'), e('confirm', 'chapters', 'b0'), e('confirm', 'stopped', 'b1'), e('chapters', 'merge'), e('merge', 'report')],
      },
    };
  }
  if (templateKey === 'review') {
    return {
      input_fields: [field('contract', '合同正文', { type: 'textarea', placeholder: '粘贴需要审校的合同全文' })],
      graph: {
        nodes: [
          n('start', 'start', 0, 40, '流程开始'),
          n('facts', 'extract', 300, 20, '提取合同要素', {
            input: '{{start.contract}}',
            fields: [
              { key: 'contract_type', label: '合同类型', type: 'string', description: '采购 / 销售 / 服务 / 其他' },
              { key: 'party_a', label: '甲方', type: 'string', description: '' },
              { key: 'party_b', label: '乙方', type: 'string', description: '' },
              { key: 'amount', label: '合同金额', type: 'number', description: '含税总价，单位元' },
              { key: 'term', label: '合同期限', type: 'string', description: '起止日期' },
            ],
          }),
          n('kind', 'classify', 600, 20, '识别合同类型', { input: '合同类型：{{facts.contract_type}}\n\n{{start.contract}}', categories: ['采购合同', '销售合同', '服务合同', '其他'] }),
          n('clauses', 'kb', 900, 20, '检索条款库', { query: '{{kind.category}} 审查要点 {{facts.contract_type}}' }),
          n('unsupported', 'answer', 600, 340, '暂不支持', { template: '这类合同暂不支持自动审校，请发起人工审核。' }),
          n('review', 'llm', 1200, 20, '逐条比对与风险分级', {
            system_prompt: '你是企业法务。',
            prompt: '对照条款库要求，逐条审查下面的{{kind.category}}，列出风险条款，每条注明风险等级（高 / 中 / 低）、原文、问题和修改建议。\n没有高风险条款时，第一行写「无高风险条款」。\n\n合同要素：{{facts.json}}\n\n条款库：\n{{clauses.context}}\n\n合同正文：\n{{start.contract}}',
          }),
          n('risky', 'ifelse', 900, 340, '存在高风险条款？', { conditions: [{ left: '{{review.text}}', operator: 'not_contains', right: '无高风险条款' }] }),
          n('alert', 'answer', 1200, 300, '输出风险报告', { template: '**发现高风险条款，建议提交法务复核。**\n\n{{review.text}}' }),
          n('clean', 'answer', 1200, 470, '输出审校结论', { template: '未发现高风险条款。\n\n{{review.text}}' }),
        ],
        edges: [
          e('start', 'facts'), e('facts', 'kind'), e('kind', 'clauses', 'b0'), e('kind', 'clauses', 'b1'), e('kind', 'clauses', 'b2'), e('kind', 'unsupported', 'b3'),
          e('clauses', 'review'), e('review', 'risky'), e('risky', 'alert', 'b0'), e('risky', 'clean', 'b1'),
        ],
      },
    };
  }
  const nodes = needsKnowledge
    ? [
      n('start', 'start', 0, 60, '流程开始'),
      n('search', 'kb', 300, 60, '知识库搜索'),
      n('reply', 'llm', 600, 60, 'AI 回答', { history: true, prompt: '参考资料：\n{{search.context}}\n\n用户问题：{{start.query}}\n\n依据参考资料回答，引用时标注 [资料 n]；资料不足时直接说明。' }),
      n('out', 'answer', 900, 60, '回复用户', { template: '{{reply.text}}' }),
    ]
    : [
      n('start', 'start', 0, 60, '流程开始'),
      n('reply', 'llm', 300, 60, 'AI 对话', { history: true }),
      n('out', 'answer', 600, 60, '回复用户', { template: '{{reply.text}}' }),
    ];
  const edges = nodes.slice(1).map((node, index) => e(nodes[index].id, node.id));
  return { input_fields: [], graph: { nodes, edges } };
}
