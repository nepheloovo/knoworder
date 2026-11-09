import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Empty, Field, Loading, Modal, Tag } from '../../components/ui';
import { send, useAction, useData, type WarehouseRow } from './shared';

export function WarehousesPage() {
  const { data, reload } = useData<WarehouseRow[]>('/warehouses');
  const { busy, run } = useAction(reload);
  const [creating, setCreating] = useState<{ code: string; name: string; address: string } | null>(null);
  const [place, setPlace] = useState<{ warehouse: WarehouseRow; code: string; zone: string; kind: string } | null>(null);
  return (
    <div className="page">
      <div className="page-head"><div className="grow"><h1>仓库</h1><p>仓库和货位。残次区的库存不参与订单分配。</p></div><button className="btn primary" onClick={() => setCreating({ code: '', name: '', address: '' })}><Plus size={15} />新增仓库</button></div>
      {!data ? <Loading /> : !data.length ? <div className="card"><Empty title="还没有仓库" /></div> : (
        <div className="col" style={{ gap: 16 }}>{data.map((item) => (
          <div key={item.id} className="card pad">
            <div className="row" style={{ marginBottom: 12 }}><strong>{item.name}</strong><span className="mono faint">{item.code}</span><span className="muted grow">{item.address}</span><button className="btn sm" onClick={() => setPlace({ warehouse: item, code: '', zone: '', kind: 'storage' })}><Plus size={13} />新增货位</button></div>
            <div className="row wrap">{item.locations.map((location) => <Tag key={location.id} tone={location.kind === 'damaged' ? 'red' : ''}>{location.code}{location.kind === 'damaged' ? ' · 残次区' : ''}</Tag>)}</div>
          </div>
        ))}</div>
      )}
      <Modal open={!!creating} title="新增仓库" onClose={() => setCreating(null)} footer={<><button className="btn" onClick={() => setCreating(null)}>取消</button><button className="btn primary" disabled={busy || !creating?.code.trim() || !creating.name.trim()} onClick={async () => { if (creating && await run(() => send('/warehouses', creating), '仓库已创建')) setCreating(null); }}>保存</button></>}>
        {creating ? <div className="col" style={{ gap: 12 }}>
          <Field label="编码" required><input className="input" value={creating.code} onChange={(event) => setCreating({ ...creating, code: event.target.value })} /></Field>
          <Field label="名称" required><input className="input" value={creating.name} onChange={(event) => setCreating({ ...creating, name: event.target.value })} /></Field>
          <Field label="地址"><input className="input" value={creating.address} onChange={(event) => setCreating({ ...creating, address: event.target.value })} /></Field>
        </div> : null}
      </Modal>
      <Modal open={!!place} title={`新增货位 · ${place?.warehouse.name ?? ''}`} onClose={() => setPlace(null)} footer={<><button className="btn" onClick={() => setPlace(null)}>取消</button><button className="btn primary" disabled={busy || !place?.code.trim()} onClick={async () => { if (place && await run(() => send(`/warehouses/${place.warehouse.id}/locations`, { code: place.code, zone: place.zone, kind: place.kind }), '货位已创建')) setPlace(null); }}>保存</button></>}>
        {place ? <div className="col" style={{ gap: 12 }}>
          <Field label="货位编码" required><input className="input" placeholder="例如 A-04-01" value={place.code} onChange={(event) => setPlace({ ...place, code: event.target.value })} /></Field>
          <Field label="库区"><input className="input" value={place.zone} onChange={(event) => setPlace({ ...place, zone: event.target.value })} /></Field>
          <Field label="类型"><select className="select" value={place.kind} onChange={(event) => setPlace({ ...place, kind: event.target.value })}><option value="storage">可售货位</option><option value="damaged">残次区</option></select></Field>
        </div> : null}
      </Modal>
    </div>
  );
}
