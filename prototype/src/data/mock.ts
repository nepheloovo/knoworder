// 原型 mock 数据：围绕「报告撰写 / 智能客服 / 制度合同审校 / 营销内容」四类业务场景。

export type AppType = 'simple' | 'chatflow' | 'agent';
export type AppStatus = 'published' | 'draft' | 'testing';
export type SceneKey = 'report' | 'service' | 'review' | 'marketing' | 'office';

export interface Scene {
  key: SceneKey;
  name: string;
  desc: string;
  color: string;
}

export const SCENES: Scene[] = [
  { key: 'report', name: '报告撰写', desc: '行业研究、经营分析、项目周报', color: '#3370ff' },
  { key: 'service', name: '智能客服', desc: '产品咨询、售后政策、订单问题', color: '#12b76a' },
  { key: 'review', name: '制度与合同审校', desc: '合同风险、制度合规、条款比对', color: '#f79009' },
  { key: 'marketing', name: '营销内容', desc: '多渠道文案、活动方案、销售话术', color: '#dd2590' },
  { key: 'office', name: '办公提效', desc: '会议纪要、邮件、制度问答', color: '#7a5af8' },
];

export interface AppItem {
  id: string;
  name: string;
  desc: string;
  type: AppType;
  scene: SceneKey;
  status: AppStatus;
  icon: string; // lucide icon name
  color: string;
  version?: string;
  owner: string;
  updatedAt: string;
  knowledge: string[];
  model: string;
  stats: { runs7d: number; users7d: number; satisfaction: number; hitRate: number };
  opening?: string;
  suggestions?: string[];
}

export const APPS: AppItem[] = [
  {
    id: 'app-service',
    name: '智能客服助手',
    desc: '7×24 回答产品使用、售后政策与订单问题，可查询订单、创建工单，复杂问题自动转人工。',
    type: 'agent',
    scene: 'service',
    status: 'published',
    icon: 'Headset',
    color: '#12b76a',
    version: 'v12',
    owner: '客服中心 · 周敏',
    updatedAt: '今天 10:42',
    knowledge: ['kb-product', 'kb-aftersale'],
    model: 'DeepSeek-V3.2',
    stats: { runs7d: 8642, users7d: 2310, satisfaction: 92, hitRate: 88 },
    opening: '您好，我是知序智能客服。可以帮您解答产品使用、售后政策，或查询订单进度。',
    suggestions: ['设备无法开机怎么办？', '退货运费谁承担？', '帮我查一下订单 SO20261024017', '发票怎么开？'],
  },
  {
    id: 'app-report',
    name: '行业研究报告撰写',
    desc: '输入主题与受众，检索研究库生成大纲，确认后分章节撰写并附引用，可导出 Word。',
    type: 'chatflow',
    scene: 'report',
    status: 'published',
    icon: 'FileText',
    color: '#3370ff',
    version: 'v5',
    owner: '战略部 · 李想',
    updatedAt: '昨天 18:20',
    knowledge: ['kb-research'],
    model: 'Qwen3-Max',
    stats: { runs7d: 312, users7d: 64, satisfaction: 87, hitRate: 91 },
    opening: '告诉我报告主题、读者和篇幅，我会先给出大纲供你确认。',
    suggestions: ['2026 年储能行业竞争格局分析', '华东区域 Q3 经营分析报告'],
  },
  {
    id: 'app-contract',
    name: '合同风险审校',
    desc: '上传合同，自动识别合同类型，对照公司法务条款库逐条比对，输出风险清单与修改建议。',
    type: 'chatflow',
    scene: 'review',
    status: 'testing',
    icon: 'ShieldCheck',
    color: '#f79009',
    version: 'v3',
    owner: '法务部 · 王律',
    updatedAt: '10-25 16:03',
    knowledge: ['kb-legal', 'kb-policy'],
    model: 'DeepSeek-R1',
    stats: { runs7d: 128, users7d: 21, satisfaction: 81, hitRate: 84 },
    opening: '请上传需要审校的合同（PDF / Word），我会输出风险清单。',
  },
  {
    id: 'app-policy',
    name: '制度问答助手',
    desc: '基于公司制度库回答报销、请假、采购等流程问题，每个回答都附制度原文出处。',
    type: 'simple',
    scene: 'office',
    status: 'published',
    icon: 'BookOpen',
    color: '#7a5af8',
    version: 'v8',
    owner: '人力行政部 · 陈晨',
    updatedAt: '10-24 09:12',
    knowledge: ['kb-policy'],
    model: 'DeepSeek-V3.2',
    stats: { runs7d: 1904, users7d: 612, satisfaction: 90, hitRate: 93 },
    opening: '有关报销、请假、差旅、采购的问题都可以问我。',
    suggestions: ['差旅住宿标准是多少？', '年假可以跨年使用吗？', '采购超过 5 万需要几级审批？'],
  },
  {
    id: 'app-marketing',
    name: '多渠道营销文案',
    desc: '填写产品、卖点和渠道，一次生成公众号、小红书、朋友圈等多版本文案。',
    type: 'simple',
    scene: 'marketing',
    status: 'published',
    icon: 'Megaphone',
    color: '#dd2590',
    version: 'v4',
    owner: '市场部 · 赵一',
    updatedAt: '10-22 14:30',
    knowledge: ['kb-product', 'kb-sales'],
    model: 'Qwen3-Max',
    stats: { runs7d: 486, users7d: 58, satisfaction: 85, hitRate: 0 },
    opening: '告诉我产品、核心卖点和要发布的渠道，我会为每个渠道各写一版。',
    suggestions: ['ES-200 储能柜，主打削峰填谷省电费，发公众号和小红书'],
  },
  {
    id: 'app-sales',
    name: '销售话术教练',
    desc: '模拟客户异议，基于成交案例库给出应对话术，并评估销售回答质量。',
    type: 'agent',
    scene: 'marketing',
    status: 'draft',
    icon: 'Target',
    color: '#0e9384',
    owner: '销售运营 · 孙亮',
    updatedAt: '10-21 11:05',
    knowledge: ['kb-sales'],
    model: 'DeepSeek-V3.2',
    stats: { runs7d: 0, users7d: 0, satisfaction: 0, hitRate: 0 },
  },
  {
    id: 'app-weekly',
    name: '项目周报生成',
    desc: '汇总本周工作记录与项目进度，按公司模板生成周报并识别风险项。',
    type: 'chatflow',
    scene: 'report',
    status: 'draft',
    icon: 'CalendarCheck',
    color: '#3370ff',
    owner: 'PMO · 刘洋',
    updatedAt: '10-20 17:48',
    knowledge: [],
    model: 'Qwen3-Max',
    stats: { runs7d: 0, users7d: 0, satisfaction: 0, hitRate: 0 },
  },
  {
    id: 'app-minutes',
    name: '会议纪要整理',
    desc: '粘贴会议转写稿，提炼结论、待办与负责人，输出标准纪要格式。',
    type: 'simple',
    scene: 'office',
    status: 'published',
    icon: 'NotebookPen',
    color: '#7a5af8',
    version: 'v2',
    owner: '总裁办 · 何静',
    updatedAt: '10-18 10:00',
    knowledge: [],
    model: 'DeepSeek-V3.2',
    stats: { runs7d: 233, users7d: 41, satisfaction: 89, hitRate: 0 },
    opening: '把会议转写稿粘贴给我，我会整理出结论、待办事项和负责人。',
    suggestions: ['整理 10-24 产品评审会纪要'],
  },
];

export const APP_TYPE_META: Record<AppType, { name: string; desc: string; color: string; tag: string }> = {
  simple: { name: '简易应用', desc: '提示词 + 知识库 + 表单，几分钟配置完成', color: 'purple', tag: '简易' },
  chatflow: { name: 'Chat Flow', desc: '可视化编排多步骤流程，支持分支、循环和人工确认', color: 'blue', tag: 'Chat Flow' },
  agent: { name: 'Agent', desc: '模型自主规划并调用工具，适合开放式任务', color: 'teal', tag: 'Agent' },
};

export const STATUS_META: Record<AppStatus, { name: string; tone: string }> = {
  published: { name: '已发布', tone: 'green' },
  testing: { name: '评测中', tone: 'orange' },
  draft: { name: '草稿', tone: '' },
};

/* ---------------- 知识库 ---------------- */

export type ChunkMethodKey =
  | 'auto'
  | 'separator'
  | 'heading'
  | 'fixed'
  | 'parent_child'
  | 'semantic'
  | 'qa'
  | 'page'
  | 'table_row';

export interface KnowledgeBase {
  id: string;
  name: string;
  desc: string;
  type: 'general' | 'qa' | 'table' | 'web' | 'feishu';
  color: string;
  owner: string;
  collections: number;
  chunks: number;
  embedding: string;
  updatedAt: string;
  health: 'ok' | 'warn' | 'building';
  usedBy: string[];
}

export const KNOWLEDGE_BASES: KnowledgeBase[] = [
  { id: 'kb-product', name: '产品手册与 FAQ', desc: '全系列产品说明书、常见问题与故障排查', type: 'general', color: '#12b76a', owner: '客服中心', collections: 46, chunks: 3218, embedding: 'bge-m3', updatedAt: '今天 09:30', health: 'ok', usedBy: ['app-service', 'app-marketing'] },
  { id: 'kb-aftersale', name: '售后服务政策', desc: '退换货、保修、运费与发票政策', type: 'qa', color: '#0e9384', owner: '客服中心', collections: 12, chunks: 486, embedding: 'bge-m3', updatedAt: '今天 08:12', health: 'building', usedBy: ['app-service'] },
  { id: 'kb-research', name: '行业研究库', desc: '券商研报、行业白皮书、内部调研纪要', type: 'general', color: '#3370ff', owner: '战略部', collections: 128, chunks: 15420, embedding: 'text-embedding-v4', updatedAt: '昨天 21:05', health: 'ok', usedBy: ['app-report'] },
  { id: 'kb-legal', name: '法务条款库', desc: '标准合同模板、条款红线与历史审校意见', type: 'general', color: '#f79009', owner: '法务部', collections: 64, chunks: 2741, embedding: 'bge-m3', updatedAt: '10-25 15:40', health: 'warn', usedBy: ['app-contract'] },
  { id: 'kb-policy', name: '公司制度库', desc: '人事、财务、采购、行政等管理制度', type: 'feishu', color: '#7a5af8', owner: '人力行政部', collections: 38, chunks: 1265, embedding: 'bge-m3', updatedAt: '10-24 09:00', health: 'ok', usedBy: ['app-policy', 'app-contract'] },
  { id: 'kb-sales', name: '销售案例与话术', desc: '成交案例复盘、客户异议应对、竞品对比', type: 'table', color: '#dd2590', owner: '销售运营', collections: 20, chunks: 932, embedding: 'bge-m3', updatedAt: '10-21 10:20', health: 'ok', usedBy: ['app-marketing', 'app-sales'] },
];

export const KB_TYPE_META: Record<KnowledgeBase['type'], { name: string; desc: string }> = {
  general: { name: '通用知识库', desc: '上传文件、网页或文本，按切块策略构建索引' },
  qa: { name: '问答对知识库', desc: '以问题-答案为单位，适合 FAQ 和客服' },
  table: { name: '表格知识库', desc: 'Excel / CSV 按行索引，保留表头语义' },
  web: { name: '网站同步', desc: '输入站点地址，定时抓取并增量更新' },
  feishu: { name: '飞书知识库', desc: '绑定飞书知识空间，自动同步文档变更' },
};

export interface Collection {
  id: string;
  kbId: string;
  name: string;
  source: 'file' | 'web' | 'text' | 'qa_csv' | 'feishu';
  ext: string;
  method: ChunkMethodKey;
  chunks: number;
  size: string;
  status: 'ready' | 'indexing' | 'failed' | 'queued';
  progress?: number;
  error?: string;
  updatedAt: string;
  tags: string[];
}

export const COLLECTIONS: Collection[] = [
  { id: 'c1', kbId: 'kb-product', name: '智能储能柜 ES-200 用户手册 V3.2.pdf', source: 'file', ext: 'pdf', method: 'heading', chunks: 186, size: '8.4 MB', status: 'ready', updatedAt: '今天 09:30', tags: ['ES-200', '用户手册'] },
  { id: 'c2', kbId: 'kb-product', name: '常见问题 FAQ 2026Q3.xlsx', source: 'qa_csv', ext: 'xlsx', method: 'table_row', chunks: 412, size: '326 KB', status: 'ready', updatedAt: '今天 09:12', tags: ['FAQ'] },
  { id: 'c3', kbId: 'kb-product', name: '故障代码速查表.docx', source: 'file', ext: 'docx', method: 'auto', chunks: 96, size: '1.2 MB', status: 'ready', updatedAt: '昨天 16:44', tags: ['故障排查'] },
  { id: 'c4', kbId: 'kb-product', name: 'help.example.com/docs/app', source: 'web', ext: 'web', method: 'auto', chunks: 264, size: '58 页', status: 'indexing', progress: 62, updatedAt: '今天 10:05', tags: ['帮助中心'] },
  { id: 'c5', kbId: 'kb-product', name: '家用光伏逆变器 PV-5K 安装指南.pdf', source: 'file', ext: 'pdf', method: 'parent_child', chunks: 148, size: '12.6 MB', status: 'ready', updatedAt: '10-25 11:20', tags: ['PV-5K', '安装'] },
  { id: 'c6', kbId: 'kb-product', name: '售前产品参数对比（扫描件）.pdf', source: 'file', ext: 'pdf', method: 'page', chunks: 0, size: '22.1 MB', status: 'failed', error: '第 7–12 页为图片，未配置 OCR 模型', updatedAt: '10-25 10:02', tags: [] },
  { id: 'c7', kbId: 'kb-product', name: '新品上市口径说明', source: 'text', ext: 'txt', method: 'semantic', chunks: 14, size: '6.2 千字', status: 'ready', updatedAt: '10-24 17:30', tags: ['口径'] },
  { id: 'c8', kbId: 'kb-product', name: '经销商培训手册.docx', source: 'file', ext: 'docx', method: 'qa', chunks: 0, size: '3.4 MB', status: 'queued', updatedAt: '今天 10:20', tags: [] },
];

// 其余知识库复用同一组集合结构，仅替换文件名，避免在原型里维护多份数据。
export const KB_FILE_NAMES: Record<string, string[]> = {
  'kb-aftersale': ['售后服务政策 V2.1.docx', '退换货 FAQ.xlsx', '保修条款汇编.pdf', '发票开具说明.md'],
  'kb-research': ['2026 储能行业年度报告.pdf', '工商业储能经济性测算.xlsx', '海外储能市场追踪.pdf', 'research.example.com/weekly', '专家访谈纪要 10-18.docx'],
  'kb-legal': ['标准采购合同模板 V4.docx', '采购合同条款红线.xlsx', '历史审校意见汇编 2025.pdf', '销售合同模板 V3.docx', '扫描版框架协议（2019）.pdf'],
  'kb-policy': ['差旅费用管理办法（2026 修订）.pdf', '员工手册 2026.docx', '采购管理制度.pdf', '考勤与休假制度', '报销流程说明.md'],
  'kb-sales': ['成交案例复盘 2026H1.xlsx', '客户异议应对手册.docx', '竞品对比表.xlsx', '大客户拜访话术.pdf'],
};

export interface ChunkMethod {
  key: ChunkMethodKey;
  name: string;
  desc: string;
  bestFor: string;
  icon: string;
  needsLlm?: boolean;
  backend: 'ready' | 'partial' | 'todo';
}

export const CHUNK_METHODS: ChunkMethod[] = [
  { key: 'auto', name: '智能分块', desc: '识别标题和段落结构，自动递归切分到合适长度', bestFor: '大多数文档，推荐默认', icon: 'Sparkles', backend: 'ready' },
  { key: 'heading', name: '按标题层级', desc: '按 Markdown / Word 的 H1–H3 切分，每块保留标题路径', bestFor: '手册、制度、规范', icon: 'Heading', backend: 'todo' },
  { key: 'separator', name: '自定义分隔符', desc: '按指定符号切分，如空行、### 或「第X条」', bestFor: '格式规整的条款、清单', icon: 'SeparatorHorizontal', backend: 'partial' },
  { key: 'fixed', name: '固定长度', desc: '按 Token 数和重叠量机械切分', bestFor: '无结构的长文本、转写稿', icon: 'Ruler', backend: 'ready' },
  { key: 'parent_child', name: '父子分块', desc: '小块用于精准召回，命中后返回所在大块作为上下文', bestFor: '长篇研报、技术文档', icon: 'Network', backend: 'ready' },
  { key: 'semantic', name: '语义分块', desc: '由模型按主题完整性切分，逐字保留原文', bestFor: '主题跳跃的长文、访谈纪要', icon: 'BrainCircuit', needsLlm: true, backend: 'ready' },
  { key: 'qa', name: '问答对拆分', desc: '由模型从文档中提取「问题-答案」，按问答对索引', bestFor: 'FAQ、客服、培训材料', icon: 'MessagesSquare', needsLlm: true, backend: 'todo' },
  { key: 'page', name: '按页切分', desc: 'PDF / PPT 一页一块，保留页码和版面', bestFor: '幻灯片、扫描件、图表多的报告', icon: 'FileStack', backend: 'todo' },
  { key: 'table_row', name: '表格按行', desc: 'Excel / CSV 每行一块，表头作为每行的上下文', bestFor: '参数表、价格表、FAQ 表格', icon: 'Table', backend: 'partial' },
];

export const METHOD_NAME = Object.fromEntries(CHUNK_METHODS.map((m) => [m.key, m.name])) as Record<ChunkMethodKey, string>;

export const SAMPLE_DOC = `# 售后服务政策 V2.1

## 第一章 总则

第一条 为规范公司产品售后服务，保障客户合法权益，制定本政策。本政策适用于公司销售的全部储能及光伏产品。

第二条 售后服务遵循「首问负责、限时响应、闭环回访」原则。客服人员应在 2 小时内响应客户诉求，48 小时内给出处理方案。

<!-- page -->

## 第二章 退换货

第三条 客户自签收之日起 7 日内，产品无人为损坏且包装完整的，可申请无理由退货。退货运费由客户承担，产品质量问题除外。

第四条 自签收之日起 15 日内出现非人为性能故障的，客户可选择换货或维修。换货产生的往返运费由公司承担。

第五条 定制类产品、已激活的软件授权不适用无理由退货。

<!-- page -->

## 第三章 保修

第六条 储能柜整机保修 5 年，电芯保修 10 年或 6000 次循环（以先到者为准）。光伏逆变器整机保修 5 年，可付费延保至 10 年。

第七条 以下情形不在保修范围内：未按说明书安装使用；私自拆机或改装；不可抗力造成的损坏。

## 第四章 发票

第八条 客户可在订单完成后 90 日内申请开具增值税专用发票或普通发票，电子发票将于 3 个工作日内发送至预留邮箱。`;

export const SAMPLE_TABLE = `型号,额定功率,电池容量,质保,参考价
ES-200,100 kW,215 kWh,5 年,¥ 268,000
ES-100,50 kW,107 kWh,5 年,¥ 149,000
PV-5K,5 kW,—,5 年（可延保至 10 年）,¥ 6,800
PV-10K,10 kW,—,5 年（可延保至 10 年）,¥ 11,500`;

export const SAMPLE_QA = [
  { q: '退货运费由谁承担？', a: '7 日内无理由退货的运费由客户承担；若因产品质量问题退货，运费由公司承担。' },
  { q: '多久内可以无理由退货？', a: '自签收之日起 7 日内，产品无人为损坏且包装完整即可申请。' },
  { q: '换货的运费谁出？', a: '签收 15 日内出现非人为性能故障选择换货的，往返运费由公司承担。' },
  { q: '储能柜保修多久？', a: '整机保修 5 年，电芯保修 10 年或 6000 次循环，以先到者为准。' },
  { q: '逆变器可以延保吗？', a: '光伏逆变器整机保修 5 年，可付费延保至 10 年。' },
  { q: '哪些情况不保修？', a: '未按说明书安装使用、私自拆机或改装、不可抗力造成的损坏不在保修范围内。' },
  { q: '多久内可以申请发票？', a: '订单完成后 90 日内可申请增值税专用发票或普通发票。' },
  { q: '电子发票多久能收到？', a: '3 个工作日内发送至预留邮箱。' },
];

export interface ChunkItem {
  id: string;
  index: number;
  title: string;
  content: string;
  tokens: number;
  indexes: { type: 'default' | 'question' | 'summary' | 'custom'; text: string }[];
  hits: number;
}

export const CHUNKS: ChunkItem[] = [
  { id: 'k1', index: 1, title: '1 产品概述 > 1.1 适用范围', content: 'ES-200 智能储能柜适用于工商业园区削峰填谷、需量管理与应急备电场景。额定功率 100 kW，电池容量 215 kWh，支持 1–8 台并机扩容。', tokens: 86, indexes: [{ type: 'default', text: '默认索引（正文）' }, { type: 'question', text: 'ES-200 适合哪些场景？' }, { type: 'question', text: 'ES-200 最多可以几台并机？' }], hits: 132 },
  { id: 'k2', index: 2, title: '2 安装要求 > 2.1 环境条件', content: '安装环境温度 -20℃～50℃，相对湿度 ≤95%（无凝露），海拔 ≤2000 m。设备四周预留不小于 1 m 的检修通道，顶部预留 0.5 m 散热空间。禁止安装在易燃易爆或腐蚀性气体环境中。', tokens: 112, indexes: [{ type: 'default', text: '默认索引（正文）' }, { type: 'summary', text: '安装环境温湿度、海拔、通道与禁装环境要求' }], hits: 87 },
  { id: 'k3', index: 3, title: '3 开机与调试 > 3.2 首次开机', content: '首次开机前请确认：① 直流侧与交流侧断路器均处于断开状态；② 接地电阻 ≤4 Ω；③ BMS 通讯线连接正确。依次闭合直流断路器、交流断路器，在触摸屏选择「系统自检」，自检通过后进入运行模式。', tokens: 138, indexes: [{ type: 'default', text: '默认索引（正文）' }, { type: 'question', text: '储能柜无法开机怎么办？' }, { type: 'question', text: '首次开机步骤是什么？' }], hits: 241 },
  { id: 'k4', index: 4, title: '5 故障处理 > 5.1 常见故障代码', content: 'E01 电池过温：检查散热风道是否堵塞，环境温度是否超过 50℃。\nE02 绝缘阻抗低：检查直流线缆绝缘层是否破损。\nE07 BMS 通讯中断：检查 CAN 通讯线及终端电阻。', tokens: 104, indexes: [{ type: 'default', text: '默认索引（正文）' }, { type: 'custom', text: 'E01 E02 E07 报警 故障码' }], hits: 318 },
  { id: 'k5', index: 5, title: '6 维护保养 > 6.1 定期巡检', content: '建议每季度进行一次巡检：清洁进风口滤网，检查线缆端子是否松动，记录电芯电压一致性。电芯压差超过 50 mV 时应执行均衡维护。', tokens: 78, indexes: [{ type: 'default', text: '默认索引（正文）' }], hits: 45 },
  { id: 'k6', index: 6, title: '7 质保说明', content: '整机保修 5 年，电芯保修 10 年或 6000 次循环（以先到者为准）。保修期内非人为损坏免费维修，保修期外按备件价格收费。', tokens: 70, indexes: [{ type: 'default', text: '默认索引（正文）' }, { type: 'question', text: 'ES-200 保修几年？' }], hits: 166 },
];

/* ---------------- 模型 / 工具 ---------------- */

export const MODELS = [
  { name: 'DeepSeek-V3.2', provider: 'DeepSeek', type: 'LLM', ctx: '128K', status: 'ok', tags: ['工具调用', '默认对话'] },
  { name: 'DeepSeek-R1', provider: 'DeepSeek', type: 'LLM', ctx: '128K', status: 'ok', tags: ['推理'] },
  { name: 'Qwen3-Max', provider: '通义千问', type: 'LLM', ctx: '256K', status: 'ok', tags: ['长文写作', '工具调用'] },
  { name: 'Qwen-VL-Max', provider: '通义千问', type: '视觉', ctx: '32K', status: 'ok', tags: ['OCR', '图片理解'] },
  { name: 'bge-m3', provider: '本地部署', type: 'Embedding', ctx: '8K', status: 'ok', tags: ['1024 维'] },
  { name: 'text-embedding-v4', provider: '通义千问', type: 'Embedding', ctx: '8K', status: 'ok', tags: ['1536 维'] },
  { name: 'bge-reranker-v2-m3', provider: '本地部署', type: 'Rerank', ctx: '8K', status: 'warn', tags: ['重排'] },
];

export const TOOLS = [
  { id: 't-order', name: '订单查询', kind: 'HTTP', desc: '按订单号查询物流与状态（ERP 接口）', icon: 'PackageSearch', color: '#3370ff', calls: 1284, status: 'ok' },
  { id: 't-ticket', name: '创建售后工单', kind: 'HTTP', desc: '在工单系统创建维修 / 退换货工单', icon: 'TicketPlus', color: '#f79009', calls: 312, status: 'ok' },
  { id: 't-crm', name: '客户档案查询', kind: 'HTTP', desc: '查询 CRM 中的客户等级与历史购买', icon: 'Contact', color: '#7a5af8', calls: 640, status: 'ok' },
  { id: 't-feishu', name: '飞书消息通知', kind: 'MCP', desc: '向指定群 / 人发送飞书消息卡片', icon: 'Send', color: '#0e9384', calls: 96, status: 'ok' },
  { id: 't-search', name: '联网搜索', kind: '系统', desc: '实时检索公开网页信息', icon: 'Globe', color: '#12b76a', calls: 455, status: 'ok' },
  { id: 't-word', name: '导出 Word 文档', kind: '系统', desc: '把 Markdown 按公司模板转为 .docx', icon: 'FileDown', color: '#3370ff', calls: 188, status: 'ok' },
  { id: 't-sql', name: '经营数据查询', kind: '工作流插件', desc: '自然语言转 SQL 查询 BI 数仓（只读）', icon: 'Database', color: '#dd2590', calls: 74, status: 'beta' },
];

/* ---------------- 日志 ---------------- */

export const LOGS = [
  { id: 'l1', app: 'app-service', user: '访客 3f2a', channel: '官网嵌入', question: '储能柜报 E07 是什么问题？', turns: 4, time: '10:41', feedback: 'good', status: 'ok', tokens: 3120, cites: 2 },
  { id: 'l2', app: 'app-service', user: '张先生', channel: '企业微信', question: '帮我查一下订单 SO20261024017 到哪了', turns: 2, time: '10:36', feedback: '', status: 'ok', tokens: 1860, cites: 0 },
  { id: 'l3', app: 'app-service', user: '访客 9c1e', channel: '官网嵌入', question: '你们和 X 品牌比哪个更便宜', turns: 3, time: '10:22', feedback: 'bad', status: 'handoff', tokens: 2410, cites: 0 },
  { id: 'l4', app: 'app-policy', user: '研发部 · 黄磊', channel: '工作台', question: '出差深圳住宿标准是多少', turns: 1, time: '10:15', feedback: 'good', status: 'ok', tokens: 980, cites: 1 },
  { id: 'l5', app: 'app-report', user: '战略部 · 李想', channel: '工作台', question: '2026 年储能行业竞争格局分析', turns: 6, time: '09:58', feedback: 'good', status: 'ok', tokens: 48210, cites: 14 },
  { id: 'l6', app: 'app-service', user: '访客 77ab', channel: '官网嵌入', question: 'PV-5K 能不能接 48V 电池', turns: 2, time: '09:40', feedback: '', status: 'nohit', tokens: 1120, cites: 0 },
  { id: 'l7', app: 'app-contract', user: '法务部 · 王律', channel: '工作台', question: '《年度框架采购合同-华东》审校', turns: 2, time: '09:21', feedback: 'good', status: 'ok', tokens: 22840, cites: 9 },
];

export const KNOWLEDGE_GAPS = [
  { q: 'PV-5K 能不能接 48V 电池', count: 17, app: '智能客服助手', kb: '产品手册与 FAQ' },
  { q: '海外订单的保修政策', count: 11, app: '智能客服助手', kb: '售后服务政策' },
  { q: '异地办公的通讯补贴标准', count: 8, app: '制度问答助手', kb: '公司制度库' },
  { q: '框架合同里的价格调整机制', count: 5, app: '合同风险审校', kb: '法务条款库' },
];

export function appById(id: string) {
  return APPS.find((a) => a.id === id);
}

export function kbById(id: string) {
  return KNOWLEDGE_BASES.find((k) => k.id === id);
}
