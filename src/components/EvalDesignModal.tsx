import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage, type ApiEvaluationSet } from '../api/client';
import { evalApi, type DesignRules } from '../api/evaluation';
import type { FDEApp } from '../api/fde';
import { Field, Loading, Modal, Notice, Slider, Spinner, Switch, Tag, useToast } from './ui';

/** AI 设计评测集：勾选评测规则、补充业务方向，生成可直接运行的 Case；可选生成后自动运行。 */
export function EvalDesignModal({ open, apps, appId, onClose, onCreated }: {
  open: boolean;
  /** 不传 appId 时让用户选择应用 */
  apps?: FDEApp[];
  appId?: string;
  onClose: () => void;
  onCreated: (set: ApiEvaluationSet, autoRun: boolean) => void;
}) {
  const toast = useToast();
  const [target, setTarget] = useState(appId ?? '');
  const [rules, setRules] = useState<DesignRules | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [directions, setDirections] = useState('');
  const [count, setCount] = useState(10);
  const [autoRun, setAutoRun] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTarget(appId ?? apps?.find((app) => app.status !== 'archived')?.id ?? '');
    setDirections(''); setCount(10); setAutoRun(true);
  }, [open, appId, apps]);

  useEffect(() => {
    if (!open || !target) return;
    setRules(null);
    evalApi.designRules(target).then((value) => { setRules(value); setPicked(value.recommended); }).catch((caught) => toast(errorMessage(caught), 'error'));
  }, [open, target, toast]);

  const submit = async () => {
    setBusy(true);
    try {
      const set = await evalApi.aiDesign({ app_id: target, rule_keys: picked, directions: directions.trim(), count });
      toast(`已生成 ${set.case_count} 条评测 Case`);
      onCreated(set, autoRun);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} wide title="AI 设计评测集" icon={<Sparkles size={18} color="var(--purple)" />} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !target || !rules || (!picked.length && !directions.trim())} onClick={() => void submit()}>{busy ? <Spinner /> : <Sparkles size={15} />}{busy ? 'AI 正在设计用例…' : autoRun ? '生成并运行' : '生成评测集'}</button></>}>
      {apps && !appId ? (
        <Field label="评测哪个应用" required>
          <select className="select" value={target} onChange={(event) => setTarget(event.target.value)}>{apps.filter((app) => app.status !== 'archived').map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}</select>
        </Field>
      ) : null}
      {!target ? <p className="faint">请先创建一个应用。</p> : !rules ? <Loading /> : <>
        {!rules.has_model ? <div style={{ marginBottom: 12 }}><Notice tone="info" title="应用还没有选择对话模型">将按评测规则模板生成用例（标签为「规则模板」）；在应用编排中选择对话模型后，AI 会结合业务方向设计得更贴切。</Notice></div> : null}
        <Field label="评测规则" hint="已按应用场景勾选推荐规则">
          <div className="grid c2" style={{ gap: 8 }}>
            {rules.rules.map((rule) => {
              const disabled = rule.needs_knowledge && !rules.has_knowledge;
              const on = picked.includes(rule.key);
              return (
                <button key={rule.key} type="button" disabled={disabled} className={`method-card ${on ? 'active' : ''}`} style={{ padding: 10, opacity: disabled ? 0.45 : 1 }}
                  title={disabled ? '应用未关联知识库' : undefined} onClick={() => setPicked(on ? picked.filter((item) => item !== rule.key) : [...picked, rule.key])}>
                  <input type="checkbox" readOnly checked={on} tabIndex={-1} style={{ marginTop: 3 }} />
                  <div><h4 style={{ fontSize: 13 }}>{rule.name}{rules.recommended.includes(rule.key) ? <Tag tone="green">推荐</Tag> : null}</h4><p>{rule.description}</p></div>
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="补充业务方向" hint="可选，越具体生成的 Case 越贴近业务">
          <textarea className="textarea" style={{ minHeight: 80 }} value={directions} onChange={(event) => setDirections(event.target.value)}
            placeholder="例如：重点测试退换货时效、跨店铺订单、会员折扣叠加；报告需包含数据来源说明" />
        </Field>
        <div className="form-grid">
          <Field label="生成数量" hint="条"><Slider label="生成数量" value={count} min={3} max={30} onChange={setCount} /></Field>
          <Field label="生成后自动运行"><div className="row" style={{ height: 36 }}><Switch on={autoRun} label="生成后自动运行" onChange={setAutoRun} /><span className="faint">基于当前草稿逐条运行并显示进度</span></div></Field>
        </div>
        <p className="faint">每条 Case 都会带可自动判定的标准（必须包含 / 禁止出现的关键词、是否要求引用）；生成后可逐条修改。</p>
      </>}
    </Modal>
  );
}
