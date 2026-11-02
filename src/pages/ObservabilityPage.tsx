import {
  Activity, AlertTriangle, ArrowRight, Bot, BookOpen, CheckCircle2, ChevronDown, ChevronRight, CircleDollarSign, Database, FileText, Gauge,
  Headset, Layers3, MessageSquareText, RefreshCw, Search, ShieldAlert, Sparkles, ThumbsDown, ThumbsUp, Wrench, XCircle, type LucideIcon, Workflow } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiFetch, errorMessage, type ApiKnowledgeBase } from '../api/client';
import { fdeApi, type FDEApp } from '../api/fde';
import {
  CHANNEL_LABEL, obsApi, type BuildJob, type ConversationDetail, type ConversationItem, type Overview, type RunDetail, type RunItem, type Span, type Usage,
} from '../api/observability';
import { CaseReturnModal, type CaseReturn } from '../components/CaseReturnModal';
import { Markdown } from '../components/Markdown';
import { Drawer, Empty, Loading, Notice, Spinner, Tag, formatCost, formatDuration, formatTime, formatTokens, useToast } from '../components/ui';
import { FILE_STATUS, METHOD_LABEL, STAGE_LABEL, ACTIVE_STATUSES, type ChunkMethod } from '../lib/knowledge';
import { C } from '../theme';

type ViewKey = 'overview' | 'runs' | 'conversations' | 'builds' | 'usage';

const VIEWS: Array<{ key: ViewKey; name: string; icon: LucideIcon }> = [
  { key: 'overview', name: '总览', icon: Activity },
  { key: 'runs', name: '运行 Trace', icon: Bot },
  { key: 'conversations', name: '对话日志', icon: MessageSquareText },
  { key: 'builds', name: '知识构建', icon: Database },
  { key: 'usage', name: '用量与费用', icon: CircleDollarSign },
];

const SPAN_META: Record<string, { label: string; icon: LucideIcon; color: string }> = {
  context: { label: '上下文', icon: Layers3, color: C.slate },
  retrieval: { label: '知识检索', icon: BookOpen, color: C.success },
  model: { label: '模型', icon: Sparkles, color: C.violet },
  tool: { label: '工具', icon: Wrench, color: C.primary },
  handoff: { label: '转人工', icon: Headset, color: C.warning },
  guardrail: { label: '护栏', icon: ShieldAlert, color: C.rose },
  harness: { label: 'Harness', icon: ShieldAlert, color: C.danger },
  error: { label: '错误', icon: XCircle, color: C.danger },
  flow: { label: '流程节点', icon: Workflow, color: C.slate },
};

function RunStatus({ status, handoff }: { status: string; handoff?: boolean }) {
  return <>{status === 'success' ? <Tag tone="green"><span className="dot" />成功</Tag> : status === 'failed' ? <Tag tone="red"><span className="dot" />失败</Tag> : <Tag tone="blue"><span className="dot" />运行中</Tag>}{handoff ? <Tag tone="orange">转人工</Tag> : null}</>;
}

export function ObservabilityPage() {
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.some((item) => item.key === params.get('view')) ? params.get('view') : 'overview') as ViewKey;
  const traceId = params.get('trace');
  const [days, setDays] = useState(7);
  const appId = params.get('app') ?? '';
  const [apps, setApps] = useState<FDEApp[]>([]);
  const [caseReturn, setCaseReturn] = useState<CaseReturn | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => { fdeApi.list().then(setApps).catch(() => undefined); }, []);
  // 都用函数式更新，避免连续两次 setParams 时后一次用旧参数覆盖前一次
  const update = (change: (next: URLSearchParams) => void) => setParams((current) => { const next = new URLSearchParams(current); change(next); return next; });
  const setView = (view: ViewKey) => setParams(() => { const next = new URLSearchParams(); if (view !== 'overview') next.set('view', view); if (appId) next.set('app', appId); return next; });
  const setAppId = (id: string) => update((next) => { if (id) next.set('app', id); else next.delete('app'); });
  const openTrace = (id: string) => update((next) => { next.set('trace', id); next.delete('conversation'); });
  const closeTrace = () => update((next) => next.delete('trace'));

  return (
    <div className="observability-layout">
      <header className="observability-head">
        <div className="grow">
          <h1>可观测</h1>
          <p>从业务异常下钻到单次 Trace，定位知识构建、模型、工具、上下文和费用问题。</p>
        </div>
        {view !== 'builds' ? <select className="select sm" style={{ width: 180 }} aria-label="应用" value={appId} onChange={(event) => setAppId(event.target.value)}><option value="">全部应用</option>{apps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}</select> : null}
        {view === 'overview' || view === 'usage' ? <select className="select sm" style={{ width: 130 }} aria-label="时间范围" value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>最近 24 小时</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option></select> : null}
        <button className="btn sm" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={14} />刷新</button>
      </header>
      <nav className="observability-tabs" aria-label="可观测视图">
        {VIEWS.map(({ key, name, icon: Icon }) => <button key={key} className={view === key ? 'active' : ''} onClick={() => setView(key)}><Icon size={15} />{name}</button>)}
      </nav>
      <div className="observability-content" key={refreshKey}>
        {view === 'overview' ? <OverviewView days={days} appId={appId} onTrace={openTrace} setView={setView} /> : null}
        {view === 'runs' ? <RunsView appId={appId} onTrace={openTrace} onReturn={setCaseReturn} /> : null}
        {view === 'conversations' ? <ConversationsView appId={appId} onTrace={openTrace} /> : null}
        {view === 'builds' ? <BuildsView /> : null}
        {view === 'usage' ? <UsageView days={days} appId={appId} /> : null}
      </div>
      <TraceDrawer traceId={traceId} onClose={closeTrace} onReturn={setCaseReturn} />
      <CaseReturnModal value={caseReturn} onClose={() => setCaseReturn(null)} />
    </div>
  );
}

/* ------------------------------ 总览 ------------------------------ */

function OverviewView({ days, appId, onTrace, setView }: { days: number; appId: string; onTrace: (id: string) => void; setView: (view: ViewKey) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { setData(null); setError(''); obsApi.overview({ days, app_id: appId }).then(setData).catch((caught) => setError(errorMessage(caught))); }, [days, appId]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Loading />;
  const max = Math.max(1, ...data.daily.map((item) => item.runs));
  const rate = data.runs.success_rate;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid observability-stats">
        {[
          { icon: CheckCircle2, label: '运行成功率', value: rate == null ? '—' : `${rate}%`, meta: `${data.runs.total} 次运行`, tone: rate == null || rate >= 98 ? 'ok' : rate >= 90 ? 'warn' : 'bad' },
          { icon: Gauge, label: 'P95 延迟', value: formatDuration(data.runs.p95_ms), meta: `P50 ${formatDuration(data.runs.p50_ms)}`, tone: (data.runs.p95_ms ?? 0) < 8000 ? 'ok' : 'warn' },
          { icon: AlertTriangle, label: '失败运行', value: String(data.runs.failed), meta: `转人工 ${data.runs.handoff} 次`, tone: data.runs.failed ? 'bad' : 'ok' },
          { icon: CircleDollarSign, label: '估算费用', value: formatCost(data.cost.total), meta: data.cost.unpriced_runs ? `${data.cost.unpriced_runs} 次未计价` : `${formatTokens(data.tokens.total)} tokens`, tone: data.cost.unpriced_runs ? 'warn' : 'ok' },
          { icon: Layers3, label: '知识构建', value: `${data.builds.completed}/${data.builds.total}`, meta: data.builds.failed ? `${data.builds.failed} 个失败` : data.builds.running ? `${data.builds.running} 个进行中` : '无异常', tone: data.builds.failed ? 'bad' : 'ok' },
        ].map(({ icon: Icon, label, value, meta, tone }) => (
          <div className="card stat" key={label}><div className="label"><Icon size={15} />{label}</div><div className="value">{value}</div><div className={`observability-meta ${tone}`}>{meta}</div></div>
        ))}
      </div>
      <div className="grid observability-main-grid">
        <section className="card pad">
          <div className="row section-row"><div><strong>每日运行</strong><div className="faint">失败次数以红色显示</div></div><span className="grow" /><span className="faint">好评 {data.feedback.up} · 差评 {data.feedback.down}</span></div>
          <div className="bar-chart" style={{ height: 150, marginBottom: 26, gap: 8 }}>
            {data.daily.map((item) => (
              <div key={item.date} style={{ height: `${Math.max(2, (item.runs / max) * 100)}%`, background: item.failed ? `linear-gradient(to top, ${C.danger} ${(item.failed / Math.max(1, item.runs)) * 100}%, var(--primary-100) 0)` : undefined }} title={`${item.date}：${item.runs} 次，失败 ${item.failed}，${formatTokens(item.tokens)} tokens`}>
                <span>{item.date.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="card pad">
          <div className="row section-row"><div><strong>需要处理</strong><div className="faint">最近失败的运行</div></div><span className="grow" /><button className="btn sm ghost" onClick={() => setView('runs')}>全部<ArrowRight size={13} /></button></div>
          {!data.recent_failures.length ? <Empty icon={<CheckCircle2 size={22} color={C.success} />} title="没有失败运行" /> : data.recent_failures.map((item) => (
            <button key={item.trace_id} className="incident-row high" onClick={() => onTrace(item.trace_id)}>
              <span className="incident-icon"><XCircle size={17} /></span>
              <span className="grow" style={{ minWidth: 0 }}><strong className="ellipsis">{item.query}</strong><small className="clamp-2">{item.error_message}</small></span>
              <span><Tag>{CHANNEL_LABEL[item.channel] ?? item.channel}</Tag><small>{formatTime(item.started_at)}</small></span><ChevronRight size={16} />
            </button>
          ))}
        </section>
      </div>
      <section className="card pad">
        <div className="row section-row"><strong className="grow">应用运行排行</strong></div>
        {!data.top_apps.length ? <p className="faint">该时间段还没有运行。</p> : (
          <table className="table"><thead><tr><th>应用</th><th>运行次数</th><th>失败</th><th>失败率</th></tr></thead>
            <tbody>{data.top_apps.map((item) => <tr key={item.app_id}><td><Link to={`/apps/${item.app_id}?tab=logs`}>{item.app_name}</Link></td><td>{item.runs}</td><td>{item.failed}</td><td><Tag tone={item.failed ? 'red' : 'green'}>{((item.failed / item.runs) * 100).toFixed(1)}%</Tag></td></tr>)}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/* ------------------------------ 运行 ------------------------------ */

const PAGE = 30;

function RunsView({ appId, onTrace, onReturn }: { appId: string; onTrace: (id: string) => void; onReturn: (value: CaseReturn) => void }) {
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; items: RunItem[] } | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<RunItem[]>([]);

  useEffect(() => { setOffset(0); setSelected([]); }, [appId, status, channel, query]);
  useEffect(() => {
    setData(null);
    setError('');
    obsApi.runs({ app_id: appId, status, channel, search: query, limit: PAGE, offset }).then(setData).catch((caught) => setError(errorMessage(caught)));
  }, [appId, status, channel, query, offset]);

  const toggle = (run: RunItem) => setSelected((current) => (current.some((item) => item.trace_id === run.trace_id) ? current.filter((item) => item.trace_id !== run.trace_id) : [...current, run]));
  const sameApp = selected.length > 0 && selected.every((item) => item.app_id === selected[0].app_id);

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="view-title"><div><h2>运行 Trace</h2><p>每次输入到输出的完整调用链：上下文、模型推理、知识检索、工具与护栏。</p></div></div>
      <div className="row filter-bar wrap">
        <div className="seg">{[['', '全部'], ['success', '成功'], ['failed', '失败']].map(([key, label]) => <button key={key} className={status === key ? 'active' : ''} onClick={() => setStatus(key)}>{label}</button>)}</div>
        <select className="select sm" style={{ width: 130 }} aria-label="渠道" value={channel} onChange={(event) => setChannel(event.target.value)}><option value="">全部渠道</option>{Object.entries(CHANNEL_LABEL).filter(([key]) => key !== 'evaluation').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <span className="grow" />
        <form className="search-box" style={{ width: 260 }} onSubmit={(event) => { event.preventDefault(); setQuery(search); }}><Search size={15} /><input className="input sm" aria-label="搜索运行" placeholder="搜索输入、错误或 Trace ID，回车" value={search} onChange={(event) => setSearch(event.target.value)} /></form>
      </div>
      {selected.length ? (
        <div className="eval-batch-bar">
          <span>已选择 <strong>{selected.length}</strong> 条运行{sameApp ? '' : '（需来自同一应用才能回流）'}</span>
          <button className="btn sm" disabled={!sameApp} onClick={() => onReturn({ traceIds: selected.map((item) => item.trace_id), appId: selected[0].app_id!, appName: selected[0].app_name, type: 'good' })}><ThumbsUp size={13} />标记 Good Case</button>
          <button className="btn sm primary" disabled={!sameApp} onClick={() => onReturn({ traceIds: selected.map((item) => item.trace_id), appId: selected[0].app_id!, appName: selected[0].app_name, type: 'bad' })}><ThumbsDown size={13} />标记 Bad Case</button>
          <button className="btn sm ghost" onClick={() => setSelected([])}>取消</button>
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!data && !error ? <Loading /> : null}
      {data && !data.items.length ? <Empty icon={<Bot size={24} />} title="没有符合条件的运行" desc="在应用编排页调试或用户使用后，运行会出现在这里。" /> : null}
      {data && data.items.length ? (
        <div className="card table-card table-scroll">
          <table className="table observability-table">
            <thead><tr><th style={{ width: 32 }} /><th>输入</th><th>应用</th><th>状态</th><th>步骤</th><th>耗时</th><th>Tokens</th><th>费用</th><th>反馈</th><th>时间</th></tr></thead>
            <tbody>{data.items.map((run) => (
              <tr key={run.trace_id} className="clickable" onClick={() => onTrace(run.trace_id)}>
                <td onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`选择 ${run.query}`} disabled={!run.app_id} checked={selected.some((item) => item.trace_id === run.trace_id)} onChange={() => toggle(run)} /></td>
                <td><div className="trace-primary ellipsis">{run.query}</div>{run.error_message ? <div className="faint ellipsis" style={{ maxWidth: 320, color: C.dangerText }}>{run.error_message}</div> : <code>{run.trace_id.slice(0, 8)}</code>}</td>
                <td>{run.app_name ?? '—'}<div className="faint">{run.app_version ? `v${run.app_version}` : '草稿'} · {CHANNEL_LABEL[run.channel] ?? run.channel}</div></td>
                <td><RunStatus status={run.status} handoff={run.handoff} /></td>
                <td className="faint">模型 {run.model_calls} · 检索 {run.retrievals} · 工具 {run.tool_calls}{run.errors ? <Tag tone="red">{run.errors} 错误</Tag> : null}</td>
                <td>{formatDuration(run.duration_ms)}</td>
                <td>{formatTokens(run.tokens.total)}</td>
                <td>{formatCost(run.cost, run.currency)}</td>
                <td>{run.feedback === 1 ? <ThumbsUp size={15} color={C.success} /> : run.feedback === -1 ? <ThumbsDown size={15} color={C.danger} /> : <span className="faint">—</span>}</td>
                <td className="faint">{formatTime(run.started_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      {data && data.total > PAGE ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <span className="faint">第 {offset + 1}–{Math.min(offset + PAGE, data.total)} 条，共 {data.total} 条</span>
          <button className="btn sm" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</button>
          <button className="btn sm" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>下一页</button>
        </div>
      ) : null}
    </div>
  );
}

function SpanRow({ span }: { span: Span }) {
  const [open, setOpen] = useState(span.status !== 'success');
  const meta = SPAN_META[span.kind] ?? { label: span.kind, icon: Activity, color: C.slate };
  const Icon = meta.icon;
  const tokens = span.metadata.tokens as { input?: number; output?: number; total?: number } | undefined;
  const toolCalls = span.metadata.tool_calls as Array<{ name: string; arguments: unknown }> | undefined;
  const failed = ['error', 'failed'].includes(span.status);
  return (
    <div className="span-row">
      <span className="span-dot" style={{ background: failed ? C.danger : meta.color }}><Icon size={12} /></span>
      <div style={{ minWidth: 0 }}>
        <button className="row" style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', width: '100%' }} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <strong style={{ fontSize: 13 }}>{span.name}</strong>
          <Tag>{meta.label}</Tag>
          {span.status !== 'success' ? <Tag tone={failed ? 'red' : 'orange'}>{({ blocked: '已拦截', warning: '告警', confirmation_required: '待确认' } as Record<string, string>)[span.status] ?? span.status}</Tag> : null}
          {tokens?.total != null ? <span className="faint">{tokens.input ?? '—'} → {tokens.output ?? '—'} tokens</span> : null}
        </button>
        {!open ? <div className="faint ellipsis" style={{ marginLeft: 19 }}>{span.detail}</div> : (
          <div className="col" style={{ gap: 6, marginTop: 6, marginLeft: 19 }}>
            {toolCalls?.length ? <div><div className="faint">请求调用工具</div><div className="json-view">{JSON.stringify(toolCalls, null, 2)}</div></div> : null}
            {span.metadata.arguments ? <div><div className="faint">调用参数</div><div className="json-view">{JSON.stringify(span.metadata.arguments, null, 2)}</div></div> : null}
            {span.metadata.query ? <div className="faint">检索问题：{String(span.metadata.query)} · 模式 {String(span.metadata.mode ?? '')} · 召回 {String(span.metadata.recalled ?? '—')} · 返回 {String(span.metadata.returned ?? '—')}{span.metadata.top_score != null ? ` · 最高分 ${String(span.metadata.top_score)}` : ''}</div> : null}
            {span.kind === 'context' && span.metadata.system_prompt ? <div><div className="faint">系统提示词</div><div className="json-view">{String(span.metadata.system_prompt)}</div></div> : null}
            {span.detail ? <div><div className="faint">{span.kind === 'model' ? '模型输出' : span.kind === 'context' ? '摘要' : '结果'}</div><div className="json-view">{span.detail}</div></div> : null}
          </div>
        )}
      </div>
      <span className="faint" style={{ whiteSpace: 'nowrap' }}>{span.duration_ms ? formatDuration(span.duration_ms) : ''}</span>
    </div>
  );
}

function TraceDrawer({ traceId, onClose, onReturn }: { traceId: string | null; onClose: () => void; onReturn: (value: CaseReturn) => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { setRun(null); setError(''); if (traceId) obsApi.run(traceId).then(setRun).catch((caught) => setError(errorMessage(caught))); }, [traceId]);
  const totalStepMs = run?.spans.reduce((sum, span) => sum + span.duration_ms, 0) ?? 0;
  return (
    <Drawer open={!!traceId} wide title={`Trace ${traceId?.slice(0, 8) ?? ''}`} onClose={onClose}
      footer={run?.app_id ? <>
        {run.conversation_id ? <Link className="btn ghost" to={`/observability?view=conversations&conversation=${run.conversation_id}`}>查看所在会话</Link> : null}
        <span className="grow" />
        <button className="btn" onClick={() => onReturn({ traceIds: [run.trace_id], appId: run.app_id!, appName: run.app_name, type: 'good' })}><ThumbsUp size={14} />保存 Good Case</button>
        <button className="btn primary" onClick={() => onReturn({ traceIds: [run.trace_id], appId: run.app_id!, appName: run.app_name, type: 'bad' })}><ThumbsDown size={14} />保存 Bad Case</button>
      </> : undefined}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!run && !error ? <Loading /> : null}
      {run ? (
        <div className="col" style={{ gap: 16 }}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="grow"><strong style={{ fontSize: 15 }}>{run.query}</strong><div className="faint mono">{run.trace_id}</div></div>
            <RunStatus status={run.status} handoff={run.handoff} />
          </div>
          <div className="grid c4" style={{ gap: 10 }}>
            {[
              ['应用', run.app_id ? <Link to={`/apps/${run.app_id}`}>{run.app_name}</Link> : '—'],
              ['版本 · 渠道', `${run.app_version ? `v${run.app_version}` : '草稿'} · ${CHANNEL_LABEL[run.channel] ?? run.channel}`],
              ['模型', `${run.model_name ?? '—'}${run.simulated ? '（测试替身）' : ''}`],
              ['时间', formatTime(run.started_at)],
              ['总耗时', formatDuration(run.duration_ms)],
              ['Tokens', `${formatTokens(run.tokens.input)} 入 / ${formatTokens(run.tokens.output)} 出`],
              ['估算费用', formatCost(run.cost, run.currency)],
              ['上下文', `历史 ${run.history_messages} 条 · 引用 ${run.citations.length} 条`],
            ].map(([label, value]) => <div key={String(label)} className="card" style={{ padding: '8px 10px' }}><div className="faint">{label}</div><div style={{ fontSize: 13, fontWeight: 500 }} className="ellipsis">{value}</div></div>)}
          </div>
          {run.error_message ? <Notice tone="error" title="运行失败">{run.error_message}</Notice> : null}
          {run.feedback_items.length ? <Notice tone={run.feedback_items.some((item) => item.rating < 0) ? 'warn' : 'success'} title="用户反馈">{run.feedback_items.map((item) => `${item.rating > 0 ? '👍' : '👎'} ${item.comment || ''}`).join('；')}</Notice> : null}
          {Object.keys(run.input_values).length ? <div><div className="field-label">业务输入</div><div className="json-view">{JSON.stringify(run.input_values, null, 2)}</div></div> : null}
          <div>
            <div className="row" style={{ marginBottom: 4 }}><strong className="grow">执行轨迹</strong><span className="faint">{run.spans.length} 步 · 步骤合计 {formatDuration(totalStepMs)}</span></div>
            <p className="faint" style={{ marginBottom: 6 }}>只展示运行时实际记录的步骤与模型显式输出，不包含模型不可见的内部推理。</p>
            <div className="card" style={{ padding: '0 12px' }}>{run.spans.map((span) => <SpanRow key={span.id} span={span} />)}</div>
          </div>
          {run.output ? <div><div className="field-label">最终输出</div><div className="card pad"><Markdown text={run.output} /></div></div> : null}
          {run.citations.length ? (
            <div><div className="field-label">引用来源</div>
              <div className="col" style={{ gap: 8 }}>{run.citations.map((item, index) => <div key={index} className="chunk-card"><header><span className="idx">[{index + 1}]</span><span className="grow ellipsis">{item.filename} · {item.title}</span><span className="score">{item.score.toFixed(3)}</span></header><div className="body clamp-3">{item.content}</div></div>)}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

/* ------------------------------ 对话日志 ------------------------------ */

function ConversationsView({ appId, onTrace }: { appId: string; onTrace: (id: string) => void }) {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ total: number; items: ConversationItem[] } | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const openId = params.get('conversation');

  useEffect(() => { setData(null); setError(''); obsApi.conversations({ app_id: appId, search: query, limit: 50 }).then(setData).catch((caught) => setError(errorMessage(caught))); }, [appId, query]);
  useEffect(() => { setDetail(null); if (openId) obsApi.conversation(openId).then(setDetail).catch((caught) => setError(errorMessage(caught))); }, [openId]);
  const close = () => setParams((current) => { const next = new URLSearchParams(current); next.delete('conversation'); return next; });

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="view-title"><div><h2>对话日志</h2><p>按会话查看多轮消息、反馈和累计消耗，可从任一轮下钻到 Trace。</p></div></div>
      <div className="row filter-bar"><span className="grow" /><form className="search-box" style={{ width: 260 }} onSubmit={(event) => { event.preventDefault(); setQuery(search); }}><Search size={15} /><input className="input sm" aria-label="搜索会话" placeholder="搜索会话标题，回车" value={search} onChange={(event) => setSearch(event.target.value)} /></form></div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!data && !error ? <Loading /> : null}
      {data && !data.items.length ? <Empty icon={<MessageSquareText size={24} />} title="还没有会话" /> : null}
      {data && data.items.length ? (
        <div className="card table-card table-scroll">
          <table className="table observability-table">
            <thead><tr><th>会话</th><th>应用</th><th>轮次</th><th>Tokens</th><th>累计费用</th><th>反馈</th><th>失败</th><th>更新时间</th></tr></thead>
            <tbody>{data.items.map((item) => (
              <tr key={item.id} className="clickable" onClick={() => setParams((current) => { const next = new URLSearchParams(current); next.set('conversation', item.id); return next; })}>
                <td><div className="trace-primary ellipsis">{item.title}</div><code>{item.id.slice(0, 8)}</code></td>
                <td>{item.app_name}</td><td>{item.turns}</td><td>{formatTokens(item.tokens)}</td><td>{formatCost(item.cost)}</td>
                <td>{item.feedback.up ? <Tag tone="green">👍 {item.feedback.up}</Tag> : null}{item.feedback.down ? <Tag tone="red">👎 {item.feedback.down}</Tag> : null}{!item.feedback.up && !item.feedback.down ? <span className="faint">—</span> : null}</td>
                <td>{item.failed_runs ? <Tag tone="red">{item.failed_runs}</Tag> : <span className="faint">0</span>}</td>
                <td className="faint">{formatTime(item.updated_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      <Drawer open={!!openId} wide title={detail?.title ?? '会话详情'} onClose={close}>
        {!detail ? <Loading /> : (
          <div className="col" style={{ gap: 14 }}>
            <div className="faint">{detail.app_name} · 创建于 {formatTime(detail.created_at)} · {detail.messages.filter((item) => item.role === 'user').length} 轮</div>
            {detail.messages.map((message) => message.role === 'user' ? (
              <div key={message.id} className="msg user"><div className="bubble">{message.content}</div></div>
            ) : (
              <div key={message.id} className="msg">
                <div style={{ maxWidth: '88%' }}>
                  <div className="bubble" style={{ whiteSpace: 'normal' }}><Markdown text={message.content} /></div>
                  <div className="row wrap" style={{ marginTop: 4 }}>
                    {message.feedback === 1 ? <Tag tone="green">👍 好评</Tag> : message.feedback === -1 ? <Tag tone="red">👎 差评</Tag> : null}
                    {message.citations.length ? <span className="faint">引用 {message.citations.length} 条</span> : null}
                    <span className="faint">{formatTokens((message.tokens.input ?? 0) + (message.tokens.output ?? 0))} tokens · {formatDuration(message.duration_ms)} · {formatCost(message.cost)}</span>
                    {message.trace_id ? <button className="btn ghost sm" onClick={() => onTrace(message.trace_id!)}><Activity size={13} />Trace</button> : null}
                  </div>
                </div>
              </div>
            ))}
            {detail.failed_runs.length ? <Notice tone="error" title={`${detail.failed_runs.length} 次失败运行`}>{detail.failed_runs.map((item) => <div key={item.trace_id}><button className="btn ghost sm" onClick={() => onTrace(item.trace_id)}>{item.query}</button>：{item.error_message}</div>)}</Notice> : null}
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ------------------------------ 知识构建 ------------------------------ */

function BuildsView() {
  const toast = useToast();
  const [kbs, setKbs] = useState<ApiKnowledgeBase[]>([]);
  const [kbId, setKbId] = useState('');
  const [status, setStatus] = useState('');
  const [data, setData] = useState<Awaited<ReturnType<typeof obsApi.buildJobs>> | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<BuildJob | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => obsApi.buildJobs({ knowledge_base_id: kbId, status, limit: 50 }).then(setData).catch((caught) => setError(errorMessage(caught))), [kbId, status]);
  useEffect(() => { apiFetch<ApiKnowledgeBase[]>('/knowledge-bases').then(setKbs).catch(() => undefined); }, []);
  useEffect(() => { setData(null); setError(''); void load(); }, [load]);
  const running = data?.items.some((item) => ACTIVE_STATUSES.has(item.status));
  useEffect(() => { if (!running) return undefined; const timer = window.setInterval(() => void load(), 3000); return () => window.clearInterval(timer); }, [running, load]);

  const retry = async (job: BuildJob) => {
    setBusy(job.id);
    try {
      await apiFetch(`/knowledge-bases/${job.knowledge_base_id}/files/${job.file_id}/retry`, { method: 'POST', body: JSON.stringify({}) });
      toast('已重新提交构建');
      setOpen(null);
      await load();
    } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(''); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="view-title"><div><h2>知识构建</h2><p>按文件追踪解析、元数据、切块、向量化与索引的每个阶段。</p></div></div>
      {data ? (
        <div className="grid c4">
          <div className="card stat"><div className="label">构建任务</div><div className="value">{data.summary.total}</div></div>
          <div className="card stat"><div className="label">已完成</div><div className="value">{data.summary.completed}</div></div>
          <div className="card stat"><div className="label">进行中</div><div className="value">{data.summary.running}</div></div>
          <div className="card stat"><div className="label">失败</div><div className="value" style={{ color: data.summary.failed ? 'var(--red)' : undefined }}>{data.summary.failed}</div><div className={`observability-meta ${data.summary.failed ? 'bad' : 'ok'}`}>{data.summary.failed ? '需要处理' : '无异常'}</div></div>
        </div>
      ) : null}
      <div className="row filter-bar wrap">
        <div className="seg">{[['', '全部'], ['running', '进行中'], ['failed', '失败'], ['completed', '已完成']].map(([key, label]) => <button key={key} className={status === key ? 'active' : ''} onClick={() => setStatus(key)}>{label}</button>)}</div>
        <select className="select sm" style={{ width: 180 }} aria-label="知识库" value={kbId} onChange={(event) => setKbId(event.target.value)}><option value="">全部知识库</option>{kbs.map((kb) => <option key={kb.id} value={kb.id}>{kb.name}</option>)}</select>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!data && !error ? <Loading /> : null}
      {data && !data.items.length ? <Empty icon={<Database size={24} />} title="没有构建任务" /> : null}
      {data && data.items.length ? (
        <div className="card table-card table-scroll">
          <table className="table observability-table">
            <thead><tr><th>文件</th><th>知识库</th><th>切块方式</th><th>状态</th><th>当前阶段</th><th>分块</th><th>耗时</th><th>开始时间</th></tr></thead>
            <tbody>{data.items.map((job) => {
              const meta = FILE_STATUS[job.status] ?? { label: job.status, tone: '' };
              return (
                <tr key={job.id} className="clickable" onClick={() => setOpen(job)}>
                  <td><div className="row"><FileText size={15} color={C.primary} /><div className="trace-primary ellipsis">{job.filename}</div></div></td>
                  <td><Link to={`/knowledge/${job.knowledge_base_id}`} onClick={(event) => event.stopPropagation()}>{job.knowledge_base_name}</Link></td>
                  <td><Tag tone="blue">{METHOD_LABEL[job.chunk_method as ChunkMethod] ?? job.chunk_method}</Tag></td>
                  <td><Tag tone={meta.tone}>{ACTIVE_STATUSES.has(job.status) ? <Spinner size={11} /> : null}{meta.label}</Tag></td>
                  <td>{STAGE_LABEL[job.current_stage] ?? job.current_stage}{ACTIVE_STATUSES.has(job.status) ? ` · ${job.progress}%` : ''}</td>
                  <td>{job.chunk_count || '—'}</td>
                  <td>{formatDuration(job.duration_ms)}</td>
                  <td className="faint">{formatTime(job.started_at ?? job.created_at)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : null}
      <Drawer open={!!open} title={open?.filename ?? ''} onClose={() => setOpen(null)}
        footer={open?.status === 'failed' ? <button className="btn primary" disabled={busy === open.id} onClick={() => void retry(open)}>{busy === open.id ? <Spinner /> : <RefreshCw size={14} />}重新构建</button> : undefined}>
        {open ? (
          <div className="col" style={{ gap: 12 }}>
            <div className="faint">{open.knowledge_base_name} · {METHOD_LABEL[open.chunk_method as ChunkMethod] ?? open.chunk_method} · 任务 {open.id.slice(0, 8)}</div>
            {open.error_message ? <Notice tone="error" title="失败原因">{open.error_message}</Notice> : null}
            <div className="card" style={{ padding: '0 12px' }}>
              {open.stage_details.map((stage, index) => {
                const ok = stage.status === 'success';
                const active = stage.status === 'active';
                const warning = stage.status === 'warning';
                return (
                  <div key={index} className="span-row">
                    <span className="span-dot" style={{ background: ok ? C.success : active ? C.primary : warning ? C.warning : C.danger }}>{ok ? <CheckCircle2 size={12} /> : active ? <Spinner size={12} /> : warning ? <AlertTriangle size={12} /> : <XCircle size={12} />}</span>
                    <div><strong style={{ fontSize: 13 }}>{STAGE_LABEL[stage.name] ?? stage.name}</strong><div className="faint" style={{ whiteSpace: 'pre-wrap' }}>{stage.detail}</div></div>
                    <span />
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

/* ------------------------------ 用量与费用 ------------------------------ */

function UsageView({ days, appId }: { days: number; appId: string }) {
  const [groupBy, setGroupBy] = useState<'app' | 'model' | 'channel'>('app');
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { setData(null); setError(''); obsApi.usage({ days, group_by: groupBy, app_id: appId }).then(setData).catch((caught) => setError(errorMessage(caught))); }, [days, groupBy, appId]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Loading />;
  const totalCost = data.totals.cost ?? 0;
  const totalTokens = Math.max(1, data.totals.total_tokens);
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="view-title"><div><h2>用量与费用</h2><p>费用按调用时的模型单价快照估算，用于归因与预警；以供应商账单为准。</p></div><span className="grow" /><Link className="btn sm" to="/tools?tab=models">配置模型单价</Link></div>
      <div className="grid c4">
        <div className="card stat"><div className="label">估算费用</div><div className="value">{formatCost(data.totals.cost)}</div><div className={`observability-meta ${data.totals.priced_runs < data.totals.runs ? 'warn' : 'ok'}`}>{data.totals.priced_runs}/{data.totals.runs} 次已计价</div></div>
        <div className="card stat"><div className="label">运行次数</div><div className="value">{data.totals.runs.toLocaleString()}</div></div>
        <div className="card stat"><div className="label">输入 Tokens</div><div className="value">{formatTokens(data.totals.input_tokens)}</div></div>
        <div className="card stat"><div className="label">输出 Tokens</div><div className="value">{formatTokens(data.totals.output_tokens)}</div></div>
      </div>
      {data.totals.priced_runs < data.totals.runs ? <Notice tone="warn" title="部分运行未计价">没有配置单价的模型不计算费用，也不会被估算。在「集成 → 模型」为模型填写每百万 Tokens 的输入/输出单价。</Notice> : null}
      <section className="card pad">
        <div className="row section-row"><strong className="grow">费用归因</strong><div className="seg">{([['app', '按应用'], ['model', '按模型'], ['channel', '按渠道']] as const).map(([key, label]) => <button key={key} className={groupBy === key ? 'active' : ''} onClick={() => setGroupBy(key)}>{label}</button>)}</div></div>
        {!data.items.length ? <p className="faint">该时间段没有运行。</p> : (
          <div className="table-scroll">
            <table className="table observability-table">
              <thead><tr><th>{groupBy === 'app' ? '应用' : groupBy === 'model' ? '模型' : '渠道'}</th><th>运行</th><th>失败</th><th>输入 Tokens</th><th>输出 Tokens</th><th>平均耗时</th><th>费用</th><th>占比</th></tr></thead>
              <tbody>{data.items.map((item) => {
                const share = totalCost ? ((item.cost ?? 0) / totalCost) * 100 : (item.total_tokens / totalTokens) * 100;
                return (
                  <tr key={item.key}>
                    <td><strong>{groupBy === 'channel' ? CHANNEL_LABEL[item.name] ?? item.name : item.name}</strong></td>
                    <td>{item.runs}</td><td>{item.failed || '—'}</td><td>{formatTokens(item.input_tokens)}</td><td>{formatTokens(item.output_tokens)}</td>
                    <td>{formatDuration(item.avg_duration_ms)}</td><td>{formatCost(item.cost, data.currency)}</td>
                    <td><div className="share-cell"><span style={{ width: `${share}%` }} />{share.toFixed(1)}%</div></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        <p className="faint" style={{ marginTop: 8 }}>{totalCost ? '占比按费用计算' : '尚无计价数据，占比按 Tokens 计算'}</p>
      </section>
    </div>
  );
}
