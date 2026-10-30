import { AlertTriangle, ArrowLeft, CheckCircle2, Cloud, CloudOff, Play, Rocket } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiFetch, errorMessage, type ApiEvaluationSet, type ApiKnowledgeBase, type ApiModelOption, type ApiToolConfig } from '../api/client';
import { evalApi } from '../api/evaluation';
import { fdeApi, type AppManifest, type AppTemplate, type FDEApp, type ValidationIssue } from '../api/fde';
import { ChatPanel } from '../components/ChatPanel';
import { AppTile, Field, Loading, Modal, Notice, Spinner, Tag, useToast } from '../components/ui';
import { AppConfigForm } from '../editors/AppConfigForm';
import { appStatus, TYPE_META } from '../lib/apps';
import { EvalTab, LogsTab, PublishTab, VersionsTab } from './AppTabs';
import { C } from '../theme';

const TABS = [
  { key: 'edit', name: '编排' },
  { key: 'publish', name: '发布渠道' },
  { key: 'eval', name: '评测' },
  { key: 'logs', name: '运行记录' },
  { key: 'versions', name: '版本' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export function AppEditorPage() {
  const { appId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabKey) || 'edit';
  const [app, setApp] = useState<FDEApp | null>(null);
  const [manifest, setManifest] = useState<AppManifest | null>(null);
  const [resources, setResources] = useState<{ templates: AppTemplate[]; models: ApiModelOption[]; knowledge: ApiKnowledgeBase[]; tools: ApiToolConfig[] }>({ templates: [], models: [], knowledge: [], tools: [] });
  const [save, setSave] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState('');
  const [error, setError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const pending = useRef<Promise<void> | null>(null);
  const latest = useRef<AppManifest | null>(null);

  const reload = useCallback(async () => {
    const loaded = await fdeApi.get(appId);
    setApp(loaded);
    return loaded;
  }, [appId]);

  useEffect(() => {
    Promise.all([
      fdeApi.get(appId), fdeApi.templates(), apiFetch<ApiModelOption[]>('/model-options'),
      apiFetch<ApiKnowledgeBase[]>('/knowledge-bases'), apiFetch<ApiToolConfig[]>('/tools').catch(() => [] as ApiToolConfig[]),
    ]).then(([loaded, templates, models, knowledge, tools]) => {
      setApp(loaded);
      const withDefaults = { ...loaded.manifest, experience: loaded.manifest.experience ?? { opening: '', suggestions: [] } };
      setManifest(withDefaults);
      latest.current = withDefaults;
      setResources({ templates, models, knowledge, tools });
    }).catch((caught) => setError(errorMessage(caught)));
  }, [appId]);

  const persist = useCallback(async () => {
    const value = latest.current;
    if (!value) return;
    setSave('saving');
    try {
      const saved = await fdeApi.save(appId, value);
      setApp(saved);
      setSave(latest.current === value ? 'saved' : 'dirty');
      setSaveError('');
    } catch (caught) {
      setSave('error');
      setSaveError(errorMessage(caught));
      throw caught;
    }
  }, [appId]);

  // 修改后 1 秒自动保存草稿；草稿不影响线上版本
  useEffect(() => {
    if (save !== 'dirty') return undefined;
    const timer = window.setTimeout(() => { pending.current = persist().catch(() => undefined); }, 1000);
    return () => window.clearTimeout(timer);
  }, [save, manifest, persist]);

  // 离开页面时补存尚未保存的修改，并在关闭标签页前提醒
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (saveRef.current === 'dirty' || saveRef.current === 'saving') event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      if (saveRef.current === 'dirty' && latest.current) void fdeApi.save(appId, latest.current).catch(() => undefined);
    };
  }, [appId]);

  const ensureSaved = useCallback(async () => {
    if (pending.current) await pending.current;
    if (save === 'dirty' || save === 'error') await persist();
  }, [persist, save]);

  const patch = (value: Partial<AppManifest>) => {
    setManifest((current) => {
      const next = current ? { ...current, ...value } : current;
      latest.current = next;
      return next;
    });
    setSave('dirty');
  };

  if (error) return <div className="page"><Notice tone="error" title="无法加载应用">{error}</Notice></div>;
  if (!app || !manifest) return <Loading />;
  const status = appStatus(app);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="topbar editor-topbar">
        <button className="btn ghost sm icon" aria-label="返回应用列表" onClick={() => navigate('/apps')}><ArrowLeft size={16} /></button>
        <AppTile templateKey={manifest.template_key} type={manifest.type} size="sm" />
        <div className="title row editor-title" style={{ gap: 6 }}><span className="ellipsis">{manifest.name || '未命名应用'}</span><Tag tone={TYPE_META[manifest.type].tone}>{TYPE_META[manifest.type].name}</Tag></div>
        <div className="tabs editor-tabs">
          {TABS.map((item) => <button key={item.key} className={`tab ${tab === item.key ? 'active' : ''}`} onClick={() => setParams(item.key === 'edit' ? {} : { tab: item.key })}>{item.name}</button>)}
        </div>
        <span className="grow" />
        <span className="faint row editor-save" style={{ gap: 4 }} title={saveError}>
          {save === 'saving' ? <><Spinner size={13} /><span className="editor-save-text">保存中</span></> : save === 'dirty' ? <><Cloud size={13} /><span className="editor-save-text">有未保存修改</span></> : save === 'error' ? <><CloudOff size={13} color={C.danger} /><span className="editor-save-text" style={{ color: C.dangerText }}>保存失败</span></> : <><Cloud size={13} /><span className="editor-save-text">草稿已保存</span></>}
        </span>
        <Tag tone={status.tone}>{status.label}</Tag>
        <button className="btn" disabled={!app.is_enabled || !app.published_version_id} onClick={() => navigate(`/chat/${app.id}`)}><Play size={14} />使用线上版</button>
        <button className="btn primary" onClick={async () => { try { await ensureSaved(); setPublishing(true); } catch { toast('请先修正草稿保存错误', 'error'); } }}><Rocket size={14} />发布</button>
      </div>
      {save === 'error' ? <div style={{ padding: '8px 16px' }}><Notice tone="error" title="草稿保存失败">{saveError}</Notice></div> : null}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: tab === 'edit' ? 'hidden' : 'auto' }}>
        {/* 编排区常驻挂载：切换到其他 Tab 再回来，调试对话不会丢失 */}
        <div style={{ flex: 1, display: tab === 'edit' ? 'flex' : 'none', minHeight: 0, flexWrap: 'wrap' }}>
          <div style={{ width: 560, maxWidth: '100%', flex: 'none', overflow: 'auto', padding: '4px 24px 24px', borderRight: '1px solid var(--border)', maxHeight: '100%' }}>
            <AppConfigForm manifest={manifest} patch={patch} {...resources} />
          </div>
          <div className="grow" style={{ display: 'flex', flexDirection: 'column', minWidth: 320, background: 'var(--bg-soft)', minHeight: 0, height: '100%' }}>
            <ChatPanel key={manifest.type} appId={app.id} manifest={manifest} mode="debug" beforeSend={ensureSaved}
              title={<><strong>调试预览</strong><Tag tone="orange">草稿</Tag><span className="faint">运行记录进入可观测 · 渠道「调试」</span></>} />
          </div>
          </div>
        {tab === 'publish' ? <PublishTab app={app} onChanged={() => void reload()} /> : null}
        {tab === 'eval' ? <EvalTab app={app} /> : null}
        {tab === 'logs' ? <LogsTab app={app} /> : null}
        {tab === 'versions' ? <VersionsTab app={app} onChanged={() => void reload()} /> : null}
      </div>

      <PublishModal open={publishing} app={app} onClose={() => setPublishing(false)} onPublished={async () => { setPublishing(false); await reload(); }} />
    </div>
  );
}

function PublishModal({ open, app, onClose, onPublished }: { open: boolean; app: FDEApp; onClose: () => void; onPublished: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [gates, setGates] = useState<ApiEvaluationSet[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIssues(null);
    setNotes('');
    Promise.all([fdeApi.validate(app.id), evalApi.list(app.id)])
      .then(([validation, sets]) => { setIssues(validation.issues); setGates(sets.filter((item) => item.is_release_gate)); })
      .catch((caught) => toast(errorMessage(caught), 'error'));
  }, [open, app.id, toast]);

  const errors = issues?.filter((item) => item.severity === 'error') ?? [];
  const warnings = issues?.filter((item) => item.severity === 'warning') ?? [];
  const gatePassed = (set: ApiEvaluationSet) => !!set.latest_run && !set.latest_run.failed_count && set.latest_run.passed_count >= set.ready_count && set.latest_run.matches_draft !== false;
  const gateBlocked = gates.some((set) => !gatePassed(set));
  const nextVersion = (app.versions[0]?.version ?? 0) + 1;

  const publish = async () => {
    setBusy(true);
    try {
      const released = await fdeApi.release(app.id, notes.trim());
      toast(`已发布 v${released.published_version?.version ?? ''}，工作台与各渠道即时生效`);
      onPublished();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={`发布 v${nextVersion}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !issues || errors.length > 0 || gateBlocked || !notes.trim()} onClick={() => void publish()}>{busy ? <Spinner /> : <Rocket size={14} />}创建版本并发布</button></>}>
      {!issues ? <Loading text="正在校验" /> : <>
        <div className="section-title" style={{ marginTop: 0 }}>1. 配置校验</div>
        {errors.length ? <Notice tone="error" title={`${errors.length} 个问题必须修复`}><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{errors.map((item) => <li key={item.path + item.code}>{item.message}</li>)}</ul></Notice> : <Notice tone="success">校验通过</Notice>}
        {warnings.length ? <div style={{ marginTop: 8 }}><Notice tone="warn" title="建议处理"><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{warnings.map((item) => <li key={item.path + item.code}>{item.message}</li>)}</ul></Notice></div> : null}

        <div className="section-title">2. 质量门禁</div>
        {!gates.length ? <Notice tone="info" title="未设置发布门禁" action={<button className="btn sm" onClick={() => { onClose(); navigate(`/apps/${app.id}?tab=eval`); }}>去设置</button>}>建议把一个评测集设为门禁，发布前自动要求全部通过。</Notice> : gates.map((set) => {
          const run = set.latest_run;
          const passed = gatePassed(set);
          const stale = run && run.matches_draft === false;
          return (
            <div key={set.id} className="row" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
              {passed ? <CheckCircle2 size={16} color={C.success} /> : <AlertTriangle size={16} color={C.warning} />}
              <span className="grow">{set.name}<span className="faint"> · {!run ? '尚未运行' : stale ? '草稿已修改，需重新运行' : `最近 ${run.passed_count}/${set.ready_count} 通过${set.needs_standard_count ? `（${set.needs_standard_count} 条待补标准未计入）` : ''}`}</span></span>
              {!passed ? <button className="btn sm" onClick={() => navigate(`/evaluation-sets?set=${set.id}`)}>去运行</button> : null}
            </div>
          );
        })}

        <div className="section-title">3. 版本说明</div>
        <Field label="本次改了什么" required><textarea className="textarea" style={{ minHeight: 70 }} value={notes} placeholder="例如：新增订单查询工具；竞品比价转人工" onChange={(event) => setNotes(event.target.value)} /></Field>
        <p className="faint">发布会把当前草稿固化为不可变版本 v{nextVersion}，可随时回滚；草稿与最新版本相同时直接发布该版本。</p>
      </>}
    </Modal>
  );
}
