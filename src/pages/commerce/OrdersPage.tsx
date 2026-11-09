import { Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Drawer, Empty, Field, Loading, Modal, Tag, formatTime } from '../../components/ui';
import { ORDER_TONE, money, send, useAction, useData, type Customer, type Order, type Shop, type StockRow } from './shared';

const STATUS = [['', '全部状态'], ['paid', '待发货'], ['picking', '拣货中'], ['shipped', '已发货'], ['delivered', '已签收'], ['refunded', '已退款'], ['cancelled', '已取消']];

function NewOrder({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => unknown }) {
  const shops = useData<Shop[]>('/shops');
  const customers = useData<Customer[]>('/customers');
  const stock = useData<StockRow[]>('/inventory');
  const [form, setForm] = useState({ shop_id: '', customer_id: '', sku_id: '', quantity: 1 });
  const { busy, run } = useAction(onDone);
  const shop = form.shop_id || shops.data?.[0]?.id || '';
  const customer = form.customer_id || customers.data?.[0]?.id || '';
  const sku = form.sku_id || stock.data?.[0]?.sku_id || '';
  const chosen = stock.data?.find((item) => item.sku_id === sku);
  return (
    <Modal open={open} title="模拟下单" onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !sku} onClick={async () => { if (await run(() => send('/orders', { shop_id: shop, customer_id: customer, items: [{ sku_id: sku, quantity: form.quantity }] }), '下单成功，库存已锁定')) { onClose(); void stock.reload(); } }}>确认下单</button></>}>
      <div className="col" style={{ gap: 12 }}>
        <Field label="店铺"><select className="select" value={shop} onChange={(event) => setForm({ ...form, shop_id: event.target.value })}>{shops.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field label="买家"><select className="select" value={customer} onChange={(event) => setForm({ ...form, customer_id: event.target.value })}>{customers.data?.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.level}）</option>)}</select></Field>
        <Field label="商品" hint={chosen ? `可用 ${chosen.available}` : undefined}><select className="select" value={sku} onChange={(event) => setForm({ ...form, sku_id: event.target.value })}>{stock.data?.map((item) => <option key={item.sku_id} value={item.sku_id}>{item.name}（{item.code}）</option>)}</select></Field>
        <Field label="件数"><input className="input" type="number" min={1} value={form.quantity} onChange={(event) => setForm({ ...form, quantity: Math.max(1, Number(event.target.value)) })} /></Field>
      </div>
    </Modal>
  );
}

export function OrdersPage() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const path = useMemo(() => `/orders?status=${status}&q=${encodeURIComponent(q)}`, [status, q]);
  const { data, reload } = useData<Order[]>(path);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { busy, run } = useAction(reload);
  const selected = data?.find((item) => item.id === selectedId) ?? null;
  return (
    <div className="page">
      <div className="page-head"><div className="grow"><h1>订单</h1><p>下单时自动分仓并锁定库存，生成出库单。</p></div><button className="btn primary" onClick={() => setCreating(true)}><Plus size={15} />模拟下单</button></div>
      <div className="row wrap biz-filter">
        <div className="search-box"><Search size={14} /><input className="input" aria-label="搜索订单" placeholder="订单号或买家" value={q} onChange={(event) => setQ(event.target.value)} /></div>
        <select className="select" style={{ width: 140 }} aria-label="订单状态" value={status} onChange={(event) => setStatus(event.target.value)}>{STATUS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
      {!data ? <Loading /> : !data.length ? <div className="card"><Empty title="没有符合条件的订单" /></div> : (
        <div className="card table-card"><div className="table-scroll"><table className="table">
          <thead><tr><th>订单号</th><th>买家</th><th>商品</th><th>金额</th><th>状态</th><th>店铺</th><th>下单时间</th></tr></thead>
          <tbody>{data.map((item) => (
            <tr key={item.id} className="clickable" onClick={() => setSelectedId(item.id)}>
              <td className="mono">{item.order_no}</td><td>{item.customer}</td>
              <td><div className="biz-lines">{item.items.map((line) => <span key={line.sku_id}>{line.name} ×{line.quantity}</span>)}</div></td>
              <td>{money(item.total)}</td><td><Tag tone={ORDER_TONE[item.status]}>{item.status_label}</Tag></td><td>{item.shop}</td><td className="faint">{formatTime(item.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div></div>
      )}
      <NewOrder open={creating} onClose={() => setCreating(false)} onDone={reload} />
      <Drawer open={!!selected} title={selected?.order_no ?? ''} onClose={() => setSelectedId(null)} footer={selected ? <>
        {['paid', 'picking'].includes(selected.status) ? <button className="btn danger" disabled={busy} onClick={() => run(() => send(`/orders/${selected.id}/cancel`), '订单已取消，库存已释放')}>取消订单</button> : null}
        {selected.status === 'shipped' ? <button className="btn primary" disabled={busy} onClick={() => run(() => send(`/orders/${selected.id}/deliver`), '已标记签收')}>模拟签收</button> : null}
        {['shipped', 'delivered'].includes(selected.status) ? <button className="btn" disabled={busy} onClick={() => run(() => send('/after-sales', { order_id: selected.id, kind: 'return', reason: '坐席代客申请' }), '售后单已创建')}>发起退货</button> : null}
      </> : undefined}>
        {selected ? <div className="col" style={{ gap: 16 }}>
          <div className="row"><Tag tone={ORDER_TONE[selected.status]}>{selected.status_label}</Tag><span className="grow" /><strong>{money(selected.total)}</strong></div>
          {selected.refunded ? <div className="faint">已退款 {money(selected.refunded)}</div> : null}
          <div><div className="faint">买家</div>{selected.customer}（{selected.customer_level}）<div className="muted">{selected.address}</div></div>
          <div><div className="faint" style={{ marginBottom: 4 }}>商品</div>{selected.items.map((line) => <div key={line.sku_id} className="row"><span className="grow">{line.name} ×{line.quantity}</span><span>{money(line.price)}</span></div>)}</div>
          {selected.note ? <div><div className="faint">备注</div>{selected.note}</div> : null}
          {selected.shipment ? <div><div className="faint" style={{ marginBottom: 6 }}>{selected.shipment.carrier} · {selected.shipment.tracking_no}</div><div className="timeline">{selected.shipment.events.map((event) => <div key={event.at + event.text}><i /><span className="grow">{event.text}</span><span className="faint">{formatTime(event.at)}</span></div>)}</div></div> : <div className="faint">仓库尚未发货</div>}
        </div> : null}
      </Drawer>
    </div>
  );
}
