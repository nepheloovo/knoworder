import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Empty, Field, Loading, Modal, Tag, formatTime } from '../../components/ui';
import { send, useAction, useData, type Inbound, type StockRow, type WarehouseRow } from './shared';

const STATUS: Record<string, [string, string]> = { pending: ['待到货', 'orange'], received: ['待上架', 'blue'], completed: ['已完成', 'green'] };

export function InboundPage() {
  const { data, reload } = useData<Inbound[]>('/inbound');
  const warehouses = useData<WarehouseRow[]>('/warehouses');
  const stock = useData<StockRow[]>('/inventory');
  const { busy, run } = useAction(reload);
  const [creating, setCreating] = useState<{ warehouse_id: string; supplier: string; lines: Array<{ sku_id: string; expected: number }> } | null>(null);
  const [receiving, setReceiving] = useState<{ item: Inbound; values: Record<string, number> } | null>(null);
  const [placing, setPlacing] = useState<{ item: Inbound; values: Record<string, string> } | null>(null);
  const shelves = (warehouseId: string) => warehouses.data?.find((item) => item.id === warehouseId)?.locations.filter((place) => place.kind === 'storage') ?? [];
  const firstSku = stock.data?.[0]?.sku_id ?? '';
  return (
    <div className="page">
      <div className="page-head"><div className="grow"><h1>入库</h1><p>到货确认实收数量，上架到货位后计入库存。</p></div><button className="btn primary" disabled={!warehouses.data?.length || !firstSku} onClick={() => setCreating({ warehouse_id: warehouses.data?.[0]?.id ?? '', supplier: '', lines: [{ sku_id: firstSku, expected: 10 }] })}><Plus size={15} />新建入库单</button></div>
      {!data ? <Loading /> : !data.length ? <div className="card"><Empty title="还没有入库单" /></div> : (
        <div className="card table-card"><div className="table-scroll"><table className="table">
          <thead><tr><th>入库单</th><th>仓库</th><th>供应商</th><th>明细</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>{data.map((item) => (
            <tr key={item.id}>
              <td className="mono">{item.inbound_no}<div className="faint">{formatTime(item.created_at)}</div></td><td>{item.warehouse}</td><td>{item.supplier}</td>
              <td><div className="biz-lines">{item.lines.map((line) => <span key={line.id}>{line.name} · 应收 {line.expected}{item.status !== 'pending' ? ` · 实收 ${line.received}` : ''}{line.location ? ` · ${line.location}` : ''}</span>)}</div></td>
              <td><Tag tone={STATUS[item.status][1]}>{STATUS[item.status][0]}</Tag></td>
              <td>
                {item.status === 'pending' ? <button className="btn sm primary" onClick={() => setReceiving({ item, values: Object.fromEntries(item.lines.map((line) => [line.id, line.expected])) })}>确认到货</button> : null}
                {item.status === 'received' ? <button className="btn sm primary" onClick={() => setPlacing({ item, values: Object.fromEntries(item.lines.map((line) => [line.id, shelves(item.warehouse_id)[0]?.id ?? ''])) })}>上架</button> : null}
              </td>
            </tr>
          ))}</tbody>
        </table></div></div>
      )}
      <Modal open={!!creating} wide title="新建入库单" onClose={() => setCreating(null)} footer={<><button className="btn" onClick={() => setCreating(null)}>取消</button><button className="btn primary" disabled={busy} onClick={async () => { if (creating && await run(() => send('/inbound', creating), '入库单已创建')) setCreating(null); }}>保存</button></>}>
        {creating ? <div className="col" style={{ gap: 12 }}>
          <div className="row">
            <div className="grow"><Field label="仓库"><select className="select" value={creating.warehouse_id} onChange={(event) => setCreating({ ...creating, warehouse_id: event.target.value })}>{warehouses.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
            <div className="grow"><Field label="供应商"><input className="input" value={creating.supplier} onChange={(event) => setCreating({ ...creating, supplier: event.target.value })} /></Field></div>
          </div>
          {creating.lines.map((line, index) => {
            const update = (patch: Partial<typeof line>) => setCreating({ ...creating, lines: creating.lines.map((item, position) => (position === index ? { ...item, ...patch } : item)) });
            return <div className="row" key={index} style={{ alignItems: 'flex-end' }}>
              <div className="grow"><Field label="SKU"><select className="select" value={line.sku_id} onChange={(event) => update({ sku_id: event.target.value })}>{stock.data?.map((item) => <option key={item.sku_id} value={item.sku_id}>{item.name}（{item.code}）</option>)}</select></Field></div>
              <div style={{ width: 110 }}><Field label="应收数量"><input className="input" type="number" min={1} value={line.expected} onChange={(event) => update({ expected: Math.max(1, Number(event.target.value)) })} /></Field></div>
              <button className="btn icon" aria-label="删除这一行" disabled={creating.lines.length === 1} onClick={() => setCreating({ ...creating, lines: creating.lines.filter((_, position) => position !== index) })}><Trash2 size={15} /></button>
            </div>;
          })}
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setCreating({ ...creating, lines: [...creating.lines, { sku_id: firstSku, expected: 10 }] })}><Plus size={13} />加一行</button>
        </div> : null}
      </Modal>
      <Modal open={!!receiving} title="确认到货" onClose={() => setReceiving(null)} footer={<><button className="btn" onClick={() => setReceiving(null)}>取消</button><button className="btn primary" disabled={busy} onClick={async () => { if (receiving && await run(() => send(`/inbound/${receiving.item.id}/receive`, { received: receiving.values }), '已确认到货')) setReceiving(null); }}>确认</button></>}>
        {receiving ? <div className="col" style={{ gap: 12 }}>{receiving.item.lines.map((line) => <Field key={line.id} label={line.name} hint={`应收 ${line.expected}`}><input className="input" type="number" min={0} aria-label={`${line.name} 实收数量`} value={receiving.values[line.id]} onChange={(event) => setReceiving({ ...receiving, values: { ...receiving.values, [line.id]: Math.max(0, Number(event.target.value)) } })} /></Field>)}</div> : null}
      </Modal>
      <Modal open={!!placing} title="上架到货位" onClose={() => setPlacing(null)} footer={<><button className="btn" onClick={() => setPlacing(null)}>取消</button><button className="btn primary" disabled={busy} onClick={async () => { if (placing && await run(() => send(`/inbound/${placing.item.id}/putaway`, { locations: placing.values }), '已上架，库存已增加')) { setPlacing(null); void stock.reload(); } }}>确认上架</button></>}>
        {placing ? <div className="col" style={{ gap: 12 }}>{placing.item.lines.map((line) => <Field key={line.id} label={line.name} hint={`实收 ${line.received}`}><select className="select" aria-label={`${line.name} 上架货位`} value={placing.values[line.id]} onChange={(event) => setPlacing({ ...placing, values: { ...placing.values, [line.id]: event.target.value } })}>{shelves(placing.item.warehouse_id).map((place) => <option key={place.id} value={place.id}>{place.code}（{place.zone} 区）</option>)}</select></Field>)}</div> : null}
      </Modal>
    </div>
  );
}
