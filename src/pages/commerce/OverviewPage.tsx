import { AlertTriangle, Clock, Headset, PackageCheck, ReceiptText, RotateCcw, Timer, TrendingUp, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { Empty, Loading, Tag } from '../../components/ui';
import { money, percent, send, useAction, useData, type StockRow } from './shared';

type Overview = {
  has_data: boolean; orders_today: number; gmv_today: number; to_ship: number; after_sales: number; queued: number; ai_resolved_rate: number | null; handoff_rate: number | null;
  avg_ship_hours: number | null; stock_turnover: number | null; low_stock: StockRow[]; low_stock_count: number; order_status: Array<{ status: string; label: string; count: number }>;
};

const STEPS: Array<[string, string]> = [['模拟下单', '/orders'], ['拣货发货', '/outbound'], ['买家咨询', '/service/buyer'], ['坐席接管', '/service'], ['售后审核', '/after-sales'], ['退货入库', '/after-sales'], ['查看库存', '/inventory']];

function Stat({ icon, label, value, hint, to }: { icon: ReactNode; label: string; value: string; hint?: string; to?: string }) {
  const body = <><div className="label">{icon}{label}</div><div className="value">{value}</div><div className="delta" style={{ color: 'var(--text-4)' }}>{hint ?? ' '}</div></>;
  return to ? <Link to={to} className="card stat hover">{body}</Link> : <div className="card stat">{body}</div>;
}

export function OverviewPage() {
  const { me } = useAuth();
  const { data, reload } = useData<Overview>('/overview');
  const { busy, run } = useAction(reload);
  if (!data) return <div className="page"><Loading /></div>;
  if (!data.has_data) {
    return (
      <div className="page">
        <div className="page-head"><div className="grow"><h1>业务总览</h1><p>智能客服与仓储管理的经营数据。</p></div></div>
        <div className="card">
          <Empty title="还没有业务数据" desc={me?.role === 'admin' ? '载入一组演示商品、库存、订单和客服 Agent，就可以走完整流程。' : '请管理员先载入演示数据。'} action={me?.role === 'admin' ? <button className="btn primary" disabled={busy} onClick={() => run(() => send('/demo/seed'), '演示数据已载入')}>载入演示数据</button> : undefined} />
        </div>
      </div>
    );
  }
  const totalOrders = Math.max(1, ...data.order_status.map((item) => item.count));
  return (
    <div className="page">
      <div className="page-head"><div className="grow"><h1>业务总览</h1><p>今天的订单、履约、客服和库存情况。</p></div></div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <Stat icon={<ReceiptText size={15} />} label="今日订单" value={String(data.orders_today)} to="/orders" />
        <Stat icon={<Wallet size={15} />} label="今日成交额" value={money(data.gmv_today)} />
        <Stat icon={<PackageCheck size={15} />} label="待发货" value={String(data.to_ship)} to="/outbound" />
        <Stat icon={<RotateCcw size={15} />} label="处理中售后" value={String(data.after_sales)} to="/after-sales" />
        <Stat icon={<Headset size={15} />} label="排队待接入" value={String(data.queued)} to="/service" />
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginTop: 16 }}>
        <Stat icon={<TrendingUp size={15} />} label="AI 解决率" value={percent(data.ai_resolved_rate)} hint="未转人工的会话占比" />
        <Stat icon={<Headset size={15} />} label="转人工率" value={percent(data.handoff_rate)} />
        <Stat icon={<Timer size={15} />} label="平均发货时长" value={data.avg_ship_hours === null ? '—' : `${data.avg_ship_hours} 小时`} hint="近 30 天" />
        <Stat icon={<Clock size={15} />} label="库存周转" value={data.stock_turnover === null ? '—' : `${data.stock_turnover} 次`} hint="近 30 天出库量 ÷ 当前在库" />
      </div>
      <div className="row wrap" style={{ alignItems: 'stretch', gap: 16, marginTop: 16 }}>
        <div className="card pad grow" style={{ minWidth: 320 }}>
          <div className="row" style={{ marginBottom: 12 }}><AlertTriangle size={16} color="var(--orange)" /><strong className="grow">低库存预警</strong><Link className="faint" to="/inventory">共 {data.low_stock_count} 个 SKU</Link></div>
          {data.low_stock.length ? <div className="table-scroll"><table className="table"><thead><tr><th>SKU</th><th>可用</th><th>预警线</th></tr></thead><tbody>
            {data.low_stock.map((item) => <tr key={item.sku_id}><td>{item.name}<div className="faint mono">{item.code}</div></td><td><Tag tone="orange">{item.available}</Tag></td><td>{item.threshold}</td></tr>)}
          </tbody></table></div> : <div className="faint">库存都在安全线以上。</div>}
        </div>
        <div className="card pad" style={{ flex: '1 1 300px' }}>
          <strong style={{ display: 'block', marginBottom: 12 }}>订单状态</strong>
          <div className="col" style={{ gap: 10 }}>
            {data.order_status.map((item) => <div key={item.status}><div className="row"><span className="grow">{item.label}</span><strong>{item.count}</strong></div><div style={{ height: 6, borderRadius: 3, background: 'var(--bg-soft)', marginTop: 4 }}><div style={{ height: 6, borderRadius: 3, background: 'var(--primary)', width: `${(item.count / totalOrders) * 100}%` }} /></div></div>)}
          </div>
        </div>
      </div>
      <div className="section-title">演示主线<small>按顺序点开，走完一单从下单到退货入库</small></div>
      <div className="step-strip">{STEPS.map(([label, to], index) => <Link key={label} to={to}>{index + 1}. {label}</Link>)}</div>
    </div>
  );
}
