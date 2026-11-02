import { Bot, BookOpen, Brain, Headset, MessageSquareText, Plus, Settings2, Shield, Wrench, X } from 'lucide-react';
import { useState } from 'react';
import { ChatPanel } from '../components/ChatPanel';
import { Dev, Field, Icon, Modal, Slider, Switch, Tag, useToast } from '../components/ui';
import { APPS, TOOLS, type AppItem } from '../data/mock';
import { KnowledgePicker, ListEditor, ModelPicker, PromptBox, Section } from './common';

const SERVICE_PROMPT = `# 角色
你是「知序储能」的售后客服，语气专业、耐心，称呼客户为「您」。

# 工作方式
1. 产品使用、故障、政策类问题：先调用「知识库搜索」，只依据检索结果回答，并标注引用。
2. 用户提供订单号或询问物流：调用「订单查询」。
3. 故障无法远程解决且用户同意上门：调用「创建售后工单」，并告知工单号与预计响应时间。
4. 涉及赔偿、投诉、竞品比价，或同一问题连续 2 次未解决：调用「转人工」。

# 约束
- 不承诺保修政策以外的内容，不报具体项目价格。
- 先给结论，再给步骤；步骤不超过 5 条。`;

export function AgentEditor({ app }: { app: AppItem }) {
  const toast = useToast();
  const [tools, setTools] = useState(app.id === 'app-service' ? ['t-order', 't-ticket', 't-crm'] : ['t-search']);
  const [adding, setAdding] = useState(false);
  const [steps, setSteps] = useState(8);
  const [tab, setTab] = useState<'tool' | 'flow' | 'mcp'>('tool');

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ width: 560, flex: 'none', overflow: 'auto', padding: '4px 24px 24px', borderRight: '1px solid var(--border)' }}>
        <Section icon={<Bot size={16} />} title="模型与角色">
          <div className="field-label">模型</div>
          <ModelPicker value={app.model} toolCalling />
          <div className="field-label" style={{ marginTop: 14 }}>角色与工作方式<span className="hint">说清楚何时用哪个工具</span></div>
          <PromptBox rows={12} vars={['customer_level', '当前时间']} value={app.id === 'app-service' ? SERVICE_PROMPT : '# 角色\n你是销售陪练，扮演一位对价格敏感的工厂采购负责人……'} />
        </Section>

        <Section icon={<Wrench size={16} />} title={<>工具<Dev s="todo" note="tool calling 循环" /></>} extra={<button className="btn sm" onClick={() => setAdding(true)}><Plus size={13} />添加</button>}>
          <div className="col" style={{ gap: 8 }}>
            {tools.map((id) => {
              const t = TOOLS.find((x) => x.id === id)!;
              return (
                <div key={id} className="row" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
                  <span className="avatar-tile sm" style={{ background: t.color }}><Icon name={t.icon} size={14} /></span>
                  <div className="grow"><div className="row" style={{ gap: 6 }}><strong style={{ fontSize: 13 }}>{t.name}</strong><Tag>{t.kind}</Tag></div><div className="faint">{t.desc}</div></div>
                  <button className="btn ghost sm icon" aria-label="配置"><Settings2 size={14} /></button>
                  <button className="btn ghost sm icon" aria-label="移除" onClick={() => setTools(tools.filter((x) => x !== id))}><X size={14} /></button>
                </div>
              );
            })}
            <div className="row" style={{ border: '1px dashed var(--border-strong)', borderRadius: 10, padding: '10px 12px', background: 'var(--orange-50)' }}>
              <span className="avatar-tile sm" style={{ background: '#f79009' }}><Headset size={14} /></span>
              <div className="grow"><strong style={{ fontSize: 13 }}>转人工</strong><Tag tone="orange">内置</Tag><div className="faint">把会话与摘要推送给人工坐席（企业微信客服 / 工单系统）</div></div>
              <Switch on onChange={() => undefined} label="转人工" />
            </div>
          </div>
        </Section>

        <Section icon={<BookOpen size={16} />} title="知识库" extra={<Tag>{app.knowledge.length} 个</Tag>}>
          <KnowledgePicker initial={app.knowledge} agentMode />
        </Section>

        <Section icon={<Brain size={16} />} title="执行与记忆">
          <Field label="最大推理步数" hint="单轮最多调用工具次数"><Slider value={steps} min={1} max={20} onChange={setSteps} /></Field>
          <div className="col" style={{ gap: 10 }}>
            <div className="row"><span className="grow">多轮上下文<div className="faint">携带最近 10 轮对话</div></span><Switch on onChange={() => undefined} label="多轮" /></div>
            <div className="row"><span className="grow">用户长期记忆<Dev s="todo" /><div className="faint">记住客户设备型号、历史工单等偏好，跨会话生效</div></span><Switch on={false} onChange={() => undefined} label="长期记忆" /></div>
            <div className="row"><span className="grow">工具调用前需用户确认<div className="faint">如「创建工单」等有副作用的操作</div></span><Switch on onChange={() => undefined} label="确认" /></div>
          </div>
        </Section>

        <Section icon={<MessageSquareText size={16} />} title="对话体验" defaultOpen={false}>
          <div className="field-label">开场白</div>
          <textarea className="textarea" style={{ minHeight: 60 }} defaultValue={app.opening ?? ''} />
          <div className="field-label" style={{ marginTop: 12 }}>猜你想问</div>
          <ListEditor items={app.suggestions ?? []} placeholder="添加推荐问题" />
          <div className="row" style={{ marginTop: 12 }}><span className="grow">展示思考与工具调用过程</span><Switch on onChange={() => undefined} label="展示过程" /></div>
        </Section>

        <Section icon={<Shield size={16} />} title="安全护栏" defaultOpen={false}>
          <div className="field-label">禁止承诺 / 禁止话题</div>
          <ListEditor items={['超出保修政策的承诺', '具体项目报价', '竞品负面评价']} placeholder="添加" />
          <div className="row" style={{ marginTop: 12 }}><span className="grow">敏感词过滤<div className="faint">使用「客服通用」词库</div></span><Switch on onChange={() => undefined} label="敏感词" /></div>
        </Section>
      </div>
      <div className="grow" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--bg-soft)' }}>
        <ChatPanel app={app} debug title={<><strong>调试预览</strong><Tag tone="orange">草稿</Tag><span className="faint">展开每轮的规划与工具调用</span></>} />
      </div>

      <Modal open={adding} title="添加工具" onClose={() => setAdding(false)} wide footer={<button className="btn primary" onClick={() => setAdding(false)}>完成</button>}>
        <div className="seg" style={{ marginBottom: 14 }}>
          <button className={tab === 'tool' ? 'active' : ''} onClick={() => setTab('tool')}>工具库</button>
          <button className={tab === 'flow' ? 'active' : ''} onClick={() => setTab('flow')}>工作流作为工具</button>
          <button className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>MCP 服务</button>
        </div>
        {tab === 'tool' ? (
          <div className="grid c2" style={{ gap: 10 }}>
            {TOOLS.map((t) => {
              const on = tools.includes(t.id);
              return (
                <button key={t.id} className={`method-card ${on ? 'active' : ''}`} onClick={() => { setTools(on ? tools.filter((x) => x !== t.id) : [...tools, t.id]); }}>
                  <span className="avatar-tile sm" style={{ background: t.color }}><Icon name={t.icon} size={14} /></span>
                  <div className="grow"><h4>{t.name}<Tag>{t.kind}</Tag>{t.status === 'beta' ? <Tag tone="orange">Beta</Tag> : null}</h4><p>{t.desc}</p></div>
                  {on ? <Tag tone="blue">已添加</Tag> : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {tab === 'flow' ? (
          <div className="col">
            <p className="faint">已发布的 Chat Flow 可以作为工具被 Agent 调用，适合把固定流程封装成能力。</p>
            {APPS.filter((a) => a.type === 'chatflow').map((a) => (
              <button key={a.id} className="method-card" onClick={() => toast(`已添加「${a.name}」为工具`)}><Icon name={a.icon} /><div className="grow"><h4>{a.name}</h4><p>{a.desc}</p></div></button>
            ))}
          </div>
        ) : null}
        {tab === 'mcp' ? (
          <div className="col">
            <Field label="MCP 服务地址"><input className="input" placeholder="https://mcp.example.com/sse" /></Field>
            <Field label="鉴权 Header"><input className="input" placeholder="Authorization: Bearer ..." /></Field>
            <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => toast('已发现 6 个工具：查询库存、查询价格…')}>连接并发现工具</button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
