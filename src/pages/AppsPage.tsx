import { Archive, ArchiveRestore, Bot, Copy, LayoutTemplate, MessageSquare, MoreHorizontal, Play, Plus, Search, Sparkles, Trash2, Wand2, Workflow } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch, errorMessage, type ApiModelOption } from '../api/client';
import { fdeApi, type AppManifest, type AppTemplate, type FDEApp } from '../api/fde';
import { AppTile, ConfirmModal, Empty, Field, Loading, Modal, Notice, Spinner, Tag, formatTime, useToast } from '../components/ui';
import { useAuth } from '../auth';
import { appStatus, blankManifest, defaultLlm, manifestFromTemplate, sceneOf, SCENES, TYPE_META, type AppType } from '../lib/apps';

const TYPE_ICON: Record<AppType, ReactNode> = {
  simple: <MessageSquare size={18} />,
  agent: <Bot size={18} />,
  chatflow: <Workflow size={18} />,
};

function CreateModal({ open, onClose, templates, options }: { open: boolean; onClose: () => void; templates: AppTemplate[]; options: ApiModelOption[] }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState<'template' | 'blank' | 'ai'>('template');
  const [type, setType] = useState<AppType>('agent');
  const [templateKey, setTemplateKey] = useState('customer_service');
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [plan, setPlan] = useState<AppManifest | null>(null);
  const [busy, setBusy] = useState(false);
  const { me } = useAuth();
  const llm = defaultLlm(options);

  // 每次打开都从干净状态开始
  useEffect(() => {
    if (!open) return;
    setMode('template'); setType('agent'); setTemplateKey('customer_service'); setName(''); setBrief(''); setPlan(null);
  }, [open]);

  const create = async (manifest: AppManifest) => {
    setBusy(true);
    try {
      const app = await fdeApi.create(manifest);
      toast(`已创建「${app.name}」`);
      navigate(`/apps/${app.id}`);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  };

  const template = templates.find((item) => item.key === templateKey) ?? templates[0];
  const design = async () => {
    if (!template) return;
    setBusy(true);
    try {
      const result = await fdeApi.design({ brief, template_key: template.key, llm_model_id: llm?.id ?? null });
      setPlan({ ...manifestFromTemplate(template, type, llm?.id ?? null), ...result.manifest, type, schema_version: 'fde.app/v2', agent: { max_steps: 8, require_confirmation_for_side_effects: true, show_tool_steps: true, long_term_memory: false, knowledge_mode: 'tool' }, experience: result.manifest.experience ?? { opening: '', suggestions: [] }, input_fields: type === 'agent' ? [] : result.manifest.input_fields });
      if (result.simulated) toast('当前使用测试替身生成，方案仅供参考');
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  };

  const footer = mode === 'ai'
    ? <><button className="btn" onClick={onClose}>取消</button>{plan ? <button className="btn primary" disabled={busy} onClick={() => void create(plan)}>{busy ? <Spinner /> : null}按此方案创建</button> : <button className="btn primary" disabled={busy || brief.trim().length < 8} onClick={() => void design()}>{busy ? <Spinner /> : <Wand2 size={15} />}生成方案</button>}</>
    : <><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !template} onClick={() => {
      const manifest = mode === 'blank' ? blankManifest(templates, type, llm?.id ?? null, name.trim() || `未命名${TYPE_META[type].name}`) : template ? manifestFromTemplate(template, type, llm?.id ?? null, name || undefined) : null;
      if (manifest) void create(manifest);
    }}>{busy ? <Spinner /> : null}创建</button></>;

  return (
    <Modal open={open} title="新建应用" onClose={onClose} wide footer={footer}>
      <div className="seg" style={{ marginBottom: 18 }}>
        <button className={mode === 'template' ? 'active' : ''} onClick={() => setMode('template')}><LayoutTemplate size={14} />从业务模板</button>
        <button className={mode === 'blank' ? 'active' : ''} onClick={() => setMode('blank')}><Plus size={14} />空白应用</button>
        <button className={mode === 'ai' ? 'active' : ''} disabled={type === 'chatflow'} title={type === 'chatflow' ? 'Chat Flow 请从业务模板或空白流程开始' : undefined} onClick={() => { setMode('ai'); setPlan(null); }}><Sparkles size={14} />AI 帮我搭建</button>
      </div>
      {!llm ? <div style={{ marginBottom: 12 }}><Notice tone="warn" title="还没有可用的对话模型" action={me?.role === 'admin' ? <Link className="btn sm" to="/tools?tab=models">去接入</Link> : undefined}>{me?.role === 'admin' ? '先接入一个 LLM，应用创建后也可再选择。' : '请联系管理员在「集成 → 模型」接入 LLM，应用创建后也可再选择。'}</Notice></div> : null}

      <Field label="应用类型" required>
        <div className="grid c3" style={{ gap: 10 }}>
          {(['simple', 'agent', 'chatflow'] as const).map((key) => (
            <button key={key} type="button" className={`method-card ${type === key ? 'active' : ''}`} style={{ flexDirection: 'column' }} onClick={() => { setType(key); setPlan(null); if (key === 'chatflow' && mode === 'ai') setMode('template'); }}>
              <div className="row" style={{ color: 'var(--primary)' }}>{TYPE_ICON[key]}<h4 style={{ color: 'var(--text-1)' }}>{TYPE_META[key].name}</h4></div>
              <p>{TYPE_META[key].desc}</p>
              <p style={{ marginTop: 4, color: 'var(--text-2)' }}>例：{TYPE_META[key].examples}</p>
            </button>
          ))}
        </div>
      </Field>

      {mode !== 'blank' ? (
        <Field label="业务场景模板">
          <div className="grid c2" style={{ gap: 10 }}>
            {templates.map((item) => (
              <button key={item.key} type="button" className={`method-card ${templateKey === item.key ? 'active' : ''}`} onClick={() => { setTemplateKey(item.key); setPlan(null); }}>
                <AppTile templateKey={item.key} />
                <div className="grow"><h4>{item.name}{item.knowledge_bases.required ? <Tag>需知识库</Tag> : null}</h4><p>{item.description}</p></div>
              </button>
            ))}
          </div>
        </Field>
      ) : null}

      {mode !== 'ai' ? <Field label="应用名称"><input className="input" value={name} placeholder={mode === 'template' ? template?.name : '例如：售后客服助手'} onChange={(event) => setName(event.target.value)} /></Field> : null}

      {mode === 'ai' ? <>
        <Field label="描述业务需求" hint="谁用、做什么、依据哪些资料、需要哪些系统">
          <textarea className="textarea" style={{ minHeight: 100 }} value={brief} placeholder="例如：客服部门需要一个售后助手，回答保修和退换货政策，按订单号查物流，涉及赔偿或投诉转人工。" onChange={(event) => { setBrief(event.target.value); setPlan(null); }} />
        </Field>
        {plan ? (
          <div className="card pad" style={{ background: 'var(--bg-soft)' }}>
            <div className="row" style={{ marginBottom: 8 }}><Sparkles size={16} color="var(--purple)" /><strong>{plan.name}</strong><Tag tone={TYPE_META[plan.type].tone}>{TYPE_META[plan.type].name}</Tag></div>
            <p className="muted" style={{ fontSize: 13 }}>{plan.description}</p>
            <div className="json-view" style={{ marginTop: 8, maxHeight: 160 }}>{plan.system_prompt}</div>
            <p className="faint" style={{ marginTop: 8 }}>创建后在编排页关联知识库、工具并调试。</p>
          </div>
        ) : null}
      </> : null}
    </Modal>
  );
}

function AppMenu({ app, onAction }: { app: FDEApp; onAction: (action: 'duplicate' | 'archive' | 'restore' | 'delete') => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }} onClick={(event) => event.stopPropagation()}>
      <button className="btn ghost sm icon" aria-label={`${app.name} 更多操作`} onClick={() => setOpen(!open)}><MoreHorizontal size={16} /></button>
      {open ? (
        <div className="card" role="menu" style={{ position: 'absolute', right: 0, top: 30, zIndex: 20, padding: 6, width: 140, boxShadow: 'var(--shadow-lg)' }}>
          <button className="sub-link" role="menuitem" onClick={() => { setOpen(false); onAction('duplicate'); }}><Copy size={14} />复制</button>
          {app.status === 'archived'
            ? <button className="sub-link" role="menuitem" onClick={() => { setOpen(false); onAction('restore'); }}><ArchiveRestore size={14} />恢复</button>
            : <button className="sub-link" role="menuitem" onClick={() => { setOpen(false); onAction('archive'); }}><Archive size={14} />归档</button>}
          <button className="sub-link" role="menuitem" style={{ color: 'var(--red)' }} onClick={() => { setOpen(false); onAction('delete'); }}><Trash2 size={14} />删除</button>
        </div>
      ) : null}
    </div>
  );
}

export function AppsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [apps, setApps] = useState<FDEApp[] | null>(null);
  const [templates, setTemplates] = useState<AppTemplate[]>([]);
  const [options, setOptions] = useState<ApiModelOption[]>([]);
  const [error, setError] = useState('');
  const [type, setType] = useState<AppType | 'all'>('all');
  const [scene, setScene] = useState('all');
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<FDEApp | null>(null);

  const load = useCallback(async () => {
    try {
      const [loadedApps, loadedTemplates, loadedOptions] = await Promise.all([fdeApi.list(), fdeApi.templates(), apiFetch<ApiModelOption[]>('/model-options')]);
      setApps(loadedApps);
      setTemplates(loadedTemplates);
      setOptions(loadedOptions);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (params.get('create')) { setCreating(true); setParams({}, { replace: true }); } }, [params, setParams]);

  const act = async (app: FDEApp, action: 'duplicate' | 'archive' | 'restore' | 'delete') => {
    if (action === 'delete') { setDeleting(app); return; }
    try {
      if (action === 'duplicate') { const copy = await fdeApi.duplicate(app.id); toast(`已复制为「${copy.name}」`); }
      if (action === 'archive') { await fdeApi.archive(app.id); toast('已归档，线上服务已停止'); }
      if (action === 'restore') { await fdeApi.restore(app.id); toast('已恢复为草稿'); }
      await load();
    } catch (caught) { toast(errorMessage(caught), 'error'); }
  };

  const list = (apps ?? []).filter((app) => (showArchived ? app.status === 'archived' : app.status !== 'archived')
    && (type === 'all' || app.manifest.type === type)
    && (scene === 'all' || app.manifest.template_key === scene)
    && (!q || `${app.name}${app.description}`.includes(q)));

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1>应用</h1><p>搭建、调试和发布 AI 应用。发布后出现在业务人员的工作台。</p></div>
        <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} />新建应用</button>
      </div>
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <div className="seg">
          <button className={type === 'all' ? 'active' : ''} onClick={() => setType('all')}>全部</button>
          {(['simple', 'agent', 'chatflow'] as const).map((key) => <button key={key} className={type === key ? 'active' : ''} onClick={() => setType(key)}>{TYPE_ICON[key]}{TYPE_META[key].name}</button>)}
        </div>
        <select className="select sm" style={{ width: 150 }} aria-label="业务场景" value={scene} onChange={(event) => setScene(event.target.value)}>
          <option value="all">全部场景</option>{Object.entries(SCENES).map(([key, item]) => <option key={key} value={key}>{item.name}</option>)}
        </select>
        <label className="row faint" style={{ fontSize: 13 }}><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />查看已归档</label>
        <span className="grow" />
        <div className="search-box" style={{ width: 240 }}><Search size={15} /><input className="input sm" aria-label="搜索应用" placeholder="搜索应用" value={q} onChange={(event) => setQ(event.target.value)} /></div>
      </div>
      {error ? <Notice tone="error" title="无法加载应用">{error}</Notice> : null}
      {!apps && !error ? <Loading /> : null}
      {apps && !list.length ? <Empty icon={<Bot size={26} />} title={apps.length ? '没有符合条件的应用' : '还没有应用'} desc="从业务模板开始，几分钟搭出第一个可用的 Agent。" action={<button className="btn primary" onClick={() => setCreating(true)}><Plus size={15} />新建应用</button>} /> : null}
      <div className="grid auto">
        {list.map((app) => {
          const status = appStatus(app);
          const scn = sceneOf(app.manifest.template_key);
          return (
            <article key={app.id} className="card pad hover" onClick={() => navigate(`/apps/${app.id}`)}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <AppTile templateKey={app.manifest.template_key} type={app.manifest.type} size="lg" />
                <div className="grow" style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 15 }} className="ellipsis">{app.name}</strong>
                  <div className="row" style={{ marginTop: 4 }}><Tag tone={TYPE_META[app.manifest.type].tone}>{TYPE_META[app.manifest.type].name}</Tag><Tag tone={status.tone}><span className="dot" />{status.label}</Tag></div>
                </div>
                <AppMenu app={app} onAction={(action) => void act(app, action)} />
              </div>
              <p className="muted clamp-2" style={{ fontSize: 13, margin: '10px 0 12px', minHeight: 42 }}>{app.description || '暂无描述'}</p>
              <div className="row faint" style={{ gap: 12 }}>
                <span className="dot" style={{ color: scn.color }} /><span>{scn.name}</span>
                <span>{app.manifest.knowledge_base_ids.length} 个知识库</span>
                {app.manifest.type === 'agent' ? <span>{app.manifest.tools.filter((tool) => tool.tool_id).length} 个工具</span> : null}
                <span className="grow" />
                <span>{app.conversation_count ?? 0} 个会话 · {formatTime(app.updated_at)}</span>
              </div>
              <div className="divider" style={{ margin: '12px 0 10px' }} />
              <div className="row" onClick={(event) => event.stopPropagation()}>
                <button className="btn sm" onClick={() => navigate(`/apps/${app.id}`)}>编排</button>
                <button className="btn sm ghost" disabled={!app.is_enabled || !app.published_version_id} onClick={() => navigate(`/chat/${app.id}`)}><Play size={13} />使用线上版</button>
              </div>
            </article>
          );
        })}
      </div>
      <CreateModal open={creating} onClose={() => setCreating(false)} templates={templates} options={options} />
      <ConfirmModal open={!!deleting} danger title="删除应用" confirmText="永久删除" body={<>删除「{deleting?.name}」及其版本、会话和评测集，此操作不可恢复。建议优先使用归档。</>} onClose={() => setDeleting(null)}
        onConfirm={async () => { if (!deleting) return; try { await fdeApi.delete(deleting.id); toast('应用已删除'); await load(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} />
    </div>
  );
}
