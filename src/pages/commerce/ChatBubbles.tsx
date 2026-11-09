import { Bot, UserRound } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { C } from '../../theme';
import { Markdown } from '../../components/Markdown';
import type { ChatMessage } from './shared';

/** 同一段会话在买家端和坐席端的展示；mine 表示右侧是哪一方。 */
export function ChatBubbles({ messages, mine }: { messages: ChatMessage[]; mine: 'user' | 'agent' }) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [messages.length]);
  return (
    <div className="chat-scroll" ref={scroller} aria-live="polite">
      {messages.map((item) => {
        if (item.role === 'system') return <div key={item.id} className="msg-system">{item.content}</div>;
        const right = item.role === mine;
        const visual = item.role === 'assistant' ? { bg: C.success, icon: <Bot size={16} /> } : item.role === 'agent' ? { bg: C.primary, icon: <UserRound size={16} /> } : { bg: C.avatarBg, icon: <span style={{ color: C.avatarText, fontSize: 13, fontWeight: 600 }}>买</span> };
        return (
          <div key={item.id} className={`msg ${right ? 'user' : ''}`}>
            <span className="who" style={{ background: visual.bg }}>{visual.icon}</span>
            <div className="bubble" style={{ whiteSpace: 'normal' }}>
              <Markdown text={item.content} />
              {item.citations?.length ? <div className="msg-meta"><span className="faint">依据：{[...new Set(item.citations.map((cite) => cite.filename))].join('、')}</span></div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
