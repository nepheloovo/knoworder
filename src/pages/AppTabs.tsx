import { Activity, CheckCircle2, ClipboardCheck, Sparkles, Code2, Copy, ExternalLink, Globe, KeyRound, LayoutGrid, Link2, MessageCircle, Play, Plus, RotateCcw, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API_BASE_URL, errorMessage, type ApiEvaluationSet } from '../api/client';
import { evalApi, runWithProgress } from '../api/evaluation';
import { fdeApi, type AppShare, type AppVersion, type FDEApp } from '../api/fde';
import { CHANNEL_LABEL, obsApi, type RunItem } from '../api/observability';
import { EvalDesignModal } from '../components/EvalDesignModal';
import { ConfirmModal, Drawer, Empty, Field, Loading, Modal, Notice, Spinner, Switch, Tag, formatCost, formatDuration, formatTime, formatTokens, useToast } from '../components/ui';
import { C } from '../theme';

/* ------------------------------ 发布渠道 ------------------------------ */

export function PublishTab({ app, onChanged }: { app: FDEApp; onChanged: () => void }) {
  const toast = useToast();
  const [shares, setShares] = useState<AppShare[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '对外分享', days: 30, maxUses: 0 });
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AppShare | null>(null);
  const [unpublishing, setUnpublishing] = useState(false);
  const online = app.is_enabled && !!app.published_version_id;

  const load = useCallback(() => fdeApi.shares(app.id).then(setShares).catch((caught) => toast(errorMessage(caught), 'error')), [app.id, toast]);
  useEffect(() => { void load(); }, [load]);

  const copy = (text: string) => { void navigator.clipboard?.writeText(text); toast('已复制'); };
  const apiExample = `curl -X POST ${window.location.origin}${API_BASE_URL}/fde/apps/${app.id}/run \\
  -H "Authorization: Bearer $FDE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "你的问题", "input_values": {}, "conversation_id": null}'`;

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-head"><div className="grow"><h1 style={{ fontSize: 18 }}>发布渠道</h1><p>所有渠道运行同一个线上版本，草稿修改不影响线上。</p></div></div>
      {!online ? <div style={{ marginBottom: 16 }}><Notice tone="warn" title="应用尚未上线">点击右上角「发布」后，下列渠道才会生效。</Notice></div> : null}
      <div className="grid c2">
        <div className="card pad">
          <div className="row"><LayoutGrid size={18} color="var(--primary)" /><strong className="grow">企业工作台</strong>{online ? <Tag tone="green">已上线 v{app.published_version?.version}</Tag> : <Tag>未上线</Tag>}</div>
          <p className="faint" style={{ margin: '6px 0 12px' }}>员工登录后在工作台按业务场景找到并使用该应用。</p>
          <div className="row"><Link className="btn sm" to={`/chat/${app.id}`}><Play size={13} />打开</Link>{online ? <button className="btn sm danger" onClick={() => setUnpublishing(true)}>下线</button> : null}</div>
        </div>
        <div className="card pad">
          <div className="row"><KeyRound size={18} color="var(--primary)" /><strong className="grow">API 调用</strong><Tag tone="blue">可用</Tag></div>
          <p className="faint" style={{ margin: '6px 0 12px' }}>业务系统用具备 <code>apps:run</code> 权限的 Token 调用，渠道记为「API」。</p>
          <div className="code-block" style={{ fontSize: 11 }}>{apiExample}</div>
          <div className="row" style={{ marginTop: 8 }}><button className="btn sm" onClick={() => copy(apiExample)}><Copy size={13} />复制</button><Link className="btn sm ghost" to="/settings?tab=tokens">管理 Token</Link></div>
        </div>
      </div>

      <div className="card pad" style={{ marginTop: 16 }}>
        <div className="row"><Link2 size={18} color="var(--primary)" /><strong className="grow">免登录分享链接</strong><button className="btn sm primary" disabled={!online} onClick={() => { setCreated(null); setCreating(true); }}><Plus size={13} />创建链接</button></div>
        <p className="faint" style={{ margin: '6px 0 12px' }}>外部用户无需登录即可使用，可限制有效期与次数；链接只在创建时显示一次。</p>
        {!shares ? <Loading /> : !shares.length ? <p className="faint">暂无分享链接</p> : (
          <table className="table">
            <thead><tr><th>名称</th><th>使用次数</th><th>有效期</th><th>状态</th><th /></tr></thead>
            <tbody>{shares.map((share) => (
              <tr key={share.id}>
                <td>{share.name}</td><td>{share.use_count}{share.max_uses ? ` / ${share.max_uses}` : ''}</td>
                <td className="faint">{share.expires_at ? formatTime(share.expires_at) : '长期'}</td>
                <td>{share.is_enabled ? <Tag tone="green">有效</Tag> : <Tag>已撤销</Tag>}</td>
                <td>{share.is_enabled ? <button className="btn sm ghost" onClick={() => setRevoking(share)}><Trash2 size={13} />撤销</button> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      <div className="grid c3" style={{ marginTop: 16 }}>
        {[{ icon: Code2, name: '网页嵌入' }, { icon: MessageCircle, name: '企业微信' }, { icon: Globe, name: '飞书机器人' }].map(({ icon: Icon, name }) => (
          <div key={name} className="card pad row coming-soon" style={{ cursor: 'default' }}><Icon size={18} /><strong className="grow">{name}</strong><Tag>即将上线</Tag></div>
        ))}
      </div>

      <Modal open={creating} title="创建分享链接" onClose={() => setCreating(false)}
        footer={created ? <button className="btn primary" onClick={() => setCreating(false)}>完成</button> : <><button className="btn" onClick={() => setCreating(false)}>取消</button><button className="btn primary" onClick={async () => {
          try {
            const share = await fdeApi.createShare(app.id, { name: form.name, expires_in_days: form.days || null, max_uses: form.maxUses || null });
            setCreated(`${window.location.origin}/share/${share.token}`);
            void load();
          } catch (caught) { toast(errorMessage(caught), 'error'); }
        }}>创建</button></>}>
        {created ? <>
          <Notice tone="success" title="链接已创建">请立即复制保存，关闭后无法再次查看。</Notice>
          <div className="row" style={{ marginTop: 12 }}><input className="input mono" readOnly value={created} /><button className="btn" onClick={() => copy(created)}><Copy size={14} />复制</button><a className="btn" href={created} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a></div>
        </> : <>
          <Field label="名称"><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <div className="form-grid">
            <Field label="有效天数" hint="0 表示长期"><input className="input" type="number" min={0} max={365} value={form.days} onChange={(event) => setForm({ ...form, days: Number(event.target.value) })} /></Field>
            <Field label="最大使用次数" hint="0 表示不限"><input className="input" type="number" min={0} value={form.maxUses} onChange={(event) => setForm({ ...form, maxUses: Number(event.target.value) })} /></Field>
          </div>
        </>}
      </Modal>
      <ConfirmModal open={!!revoking} danger title="撤销分享链接" confirmText="撤销" body="撤销后该链接立即失效。" onClose={() => setRevoking(null)}
        onConfirm={async () => { if (!revoking) return; try { await fdeApi.revokeShare(app.id, revoking.id); toast('已撤销'); void load(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} />
      <ConfirmModal open={unpublishing} danger title="下线应用" confirmText="下线" body="下线后工作台、分享链接和 API 都将无法使用该应用，版本保留，可随时重新发布。" onClose={() => setUnpublishing(false)}
        onConfirm={async () => { try { await fdeApi.unpublish(app.id); toast('已下线'); onChanged(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} />
    </div>
  );
}

/* ------------------------------ 评测 ------------------------------ */

export function EvalTab({ app }: { app: FDEApp }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [sets, setSets] = useState<ApiEvaluationSet[] | null>(null);
  const [running, setRunning] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [designing, setDesigning] = useState(false);
  const [name, setName] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(() => evalApi.list(app.id).then(setSets).catch((caught) => toast(errorMessage(caught), 'error')), [app.id, toast]);
  useEffect(() => { void load(); }, [load]);

  const runSet = async (set: ApiEvaluationSet) => {
    setRunning(set.id);
    try {
      const resume = set.latest_run?.status === 'running' ? set.latest_run : undefined;
      const result = await runWithProgress(set.id, (run) => { if (alive.current) setProgress({ done: run.done_count ?? 0, total: run.total_count ?? set.ready_count }); }, { resume, shouldStop: () => !alive.current });
      if (!alive.current) return;
      if (result.status !== 'running') toast(`评测完成：${result.passed_count} 通过，${result.failed_count} 未通过`);
      await load();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      if (alive.current) { setRunning(''); setProgress(null); }
    }
  };

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-head">
        <div className="grow"><h1 style={{ fontSize: 18 }}>评测</h1><p>评测集基于当前草稿运行。设为「发布门禁」的评测集必须全部通过才能发布。</p></div>
        <button className="btn" onClick={() => navigate('/observability?view=runs')}><Activity size={15} />从线上日志回流 Case</button>
        <button className="btn" onClick={() => setCreating(true)}><Plus size={15} />手工新建</button>
        <button className="btn primary" onClick={() => setDesigning(true)}><Sparkles size={15} />AI 设计评测集</button>
      </div>
      {!sets ? <Loading /> : !sets.length ? <Empty icon={<ClipboardCheck size={26} />} title="还没有评测集" desc="在可观测中把真实对话标记为 Good / Bad Case，或手工编写用例。" /> : (
        <table className="table">
          <thead><tr><th>评测集</th><th>Case</th><th>最近结果</th><th>发布门禁</th><th /></tr></thead>
          <tbody>{sets.map((set) => {
            const run = set.latest_run;
            return (
              <tr key={set.id}>
                <td><Link to={`/evaluation-sets?set=${set.id}`} style={{ fontWeight: 500 }}>{set.name}</Link><div className="faint">{set.description}</div></td>
                <td>{set.case_count}{set.needs_standard_count ? <Tag tone="orange">{set.needs_standard_count} 待补标准</Tag> : null}</td>
                <td>{run?.status === 'running' && running !== set.id ? <Tag tone="orange">中断于 {run.done_count ?? run.results.length}/{set.ready_count}</Tag> : run ? (run.failed_count ? <Tag tone="red"><XCircle size={12} />{run.passed_count}/{run.passed_count + run.failed_count} 通过</Tag> : <Tag tone="green"><CheckCircle2 size={12} />全部通过</Tag>) : <span className="faint">未运行</span>}{run?.matches_draft === false ? <Tag tone="orange">草稿已改动，需重跑</Tag> : null}{run ? <div className="faint">{formatTime(run.created_at)}</div> : null}</td>
                <td><Switch on={set.is_release_gate} label="发布门禁" onChange={async (value) => { try { await evalApi.update(set.id, { is_release_gate: value }); toast(value ? '已设为发布门禁' : '已取消门禁'); void load(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} /></td>
                <td><button className="btn sm" disabled={running === set.id || !set.ready_count} title={!set.ready_count ? '没有可运行的 Case' : set.needs_standard_count ? `${set.needs_standard_count} 条待补标准的 Case 会被跳过` : undefined} onClick={() => void runSet(set)}>{running === set.id ? <Spinner size={12} /> : <Play size={13} />}{running === set.id && progress ? `${progress.done}/${progress.total}` : run?.status === 'running' ? '继续' : '运行'}</button></td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
      <EvalDesignModal open={designing} appId={app.id} onClose={() => setDesigning(false)}
        onCreated={(set, run) => { setDesigning(false); navigate(`/evaluation-sets?set=${set.id}${run ? '&autorun=1' : ''}`); }} />
      <Modal open={creating} title="新建评测集" onClose={() => { setCreating(false); setName(''); }} footer={<><button className="btn" onClick={() => { setCreating(false); setName(''); }}>取消</button><button className="btn primary" disabled={!name.trim()} onClick={async () => {
        try { const set = await evalApi.create({ app_id: app.id, name: name.trim() }); setCreating(false); setName(''); navigate(`/evaluation-sets?set=${set.id}`); } catch (caught) { toast(errorMessage(caught), 'error'); }
      }}>创建</button></>}>
        <Field label="名称" required><input className="input" autoFocus value={name} placeholder="例如：售后政策回归集" onChange={(event) => setName(event.target.value)} /></Field>
      </Modal>
    </div>
  );
}

/* ------------------------------ 运行记录 ------------------------------ */

export function LogsTab({ app }: { app: FDEApp }) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<RunItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { obsApi.runs({ app_id: app.id, limit: 30 }).then((result) => setRuns(result.items)).catch((caught) => setError(errorMessage(caught))); }, [app.id]);
  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1 style={{ fontSize: 18 }}>运行记录</h1><p>最近 30 次运行，含调试与线上。点击进入可观测查看完整 Trace。</p></div>
        <button className="btn" onClick={() => navigate(`/observability?view=runs&app=${app.id}`)}><Activity size={15} />在可观测中查看全部</button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!runs && !error ? <Loading /> : runs && !runs.length ? <Empty title="还没有运行记录" desc="在编排页调试或用户使用后会出现在这里。" /> : runs ? (
        <table className="table">
          <thead><tr><th>输入</th><th>渠道</th><th>版本</th><th>状态</th><th>步骤</th><th>耗时</th><th>Tokens</th><th>费用</th><th>时间</th></tr></thead>
          <tbody>{runs.map((run) => (
            <tr key={run.trace_id} className="clickable" onClick={() => navigate(`/observability?view=runs&trace=${run.trace_id}`)}>
              <td style={{ maxWidth: 320 }}><div className="ellipsis">{run.query}</div>{run.error_message ? <div className="faint ellipsis" style={{ color: C.dangerText }}>{run.error_message}</div> : null}</td>
              <td><Tag>{CHANNEL_LABEL[run.channel] ?? run.channel}</Tag></td>
              <td>{run.app_version ? `v${run.app_version}` : <span className="faint">草稿</span>}</td>
              <td>{run.status === 'success' ? <Tag tone="green">成功</Tag> : run.status === 'failed' ? <Tag tone="red">失败</Tag> : <Tag tone="blue">运行中</Tag>}{run.handoff ? <Tag tone="orange">转人工</Tag> : null}</td>
              <td className="faint">模型 {run.model_calls} · 检索 {run.retrievals} · 工具 {run.tool_calls}</td>
              <td>{formatDuration(run.duration_ms)}</td>
              <td>{formatTokens(run.tokens.total)}</td>
              <td>{formatCost(run.cost, run.currency)}</td>
              <td className="faint">{formatTime(run.started_at)}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : null}
    </div>
  );
}

/* ------------------------------ 版本 ------------------------------ */

export function VersionsTab({ app, onChanged }: { app: FDEApp; onChanged: () => void }) {
  const toast = useToast();
  const [viewing, setViewing] = useState<AppVersion | null>(null);
  const [rolling, setRolling] = useState<AppVersion | null>(null);
  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <div className="page-head"><div className="grow"><h1 style={{ fontSize: 18 }}>版本</h1><p>每次发布生成不可变版本，可查看配置并一键回滚。</p></div></div>
      {!app.versions.length ? <Empty icon={<ShieldCheck size={26} />} title="尚未发布任何版本" /> : (
        <div className="card pad">
          {app.versions.map((version) => {
            const live = version.id === app.published_version_id && app.is_enabled;
            return (
              <div key={version.id} className="list-row">
                <Tag tone={live ? 'green' : ''}>v{version.version}</Tag>
                <div className="grow"><div>{version.release_notes || <span className="faint">无版本说明</span>}</div><div className="faint">{formatTime(version.created_at)} · {version.manifest.type === 'agent' ? 'Agent' : '简易应用'} · {version.manifest.knowledge_base_ids.length} 个知识库 · {version.manifest.tools.filter((tool) => tool.tool_id).length} 个工具</div></div>
                <button className="btn sm ghost" onClick={() => setViewing(version)}>查看配置</button>
                {live ? <Tag tone="green">线上</Tag> : <button className="btn sm" onClick={() => setRolling(version)}><RotateCcw size={13} />{version.id === app.published_version_id ? '重新上线' : app.published_version_id ? '回滚到此版本' : '发布此版本'}</button>}
              </div>
            );
          })}
        </div>
      )}
      <Drawer open={!!viewing} wide title={`v${viewing?.version ?? ''} 配置`} onClose={() => setViewing(null)}>
        {viewing ? <div className="json-view" style={{ maxHeight: 'none' }}>{JSON.stringify(viewing.manifest, null, 2)}</div> : null}
      </Drawer>
      <ConfirmModal open={!!rolling} title={`切换到 v${rolling?.version ?? ''}`} confirmText="确认切换" body="所有渠道将立即使用该版本；当前草稿不受影响。回滚不受发布门禁限制。" onClose={() => setRolling(null)}
        onConfirm={async () => { if (!rolling) return; try { await fdeApi.rollback(app.id, rolling.id); toast(`线上已切换到 v${rolling.version}`); onChanged(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} />
    </div>
  );
}
