import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Loading, Tag, formatTime } from '../../components/ui';
import { AFTER_SALE_TONE, money, send, useAction, useData, type AfterSale } from './shared';

const TABS = [['', '全部'], ['requested', '待审核'], ['approved', '待寄回'], ['returning', '退回中'], ['completed', '已完成'], ['rejected', '已驳回']];
const SOURCE: Record<string, string> = { ai: 'AI 创建', agent: '坐席创建', manual: '后台创建' };

export function AfterSalesPage() {
  const [status, setStatus] = useState('');
  const { data, reload } = useData<AfterSale[]>(`/after-sales?status=${status}`);
  const { busy, run } = useAction(reload);
  const act = (item: AfterSale, path: string, body: unknown, done: string) => run(() => send(`/after-sales/${item.id}/${path}`, body), done);
  return (
    <div className="page">
      <div className="page-head"><div className="grow"><h1>售后</h1><p>退款金额由系统按订单计算。退货由仓库收货后入库，良品回到可售库存。</p></div></div>
      <div className="tabs" style={{ marginBottom: 14 }} role="tablist">{TABS.map(([value, label]) => <button key={value} role="tab" aria-selected={status === value} className={`tab ${status === value ? 'active' : ''}`} style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setStatus(value)}>{label}</button>)}</div>
      {!data ? <Loading /> : !data.length ? <div className="card"><Empty title="没有售后单" /></div> : (
        <div className="card table-card"><div className="table-scroll"><table className="table">
          <thead><tr><th>售后单</th><th>订单</th><th>买家</th><th>类型</th><th>原因</th><th>金额</th><th>状态</th><th>来源</th><th>操作</th></tr></thead>
          <tbody>{data.map((item) => (
            <tr key={item.id}>
              <td className="mono">{item.after_sale_no}<div className="faint">{formatTime(item.created_at)}</div></td>
              <td className="mono"><Link to={`/orders`}>{item.order_no}</Link></td><td>{item.customer}</td><td>{item.kind_label}</td><td style={{ maxWidth: 200 }}><div className="clamp-2">{item.reason}</div></td>
              <td>{money(item.amount)}</td><td><Tag tone={AFTER_SALE_TONE[item.status]}>{item.status_label}</Tag>{item.result_note ? <div className="faint">{item.result_note}</div> : null}</td><td>{SOURCE[item.source] ?? item.source}</td>
              <td><div className="row">
                {item.status === 'requested' ? <><button className="btn sm primary" disabled={busy} onClick={() => act(item, 'review', { approve: true }, '已通过')}>通过</button><button className="btn sm" disabled={busy} onClick={() => act(item, 'review', { approve: false }, '已驳回')}>驳回</button></> : null}
                {item.status === 'approved' ? <button className="btn sm" disabled={busy} onClick={() => act(item, 'returning', {}, '已标记买家寄回')}>买家已寄回</button> : null}
                {item.status === 'returning' ? <><button className="btn sm primary" disabled={busy} onClick={() => act(item, 'receive', { condition: 'good' }, '良品已入库')}>良品入库</button><button className="btn sm" disabled={busy} onClick={() => act(item, 'receive', { condition: 'damaged' }, '已入残次区')}>残次入库</button></> : null}
              </div></td>
            </tr>
          ))}</tbody>
        </table></div></div>
      )}
    </div>
  );
}
