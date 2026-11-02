import { Bot, Pencil, Play, Plus, RefreshCw, Search, Trash2, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch, errorMessage, formatDateTime, type ApiModelConfig, type ApiOpenRouterCatalog, type ApiOpenRouterCatalogModel, type ApiToolConfig } from '../api/client';
import { ConfirmModal, Drawer, Empty, Field, Loading, Notice, Spinner, Switch, Tag, useToast } from '../components/ui';
import { C } from '../theme';

type Tab = 'models' | 'tools';

const PROVIDERS: Record<ApiModelConfig['provider'], string> = { openrouter: 'OpenRouter', aihubmix: 'AIHubMix', deepseek: 'DeepSeek', tongyi: '通义', mock: '测试替身' };
const MODEL_TYPES: Record<ApiModelConfig['model_type'], string> = { llm: '对话模型 LLM', embedding: '索引模型 Embedding', rerank: '重排模型 Rerank', ocr: '图片理解 / OCR' };
const STATUS: Record<string, { label: string; tone: string }> = { connected: { label: '已连通', tone: 'green' }, untested: { label: '未测试', tone: '' }, error: { label: '连接异常', tone: 'red' }, mock: { label: '测试替身', tone: 'orange' } };

export function ToolsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'tools' ? 'tools' : 'models';
  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1>集成</h1><p>接入模型服务商和业务系统接口，供知识库与应用使用。</p></div>
      </div>
      <div className="seg" style={{ marginBottom: 16 }}>
        <button className={tab === 'models' ? 'active' : ''} onClick={() => setParams({ tab: 'models' })}><Bot size={14} />模型</button>
        <button className={tab === 'tools' ? 'active' : ''} onClick={() => setParams({ tab: 'tools' })}><Wrench size={14} />业务工具</button>
      </div>
      {tab === 'models' ? <ModelsView /> : <HttpToolsView />}
    </div>
  );
}

/* ------------------------------ 模型 ------------------------------ */

type ModelDraft = {
  id?: string; display_name: string; provider: ApiModelConfig['provider']; model_type: ApiModelConfig['model_type']; model_name: string;
  base_url: string; api_key: string; is_enabled: boolean; input_price: string; output_price: string; currency: string; dimensions: string; rerank_url: string;
};

const emptyModel: ModelDraft = { display_name: '', provider: 'openrouter', model_type: 'llm', model_name: '', base_url: '', api_key: '', is_enabled: true, input_price: '', output_price: '', currency: 'USD', dimensions: '', rerank_url: '' };

function ModelsView() {
  const toast = useToast();
  const [items, setItems] = useState<ApiModelConfig[] | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [busy, setBusy] = useState('');
  const [removing, setRemoving] = useState<ApiModelConfig | null>(null);
  const [connecting, setConnecting] = useState<{ provider?: CatalogProvider; sourceModelId?: string } | null>(null);

  const load = useCallback(() => apiFetch<ApiModelConfig[]>('/models').then((list) => { setItems(list); setError(''); }).catch((caught) => setError(errorMessage(caught))), []);
  useEffect(() => { void load(); }, [load]);

  const edit = (model: ApiModelConfig) => {
    const config = model.config ?? {};
    setDraft({
      id: model.id, display_name: model.display_name, provider: model.provider, model_type: model.model_type, model_name: model.model_name, base_url: model.base_url,
      api_key: '', is_enabled: model.is_enabled, input_price: String(config.input_price_per_million ?? ''), output_price: String(config.output_price_per_million ?? ''),
      currency: String(config.currency ?? 'USD'), dimensions: String(config.dimensions ?? ''), rerank_url: String(config.rerank_url ?? ''),
    });
  };

  const save = async () => {
    if (!draft) return;
    setBusy('save');
    const config: Record<string, unknown> = { currency: draft.currency || 'USD' };
    if (draft.input_price.trim()) config.input_price_per_million = Number(draft.input_price);
    if (draft.output_price.trim()) config.output_price_per_million = Number(draft.output_price);
    if (draft.dimensions.trim()) config.dimensions = Number(draft.dimensions);
    if (draft.rerank_url.trim()) config.rerank_url = draft.rerank_url.trim();
    const common = { display_name: draft.display_name.trim(), model_name: draft.model_name.trim(), base_url: draft.base_url.trim() || null, is_enabled: draft.is_enabled, config, ...(draft.api_key.trim() ? { api_key: draft.api_key.trim() } : {}) };
    try {
      if (draft.id) await apiFetch(`/models/${draft.id}`, { method: 'PATCH', body: JSON.stringify(common) });
      else await apiFetch('/models', { method: 'POST', body: JSON.stringify({ ...common, provider: draft.provider, model_type: draft.model_type }) });
      toast(draft.id ? '模型已更新' : '模型已接入，建议立即测试连接');
      setDraft(null);
      await load();
    } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(''); }
  };

  const test = async (model: ApiModelConfig) => {
    setBusy(model.id);
    try {
      const result = await apiFetch<{ ok: boolean; detail?: string }>(`/models/${model.id}/test`, { method: 'POST' });
      toast(result.ok ? '连接成功' : result.detail || '连接失败', result.ok ? 'info' : 'error');
    } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(''); await load(); }
  };

  // 每家已接入的服务商取一个模型作为凭据来源，追加模型时无需重新填写 API Key
  const connected = Object.keys(CATALOG_PROVIDERS).flatMap((provider) => {
    const source = items?.find((item) => item.provider === provider && item.api_key_masked);
    return source ? [{ provider: provider as CatalogProvider, sourceModelId: source.id }] : [];
  });
  const isNew = !draft?.id;
  const keyRequired = isNew && draft?.provider !== 'mock';

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <p className="faint grow">知识库需要 Embedding 模型建索引，应用需要 LLM 对话。填写单价后，可观测会估算费用。</p>
        <button className="btn" onClick={() => void load()}><RefreshCw size={14} />刷新</button>
        <button className="btn" onClick={() => setDraft({ ...emptyModel })}>手动添加</button>
        <button className="btn primary" onClick={() => setConnecting({})}><Plus size={15} />接入模型服务商</button>
      </div>
      {connected.length ? (
        <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
          <span className="faint">已接入：</span>
          {connected.map((item) => <button key={item.provider} className="btn sm" onClick={() => setConnecting({ provider: item.provider, sourceModelId: item.sourceModelId })}><Plus size={13} />从 {CATALOG_PROVIDERS[item.provider].name} 添加更多模型</button>)}
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!items && !error ? <Loading /> : null}
      {items && !items.length ? <Empty icon={<Bot size={26} />} title="还没有接入模型" desc="先接入一个 LLM 和一个 Embedding 模型，就能创建知识库和应用。" action={<button className="btn primary" onClick={() => setConnecting({})}><Plus size={15} />接入模型服务商</button>} /> : null}
      {items?.length ? (
        <table className="table">
          <thead><tr><th>名称</th><th>类型</th><th>供应商 · 模型</th><th>单价（每百万 tokens）</th><th>状态</th><th>启用</th><th style={{ width: 170 }} /></tr></thead>
          <tbody>{items.map((model) => {
            const status = STATUS[model.connection_status] ?? { label: model.connection_status, tone: '' };
            const config = model.config ?? {};
            return (
              <tr key={model.id}>
                <td><strong>{model.display_name}</strong><div className="faint">{model.api_key_masked ?? '无密钥'}</div></td>
                <td><Tag>{MODEL_TYPES[model.model_type]}</Tag></td>
                <td><div>{PROVIDERS[model.provider] ?? model.provider}</div><div className="faint mono">{model.model_name}</div></td>
                <td className="faint">{config.input_price_per_million != null ? `入 ${String(config.input_price_per_million)} / 出 ${String(config.output_price_per_million ?? '—')} ${String(config.currency ?? 'USD')}` : '未配置'}</td>
                <td><Tag tone={status.tone}>{status.label}</Tag>{model.last_error ? <div className="faint clamp-2" style={{ maxWidth: 220, color: C.dangerText }}>{model.last_error}</div> : <div className="faint">{formatDateTime(model.last_tested_at)}</div>}</td>
                <td><Switch on={model.is_enabled} label={`启用 ${model.display_name}`} onChange={async (value) => { try { await apiFetch(`/models/${model.id}`, { method: 'PATCH', body: JSON.stringify({ is_enabled: value }) }); await load(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} /></td>
                <td>
                  <div className="row" style={{ gap: 2 }}>
                    <button className="btn sm" disabled={busy === model.id} onClick={() => void test(model)}>{busy === model.id ? <Spinner size={12} /> : <Play size={13} />}测试</button>
                    <button className="btn sm ghost icon" aria-label={`编辑 ${model.display_name}`} onClick={() => edit(model)}><Pencil size={14} /></button>
                    <button className="btn sm ghost icon" aria-label={`删除 ${model.display_name}`} onClick={() => setRemoving(model)}><Trash2 size={14} /></button>
                  </div>
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      ) : null}

      <Drawer open={!!draft} title={isNew ? '接入模型' : '编辑模型'} onClose={() => setDraft(null)}
        footer={<><button className="btn" onClick={() => setDraft(null)}>取消</button><button className="btn primary" disabled={busy === 'save' || !draft?.display_name.trim() || !draft?.model_name.trim() || (keyRequired && !draft?.api_key.trim())} onClick={() => void save()}>{busy === 'save' ? <Spinner /> : null}保存</button></>}>
        {draft ? <>
          <div className="form-grid">
            <Field label="模型类型" required><select className="select" disabled={!isNew} value={draft.model_type} onChange={(event) => setDraft({ ...draft, model_type: event.target.value as ModelDraft['model_type'] })}>{Object.entries(MODEL_TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
            <Field label="供应商" required><select className="select" disabled={!isNew} value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value as ModelDraft['provider'] })}>{Object.entries(PROVIDERS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
          </div>
          <Field label="显示名称" required><input className="input" value={draft.display_name} placeholder="例如：DeepSeek V3" onChange={(event) => setDraft({ ...draft, display_name: event.target.value })} /></Field>
          <Field label="模型 ID" required hint="供应商侧的模型名"><input className="input mono" value={draft.model_name} placeholder="例如：deepseek/deepseek-chat" onChange={(event) => setDraft({ ...draft, model_name: event.target.value })} /></Field>
          <Field label="API Key" required={keyRequired} hint={isNew ? undefined : '留空保持不变'}><input className="input mono" type="password" autoComplete="off" value={draft.api_key} onChange={(event) => setDraft({ ...draft, api_key: event.target.value })} /></Field>
          <Field label="Base URL" hint="留空使用供应商默认地址"><input className="input mono" value={draft.base_url} onChange={(event) => setDraft({ ...draft, base_url: event.target.value })} /></Field>
          {draft.model_type === 'embedding' ? <Field label="向量维度" hint="可选"><input className="input" type="number" min={1} value={draft.dimensions} onChange={(event) => setDraft({ ...draft, dimensions: event.target.value })} /></Field> : null}
          {draft.model_type === 'rerank' ? <Field label="重排接口地址" hint="可选，默认 {Base URL}/rerank"><input className="input mono" value={draft.rerank_url} onChange={(event) => setDraft({ ...draft, rerank_url: event.target.value })} /></Field> : null}
          <div className="section-title">计价（用于费用估算）</div>
          <div className="form-grid">
            <Field label="输入单价" hint="每百万 tokens"><input className="input" type="number" min={0} step="any" value={draft.input_price} onChange={(event) => setDraft({ ...draft, input_price: event.target.value })} /></Field>
            <Field label="输出单价" hint="每百万 tokens"><input className="input" type="number" min={0} step="any" value={draft.output_price} onChange={(event) => setDraft({ ...draft, output_price: event.target.value })} /></Field>
          </div>
          <Field label="币种"><select className="select" value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value })}><option value="USD">USD</option><option value="CNY">CNY</option></select></Field>
          <div className="row"><span className="grow">启用</span><Switch on={draft.is_enabled} label="启用" onChange={(value) => setDraft({ ...draft, is_enabled: value })} /></div>
        </> : null}
      </Drawer>
      <ProviderConnect value={connecting} existing={items ?? []} onClose={() => setConnecting(null)} onDone={() => { setConnecting(null); void load(); }} />
      <ConfirmModal open={!!removing} danger title="删除模型" confirmText="删除" body={<>删除「{removing?.display_name}」后，使用它的知识库和应用需要改选其他模型。</>} onClose={() => setRemoving(null)}
        onConfirm={async () => { if (!removing) return; try { await apiFetch(`/models/${removing.id}`, { method: 'DELETE' }); toast('已删除'); await load(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} />
    </>
  );
}

/* ------------------------------ 接入模型服务商 ------------------------------ */

type CatalogProvider = 'openrouter' | 'aihubmix' | 'deepseek';
const CATALOG_PROVIDERS: Record<CatalogProvider, { name: string; desc: string; keyUrl: string }> = {
  openrouter: { name: 'OpenRouter', desc: '聚合数百个主流模型，一个 Key 全部可用', keyUrl: 'https://openrouter.ai/keys' },
  aihubmix: { name: 'AIHubMix', desc: '国内可直连的多模型聚合，含 Embedding / Rerank', keyUrl: 'https://aihubmix.com' },
  deepseek: { name: 'DeepSeek', desc: 'DeepSeek 官方 API', keyUrl: 'https://platform.deepseek.com/api_keys' },
};
const TYPE_TABS: Array<[ApiModelConfig['model_type'] | 'all', string]> = [['all', '全部'], ['llm', '对话'], ['embedding', '索引'], ['rerank', '重排'], ['ocr', '图片理解']];
/** 服务商目录给的是每 token 单价（如 0.00000027），换算成更好读的每百万 token 价格。 */
function pricePerMillion(price: string) {
  const value = Number(price);
  if (!Number.isFinite(value)) return price;
  return value === 0 ? '免费' : `$${Number((value * 1_000_000).toPrecision(4))}/M`;
}

const catalogKey = (model: Pick<ApiOpenRouterCatalogModel, 'model_type' | 'id'>) => `${model.model_type}:${model.id}`;

/** 先选服务商、填一次 Key，再从读取到的模型目录里勾选要接入的模型。 */
function ProviderConnect({ value, existing, onClose, onDone }: { value: { provider?: CatalogProvider; sourceModelId?: string } | null; existing: ApiModelConfig[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [provider, setProvider] = useState<CatalogProvider>('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [catalog, setCatalog] = useState<ApiOpenRouterCatalog | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [type, setType] = useState<(typeof TYPE_TABS)[number][0]>('all');
  const [q, setQ] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [busy, setBusy] = useState('');

  const credentials = (): Record<string, string> => (value?.sourceModelId ? { source_model_id: value.sourceModelId } : { api_key: apiKey.trim(), ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}) });
  const loadCatalog = useCallback(async (target: CatalogProvider, creds: Record<string, string>) => {
    setBusy('catalog');
    setCatalog(null);
    try {
      setCatalog(await apiFetch<ApiOpenRouterCatalog>(`/models/providers/${target}/catalog`, { method: 'POST', body: JSON.stringify(creds) }));
    } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(''); }
  }, [toast]);

  useEffect(() => {
    if (!value) return;
    setProvider(value.provider ?? 'openrouter'); setApiKey(''); setBaseUrl(''); setCatalog(null); setSelected([]); setType('all'); setQ(''); setFreeOnly(false);
    // 已接入的服务商直接用已保存的 Key 读取目录
    if (value.provider && value.sourceModelId) void loadCatalog(value.provider, { source_model_id: value.sourceModelId });
  }, [value, loadCatalog]);

  const already = new Set(existing.filter((item) => item.provider === provider).map((item) => `${item.model_type}:${item.model_name}`));
  const counts = Object.fromEntries(TYPE_TABS.map(([key]) => [key, catalog?.models.filter((model) => key === 'all' || model.model_type === key).length ?? 0]));
  const visible = (catalog?.models ?? []).filter((model) => (type === 'all' || model.model_type === type)
    && (!freeOnly || model.is_free)
    && (!q || `${model.id} ${model.name}`.toLowerCase().includes(q.toLowerCase())));

  const save = async () => {
    if (!catalog) return;
    setBusy('import');
    try {
      const models = catalog.models.filter((model) => selected.includes(catalogKey(model))).map((model) => ({ model_name: model.id, display_name: model.name.slice(0, 120), model_type: model.model_type }));
      const saved = await apiFetch<ApiModelConfig[]>(`/models/providers/${provider}/import`, { method: 'POST', body: JSON.stringify({ ...credentials(), models }) });
      toast(`已接入 ${saved.length} 个模型，可在列表中测试连接`);
      onDone();
    } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(''); }
  };

  const fixed = !!value?.sourceModelId;
  return (
    <Drawer open={!!value} wide title={fixed ? `从 ${CATALOG_PROVIDERS[provider].name} 添加模型` : '接入模型服务商'} onClose={onClose}
      footer={<><span className="faint grow">已选 {selected.length} 个</span><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={!selected.length || busy === 'import'} onClick={() => void save()}>{busy === 'import' ? <Spinner /> : null}接入选中的模型</button></>}>
      {!fixed ? <>
        <div className="field-label">1. 选择服务商</div>
        <div className="grid c3" style={{ gap: 10, marginBottom: 14 }}>
          {(Object.keys(CATALOG_PROVIDERS) as CatalogProvider[]).map((key) => (
            <button key={key} type="button" className={`method-card ${provider === key ? 'active' : ''}`} style={{ flexDirection: 'column', alignItems: 'flex-start' }} onClick={() => { setProvider(key); setCatalog(null); setSelected([]); }}>
              <h4>{CATALOG_PROVIDERS[key].name}{existing.some((item) => item.provider === key) ? <Tag tone="green">已接入</Tag> : null}</h4><p>{CATALOG_PROVIDERS[key].desc}</p>
            </button>
          ))}
        </div>
        <div className="field-label">2. 填写 API Key<a className="hint" href={CATALOG_PROVIDERS[provider].keyUrl} target="_blank" rel="noreferrer">去获取 Key</a></div>
        <div className="row" style={{ marginBottom: 8 }}>
          <input className="input mono" type="password" autoComplete="off" placeholder={`${CATALOG_PROVIDERS[provider].name} API Key`} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          <button className="btn primary" disabled={!apiKey.trim() || busy === 'catalog'} onClick={() => void loadCatalog(provider, credentials())}>{busy === 'catalog' ? <Spinner /> : null}读取模型列表</button>
        </div>
        <details style={{ marginBottom: 14 }}><summary className="faint" style={{ cursor: 'pointer' }}>自定义 Base URL（使用代理或私有网关时填写）</summary><input className="input mono" style={{ marginTop: 6 }} placeholder="留空使用官方地址" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></details>
        <div className="field-label">3. 选择要接入的模型</div>
      </> : null}
      {busy === 'catalog' ? <Loading text="正在读取模型目录" /> : !catalog ? <p className="faint">{fixed ? '' : '填写 Key 并读取后，这里会列出该服务商的全部模型。'}</p> : <>
        <Notice tone="success">{catalog.detail}（{catalog.latency_ms}ms）</Notice>
        <div className="row wrap" style={{ margin: '12px 0', gap: 8 }}>
          <div className="seg">{TYPE_TABS.map(([key, label]) => <button key={key} className={type === key ? 'active' : ''} disabled={key !== 'all' && !counts[key]} onClick={() => setType(key)}>{label} {counts[key]}</button>)}</div>
          <label className="row faint" style={{ fontSize: 13 }}><input type="checkbox" checked={freeOnly} onChange={(event) => setFreeOnly(event.target.checked)} />只看免费</label>
          <span className="grow" />
          <div className="search-box" style={{ width: 220 }}><Search size={14} /><input className="input sm" placeholder="搜索模型" aria-label="搜索模型" value={q} onChange={(event) => setQ(event.target.value)} /></div>
        </div>
        <div className="col" style={{ gap: 6 }}>
          {visible.slice(0, 300).map((model) => {
            const key = catalogKey(model);
            const has = already.has(`${model.model_type}:${model.id}`);
            return (
              <label key={key} className="row" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', opacity: has ? 0.6 : 1 }}>
                <input type="checkbox" disabled={has} checked={selected.includes(key)} onChange={(event) => setSelected(event.target.checked ? [...selected, key] : selected.filter((item) => item !== key))} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}><strong style={{ fontSize: 13 }} className="ellipsis">{model.name}</strong><Tag>{MODEL_TYPES[model.model_type].split(' ')[0]}</Tag>{model.is_free ? <Tag tone="green">免费</Tag> : null}{has ? <Tag tone="blue">已接入</Tag> : null}</div>
                  <div className="faint mono ellipsis">{model.id}{model.context_length ? ` · ${Math.round(model.context_length / 1000)}K 上下文` : ''}{model.prompt_price ? ` · 输入 ${pricePerMillion(model.prompt_price)}` : ''}</div>
                </div>
              </label>
            );
          })}
          {visible.length > 300 ? <p className="faint">仅显示前 300 个，请用搜索缩小范围。</p> : null}
          {!visible.length ? <p className="faint">没有符合条件的模型。</p> : null}
        </div>
      </>}
    </Drawer>
  );
}

/* ------------------------------ 业务工具 ------------------------------ */

type ToolDraft = {
  id?: string; name: string; description: string; method: string; url: string; auth_type: 'none' | 'bearer' | 'api_key'; auth_header: string; secret: string;
  parameters: string; headers: string; body: string; response_path: string; side_effect: boolean; allow_private_network: boolean; timeout_seconds: number; is_enabled: boolean;
};

const emptyTool: ToolDraft = {
  name: '', description: '', method: 'GET', url: '', auth_type: 'none', auth_header: 'X-API-Key', secret: '',
  parameters: '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}', headers: '{}', body: '', response_path: '', side_effect: false, allow_private_network: false, timeout_seconds: 15, is_enabled: true,
};

function parseJson(label: string, text: string, fallback: unknown) {
  if (!text.trim()) return fallback;
  try { return JSON.parse(text) as unknown; } catch { throw new Error(`${label} 不是合法的 JSON`); }
}

function HttpToolsView() {
  const toast = useToast();
  const [items, setItems] = useState<ApiToolConfig[] | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<ToolDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ApiToolConfig | null>(null);
  const [testing, setTesting] = useState<{ tool: ApiToolConfig; args: string; result: string; busy: boolean } | null>(null);

  const load = useCallback(() => apiFetch<ApiToolConfig[]>('/tools').then((list) => { setItems(list); setError(''); }).catch((caught) => setError(errorMessage(caught))), []);
  useEffect(() => { void load(); }, [load]);

  const edit = (tool: ApiToolConfig) => setDraft({
    id: tool.id, name: tool.name, description: tool.description, method: tool.config.method ?? 'GET', url: tool.config.url ?? '', auth_type: tool.config.auth_type ?? 'none',
    auth_header: tool.config.auth_header ?? 'X-API-Key', secret: '', parameters: JSON.stringify(tool.config.parameters ?? {}, null, 2), headers: JSON.stringify(tool.config.headers ?? {}, null, 2),
    body: tool.config.body == null ? '' : JSON.stringify(tool.config.body, null, 2), response_path: tool.config.response_path ?? '', side_effect: !!tool.config.side_effect,
    allow_private_network: !!tool.config.allow_private_network, timeout_seconds: tool.config.timeout_seconds ?? 15, is_enabled: tool.is_enabled,
  });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const config = {
        method: draft.method, url: draft.url.trim(), auth_type: draft.auth_type, auth_header: draft.auth_header, response_path: draft.response_path.trim() || undefined,
        parameters: parseJson('参数 Schema', draft.parameters, {}), headers: parseJson('请求头', draft.headers, {}), body: parseJson('请求体模板', draft.body, undefined),
        side_effect: draft.side_effect, allow_private_network: draft.allow_private_network, timeout_seconds: draft.timeout_seconds,
      };
      const payload = { name: draft.name.trim(), description: draft.description.trim(), config, is_enabled: draft.is_enabled, ...(draft.secret.trim() ? { secret: draft.secret.trim() } : {}) };
      if (draft.id) await apiFetch(`/tools/${draft.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await apiFetch('/tools', { method: 'POST', body: JSON.stringify({ ...payload, kind: 'http' }) });
      toast(draft.id ? '工具已更新' : '工具已创建');
      setDraft(null);
      await load();
    } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(false); }
  };

  const runTest = async () => {
    if (!testing) return;
    setTesting({ ...testing, busy: true });
    try {
      const args = parseJson('测试参数', testing.args, {});
      const result = await apiFetch<unknown>(`/tools/${testing.tool.id}/test`, { method: 'POST', body: JSON.stringify({ arguments: args }) });
      setTesting({ ...testing, busy: false, result: JSON.stringify(result, null, 2) });
    } catch (caught) {
      setTesting({ ...testing, busy: false, result: `失败：${errorMessage(caught)}` });
    }
    void load();
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <p className="faint grow">把业务系统的 HTTP 接口接入为工具，Agent 应用可按需调用。有副作用的工具会在执行前请求用户确认。</p>
        <button className="btn primary" onClick={() => setDraft({ ...emptyTool })}><Plus size={15} />新建工具</button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!items && !error ? <Loading /> : null}
      {items && !items.length ? <Empty icon={<Wrench size={26} />} title="还没有业务工具" desc="例如：按订单号查询物流、创建售后工单。" /> : null}
      {items?.length ? (
        <table className="table">
          <thead><tr><th>工具</th><th>接口</th><th>状态</th><th>启用</th><th style={{ width: 170 }} /></tr></thead>
          <tbody>{items.map((tool) => {
            const status = STATUS[tool.connection_status] ?? { label: tool.connection_status, tone: '' };
            return (
              <tr key={tool.id}>
                <td><strong>{tool.name}</strong>{tool.config.side_effect ? <Tag tone="orange">有副作用</Tag> : null}<div className="faint clamp-2" style={{ maxWidth: 320 }}>{tool.description}</div></td>
                <td className="mono faint" style={{ maxWidth: 320 }}><div className="ellipsis">{tool.config.method ?? 'GET'} {tool.config.url}</div></td>
                <td><Tag tone={status.tone}>{status.label}</Tag>{tool.last_error ? <div className="faint clamp-2" style={{ maxWidth: 220, color: C.dangerText }}>{tool.last_error}</div> : null}</td>
                <td><Switch on={tool.is_enabled} label={`启用 ${tool.name}`} onChange={async (value) => { try { await apiFetch(`/tools/${tool.id}`, { method: 'PATCH', body: JSON.stringify({ is_enabled: value }) }); await load(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} /></td>
                <td>
                  <div className="row" style={{ gap: 2 }}>
                    <button className="btn sm" onClick={() => setTesting({ tool, args: '{}', result: '', busy: false })}><Play size={13} />测试</button>
                    <button className="btn sm ghost icon" aria-label={`编辑 ${tool.name}`} onClick={() => edit(tool)}><Pencil size={14} /></button>
                    <button className="btn sm ghost icon" aria-label={`删除 ${tool.name}`} onClick={() => setRemoving(tool)}><Trash2 size={14} /></button>
                  </div>
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      ) : null}

      <Drawer open={!!draft} wide title={draft?.id ? '编辑工具' : '新建 HTTP 工具'} onClose={() => setDraft(null)}
        footer={<><button className="btn" onClick={() => setDraft(null)}>取消</button><button className="btn primary" disabled={busy || !draft?.name.trim() || !/^https?:\/\//.test(draft?.url.trim() ?? '')} onClick={() => void save()}>{busy ? <Spinner /> : null}保存</button></>}>
        {draft ? <>
          <Field label="名称" required><input className="input" value={draft.name} placeholder="例如：查询物流" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
          <Field label="说明" hint="Agent 依据说明决定何时调用"><textarea className="textarea" style={{ minHeight: 60 }} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ width: 120 }}><Field label="方法"><select className="select" value={draft.method} onChange={(event) => setDraft({ ...draft, method: event.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((item) => <option key={item}>{item}</option>)}</select></Field></div>
            <div className="grow"><Field label="URL" required hint="可用 {参数名} 占位"><input className="input mono" value={draft.url} placeholder="https://api.example.com/orders/{order_id}" onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></Field></div>
          </div>
          <div className="form-grid">
            <Field label="鉴权"><select className="select" value={draft.auth_type} onChange={(event) => setDraft({ ...draft, auth_type: event.target.value as ToolDraft['auth_type'] })}><option value="none">无</option><option value="bearer">Bearer Token</option><option value="api_key">API Key 请求头</option></select></Field>
            {draft.auth_type === 'api_key' ? <Field label="请求头名"><input className="input mono" value={draft.auth_header} onChange={(event) => setDraft({ ...draft, auth_header: event.target.value })} /></Field> : null}
          </div>
          {draft.auth_type !== 'none' ? <Field label="密钥" hint={draft.id ? '留空保持不变' : '加密存储'}><input className="input mono" type="password" autoComplete="off" value={draft.secret} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} /></Field> : null}
          <Field label="参数 Schema" hint="JSON Schema，告诉 Agent 需要哪些参数"><textarea className="textarea mono" style={{ minHeight: 120 }} value={draft.parameters} onChange={(event) => setDraft({ ...draft, parameters: event.target.value })} /></Field>
          <div className="form-grid">
            <Field label="固定请求头" hint="JSON"><textarea className="textarea mono" style={{ minHeight: 70 }} value={draft.headers} onChange={(event) => setDraft({ ...draft, headers: event.target.value })} /></Field>
            <Field label="请求体模板" hint="JSON，可留空"><textarea className="textarea mono" style={{ minHeight: 70 }} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></Field>
          </div>
          <div className="form-grid">
            <Field label="结果提取路径" hint="如 data.items，可留空"><input className="input mono" value={draft.response_path} onChange={(event) => setDraft({ ...draft, response_path: event.target.value })} /></Field>
            <Field label="超时" hint="秒"><input className="input" type="number" min={1} max={60} value={draft.timeout_seconds} onChange={(event) => setDraft({ ...draft, timeout_seconds: Number(event.target.value) })} /></Field>
          </div>
          <div className="col" style={{ gap: 10 }}>
            <div className="row"><span className="grow">有副作用<div className="faint">会修改外部系统，如创建工单、修改订单</div></span><Switch on={draft.side_effect} label="有副作用" onChange={(value) => setDraft({ ...draft, side_effect: value })} /></div>
            <div className="row"><span className="grow">允许访问内网地址<div className="faint">仅在接口部署于内网时开启</div></span><Switch on={draft.allow_private_network} label="允许内网" onChange={(value) => setDraft({ ...draft, allow_private_network: value })} /></div>
            <div className="row"><span className="grow">启用</span><Switch on={draft.is_enabled} label="启用" onChange={(value) => setDraft({ ...draft, is_enabled: value })} /></div>
          </div>
        </> : null}
      </Drawer>

      <Drawer open={!!testing} title={`测试：${testing?.tool.name ?? ''}`} onClose={() => setTesting(null)}
        footer={<><button className="btn" onClick={() => setTesting(null)}>关闭</button><button className="btn primary" disabled={testing?.busy} onClick={() => void runTest()}>{testing?.busy ? <Spinner /> : <Play size={14} />}发送请求</button></>}>
        {testing ? <>
          {testing.tool.config.side_effect ? <Notice tone="warn">该工具有副作用，测试会真实调用外部系统。</Notice> : null}
          <Field label="调用参数" hint="JSON"><textarea className="textarea mono" style={{ minHeight: 120 }} value={testing.args} onChange={(event) => setTesting({ ...testing, args: event.target.value })} /></Field>
          {testing.result ? <Field label="结果"><div className="json-view">{testing.result}</div></Field> : null}
        </> : null}
      </Drawer>

      <ConfirmModal open={!!removing} danger title="删除工具" confirmText="删除" body={<>删除「{removing?.name}」后，引用它的 Agent 将无法再调用。</>} onClose={() => setRemoving(null)}
        onConfirm={async () => { if (!removing) return; try { await apiFetch(`/tools/${removing.id}`, { method: 'DELETE' }); toast('已删除'); await load(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} />
    </>
  );
}
