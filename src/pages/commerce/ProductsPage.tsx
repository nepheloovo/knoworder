import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { isManager, useAuth } from '../../auth';
import { Empty, Field, Loading, Modal, Tag } from '../../components/ui';
import { money, send, useAction, useData, type Product, type SkuRow } from './shared';

const blankSku = { code: '', spec: '', price: 0, low_stock_threshold: 10 };

export function ProductsPage() {
  const { me } = useAuth();
  const canEdit = isManager(me?.role);
  const { data, reload } = useData<Product[]>('/products');
  const { busy, run } = useAction(reload);
  const [form, setForm] = useState<{ name: string; category: string; skus: typeof blankSku[] } | null>(null);
  const [editing, setEditing] = useState<SkuRow | null>(null);
  return (
    <div className="page">
      <div className="page-head"><div className="grow"><h1>商品</h1><p>商品和 SKU 资料。智能客服查库存时使用这里的名称和规格。</p></div>{canEdit ? <button className="btn primary" onClick={() => setForm({ name: '', category: '', skus: [{ ...blankSku }] })}><Plus size={15} />新增商品</button> : null}</div>
      {!data ? <Loading /> : !data.length ? <div className="card"><Empty title="还没有商品" /></div> : (
        <div className="card table-card"><div className="table-scroll"><table className="table">
          <thead><tr><th>商品</th><th>类目</th><th>SKU 编码</th><th>规格</th><th>售价</th><th>预警线</th>{canEdit ? <th /> : null}</tr></thead>
          <tbody>{data.flatMap((product) => product.skus.map((sku, index) => (
            <tr key={sku.id}>
              {index === 0 ? <td rowSpan={product.skus.length}><strong>{product.name}</strong>{product.is_active ? null : <Tag tone="red">已下架</Tag>}</td> : null}
              {index === 0 ? <td rowSpan={product.skus.length}>{product.category}</td> : null}
              <td className="mono">{sku.code}</td><td>{sku.spec}</td><td>{money(sku.price)}</td><td>{sku.low_stock_threshold}</td>
              {canEdit ? <td><button className="btn sm" onClick={() => setEditing(sku)}>编辑</button></td> : null}
            </tr>
          )))}</tbody>
        </table></div></div>
      )}
      <Modal open={!!form} wide title="新增商品" onClose={() => setForm(null)} footer={<><button className="btn" onClick={() => setForm(null)}>取消</button><button className="btn primary" disabled={busy || !form?.name.trim() || form.skus.some((sku) => !sku.code.trim())} onClick={async () => { if (form && await run(() => send('/products', form), '商品已创建')) setForm(null); }}>保存</button></>}>
        {form ? <div className="col" style={{ gap: 12 }}>
          <div className="row"><div className="grow"><Field label="商品名称" required><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field></div><div className="grow"><Field label="类目"><input className="input" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></Field></div></div>
          {form.skus.map((sku, index) => {
            const update = (patch: Partial<typeof blankSku>) => setForm({ ...form, skus: form.skus.map((item, position) => (position === index ? { ...item, ...patch } : item)) });
            return <div className="row" key={index} style={{ alignItems: 'flex-end' }}>
              <div className="grow"><Field label="SKU 编码" required><input className="input" value={sku.code} onChange={(event) => update({ code: event.target.value })} /></Field></div>
              <div className="grow"><Field label="规格"><input className="input" value={sku.spec} onChange={(event) => update({ spec: event.target.value })} /></Field></div>
              <div className="grow"><Field label="售价（元）"><input className="input" type="number" min={0} value={sku.price} onChange={(event) => update({ price: Number(event.target.value) })} /></Field></div>
              <div className="grow"><Field label="预警线"><input className="input" type="number" min={0} value={sku.low_stock_threshold} onChange={(event) => update({ low_stock_threshold: Number(event.target.value) })} /></Field></div>
              <button className="btn icon" aria-label="删除这个 SKU" disabled={form.skus.length === 1} onClick={() => setForm({ ...form, skus: form.skus.filter((_, position) => position !== index) })}><Trash2 size={15} /></button>
            </div>;
          })}
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setForm({ ...form, skus: [...form.skus, { ...blankSku }] })}><Plus size={13} />加一个 SKU</button>
        </div> : null}
      </Modal>
      <Modal open={!!editing} title={`编辑 ${editing?.code ?? ''}`} onClose={() => setEditing(null)} footer={<><button className="btn" onClick={() => setEditing(null)}>取消</button><button className="btn primary" disabled={busy} onClick={async () => { if (editing && await run(() => send(`/skus/${editing.id}`, { spec: editing.spec, price: editing.price, low_stock_threshold: editing.low_stock_threshold }, 'PATCH'), '已保存')) setEditing(null); }}>保存</button></>}>
        {editing ? <div className="col" style={{ gap: 12 }}>
          <Field label="规格"><input className="input" value={editing.spec} onChange={(event) => setEditing({ ...editing, spec: event.target.value })} /></Field>
          <Field label="售价（元）"><input className="input" type="number" min={0} value={editing.price} onChange={(event) => setEditing({ ...editing, price: Number(event.target.value) })} /></Field>
          <Field label="预警线"><input className="input" type="number" min={0} value={editing.low_stock_threshold} onChange={(event) => setEditing({ ...editing, low_stock_threshold: Number(event.target.value) })} /></Field>
        </div> : null}
      </Modal>
    </div>
  );
}
