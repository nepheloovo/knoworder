import { useState } from 'react';
import { Empty, Loading, Tag, formatTime } from '../../components/ui';
import { send, useAction, useData, type Outbound } from './shared';

const TABS = [['pending', '待拣货'], ['picked', '待复核'], ['checked', '待发货'], ['shipped', '已发货'], ['cancelled', '已取消'], ['', '全部']];
const STATUS: Record<string, [string, string]> = { pending: ['待拣货', 'orange'], picked: ['待复核', 'blue'], checked: ['待发货', 'purple'], shipped: ['已发货', 'green'], cancelled: ['已取消', ''] };
const NEXT: Record<string, [string, string, string]> = { pending: ['pick', '拣货完成', '已拣货'], picked: ['check', '复核通过', '已复核'], checked: ['ship', '打包发货', '已发货，库存已扣减'] };

export function OutboundPage() {
  const [status, setStatus] = useState('pending');
  const { data, reload } = useData<Outbound[]>(`/outbound?status=${status}`);
  const { busy, run } = useAction(reload);
  return (
    <div className="page">
      <div className="page-head"><div className="grow"><h1>出库</h1><p>按货位拣货，复核后打包发货。发货时扣减在库和锁定库存，并生成运单。</p></div></div>
      <div className="tabs" style={{ marginBottom: 14 }} role="tablist">{TABS.map(([value, label]) => <button key={value} role="tab" aria-selected={status === value} className={`tab ${status === value ? 'active' : ''}`} style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setStatus(value)}>{label}</button>)}</div>
      {!data ? <Loading /> : !data.length ? <div className="card"><Empty title="这个状态下没有出库单" /></div> : (
        <div className="card table-card"><div className="table-scroll"><table className="table">
          <thead><tr><th>出库单</th><th>订单</th><th>买家</th><th>仓库</th><th>拣货明细</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>{data.map((item) => {
            const next = NEXT[item.status];
            return <tr key={item.id}>
              <td className="mono">{item.outbound_no}<div className="faint">{formatTime(item.created_at)}</div></td><td className="mono">{item.order_no}</td><td>{item.customer}</td><td>{item.warehouse}</td>
              <td><div className="biz-lines">{item.lines.map((line, index) => <span key={index}><span className="mono">{line.location}</span> · {line.name} ×{line.quantity}</span>)}</div></td>
              <td><Tag tone={STATUS[item.status][1]}>{STATUS[item.status][0]}</Tag></td>
              <td>{next ? <button className="btn sm primary" disabled={busy} onClick={() => run(() => send(`/outbound/${item.id}/${next[0]}`), next[2])}>{next[1]}</button> : null}</td>
            </tr>;
          })}</tbody>
        </table></div></div>
      )}
    </div>
  );
}
