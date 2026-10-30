import type { ApiModelOption } from '../api/client';
import type { AppManifest, AppTemplate, FDEApp } from '../api/fde';
import { C } from '../theme';

export type AppType = AppManifest['type'];

export const TYPE_META: Record<AppType | 'chatflow', { name: string; desc: string; tone: string; examples: string }> = {
  simple: { name: '简易应用', desc: '提示词 + 知识库 + 表单，几分钟配置完成', tone: 'purple', examples: '制度问答、文案生成、纪要整理' },
  agent: { name: 'Agent', desc: '模型自主规划，调用知识库、业务工具和转人工', tone: 'teal', examples: '智能客服、数据查询、销售陪练' },
  chatflow: { name: 'Chat Flow', desc: '可视化编排多步骤流程，支持分支、循环和人工确认', tone: 'blue', examples: '报告撰写、合同审校' },
};

export const SCENES: Record<string, { name: string; color: string }> = {
  report: { name: '报告撰写', color: C.primary },
  customer_service: { name: '智能客服', color: C.success },
  review: { name: '制度与合同审校', color: C.warning },
  content: { name: '营销内容', color: C.rose },
  qa: { name: '知识问答', color: C.violet },
};

export function sceneOf(templateKey: string) {
  return SCENES[templateKey] ?? { name: '其他', color: C.slate };
}

export function appStatus(app: FDEApp): { label: string; tone: string } {
  if (app.status === 'archived') return { label: '已归档', tone: '' };
  if (app.is_enabled && app.published_version_id) return { label: `已发布 · v${app.published_version?.version ?? '?'}`, tone: 'green' };
  if (app.published_version_id) return { label: '已下线', tone: 'orange' };
  return { label: '草稿', tone: '' };
}

/** Prefer a connected real model; fall back to any enabled LLM (including test doubles). */
export function defaultLlm(options: ApiModelOption[]) {
  const llms = options.filter((item) => item.model_type === 'llm' && item.is_enabled && item.connection_status !== 'error');
  return llms.find((item) => item.provider !== 'mock' && item.connection_status === 'connected')
    ?? llms.find((item) => item.provider !== 'mock')
    ?? llms[0];
}

export function manifestFromTemplate(template: AppTemplate, type: AppType, llmId: string | null, name?: string): AppManifest {
  return {
    schema_version: 'fde.app/v2',
    type,
    name: name?.trim() || template.name,
    description: template.description,
    template_key: template.key,
    system_prompt: template.system_prompt,
    llm_model_id: llmId,
    model: { temperature: 0.2, max_tokens: 4096, thinking_mode: 'auto' },
    knowledge_base_ids: [],
    input_fields: type === 'agent' ? [] : template.input_fields,
    output: template.output,
    tools: template.tools.filter((tool) => !tool.tool_id),
    guardrails: { ...template.guardrails, human_handoff: template.guardrails.human_handoff || (type === 'agent' && template.key === 'customer_service') },
    memory: { ...template.memory, enabled: type === 'agent' ? true : template.memory.enabled },
    delivery: template.delivery,
    agent: { max_steps: 8, require_confirmation_for_side_effects: true, show_tool_steps: true, long_term_memory: false, knowledge_mode: 'tool' },
    experience: { opening: '', suggestions: [] },
  };
}

export function retrievalConfig(manifest: AppManifest) {
  const tool = manifest.tools.find((item) => item.name === 'knowledge_retrieval');
  const config = (tool?.config ?? {}) as Record<string, number | string>;
  return {
    mode: (config.mode as 'semantic' | 'fulltext' | 'hybrid') ?? 'semantic',
    top_k: Number(config.top_k ?? 8),
    rerank_top_n: Number(config.rerank_top_n ?? 3),
    score_threshold: Number(config.score_threshold ?? 0.35),
    max_context_chars: Number(config.max_context_chars ?? 12000),
  };
}

export function withRetrievalConfig(manifest: AppManifest, patch: Partial<ReturnType<typeof retrievalConfig>>): AppManifest {
  const current = retrievalConfig(manifest);
  const others = manifest.tools.filter((item) => item.name !== 'knowledge_retrieval');
  return { ...manifest, tools: [...others, { name: 'knowledge_retrieval', enabled: true, config: { ...current, ...patch } }] };
}

/** 空白应用：沿用通用模板的结构，但不带任何预置提示词、表单和工具。 */
export function blankManifest(templates: AppTemplate[], type: AppType, llmId: string | null, name: string): AppManifest | null {
  const base = templates.find((item) => !item.knowledge_bases.required) ?? templates[0];
  if (!base) return null;
  const manifest = manifestFromTemplate(base, type, llmId, name);
  return {
    ...manifest,
    description: '',
    system_prompt: type === 'agent' ? '你是一个业务助手。说明你的职责、可以使用的知识和工具，以及何时需要转人工。' : '你是一个业务助手。请根据用户输入完成任务。',
    input_fields: [],
    tools: [],
    guardrails: { ...manifest.guardrails, human_handoff: false, blocked_topics: [] },
  };
}
