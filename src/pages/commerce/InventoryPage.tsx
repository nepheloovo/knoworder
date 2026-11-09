import { Search, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Drawer, Empty, Field, Loading, Modal, Tag, formatTime } from '../../components/ui';
import { send, useAction, useData, type Move, type StockRow, type WarehouseRow } from './shared';

const signed = (value: number) => (value > 0 ? `+${value}` : value < 0 ? String(value) : '—');

export function InventoryPage() {
  const [tab, setTab] = useState<'stock' | 'moves'>('stock');
  const [q, setQ] = useState('');
  const [warehouse, setWarehouse] = useState('');
  const [low, setLow] = useState(false);
  const warehouses = useData<WarehouseRow[]>('/warehouses');
  const stock = useData<StockRow[]>(`/inventory?q=${encodeURIComponent(q)}&warehouse_id=${warehouse}&low_only=${low}`);
  const moves = useData<Move[]>('/inventory/moves?limit=200');
  const reloadAll = () => Promise.all([stock.reload(), moves.reload()]);
  const { busy, run } = useAction(reloadAll);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adjust, setAdjust] = useState<{ location_id: string; delta: number; note: string } | null>(null);
  const selected = stock.data?.find((item) => item.sku_id === selectedId) ?? null;
  const skuMoves = useData<Move[]>(selectedId ? `/inventory/moves?sku_id=${selectedId}&limit=30` : '/inventory/moves?limit=1');
  return (
    <div className="page">
      <div className="page-head"><div className="grow"><h1>库存</h1><p>可用 = 在库 − 锁定。每次变动都写一条流水。</p></div></div>
      <div className="tabs" style={{ marginBottom: 14 }} role="tablist">
        <button role="tab" aria-selected={tab === 'stock'} className={`tab ${tab === 'stock' ? 'active' : ''}`} style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setTab('stock')}>库存台账</button>
        <button role="tab" aria-selected={tab === 'moves'} className={`tab ${tab === 'moves' ? 'active' : ''}`} style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => { setTab('moves'); void moves.reload(); }}>库存流水</button>
      </div>
      {tab === 'stock' ? <>
        <div className="row wrap biz-filter">
          <div className="search-box"><Search size={14} /><input className="input" aria-label="搜索 SKU" placeholder="商品名或 SKU 编码" value={q} onChange={(event) => setQ(event.target.value)} /></div>
          <select className="select" style={{ width: 160 }} aria-label="仓库" value={warehouse} onChange={(event) => setWarehouse(event.target.value)}><option value="">全部仓库</option>{warehouses.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <label className="row"><input type="checkbox" checked={low} onChange={(event) => setLow(event.target.checked)} />只看低库存</label>
        </div>
        {!stock.data ? <Loading /> : !stock.data.length ? <div className="card"><Empty title="没有库存记录" /></div> : (
          <div className="card table-card"><div className="table-scroll"><table className="table">
            <thead><tr><th>SKU</th><th>在库</th><th>锁定</th><th>可用</th><th>残次</th><th>预警</th></tr></thead>
            <tbody>{stock.data.map((item) => (
              <tr key={item.sku_id} className="clickable" onClick={() => setSelectedId(item.sku_id)}>
                <td>{item.name}<div className="faint mono">{item.code}</div></td><td>{item.on_hand}</td><td>{item.locked}</td><td><strong>{item.available}</strong></td><td>{item.damaged}</td>
                <td>{item.low ? <Tag tone="orange">低于 {item.threshold}</Tag> : <Tag tone="green">正常</Tag>}</td>
              </tr>
            ))}</tbody>
          </table></div></div>
        )}
      </> : !moves.data ? <Loading /> : !moves.data.length ? <div className="card"><Empty title="还没有库存流水" /></div> : (
        <div className="card table-card"><div className="table-scroll"><table className="table">
          <thead><tr><th>时间</th><th>SKU</th><th>货位</th><th>类型</th><th>在库</th><th>锁定</th><th>残次</th><th>变动后在库</th><th>单据</th><th>说明</th></tr></thead>
          <tbody>{moves.data.map((item) => <tr key={item.id}><td className="faint">{formatTime(item.created_at)}</td><td>{item.name}</td><td className="mono">{item.location}</td><td><Tag>{item.kind_label}</Tag></td><td>{signed(item.on_hand_delta)}</td><td>{signed(item.locked_delta)}</td><td>{signed(item.damaged_delta)}</td><td>{item.on_hand_after}</td><td className="mono">{item.ref_no}</td><td className="muted">{item.note}</td></tr>)}</tbody>
        </table></div></div>
      )}
      <Drawer wide open={!!selected} title={selected?.name ?? ''} onClose={() => setSelectedId(null)} footer={selected?.locations.length ? <button className="btn" onClick={() => setAdjust({ location_id: selected.locations[0].location_id, delta: 0, note: '' })}><SlidersHorizontal size={14} />库存调整</button> : undefined}>
        {selected ? <div className="col" style={{ gap: 16 }}>
          <div className="table-scroll"><table className="table"><thead><tr><th>仓库</th><th>货位</th><th>在库</th><th>锁定</th><th>残次</th></tr></thead><tbody>{selected.locations.map((item) => <tr key={item.location_id}><td>{item.warehouse}</td><td className="mono">{item.location}</td><td>{item.on_hand}</td><td>{item.locked}</td><td>{item.damaged}</td></tr>)}</tbody></table></div>
          <strong>最近流水</strong>
          <div className="table-scroll"><table className="table"><thead><tr><th>时间</th><th>类型</th><th>在库</th><th>锁定</th><th>单据</th></tr></thead><tbody>{skuMoves.data?.map((item) => <tr key={item.id}><td className="faint">{formatTime(item.created_at)}</td><td>{item.kind_label}</td><td>{signed(item.on_hand_delta)}</td><td>{signed(item.locked_delta)}</td><td className="mono">{item.ref_no}</td></tr>)}</tbody></table></div>
        </div> : null}
      </Drawer>
      <Modal open={!!adjust} title="库存调整" onClose={() => setAdjust(null)} footer={<><button className="btn" onClick={() => setAdjust(null)}>取消</button><button className="btn primary" disabled={busy || !adjust?.delta || !adjust.note.trim()} onClick={async () => { if (adjust && selected && await run(() => send('/inventory/adjust', { sku_id: selected.sku_id, ...adjust }), '库存已调整')) { setAdjust(null); void skuMoves.reload(); } }}>确认调整</button></>}>
        {adjust && selected ? <div className="col" style={{ gap: 12 }}>
          <Field label="货位"><select className="select" value={adjust.location_id} onChange={(event) => setAdjust({ ...adjust, location_id: event.target.value })}>{selected.locations.map((item) => <option key={item.location_id} value={item.location_id}>{item.warehouse} · {item.location}</option>)}</select></Field>
          <Field label="调整数量" hint="正数增加，负数减少"><input className="input" type="number" value={adjust.delta} onChange={(event) => setAdjust({ ...adjust, delta: Number(event.target.value) })} /></Field>
          <Field label="原因" required><input className="input" placeholder="例如：盘点差异" value={adjust.note} onChange={(event) => setAdjust({ ...adjust, note: event.target.value })} /></Field>
        </div> : null}
      </Modal>
    </div>
  );
}
