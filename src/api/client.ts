import type { Role } from '../types';

export const TOKEN_KEY = 'fde-access-token';
// Development uses Vite's same-origin proxy so modern Chromium Local Network
// Access rules do not block a cross-port loopback request. Deployments can
// still point at a separate API origin explicitly.
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';
export class ApiError extends Error {
  status: number;
  traceId?: string;

  constructor(status: number, message: string, traceId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.traceId = traceId;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const accessToken = window.localStorage.getItem(TOKEN_KEY);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  if (response.status === 401 && accessToken && !path.startsWith('/auth/login')) {
    window.localStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new Event('fde-session-expired'));
  }
  if (!response.ok) {
    let detail = `请求失败（HTTP ${response.status}）`;
    let traceId: string | undefined;
    try {
      const body = await response.json() as { detail?: string | Array<{ msg?: string }> | { message?: string; issues?: Array<{ message?: string }> } };
      if (typeof body.detail === 'string') detail = body.detail;
      else if (Array.isArray(body.detail)) detail = body.detail.map((item) => item.msg).filter(Boolean).join('；') || detail;
      else if (body.detail && typeof body.detail === 'object') {
        detail = [body.detail.message, ...(body.detail.issues ?? []).map((item) => item.message)].filter(Boolean).join('；') || detail;
        traceId = (body.detail as { trace_id?: string }).trace_id;
      }
    } catch {
      // Keep the HTTP fallback when the server did not return JSON.
    }
    throw new ApiError(response.status, detail, traceId);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export interface ApiModelConfig {
  id: string;
  display_name: string;
  provider: 'openrouter' | 'aihubmix' | 'deepseek' | 'tongyi' | 'mock';
  model_type: 'llm' | 'embedding' | 'rerank' | 'ocr';
  model_name: string;
  base_url: string;
  api_key_masked: string | null;
  is_enabled: boolean;
  connection_status: 'untested' | 'connected' | 'error' | 'mock';
  last_tested_at: string | null;
  last_error: string | null;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  simulated: boolean;
}

export interface ApiOpenRouterCatalogModel {
  id: string;
  name: string;
  description: string;
  model_type: 'llm' | 'embedding' | 'rerank' | 'ocr';
  context_length: number | null;
  modality: string;
  prompt_price: string | null;
  is_free: boolean;
}

export interface ApiOpenRouterCatalog {
  ok: true;
  detail: string;
  latency_ms: number;
  models: ApiOpenRouterCatalogModel[];
}

export interface ApiModelOption {
  id: string;
  display_name: string;
  provider: ApiModelConfig['provider'];
  model_type: ApiModelConfig['model_type'];
  model_name: string;
  is_enabled: boolean;
  connection_status: ApiModelConfig['connection_status'];
}

export interface ApiToolConfig {
  id: string;
  name: string;
  kind: 'http' | 'mcp' | 'workflow';
  description: string;
  config: {
    method?: string;
    url?: string;
    parameters?: Record<string, unknown>;
    headers?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
    response_path?: string;
    auth_type?: 'none' | 'bearer' | 'api_key';
    auth_header?: string;
    allow_private_network?: boolean;
    timeout_seconds?: number;
    side_effect?: boolean;
  };
  has_secret: boolean;
  is_enabled: boolean;
  connection_status: 'untested' | 'connected' | 'error';
  last_tested_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiKnowledgeBase {
  id: string;
  name: string;
  description: string;
  embedding_model_id: string | null;
  rerank_model_id: string | null;
  ocr_model_id: string | null;
  chunk_size: number;
  chunk_overlap: number;
  chunk_method: 'recursive' | 'heading' | 'separator' | 'fixed' | 'parent_child' | 'semantic' | 'page' | 'table_row' | 'qa';
  parent_chunk_size: number;
  child_chunk_size: number;
  semantic_llm_model_id: string | null;
  metadata_llm_model_id: string | null;
  file_count: number;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface ApiKnowledgeFile {
  id: string;
  knowledge_base_id: string;
  filename: string;
  content_type: string;
  extension: string;
  size_bytes: number;
  checksum_sha256: string;
  status: string;
  error_message: string | null;
  page_count: number | null;
  chunk_count: number;
  chunk_config: ApiChunkConfig;
  document_metadata: {
    document_time?: string | null;
    version?: string | null;
    subjects?: string[];
    owner?: string | null;
    keywords?: string[];
    likely_questions?: string[];
    extraction_method?: 'rules' | 'llm' | 'manual';
    extraction_status?: string;
    extracted_at?: string;
    model_id?: string | null;
  };
  created_at: string;
  updated_at: string;
}

export interface ApiChunkConfig {
  method: ApiKnowledgeBase['chunk_method'];
  chunk_size: number;
  chunk_overlap: number;
  parent_chunk_size: number;
  child_chunk_size: number;
  separators: string[];
  heading_level: number;
  rows_per_chunk: number;
  /** 分块增强：抽取关键词 / 生成问答对，写入分块并参与检索。 */
  enhance_keywords?: boolean;
  enhance_qa?: boolean;
  qa_per_chunk?: number;
}

export interface ApiChunkPreview {
  filename: string;
  method: ApiKnowledgeBase['chunk_method'];
  total_chunks: number;
  returned_chunks: number;
  page_count: number | null;
  warnings: string[];
  chunks: Array<{
    ordinal: number;
    title: string;
    content: string;
    char_count: number;
    metadata: Record<string, unknown>;
  }>;
}

export interface ApiImportJob {
  id: string;
  file_id: string;
  status: string;
  progress: number;
  current_stage: string;
  stage_details: Array<{ name: string; status: string; detail: string }>;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  simulated: boolean;
}

export interface ApiChunk {
  id: string;
  knowledge_base_id: string;
  file_id: string;
  ordinal: number;
  title: string;
  content: string;
  page_number: number | null;
  char_count: number;
  metadata_json: Record<string, unknown>;
  indexed: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiRetrievalResult {
  chunk_id: string;
  knowledge_base_id: string;
  file_id: string;
  filename: string;
  title: string;
  content: string;
  page_number: number | null;
  vector_score: number;
  keyword_score: number | null;
  rerank_score: number | null;
  final_score: number;
  metadata: Record<string, unknown>;
}

export interface ApiRetrievalResponse {
  query: string;
  results: ApiRetrievalResult[];
  recalled_count: number;
  returned_count: number;
  embedding_duration_ms: number;
  vector_duration_ms: number;
  rerank_duration_ms: number | null;
  total_duration_ms: number;
  rerank_applied: boolean;
  simulated: boolean;
}

export interface ApiQAApp {
  id: string;
  name: string;
  description: string;
  scenario_type: 'qa' | 'report' | 'content' | 'review' | 'customer_service';
  system_prompt: string;
  llm_model_id: string | null;
  knowledge_base_ids: string[];
  knowledge_bases: Array<{ id: string; name: string; description: string }>;
  top_k: number;
  rerank_top_n: number;
  score_threshold: number;
  is_enabled: boolean;
  conversation_count: number;
  created_at: string;
  updated_at: string;
}

export interface ApiCitation {
  chunk_id: string;
  knowledge_base_id: string;
  file_id: string;
  filename: string;
  title: string;
  page_number: number | null;
  content: string;
  vector_score: number;
  rerank_score: number | null;
  score: number;
  metadata: Record<string, unknown>;
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: ApiCitation[];
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  simulated: boolean;
  app_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiConversation {
  id: string;
  app_id: string;
  title: string;
  demo_role: Role;
  created_at: string;
  updated_at: string;
}

export interface ApiConversationDetail extends ApiConversation {
  messages: ApiMessage[];
}

export interface ApiTraceStep {
  id: string;
  ordinal: number;
  name: string;
  status: string;
  duration_ms: number;
  detail: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface ApiQueryLog {
  id: string;
  trace_id: string;
  app_id: string | null;
  app_name: string | null;
  conversation_id: string | null;
  demo_role: Role;
  query: string;
  status: 'running' | 'success' | 'failed';
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  duration_ms: number | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  traces: ApiTraceStep[];
}

export interface ApiLogSummary {
  query_count: number;
  success_count: number;
  failed_count: number;
  success_rate: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  average_duration_ms: number | null;
}

export interface ApiEvaluationRun {
  id: string;
  status: 'running' | 'success' | 'failed';
  passed_count: number;
  failed_count: number;
  simulated: boolean;
  /** 该次运行评测的配置是否就是当前草稿；草稿改动后需重新运行才能作为发布门禁依据。 */
  matches_draft?: boolean;
  /** 分步运行的进度：已评测 / 本次应评测的 Case 数。 */
  done_count?: number;
  total_count?: number;
  results: Array<{
    case_id: string;
    name: string;
    passed: boolean;
    reasons: string[];
    output: string;
    simulated: boolean;
    /** 配置了 LLM 评委时的 1–5 分与理由；评委调用失败时分数为 null。 */
    judge_score?: number | null;
    judge_reason?: string;
  }>;
  created_at: string;
}

export interface ApiEvaluationCase {
  id: string;
  suite_id: string;
  name: string;
  case_type: 'good' | 'bad' | 'manual' | 'ai';
  readiness: 'ready' | 'needs_standard';
  message: string;
  input_values: Record<string, unknown>;
  actual_output: string;
  expected_output: string;
  expected_keywords: string[];
  forbidden_keywords: string[];
  require_citations: boolean;
  tags: string[];
  source_log_id: string | null;
  source_trace_id: string | null;
  source_conversation_id: string | null;
  source_snapshot: {
    captured_from?: string;
    trace_id?: string;
    application?: { id: string; name: string };
    app_version?: { id: string; version: number; release_notes: string } | null;
    model?: { provider?: string; model?: string; simulated?: boolean } | null;
    channel?: string;
    started_at?: string;
    trace?: Array<{ ordinal: number; name: string; status: string; duration_ms: number; detail: string; metadata: Record<string, unknown> }>;
  };
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiJudgeConfig {
  model_id: string | null;
  rubric: string;
  pass_score: number;
}

export interface ApiEvaluationSet {
  id: string;
  app_id: string;
  app_name: string;
  name: string;
  description: string;
  is_release_gate: boolean;
  judge: ApiJudgeConfig;
  default_rubric: string;
  case_count: number;
  ready_count: number;
  needs_standard_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  latest_run: ApiEvaluationRun | null;
  cases?: ApiEvaluationCase[];
}

export function formatDateTime(value: string | null): string {
  if (!value) return '尚未测试';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误';
}
