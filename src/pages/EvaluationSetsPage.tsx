import { Activity, CheckCircle2, ClipboardCheck, Pencil, Play, Plus, Search, Sparkles, ThumbsDown, ThumbsUp, Trash2, User, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { errorMessage, type ApiEvaluationCase, type ApiEvaluationRun, type ApiEvaluationSet } from '../api/client';
import { evalApi, runWithProgress, splitList, type CaseDraft } from '../api/evaluation';
import { fdeApi, type FDEApp } from '../api/fde';
import { CHANNEL_LABEL } from '../api/observability';
import { EvalDesignModal } from '../components/EvalDesignModal';
import { ConfirmModal, Drawer, Empty, Field, Loading, Modal, Notice, Spinner, Switch, Tag, formatTime, useToast } from '../components/ui';

const CASE_TYPE: Record<ApiEvaluationCase['case_type'], { label: string; tone: string; icon: typeof ThumbsUp }> = {
  good: { label: 'Good', tone: 'green', icon: ThumbsUp },
  bad: { label: 'Bad', tone: 'red', icon: ThumbsDown },
  manual: { label: '手工', tone: 'blue', icon: User },
  ai: { label: 'AI 设计', tone: 'purple', icon: Sparkles },
};

type ResultRow = ApiEvaluationRun['results'][number];

export function EvaluationSetsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('set') ?? '';
  const [sets, setSets] = useState<ApiEvaluationSet[] | null>(null);
  const [apps, setApps] = useState<FDEApp[]>([]);
  const [detail, setDetail] = useState<ApiEvaluationSet | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [designing, setDesigning] = useState(false);
  const autoRun = params.get('autorun') === '1';
  const [createForm, setCreateForm] = useState({ app_id: '', name: '', description: '' });

  const initialized = useRef(false);
  const loadList = useCallback(async () => {
    try {
      const [loaded, loadedApps] = await Promise.all([evalApi.list(), fdeApi.list()]);
      setSets(loaded);
      setApps(loadedApps);
      setCreateForm((current) => ({ ...current, app_id: current.app_id || loadedApps.find((app) => app.status !== 'archived')?.id || '' }));
      // 只在首次加载、且 URL 没有指定评测集时默认选中第一个。
      // 注意：setParams 的函数参数拿到的是创建它那次渲染的参数，后续刷新再调用会把旧参数（如 autorun）写回 URL。
      if (!initialized.current) {
        initialized.current = true;
        if (!new URLSearchParams(window.location.search).get('set') && loaded[0]) setParams({ set: loaded[0].id }, { replace: true });
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [setParams]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) { setDetail(null); return; }
    try { setDetail(await evalApi.get(selectedId)); } catch (caught) { setError(errorMessage(caught)); }
  }, [selectedId]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { void loadDetail(); }, [loadDetail]);

  const refresh = async () => { await Promise.all([loadList(), loadDetail()]); };
  const visible = (sets ?? []).filter((set) => !search || `${set.name}${set.app_name}`.includes(search));

  return (
    <div className="sub-layout">
      <aside className="sub-side" style={{ width: 300 }}>
        <div className="row" style={{ padding: '0 4px 10px' }}><strong className="grow" style={{ fontSize: 16 }}>评测集</strong><button className="btn sm" onClick={() => setCreating(true)}><Plus size={13} />新建</button><button className="btn sm primary" onClick={() => setDesigning(true)}><Sparkles size={13} />AI 设计</button></div>
        <div className="search-box" style={{ margin: '0 4px 10px' }}><Search size={14} /><input className="input sm" aria-label="搜索评测集" placeholder="搜索评测集或应用" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        {!sets ? <Loading /> : null}
        {sets && !visible.length ? <p className="faint" style={{ padding: '0 6px' }}>暂无评测集</p> : null}
        {visible.map((set) => (
          <button key={set.id} className={`sub-link ${set.id === selectedId ? 'active' : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }} onClick={() => setParams({ set: set.id })}>
            <span className="row" style={{ gap: 6 }}><span className="grow ellipsis" style={{ fontWeight: 500 }}>{set.name}</span>{set.is_release_gate ? <Tag tone="purple">门禁</Tag> : null}</span>
            <span className="faint ellipsis">{set.app_name} · {set.case_count} 条{set.needs_standard_count ? ` · ${set.needs_standard_count} 待补标准` : ''}</span>
            {set.latest_run ? <span style={{ fontSize: 12, color: set.latest_run.failed_count ? 'var(--red)' : 'var(--green)' }}>最近 {set.latest_run.passed_count}/{set.latest_run.passed_count + set.latest_run.failed_count} 通过</span> : null}
          </button>
        ))}
      </aside>
      <section className="sub-main">
        {error ? <div className="page"><Notice tone="error">{error}</Notice></div> : null}
        {sets && !sets.length ? <div className="page"><Empty icon={<ClipboardCheck size={26} />} title="还没有评测集" desc="在「可观测 → 运行 Trace」中把真实对话标记为 Good / Bad Case，或新建评测集手工编写用例。" action={<div className="row"><button className="btn" onClick={() => setCreating(true)}><Plus size={15} />手工新建</button><button className="btn primary" onClick={() => setDesigning(true)}><Sparkles size={15} />AI 设计评测集</button></div>} /></div> : null}
        {/* 切换评测集时旧详情还在：只渲染与 URL 一致的那一份，避免自动运行落到上一个评测集 */}
        {detail && detail.id === selectedId ? <SetDetail key={detail.id} set={detail} onChanged={refresh} autoRun={autoRun} onAutoRunStarted={() => setParams({ set: detail.id }, { replace: true })} /> : selectedId ? <Loading /> : null}
      </section>
      <EvalDesignModal open={designing} apps={apps} onClose={() => setDesigning(false)}
        onCreated={async (set, run) => { setDesigning(false); await loadList(); setParams(run ? { set: set.id, autorun: '1' } : { set: set.id }); }} />
      <Modal open={creating} title="新建评测集" onClose={() => setCreating(false)} footer={<><button className="btn" onClick={() => setCreating(false)}>取消</button><button className="btn primary" disabled={!createForm.app_id || !createForm.name.trim()} onClick={async () => {
        try { const set = await evalApi.create({ ...createForm, name: createForm.name.trim() }); setCreating(false); setCreateForm({ ...createForm, name: '', description: '' }); await loadList(); setParams({ set: set.id }); toast('评测集已创建'); } catch (caught) { toast(errorMessage(caught), 'error'); }
      }}>创建</button></>}>
        <Field label="绑定应用" required hint="评测集运行该应用的当前草稿"><select className="select" value={createForm.app_id} onChange={(event) => setCreateForm({ ...createForm, app_id: event.target.value })}>{apps.filter((app) => app.status !== 'archived').map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}</select></Field>
        <Field label="名称" required><input className="input" value={createForm.name} placeholder="例如：售后政策回归集" onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} /></Field>
        <Field label="说明"><textarea className="textarea" style={{ minHeight: 60 }} value={createForm.description} onChange={(event) => setCreateForm({ ...createForm, description: event.target.value })} /></Field>
      </Modal>
    </div>
  );
}

function SetDetail({ set, onChanged, autoRun, onAutoRunStarted }: { set: ApiEvaluationSet; onChanged: () => Promise<void>; autoRun?: boolean; onAutoRunStarted?: () => void }) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<ApiEvaluationRun | null>(set.latest_run);
  const [editing, setEditing] = useState<ApiEvaluationCase | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [meta, setMeta] = useState({ name: set.name, description: set.description });
  const [filter, setFilter] = useState<'all' | 'needs_standard' | 'failed'>('all');
  const cases = set.cases ?? [];
  const results = useMemo(() => Object.fromEntries((lastRun?.results ?? []).map((item) => [item.case_id, item])) as Record<string, ResultRow>, [lastRun]);
  const visible = cases.filter((item) => filter === 'all' || (filter === 'needs_standard' ? item.readiness === 'needs_standard' : results[item.id] && !results[item.id].passed));

  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const interrupted = lastRun?.status === 'running' && !running ? lastRun : null;
  const run = async (resume?: ApiEvaluationRun) => {
    setRunning(true);
    try {
      const result = await runWithProgress(set.id, (progress) => { if (alive.current) setLastRun(progress); }, { resume, shouldStop: () => !alive.current });
      if (!alive.current) return;
      if (result.status !== 'running') toast(`评测完成：${result.passed_count} 通过，${result.failed_count} 未通过`);
      await onChanged();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      if (alive.current) setRunning(false);
    }
  };
  // AI 设计完成后带 autorun 进入：自动开始运行一次
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoRun || autoStarted.current || !set.ready_count) return;
    autoStarted.current = true;
    onAutoRunStarted?.();
    void run();
  }, [autoRun, set.ready_count]);
  const progress = running && lastRun?.total_count ? { done: lastRun.done_count ?? 0, total: lastRun.total_count } : null;

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <div className="row"><h1>{set.name}</h1><button className="btn ghost sm icon" aria-label="编辑评测集信息" onClick={() => setRenaming(true)}><Pencil size={14} /></button></div>
          <p>绑定应用 <Link to={`/apps/${set.app_id}?tab=eval`}>{set.app_name}</Link>{set.description ? ` · ${set.description}` : ''}</p>
        </div>
        <label className="row faint" style={{ fontSize: 13 }}>发布门禁<Switch on={set.is_release_gate} label="发布门禁" onChange={async (value) => { try { await evalApi.update(set.id, { is_release_gate: value }); toast(value ? '已设为发布门禁：最近一次评测全部通过才能发布' : '已取消门禁'); await onChanged(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} /></label>
        <button className="btn" onClick={() => setAdding(true)}><Plus size={15} />新增 Case</button>
        <button className="btn primary" disabled={running || !set.ready_count} title={!set.ready_count ? '没有可运行的 Case' : set.needs_standard_count ? `${set.needs_standard_count} 条待补标准的 Case 不参与本次运行` : undefined} onClick={() => void run()}>{running ? <Spinner /> : <Play size={15} />}{running ? (progress ? `运行中 ${progress.done}/${progress.total}` : '运行中') : interrupted ? '重新运行' : '运行评测'}</button>
      </div>

      <div className="grid c4" style={{ marginBottom: 16 }}>
        <div className="card stat"><div className="label">Case 总数</div><div className="value">{set.case_count}</div></div>
        <div className="card stat"><div className="label">可运行</div><div className="value">{set.ready_count}</div></div>
        <div className="card stat"><div className="label">待补标准</div><div className="value" style={{ color: set.needs_standard_count ? 'var(--orange-text)' : undefined }}>{set.needs_standard_count}</div></div>
        <div className="card stat"><div className="label">{lastRun?.status === 'running' ? '本次进行中' : '最近通过率'}</div><div className="value" style={{ color: lastRun ? (lastRun.failed_count ? 'var(--red)' : 'var(--green)') : undefined }}>{lastRun ? `${Math.round((lastRun.passed_count / Math.max(1, lastRun.passed_count + lastRun.failed_count)) * 100)}%` : '—'}</div>{lastRun ? <div className="faint">{formatTime(lastRun.created_at)}{lastRun.simulated ? ' · 含测试替身' : ''}</div> : null}</div>
      </div>
      {running ? (
        <div className="card pad" style={{ marginBottom: 12 }}>
          <div className="row" style={{ marginBottom: 6 }}><Spinner size={14} /><strong className="grow">正在评测{progress ? ` ${progress.done}/${progress.total}` : ''}</strong>{lastRun ? <span className="faint">{lastRun.passed_count} 通过 · {lastRun.failed_count} 未通过</span> : null}</div>
          <div className="progress"><i style={{ width: `${progress ? (progress.done / Math.max(1, progress.total)) * 100 : 0}%` }} /></div>
          <p className="faint" style={{ marginTop: 6 }}>每条 Case 都会真实调用一次应用。离开页面会暂停，回来后可以继续。</p>
        </div>
      ) : null}
      {interrupted ? <div style={{ marginBottom: 12 }}><Notice tone="warn" title={`上次评测在 ${interrupted.done_count ?? interrupted.results.length}/${set.ready_count} 处中断`} action={<button className="btn sm primary" onClick={() => void run(interrupted)}><Play size={13} />继续运行</button>}>未完成的运行不能作为发布门禁依据。</Notice></div> : null}
      {lastRun?.matches_draft === false ? <div style={{ marginBottom: 12 }}><Notice tone="warn" title="应用草稿在最近一次评测后有改动">结果仅供参考；作为发布门禁时需要重新运行。</Notice></div> : null}
      {set.needs_standard_count ? <div style={{ marginBottom: 12 }}><Notice tone="warn" title={`${set.needs_standard_count} 条 Case 待补标准`}>Bad Case 需要填写期望输出、必须包含 / 禁止出现的关键词或引用要求后才会参与评测。运行时会跳过它们，也不计入发布门禁。</Notice></div> : null}

      <div className="row" style={{ marginBottom: 10 }}>
        <div className="seg">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button>
          <button className={filter === 'needs_standard' ? 'active' : ''} onClick={() => setFilter('needs_standard')}>待补标准</button>
          <button className={filter === 'failed' ? 'active' : ''} onClick={() => setFilter('failed')}>最近未通过</button>
        </div>
      </div>
      {!cases.length ? <Empty icon={<ClipboardCheck size={24} />} title="还没有 Case" desc="从可观测回流线上对话，或手工新增。" /> : !visible.length ? <Empty title="没有符合条件的 Case" /> : (
        <table className="table">
          <thead><tr><th>类型</th><th>Case</th><th>判定标准</th><th>状态</th><th>最近结果</th></tr></thead>
          <tbody>{visible.map((item) => {
            const type = CASE_TYPE[item.case_type];
            const result = results[item.id];
            const rules = [item.expected_keywords.length ? `包含：${item.expected_keywords.join('、')}` : '', item.forbidden_keywords.length ? `禁止：${item.forbidden_keywords.join('、')}` : '', item.require_citations ? '须有引用' : '', item.expected_output && !item.expected_keywords.length && !item.forbidden_keywords.length && item.case_type !== 'good' ? '与期望输出一致' : '', item.case_type === 'good' && !item.expected_keywords.length && !item.forbidden_keywords.length && !item.require_citations ? '应用可成功执行' : ''].filter(Boolean);
            return (
              <tr key={item.id} className="clickable" onClick={() => setEditing(item)}>
                <td><Tag tone={type.tone}><type.icon size={12} />{type.label}</Tag></td>
                <td style={{ maxWidth: 340 }}><div className="ellipsis" style={{ fontWeight: 500 }}>{item.name}</div><div className="faint ellipsis">{item.message}</div>{item.tags.length ? <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>{item.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div> : null}</td>
                <td className="faint" style={{ maxWidth: 260 }}>{rules.length ? rules.join(' · ') : '—'}</td>
                <td>{item.readiness === 'ready' ? <Tag tone="green">可运行</Tag> : <Tag tone="orange">待补标准</Tag>}</td>
                <td>{result ? (result.passed ? <Tag tone="green"><CheckCircle2 size={12} />通过</Tag> : <div><Tag tone="red"><XCircle size={12} />未通过</Tag><div className="faint clamp-2" style={{ maxWidth: 220 }}>{result.reasons.join('；')}</div></div>) : <span className="faint">—</span>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      )}

      <CaseDrawer set={set} value={editing} result={editing ? results[editing.id] : undefined} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChanged(); }} />
      <CaseModal open={adding} onClose={() => setAdding(false)} onSubmit={async (draft) => { await evalApi.createCase(set.id, draft); toast('Case 已新增'); setAdding(false); await onChanged(); }} />
      <Modal open={renaming} title="编辑评测集" onClose={() => setRenaming(false)} footer={<><button className="btn" onClick={() => setRenaming(false)}>取消</button><button className="btn primary" disabled={!meta.name.trim()} onClick={async () => { try { await evalApi.update(set.id, meta); setRenaming(false); await onChanged(); } catch (caught) { toast(errorMessage(caught), 'error'); } }}>保存</button></>}>
        <Field label="名称" required><input className="input" value={meta.name} onChange={(event) => setMeta({ ...meta, name: event.target.value })} /></Field>
        <Field label="说明"><textarea className="textarea" value={meta.description} onChange={(event) => setMeta({ ...meta, description: event.target.value })} /></Field>
      </Modal>
    </div>
  );
}

function StandardFields({ draft, setDraft, caseType }: { draft: { expected_output: string; expected_keywords: string; forbidden_keywords: string; require_citations: boolean }; setDraft: (patch: Partial<{ expected_output: string; expected_keywords: string; forbidden_keywords: string; require_citations: boolean }>) => void; caseType: ApiEvaluationCase['case_type'] }) {
  return <>
    <Field label="期望输出" hint={caseType === 'good' ? '参考答案，仅作对照' : '未设置关键词规则时要求输出与之一致'}><textarea className="textarea" style={{ minHeight: 90 }} value={draft.expected_output} onChange={(event) => setDraft({ expected_output: event.target.value })} /></Field>
    <div className="form-grid">
      <Field label="必须包含" hint="逗号或换行分隔"><textarea className="textarea" style={{ minHeight: 60 }} value={draft.expected_keywords} onChange={(event) => setDraft({ expected_keywords: event.target.value })} /></Field>
      <Field label="禁止出现" hint="逗号或换行分隔"><textarea className="textarea" style={{ minHeight: 60 }} value={draft.forbidden_keywords} onChange={(event) => setDraft({ forbidden_keywords: event.target.value })} /></Field>
    </div>
    <div className="row form-item"><span className="grow">回答必须带引用来源</span><Switch on={draft.require_citations} onChange={(value) => setDraft({ require_citations: value })} label="必须引用" /></div>
  </>;
}

function CaseDrawer({ set, value, result, onClose, onSaved }: { set: ApiEvaluationSet; value: ApiEvaluationCase | null; result?: ResultRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [draft, setDraft] = useState({ name: '', message: '', expected_output: '', expected_keywords: '', forbidden_keywords: '', require_citations: false, tags: '' });
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    if (value) setDraft({ name: value.name, message: value.message, expected_output: value.expected_output, expected_keywords: value.expected_keywords.join('\n'), forbidden_keywords: value.forbidden_keywords.join('\n'), require_citations: value.require_citations, tags: value.tags.join(', ') });
  }, [value]);
  if (!value) return null;
  const snapshot = value.source_snapshot;
  const save = async () => {
    setBusy(true);
    try {
      await evalApi.updateCase(set.id, value.id, { name: draft.name, message: draft.message, expected_output: draft.expected_output, expected_keywords: splitList(draft.expected_keywords), forbidden_keywords: splitList(draft.forbidden_keywords), require_citations: draft.require_citations, tags: splitList(draft.tags) });
      toast('Case 已保存');
      await onSaved();
    } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(false); }
  };
  return (
    <Drawer open wide title={`${CASE_TYPE[value.case_type].label} Case`} onClose={onClose}
      footer={<><button className="btn danger" onClick={() => setRemoving(true)}><Trash2 size={14} />删除</button><span className="grow" /><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !draft.message.trim()} onClick={() => void save()}>{busy ? <Spinner /> : null}保存</button></>}>
      {result ? <div style={{ marginBottom: 14 }}><Notice tone={result.passed ? 'success' : 'error'} title={result.passed ? '最近一次评测通过' : '最近一次评测未通过'}>{result.reasons.join('；')}</Notice>{result.output ? <div className="json-view" style={{ marginTop: 8 }}>{result.output}</div> : null}</div> : null}
      <Field label="名称" required><input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label="用户输入" required><textarea className="textarea" value={draft.message} onChange={(event) => setDraft({ ...draft, message: event.target.value })} /></Field>
      {Object.keys(value.input_values).length ? <Field label="业务输入"><div className="json-view">{JSON.stringify(value.input_values, null, 2)}</div></Field> : null}
      <div className="section-title" style={{ marginTop: 4 }}>判定标准{value.readiness === 'needs_standard' ? <Tag tone="orange">待补标准</Tag> : null}</div>
      <StandardFields draft={draft} setDraft={(patch) => setDraft({ ...draft, ...patch })} caseType={value.case_type} />
      <Field label="标签" hint="逗号分隔"><input className="input" value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></Field>
      {snapshot?.trace_id ? (
        <div className="card pad" style={{ background: 'var(--bg-soft)' }}>
          <div className="row" style={{ marginBottom: 8 }}><strong className="grow">来源快照</strong><Link className="btn sm" to={`/observability?view=runs&trace=${snapshot.trace_id}`}><Activity size={13} />查看原始 Trace</Link></div>
          <div className="kv" style={{ marginBottom: 8 }}>
            <dt>时间</dt><dd>{formatTime(snapshot.started_at)}</dd>
            <dt>版本 · 渠道</dt><dd>{snapshot.app_version ? `v${snapshot.app_version.version}` : '草稿'} · {CHANNEL_LABEL[snapshot.channel ?? ''] ?? snapshot.channel}</dd>
            <dt>模型</dt><dd>{snapshot.model?.model ?? '—'}</dd>
          </div>
          <div className="faint">线上实际输出</div>
          <div className="json-view">{value.actual_output || '（无输出）'}</div>
        </div>
      ) : null}
      <ConfirmModal open={removing} danger title="删除 Case" confirmText="删除" body="删除后不可恢复。" onClose={() => setRemoving(false)} onConfirm={async () => { try { await evalApi.deleteCase(set.id, value.id); toast('已删除'); await onSaved(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} />
    </Drawer>
  );
}

function CaseModal({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (draft: CaseDraft) => Promise<void> }) {
  const toast = useToast();
  const empty = { name: '', message: '', expected_output: '', expected_keywords: '', forbidden_keywords: '', require_citations: false, tags: '' };
  const [draft, setDraft] = useState(empty);
  const [busy, setBusy] = useState(false);
  const hasStandard = draft.expected_output.trim() || draft.expected_keywords.trim() || draft.forbidden_keywords.trim() || draft.require_citations;
  return (
    <Modal open={open} title="新增 Case" onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !draft.message.trim()} onClick={async () => {
      setBusy(true);
      try {
        await onSubmit({ name: draft.name.trim() || draft.message.trim().slice(0, 60), message: draft.message, expected_output: draft.expected_output, expected_keywords: splitList(draft.expected_keywords), forbidden_keywords: splitList(draft.forbidden_keywords), require_citations: draft.require_citations, tags: splitList(draft.tags) });
        setDraft(empty);
      } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(false); }
    }}>{busy ? <Spinner /> : null}新增</button></>}>
      <Field label="用户输入" required><textarea className="textarea" value={draft.message} placeholder="例如：E07 故障代码是什么意思？" onChange={(event) => setDraft({ ...draft, message: event.target.value })} /></Field>
      <Field label="名称" hint="留空使用输入前 60 字"><input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
      <StandardFields draft={draft} setDraft={(patch) => setDraft({ ...draft, ...patch })} caseType="manual" />
      <Field label="标签" hint="逗号分隔"><input className="input" value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></Field>
      {!hasStandard ? <Notice tone="warn">未填写任何判定标准时，该 Case 为「待补标准」，不能参与评测。</Notice> : null}
    </Modal>
  );
}
