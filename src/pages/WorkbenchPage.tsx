import { ArrowRight, Blocks, Clock, Lightbulb, Search, Star, TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { fdeApi, type FDEApp, type WorkbenchSummary } from '../api/fde';
import { isManager, useAuth } from '../auth';
import { AppTile, Empty, Loading, Notice, Tag, formatTime } from '../components/ui';
import { sceneOf, SCENES, TYPE_META } from '../lib/apps';
import { C } from '../theme';

const STAR_KEY = 'zs-starred-apps';

function greeting() {
  const hour = new Date().getHours();
  return hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
}

export function WorkbenchPage() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const [apps, setApps] = useState<FDEApp[] | null>(null);
  const [error, setError] = useState('');
  const [scene, setScene] = useState('all');
  const [q, setQ] = useState('');
  const [starred, setStarred] = useState<string[]>(() => JSON.parse(localStorage.getItem(STAR_KEY) ?? '[]') as string[]);
  const [summary, setSummary] = useState<WorkbenchSummary | null>(null);

  useEffect(() => { fdeApi.list().then((list) => setApps(list.filter((app) => app.is_enabled && app.published_version_id))).catch((caught) => setError(errorMessage(caught))); }, []);
  useEffect(() => { localStorage.setItem(STAR_KEY, JSON.stringify(starred)); }, [starred]);
  useEffect(() => { fdeApi.workbench().then(setSummary).catch(() => setSummary(null)); }, []);

  const scenes = useMemo(() => Object.entries(SCENES).map(([key, item]) => ({ key, ...item, count: apps?.filter((app) => app.manifest.template_key === key).length ?? 0 })), [apps]);
  const visible = (apps ?? []).filter((app) => (scene === 'all' || app.manifest.template_key === scene) && (!q || `${app.name}${app.description}`.includes(q)));
  const toggleStar = (id: string) => setStarred((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  return (
    <div className="page" style={{ background: 'linear-gradient(180deg, var(--primary-50) 0, var(--surface) 220px)' }}>
      <div style={{ maxWidth: 1240, margin: '0 auto' }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginTop: 8 }}>{greeting()}，{me?.user?.display_name ?? ''}</h1>
        <p className="muted" style={{ marginTop: 6 }}>选择一个业务应用开始工作。</p>
        <div className="search-box" style={{ marginTop: 18, maxWidth: 720 }}>
          <Search size={17} />
          <input className="input" aria-label="搜索应用" style={{ height: 46, borderRadius: 12, paddingLeft: 38, fontSize: 15, boxShadow: 'var(--shadow)' }} value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索应用，例如「客服」「报告」「合同」" />
        </div>

        <div className="workbench-layout">
        <div style={{ minWidth: 0 }}>
        {error ? <div style={{ marginTop: 20 }}><Notice tone="error">{error}</Notice></div> : null}
        {!apps && !error ? <Loading /> : null}
        {apps ? <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, marginTop: 24 }}>
            {scenes.map((item) => (
              <button key={item.key} className="card hover" onClick={() => setScene(scene === item.key ? 'all' : item.key)}
                style={{ padding: '12px 14px', textAlign: 'left', borderColor: scene === item.key ? item.color : undefined, background: scene === item.key ? `${item.color}0d` : undefined }}>
                <div className="row"><span style={{ width: 4, height: 16, borderRadius: 2, background: item.color }} /><strong>{item.name}</strong></div>
                <div style={{ marginTop: 8, fontSize: 12, color: item.color, fontWeight: 500 }}>{item.count} 个应用</div>
              </button>
            ))}
          </div>

          {starred.some((id) => apps.some((app) => app.id === id)) ? <>
            <div className="section-title"><Star size={15} color={C.star} fill={C.star} />我的收藏</div>
            <div className="row wrap">{apps.filter((app) => starred.includes(app.id)).map((app) => <button key={app.id} className="btn" onClick={() => navigate(`/chat/${app.id}`)}><AppTile templateKey={app.manifest.template_key} type={app.manifest.type} size="sm" />{app.name}</button>)}</div>
          </> : null}

          <div className="section-title">{scene === 'all' ? '全部应用' : sceneOf(scene).name}<small>{visible.length} 个</small></div>
          {!visible.length ? (
            <Empty icon={<Blocks size={26} />} title={apps.length ? '没有匹配的应用' : '还没有已发布的应用'} desc={apps.length ? '换个关键词或场景试试。' : '应用发布后会出现在这里。'}
              action={isManager(me?.role) ? <button className="btn primary" onClick={() => navigate('/apps?create=1')}>去搭建应用</button> : undefined} />
          ) : (
            <div className="grid auto">
              {visible.map((app) => {
                const scn = sceneOf(app.manifest.template_key);
                return (
                  <article key={app.id} className="card pad hover" onClick={() => navigate(`/chat/${app.id}`)}>
                    <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                      <AppTile templateKey={app.manifest.template_key} type={app.manifest.type} size="lg" />
                      <div className="grow" style={{ minWidth: 0 }}>
                        <strong style={{ fontSize: 15 }} className="ellipsis">{app.name}</strong>
                        <div className="row" style={{ marginTop: 4 }}><Tag tone={TYPE_META[app.manifest.type].tone}>{TYPE_META[app.manifest.type].name}</Tag></div>
                      </div>
                      <button className="btn ghost sm icon" aria-label={starred.includes(app.id) ? '取消收藏' : '收藏'} onClick={(event) => { event.stopPropagation(); toggleStar(app.id); }}>
                        <Star size={16} fill={starred.includes(app.id) ? C.star : 'none'} color={starred.includes(app.id) ? C.star : 'currentColor'} />
                      </button>
                    </div>
                    <p className="muted clamp-2" style={{ fontSize: 13, marginTop: 10, minHeight: 42 }}>{app.description}</p>
                    <div className="row faint" style={{ marginTop: 12 }}>
                      <span className="dot" style={{ color: scn.color }} /><span>{scn.name}</span><span className="grow" />
                      <span style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13 }}>开始使用<ArrowRight size={14} /></span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {isManager(me?.role) ? (
            <button className="card pad hover row" style={{ marginTop: 24, width: '100%', textAlign: 'left' }} onClick={() => navigate('/apps?create=1')}>
              <Lightbulb size={20} color={C.warning} /><div className="grow"><strong>没有合适的应用？</strong><div className="faint">描述业务需求，AI 帮你生成第一版</div></div><ArrowRight size={16} className="muted" />
            </button>
          ) : null}
        </> : null}
        </div>
        {summary ? (
          <aside className="workbench-aside">
            <div className="card pad">
              <div className="row" style={{ fontWeight: 600 }}><Clock size={16} className="muted" />最近使用</div>
              {!summary.recent.length ? <p className="faint" style={{ marginTop: 10 }}>还没有对话记录，选一个应用开始吧。</p> : null}
              {summary.recent.map((item) => (
                <button key={item.conversation_id} className="list-row" style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => navigate(`/chat/${item.app_id}?conversation=${item.conversation_id}`)}>
                  <AppTile templateKey={item.template_key} size="sm" />
                  <div className="grow" style={{ minWidth: 0 }}><div className="ellipsis" style={{ fontSize: 13 }}>{item.title}</div><div className="faint ellipsis">{item.app_name} · {formatTime(item.updated_at)}</div></div>
                </button>
              ))}
            </div>
            <div className="card pad" style={{ background: 'linear-gradient(135deg, var(--primary-50), var(--surface))', borderColor: 'var(--primary-100)' }}>
              <div className="row" style={{ fontWeight: 600 }}><TrendingUp size={16} color="var(--primary)" />本月业务沉淀</div>
              <div className="grid c2" style={{ gap: 12, marginTop: 12 }}>
                <div><div className="faint">应用调用</div><strong style={{ fontSize: 20 }}>{summary.month.runs.toLocaleString()}</strong></div>
                <div><div className="faint">覆盖员工</div><strong style={{ fontSize: 20 }}>{summary.month.users.toLocaleString()}</strong></div>
                <div><div className="faint">新增知识</div><strong style={{ fontSize: 20 }}>{summary.month.new_chunks.toLocaleString()} 块</strong></div>
                <div><div className="faint">在用应用</div><strong style={{ fontSize: 20 }}>{summary.month.apps}</strong></div>
              </div>
            </div>
          </aside>
        ) : null}
        </div>
      </div>
    </div>
  );
}
