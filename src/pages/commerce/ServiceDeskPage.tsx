import { Send } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Loading, Spinner, Tag, formatTime } from '../../components/ui';
import { ChatBubbles } from './ChatBubbles';
import { ORDER_TONE, SESSION_LABEL, money, send, useAction, useData, type SessionDetail, type SessionSummary } from './shared';

const TABS: Array<[string, string]> = [['queued,serving', '待处理'], ['ai', '机器人接待'], ['closed', '已结束']];

export function ServiceDeskPage() {
  const [tab, setTab] = useState(TABS[0][0]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const list = useData<SessionSummary[]>(`/service/sessions?status=${tab}`, 2000);
  const detail = useData<SessionDetail>(selectedId ? `/service/sessions/${selectedId}` : '/service/sessions?status=none', selectedId ? 2000 : 0);
  const reloadAll = () => Promise.all([list.reload(), detail.reload()]);
  const { busy, run } = useAction(reloadAll);
  const current = selectedId && detail.data && 'messages' in detail.data && detail.data.id === selectedId ? detail.data : null;
  const act = (action: string, done: string) => current && run(() => send(`/service/sessions/${current.id}/${action}`), done);
  const submit = async () => {
    const content = reply.trim();
    if (!content || !current) return;
    if (await run(() => send(`/service/sessions/${current.id}/reply`, { content }))) setReply('');
  };
  return (
    <>
      <div className="page-bar">
        <h1>客服工作台</h1>
        <span className="faint">机器人转接的会话在这里排队，接入后机器人停止回复。</span>
        <span className="grow" />
        <Link className="btn sm" to="/service/buyer">打开买家模拟端</Link>
      </div>
      <div className="service-layout">
        <div>
          <div className="tabs" role="tablist" style={{ padding: '0 8px' }}>{TABS.map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} className={`tab ${tab === value ? 'active' : ''}`} style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setTab(value)}>{label}</button>)}</div>
          {!list.data ? <Loading /> : !list.data.length ? <Empty title="暂无会话" /> : (
            <div className="session-list">{list.data.map((item) => {
              const [label, tone] = SESSION_LABEL[item.status];
              return <button key={item.id} className={`session-item ${selectedId === item.id ? 'active' : ''}`} onClick={() => setSelectedId(item.id)}>
                <div className="row"><strong className="grow ellipsis">{item.customer}</strong><Tag tone={tone}>{label}</Tag></div>
                <div className="faint ellipsis" style={{ marginTop: 4 }}>{item.last_message}</div>
              </button>;
            })}</div>
          )}
        </div>
        <div className="chat">
          {!current ? <Empty title="选择左侧的会话" desc="可以看到机器人和买家的全部对话" /> : <>
            <div className="page-bar">
              <strong className="grow">{current.customer}<span className="faint" style={{ marginLeft: 8 }}>{current.level}</span></strong>
              {current.status === 'queued' ? <button className="btn sm primary" disabled={busy} onClick={() => act('accept', '已接入')}>接入会话</button> : null}
              {current.status === 'serving' ? <button className="btn sm" disabled={busy} onClick={() => act('release', '已交还机器人')}>交还机器人</button> : null}
              {current.status !== 'closed' ? <button className="btn sm" disabled={busy} onClick={() => act('close', '会话已结束')}>结束会话</button> : null}
            </div>
            <ChatBubbles messages={current.messages} mine="agent" />
            <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
              <textarea rows={1} aria-label="坐席回复" disabled={current.status !== 'serving'} placeholder={current.status === 'serving' ? '回复买家，Enter 发送' : '接入会话后才能回复'} value={reply} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
              <button className="btn primary icon" disabled={busy || !reply.trim() || current.status !== 'serving'} aria-label="发送回复">{busy ? <Spinner size={14} /> : <Send size={15} />}</button>
            </form>
          </>}
        </div>
        <div className="service-side">
          {current ? <>
            {current.summary ? <div className="card pad"><strong style={{ display: 'block', marginBottom: 6 }}>转接摘要</strong><div className="summary-text">{current.summary}</div>{current.queued_at ? <div className="faint" style={{ marginTop: 6 }}>{formatTime(current.queued_at)} 进入排队</div> : null}</div> : null}
            <strong>买家订单</strong>
            {current.orders?.map((item) => <div key={item.id} className="card pad">
              <div className="row"><span className="mono grow ellipsis">{item.order_no}</span><Tag tone={ORDER_TONE[item.status]}>{item.status_label}</Tag></div>
              <div className="biz-lines" style={{ marginTop: 6 }}>{item.items.map((line) => <span key={line.sku_id}>{line.name} ×{line.quantity}</span>)}</div>
              <div className="faint" style={{ marginTop: 4 }}>{money(item.total)}{item.shipment ? ` · ${item.shipment.carrier} ${item.shipment.tracking_no}` : ''}</div>
              {['shipped', 'delivered'].includes(item.status) ? <button className="btn sm" style={{ marginTop: 8 }} disabled={busy} onClick={() => run(() => send('/after-sales', { order_id: item.id, kind: 'return', reason: `坐席 ${current.assignee || ''} 代客申请`.replace('  ', ' ') }), '售后单已创建')}>发起退货</button> : null}
            </div>)}
          </> : <div className="faint">接入会话后，这里显示转接摘要和买家订单。</div>}
        </div>
      </div>
    </>
  );
}
