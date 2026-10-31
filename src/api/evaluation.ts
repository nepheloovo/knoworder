import { apiFetch, type ApiEvaluationCase, type ApiEvaluationRun, type ApiEvaluationSet, type ApiJudgeConfig } from './client';

export type CaseDraft = {
  name: string;
  message: string;
  input_values?: Record<string, unknown>;
  expected_output?: string;
  expected_keywords?: string[];
  forbidden_keywords?: string[];
  require_citations?: boolean;
  tags?: string[];
};

export type DesignRules = {
  rules: Array<{ key: string; name: string; description: string; needs_knowledge: boolean }>;
  recommended: string[];
  has_knowledge: boolean;
  has_model: boolean;
};

export const evalApi = {
  list: (appId?: string) => apiFetch<ApiEvaluationSet[]>(`/evaluation-sets${appId ? `?app_id=${appId}` : ''}`),
  get: (id: string) => apiFetch<ApiEvaluationSet>(`/evaluation-sets/${id}`),
  create: (payload: { app_id: string; name: string; description?: string }) => apiFetch<ApiEvaluationSet>('/evaluation-sets', { method: 'POST', body: JSON.stringify(payload) }),
  update: (id: string, payload: { name?: string; description?: string; is_release_gate?: boolean; judge?: ApiJudgeConfig }) => apiFetch<ApiEvaluationSet>(`/evaluation-sets/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  fromLogs: (id: string, payload: { trace_ids: string[]; case_type: 'good' | 'bad'; tags?: string[] }) => apiFetch<{ created_count: number; cases: ApiEvaluationCase[] }>(`/evaluation-sets/${id}/cases/from-logs`, { method: 'POST', body: JSON.stringify(payload) }),
  createCase: (id: string, payload: CaseDraft) => apiFetch<ApiEvaluationCase>(`/evaluation-sets/${id}/cases`, { method: 'POST', body: JSON.stringify(payload) }),
  updateCase: (id: string, caseId: string, payload: Partial<CaseDraft> & { case_type?: 'good' | 'bad' | 'manual' }) => apiFetch<ApiEvaluationCase>(`/evaluation-sets/${id}/cases/${caseId}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteCase: (id: string, caseId: string) => apiFetch<void>(`/evaluation-sets/${id}/cases/${caseId}`, { method: 'DELETE' }),
  run: (id: string) => apiFetch<ApiEvaluationRun>(`/evaluation-sets/${id}/run`, { method: 'POST' }),
  designRules: (appId: string) => apiFetch<DesignRules>(`/evaluation-sets/design-rules?app_id=${appId}`),
  aiDesign: (payload: { app_id: string; name?: string; rule_keys: string[]; directions: string; count: number }) => apiFetch<ApiEvaluationSet>('/evaluation-sets/ai-design', { method: 'POST', body: JSON.stringify(payload) }),
  start: (id: string) => apiFetch<ApiEvaluationRun>(`/evaluation-sets/${id}/runs`, { method: 'POST' }),
  step: (id: string, runId: string) => apiFetch<ApiEvaluationRun>(`/evaluation-sets/${id}/runs/${runId}/step`, { method: 'POST' }),
};

/**
 * 逐个 Case 运行评测并回报进度。传入 resume 可继续一次中断的运行。
 * shouldStop 返回 true 时停止发起下一步（例如组件已卸载）。
 */
export async function runWithProgress(setId: string, onProgress: (run: ApiEvaluationRun) => void, options: { resume?: ApiEvaluationRun; shouldStop?: () => boolean } = {}) {
  let run = options.resume ?? await evalApi.start(setId);
  onProgress(run);
  while (run.status === 'running' && !options.shouldStop?.()) {
    run = await evalApi.step(setId, run.id);
    onProgress(run);
  }
  return run;
}

export function splitList(value: string) {
  return value.split(/[\n,，、]+/).map((item) => item.trim()).filter(Boolean);
}
