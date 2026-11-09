import { Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loading, Notice, Spinner, Tag } from '../../components/ui';
import { ChatBubbles } from './ChatBubbles';
import { ORDER_TONE, SESSION_LABEL, money, send as post, useAction, useData, type ChatMessage, type Customer, type Order, type SessionDetail } from './shared';

const QUICK = ['我的订单', '物流到哪了', '咖啡机还有货吗', '买了不想要能退吗', '我要退货', '转人工'];
type Status = { app: { id: string; name: string } | null; simulated: boolean; model?: string | null };

export function BuyerPage() {
  const customers = useData<Customer[]>('/customers');
  const status = useData<Status>('/service/status');
  const [customerId, setCustomerId] = useState('');
  const current = customerId || customers.data?.[0]?.id || '';
  const session = useData<SessionDetail | null>(current ? `/service/customers/${current}/session` : '/service/status', current ? 2000 : 0);
  const orders = useData<Order[]>(`/orders`);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<ChatMessage | null>(null);
  const { busy, run } = useAction();

  useEffect(() => { setPending(null); }, [current]);

  const ask = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setPending({ id: 'pending', role: 'user', content: message, citations: [], simulated: false, created_at: '' });
    await run(async () => session.setData(await post<SessionDetail>('/service/chat', { customer_id: current, message })));
    setPending(null);
    void orders.reload();
  };

  if (!customers.data || !status.data) return <Loading />;
  if (!customers.data.length) return <div className="page"><Notice title="还没有买家数据" action={<Link className="btn sm" to="/commerce">去载入</Link>}>请先在业务总览载入演示数据。</Notice></div>;
  const detail = session.data && 'messages' in session.data ? session.data : null;
  const messages = [...(detail?.messages ?? []), ...(pending ? [pending] : [])];
  const mine = (orders.data ?? []).filter((item) => item.customer_id === current).slice(0, 6);
  const [label, tone] = SESSION_LABEL[detail?.status ?? 'ai'];
  return (
    <>
      <div className="page-bar">
        <h1>买家模拟端</h1>
        <select className="select" style={{ width: 200 }} aria-label="当前买家" value={current} onChange={(event) => setCustomerId(event.target.value)}>{customers.data.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.level}）</option>)}</select>
        <Tag tone={tone}>{label}</Tag>
        {status.data.simulated ? <Tag tone="orange" title="未接入真实模型，按关键词识别意图，查到的订单和库存是真实数据">规则演示模式</Tag> : <Tag tone="green">{status.data.model}</Tag>}
        <span className="grow" />
        <Link className="btn sm" to="/service">打开客服工作台</Link>
      </div>
      <div className="buyer-layout">
        <div className="chat">
          {messages.length ? <ChatBubbles messages={messages} mine="user" /> : <div className="chat-scroll"><div className="msg-system">您好，有什么可以帮您？</div></div>}
          <div className="suggest" style={{ margin: '0 20px' }}>{QUICK.map((item) => <button key={item} disabled={busy} onClick={() => ask(item)}>{item}</button>)}</div>
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void ask(input); }}>
            <textarea rows={1} aria-label="买家消息" placeholder="以买家身份发送消息" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(input); } }} />
            <button className="btn primary icon" disabled={busy || !input.trim()} aria-label="发送">{busy ? <Spinner size={14} /> : <Send size={15} />}</button>
          </form>
        </div>
        <div className="service-side">
          <strong>这位买家的订单</strong>
          {mine.map((item) => <div key={item.id} className="card pad"><div className="row"><span className="mono grow ellipsis">{item.order_no}</span><Tag tone={ORDER_TONE[item.status]}>{item.status_label}</Tag></div><div className="biz-lines" style={{ marginTop: 6 }}>{item.items.map((line) => <span key={line.sku_id}>{line.name} ×{line.quantity}</span>)}</div><div className="faint" style={{ marginTop: 4 }}>{money(item.total)}</div></div>)}
          {!mine.length ? <div className="faint">暂无订单</div> : null}
        </div>
      </div>
    </>
  );
}
