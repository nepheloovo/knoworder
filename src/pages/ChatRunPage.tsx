import { ArrowLeft, MessageSquarePlus, Pencil } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { fdeApi, type Citation, type FDEApp } from '../api/fde';
import { isManager, useAuth } from '../auth';
import { ChatPanel } from '../components/ChatPanel';
import { AppTile, Loading, Notice, Tag, formatTime } from '../components/ui';
import { TYPE_META } from '../lib/apps';

type Conversation = { id: string; messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; citations: Citation[] }> };

export function ChatRunPage() {
  const { appId = '' } = useParams();
  const { me } = useAuth();
  const [app, setApp] = useState<FDEApp | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; title: string; updated_at: string }>>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [session, setSession] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');

  const loadHistory = useCallback(() => fdeApi.myConversations(appId).then((list) => { setHistory(list); setHistoryError(''); }).catch((caught) => setHistoryError(errorMessage(caught))), [appId]);
  useEffect(() => { fdeApi.get(appId).then(setApp).catch((caught) => setError(errorMessage(caught))); void loadHistory(); }, [appId, loadHistory]);
  // 从工作台「最近使用」进入时直接打开那次对话
  const [searchParams] = useSearchParams();
  const openConversation = searchParams.get('conversation');
  useEffect(() => {
    if (!openConversation) return;
    fdeApi.conversation(openConversation).then((value) => { setCurrent(value); setActiveId(openConversation); setSession((count) => count + 1); }).catch((caught) => setHistoryError(errorMessage(caught)));
  }, [openConversation]);

  if (error) return <div className="page"><Notice tone="error" title="无法打开应用">{error}</Notice></div>;
  if (!app) return <Loading />;
  const published = app.published_version;
  if (!app.is_enabled || !published) return <div className="page"><Notice tone="warn" title="应用未上线">该应用尚未发布或已下线。</Notice></div>;
  const manifest = published.manifest;

  return (
    <div className="sub-layout">
      <aside className="sub-side" style={{ width: 248 }}>
        <Link className="back" to="/workbench"><ArrowLeft size={14} />工作台</Link>
        <div className="row" style={{ padding: '0 6px 12px', alignItems: 'flex-start' }}>
          <AppTile templateKey={manifest.template_key} type={manifest.type} />
          <div className="grow"><strong style={{ display: 'block' }}>{app.name}</strong><span className="faint">v{published.version}</span></div>
        </div>
        <p className="faint" style={{ padding: '0 6px 12px' }}>{app.description}</p>
        <button className="btn" style={{ margin: '0 4px 12px' }} onClick={() => { setCurrent(null); setActiveId(null); setSession((value) => value + 1); }}><MessageSquarePlus size={15} />新对话</button>
        <div className="faint" style={{ padding: '0 6px 4px' }}>我的历史对话</div>
        {history.length ? history.map((item) => (
          <button key={item.id} className={`sub-link ${activeId === item.id ? 'active' : ''}`} style={{ fontSize: 13, flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}
            onClick={async () => { try { setCurrent(await fdeApi.conversation(item.id)); setActiveId(item.id); setSession((value) => value + 1); } catch (caught) { setHistoryError(errorMessage(caught)); } }}>
            <span className="ellipsis" style={{ width: '100%' }}>{item.title}</span><span className="faint">{formatTime(item.updated_at)}</span>
          </button>
        )) : historyError ? null : <span className="faint" style={{ padding: '0 6px' }}>暂无</span>}
        {historyError ? <div style={{ padding: '6px 4px' }}><Notice tone="error" action={<button className="btn sm" onClick={() => void loadHistory()}>重试</button>}>历史对话加载失败：{historyError}</Notice></div> : null}
      </aside>
      <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="row" style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)' }}>
          <strong>{app.name}</strong><Tag tone={TYPE_META[manifest.type].tone}>{TYPE_META[manifest.type].name}</Tag>
          <span className="grow" />
          {isManager(me?.role) ? <Link to={`/apps/${app.id}`} className="btn sm ghost"><Pencil size={13} />编排</Link> : null}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ChatPanel key={session} appId={app.id} manifest={manifest} mode="run" initialConversation={current} onConversation={(id) => { setActiveId(id); void loadHistory(); }} />
        </div>
      </section>
    </div>
  );
}
