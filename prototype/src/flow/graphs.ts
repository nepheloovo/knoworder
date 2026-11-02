import type { Edge } from '@xyflow/react';
import type { FlowData, FlowNode, NodeKind } from './defs';

function n(id: string, kind: NodeKind, x: number, y: number, title: string, lines: string[] = [], branches?: string[]): FlowNode {
  const data: FlowData = { kind, title, lines, branches };
  return { id, type: 'flow', position: { x, y }, data };
}

function e(source: string, target: string, sourceHandle?: string): Edge {
  return { id: `${source}-${sourceHandle ?? 'o'}-${target}`, source, target, sourceHandle };
}

export interface Graph { nodes: FlowNode[]; edges: Edge[] }

const REPORT: Graph = {
  nodes: [
    n('sys', 'sys', 0, -170, '系统配置', ['开场白 · 全局变量 2 个', '允许上传参考资料']),
    n('start', 'start', 0, 40, '流程开始', ['用户问题', '上传文件']),
    n('form', 'form', 320, 20, '收集报告需求', ['报告主题 · 读者 · 篇幅', '是否联网补充']),
    n('kb', 'kb', 640, -70, '检索行业研究库', ['行业研究库 · 混合检索', '引用上限 8000 · Rerank']),
    n('web', 'tool', 640, 130, '联网搜索最新动态', ['工具：联网搜索', '近 90 天']),
    n('outline', 'llm', 960, 20, '生成大纲', ['Qwen3-Max · 温度 0.3', '引用：知识库 + 联网']),
    n('confirm', 'choice', 1280, 20, '确认大纲', [], ['确认，开始撰写', '修改后重新生成']),
    n('loop', 'loop', 1600, -60, '逐章撰写', ['遍历：大纲.章节列表', '并行 3 · 内含 AI 对话']),
    n('merge', 'template', 1920, -60, '合并全文与引用', ['模板：报告正文 + 参考文献']),
    n('export', 'export', 2240, -60, '导出 Word', ['模板：公司研究报告 v2', '格式：docx']),
    n('answer', 'answer', 2560, -60, '输出报告', ['{{合并全文}} + 下载链接']),
  ],
  edges: [e('start', 'form'), e('form', 'kb'), e('form', 'web'), e('kb', 'outline'), e('web', 'outline'), e('outline', 'confirm'), e('confirm', 'loop', 'b0'), e('confirm', 'outline', 'b1'), e('loop', 'merge'), e('merge', 'export'), e('export', 'answer')],
};

const CONTRACT: Graph = {
  nodes: [
    n('sys', 'sys', 0, -170, '系统配置', ['必须上传文件 · PDF / DOCX']),
    n('start', 'start', 0, 40, '流程开始', ['用户问题', '上传文件']),
    n('parse', 'doc_parse', 320, 40, '解析合同文本', ['OCR：自动', '保留条款编号']),
    n('extract', 'extract', 640, 40, '提取合同要素', ['合同类型 · 甲乙方', '金额 · 期限 · 付款方式']),
    n('cls', 'classify', 960, 20, '识别合同类型', [], ['采购合同', '销售合同', '服务 / 技术合同', '其他']),
    n('kb1', 'kb', 1280, -140, '检索采购条款库', ['法务条款库 · 标签：采购']),
    n('kb2', 'kb', 1280, 40, '检索销售条款库', ['法务条款库 · 标签：销售']),
    n('kb3', 'kb', 1280, 220, '检索服务条款库', ['法务条款库 · 标签：服务']),
    n('other', 'answer', 1280, 400, '暂不支持', ['该类型请发起人工审校']),
    n('review', 'llm', 1600, 40, '逐条比对与风险分级', ['DeepSeek-R1 · JSON 输出', '高 / 中 / 低 + 修改建议']),
    n('if', 'ifelse', 1920, 40, '存在高风险条款？', [], ['高风险数量 > 0', '否则']),
    n('notify', 'tool', 2240, -60, '通知法务负责人', ['工具：飞书消息通知', '法务部 · 王律']),
    n('out1', 'answer', 2560, -60, '输出风险报告', ['风险清单 + 修改建议']),
    n('out2', 'answer', 2240, 160, '输出审校结论', ['未发现高风险条款']),
  ],
  edges: [e('start', 'parse'), e('parse', 'extract'), e('extract', 'cls'), e('cls', 'kb1', 'b0'), e('cls', 'kb2', 'b1'), e('cls', 'kb3', 'b2'), e('cls', 'other', 'b3'), e('kb1', 'review'), e('kb2', 'review'), e('kb3', 'review'), e('review', 'if'), e('if', 'notify', 'b0'), e('if', 'out2', 'b1'), e('notify', 'out1')],
};

const WEEKLY: Graph = {
  nodes: [
    n('start', 'start', 0, 40, '流程开始', ['用户问题']),
    n('form', 'form', 320, 40, '选择项目与周期', ['项目 · 起止日期']),
    n('http', 'http', 640, -40, '拉取项目进度', ['GET /pm/projects/{id}/tasks']),
    n('sql', 'tool', 640, 130, '查询经营数据', ['工具：经营数据查询', '只读 BI 数仓']),
    n('code', 'code', 960, 40, '计算环比与延期', ['Python · 输出 metrics']),
    n('llm', 'llm', 1280, 40, '撰写周报', ['Qwen3-Max', '模板：PMO 周报']),
    n('answer', 'answer', 1600, 40, '输出周报', ['{{撰写周报.回复}}']),
  ],
  edges: [e('start', 'form'), e('form', 'http'), e('form', 'sql'), e('http', 'code'), e('sql', 'code'), e('code', 'llm'), e('llm', 'answer')],
};

export function graphFor(appId: string): Graph {
  const g = appId === 'app-contract' ? CONTRACT : appId === 'app-weekly' ? WEEKLY : REPORT;
  return { nodes: g.nodes.map((x) => ({ ...x, data: { ...x.data } })), edges: g.edges.map((x) => ({ ...x })) };
}

export const NODE_OUTPUT: Partial<Record<NodeKind, string>> = {
  start: '用户问题 = "帮我写一份储能行业竞争格局报告"',
  form: '{ 主题: "2026 年储能行业竞争格局", 读者: "公司管理层", 篇幅: "约 6000 字", 联网: true }',
  kb: '召回 14 条 → Rerank 保留 8 条（最高 0.92）',
  tool: '返回 6 条结果（来源：能源局、高工储能、上市公司公告）',
  llm: '生成 1,860 tokens',
  choice: '用户选择：确认，开始撰写',
  loop: '4 / 4 章完成（并行 3）',
  template: '正文 6,240 字 · 参考文献 14 条',
  export: '2026储能行业竞争格局.docx（312 KB）',
  answer: '已输出',
  doc_parse: '解析 18 页 · 42 个条款',
  extract: '{ 类型: "采购", 甲方: "知序储能", 金额: "¥ 3,860,000", 期限: "2026-11 ~ 2027-10" }',
  classify: '命中分支：采购合同（置信度 0.96）',
  ifelse: '高风险数量 = 2 → IF',
  http: '200 OK · 37 条任务',
  code: '{ 完成率: 0.82, 延期: 3 }',
};
