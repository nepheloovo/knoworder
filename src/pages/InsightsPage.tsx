import { ArrowRight, Headset, MessageCircleWarning, ThumbsUp, Users, Zap } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, errorMessage } from '../api/client';
import { Empty, Loading, Tag, formatTime, useToast } from '../components/ui';

type Summary = { runs: number; active_users: number; satisfaction: number | null; feedback_count: number; hit_rate: number | null; handoff_rate: number | null };
type Reason = 'downvote' | 'nohit' | 'handoff';
type Insights = {
  days: number;
  current: Summary;
  previous: Summary;
  daily: Array<{ date: string; runs: number }>;
  ranking: Array<{ app_id: string; name: string; runs: number; satisfaction: number | null; handoff_rate: number | null }>;
  gaps: Array<{ question: string; samples: string[]; count: number; reasons: Partial<Record<Reason, number>>; app_id: string; app_name: string; knowledge_base_id: string | null; knowledge_base_name: string | null; last_at: string }>;
  recent_issues: Array<{ trace_id: string; query: string; app_id: string; app_name: string; reasons: Reason[]; at: string }>;
};

const REASON: Record<Reason, { label: string; tone: string }> = {
  downvote: { label: '点踩', tone: 'red' },
  nohit: { label: '未命中', tone: 'red' },
  handoff: { label: '转人工', tone: 'orange' },
};

const pct = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);

/** 与上一个同长周期对比；比率类显示百分点差，转人工率下降才算变好 */
function delta(current: number | null, previous: number | null, kind: 'count' | 'rate', lowerIsBetter = false): { text: string; down: boolean } | null {
  if (current === null || previous === null) return null;
  if (kind === 'count') {
    if (!previous) return null;
    const change = (current - previous) / previous;
    return { text: `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`, down: lowerIsBetter ? change > 0 : change < 0 };
  }
  const change = (current - previous) * 100;
  return { text: `${change >= 0 ? '+' : ''}${change.toFixed(1)}pt`, down: lowerIsBetter ? change > 0 : change < 0 };
}

export function InsightsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Insights | null>(null);

  useEffect(() => {
    setData(null);
    apiFetch<Insights>(`/insights?days=${days}`).then(setData).catch((caught) => toast(errorMessage(caught), 'error'));
  }, [days, toast]);

  const stats: Array<{ icon: ReactNode; label: string; value: string; delta: ReturnType<typeof delta>; hint?: string }> = data ? [
    { icon: <Zap size={15} />, label: '调用次数', value: data.current.runs.toLocaleString(), delta: delta(data.current.runs, data.previous.runs, 'count') },
    { icon: <Users size={15} />, label: '活跃用户', value: data.current.active_users.toLocaleString(), delta: delta(data.current.active_users, data.previous.active_users, 'count') },
    { icon: <ThumbsUp size={15} />, label: '满意度', value: pct(data.current.satisfaction), delta: delta(data.current.satisfaction, data.previous.satisfaction, 'rate'), hint: `${data.current.feedback_count} 条反馈` },
    { icon: <MessageCircleWarning size={15} />, label: '知识命中率', value: pct(data.current.hit_rate), delta: delta(data.current.hit_rate, data.previous.hit_rate, 'rate'), hint: '关联知识库的应用中带引用的回答占比' },
    { icon: <Headset size={15} />, label: '转人工率', value: pct(data.current.handoff_rate), delta: delta(data.current.handoff_rate, data.previous.handoff_rate, 'rate', true) },
  ] : [];
  const max = data ? Math.max(1, ...data.daily.map((item) => item.runs)) : 1;
  // 30 天时日期标签太挤，只隔几天标一次
  const labelEvery = data && data.daily.length > 10 ? Math.ceil(data.daily.length / 8) : 1;

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1>运营看板</h1><p>看清 AI 应用在业务中的使用效果，并把未解决的问题沉淀回知识库。编排页里的调试运行不计入。</p></div>
        <select className="select" style={{ width: 140 }} aria-label="统计周期" value={days} onChange={(event) => setDays(Number(event.target.value))}>
          <option value={7}>最近 7 天</option><option value={30}>最近 30 天</option>
        </select>
      </div>
      {!data ? <Loading /> : <>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
          {stats.map((item) => (
            <div key={item.label} className="card stat" title={item.hint}>
              <div className="label">{item.icon}{item.label}</div>
              <div className="value">{item.value}</div>
              <div className={`delta ${item.delta?.down ? 'down' : ''}`} style={item.delta ? undefined : { color: 'var(--text-4)' }}>{item.delta ? `较上一周期 ${item.delta.text}` : item.hint ?? '暂无对比数据'}</div>
            </div>
          ))}
        </div>

        <div className="row wrap" style={{ alignItems: 'stretch', gap: 16, marginTop: 16 }}>
          <div className="card pad grow" style={{ minWidth: 320 }}>
            <div className="row" style={{ marginBottom: 20 }}><strong className="grow">每日调用</strong><span className="faint">全部应用</span></div>
            <div className="bar-chart" style={{ height: 160, marginBottom: 24 }}>
              {data.daily.map((item, index) => (
                <div key={item.date} style={{ height: `${(item.runs / max) * 100}%` }} title={`${item.date}：${item.runs.toLocaleString()} 次`}>
                  {index % labelEvery === 0 ? <span>{item.date.slice(5)}</span> : null}
                </div>
              ))}
            </div>
          </div>
          <div className="card pad" style={{ width: 420, maxWidth: '100%' }}>
            <strong>应用排行</strong>
            {!data.ranking.length ? <p className="faint" style={{ marginTop: 12 }}>这段时间还没有线上调用。</p> : null}
            {data.ranking.slice(0, 6).map((app, index) => (
              <div key={app.app_id} className="list-row" style={{ cursor: 'pointer' }} onClick={() => navigate(`/observability?view=runs&app=${app.app_id}`)}>
                <span className="faint" style={{ width: 14 }}>{index + 1}</span>
                <span className="grow ellipsis">{app.name}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{app.runs.toLocaleString()} 次</span>
                {app.satisfaction !== null ? <Tag tone={app.satisfaction >= 0.85 ? 'green' : 'orange'}>满意 {pct(app.satisfaction)}</Tag> : <Tag>无反馈</Tag>}
              </div>
            ))}
          </div>
        </div>

        <div className="row wrap" style={{ alignItems: 'stretch', gap: 16, marginTop: 16 }}>
          <div className="card pad grow" style={{ minWidth: 320 }}>
            <div className="row wrap"><strong className="grow">知识缺口</strong><span className="faint">检索无依据或被点踩的问题，相近问法合并统计</span></div>
            {!data.gaps.length ? <Empty title="暂无知识缺口" desc="线上回答都有依据，也没有收到点踩。" /> : (
              <table className="table" style={{ marginTop: 10 }}>
                <thead><tr><th>问题</th><th>次数</th><th>原因</th><th>来源应用</th><th>建议补充到</th><th /></tr></thead>
                <tbody>{data.gaps.map((gap) => (
                  <tr key={`${gap.app_id}-${gap.question}`}>
                    <td title={gap.samples.join('\n')}>{gap.question}{gap.samples.length > 1 ? <span className="faint"> 等 {gap.samples.length} 种问法</span> : null}</td>
                    <td><Tag tone="red">{gap.count}</Tag></td>
                    <td><div className="row wrap" style={{ gap: 4 }}>{(Object.keys(gap.reasons) as Reason[]).map((reason) => <Tag key={reason} tone={REASON[reason].tone}>{REASON[reason].label} {gap.reasons[reason]}</Tag>)}</div></td>
                    <td className="muted">{gap.app_name}</td>
                    <td>{gap.knowledge_base_name ? <Tag tone="blue">{gap.knowledge_base_name}</Tag> : <span className="faint">应用未关联知识库</span>}</td>
                    <td>{gap.knowledge_base_id ? <button className="btn sm" onClick={() => navigate(`/knowledge/${gap.knowledge_base_id}/import?question=${encodeURIComponent(gap.question)}`)}>补充知识<ArrowRight size={13} /></button> : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
          <div className="card pad" style={{ width: 420, maxWidth: '100%' }}>
            <strong>最新差评与转人工</strong>
            {!data.recent_issues.length ? <p className="faint" style={{ marginTop: 12 }}>暂无。</p> : null}
            {data.recent_issues.map((issue) => (
              <div key={issue.trace_id} className="list-row" style={{ alignItems: 'flex-start', cursor: 'pointer' }} onClick={() => navigate(`/observability?view=runs&trace=${issue.trace_id}`)}>
                <div className="grow"><div style={{ fontSize: 13 }}>{issue.query}</div><div className="faint">{issue.app_name} · {formatTime(issue.at)}</div></div>
                <div className="row" style={{ gap: 4 }}>{issue.reasons.map((reason) => <Tag key={reason} tone={REASON[reason].tone}>{REASON[reason].label}</Tag>)}</div>
              </div>
            ))}
          </div>
        </div>
      </>}
    </div>
  );
}
