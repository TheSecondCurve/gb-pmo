import { useEffect, useRef, useState } from 'react'
import { api, ChatMeta } from '../api'
import { useStore } from '../store'
import { Btn, Spinner, inputCls } from '../components/ui'
import { fmtDateTime } from '../fmt'

// S24 Web AI 助手会话：与飞书机器人同一核心 Agent 的 web 入口。
// 左栏会话管理（新建/改名/软删），右侧消息流；建议型事件在消息内直接「生效/驳回」（既有唯一口子）。

interface SessionRow { id: number; title: string; created_at: number; updated_at: number }
interface MessageRow { id: number; role: string; content: string; meta: ChatMeta | null; created_at: number }

export default function Chat() {
  const { toast } = useStore()
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [decided, setDecided] = useState<Record<string, string>>({}) // 本地记住已操作的建议事件/操作提议（键 e:事件id / p:提议id）
  const bottomRef = useRef<HTMLDivElement>(null)

  const reloadSessions = async (select?: number) => {
    const s = await api.chatSessions()
    setSessions(s.sessions)
    if (select) setActiveId(select)
    else if (!activeId && s.sessions.length) setActiveId(s.sessions[0].id)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- 刻意仅首载执行：reloadSessions 读取的 activeId 初始闭包是「首会话自动选中」的一次性语义，加入依赖会在选中后多取一次会话列表
  useEffect(() => { void reloadSessions() }, [])
  useEffect(() => {
    if (activeId == null) { setMessages([]); return }
    void (async () => {
      try {
        const m = await api.chatMessages(activeId)
        setMessages(m.messages)
      } catch (e) { toast((e as Error).message, 'bad') }
    })()
  }, [activeId, toast])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const create = async () => {
    const s = await api.createChatSession()
    await reloadSessions(s.id)
    setInput('')
  }
  const remove = async (id: number) => {
    await api.deleteChatSession(id)
    const rest = sessions?.filter((s) => s.id !== id) ?? []
    setSessions(rest)
    if (activeId === id) { setActiveId(rest[0]?.id ?? null); setMessages([]) }
  }
  const rename = async (id: number) => {
    const t = editTitle.trim()
    setEditingId(null)
    if (!t) return
    await api.renameChatSession(id, t)
    await reloadSessions()
  }
  const send = async () => {
    const text = input.trim()
    if (!text || busy || activeId == null) return
    setBusy(true); setInput('')
    const optimistic: MessageRow = { id: -Date.now(), role: 'user', content: text, meta: null, created_at: Date.now() }
    setMessages((m) => [...m, optimistic])
    try {
      const r = await api.sendChatMessage(activeId, text)
      setMessages((m) => [...m.filter((x) => x.id !== optimistic.id), r.user, r.assistant])
      const s = await api.chatSessions()
      setSessions(s.sessions) // 标题可能已自动生成
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id))
      setInput(text)
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }
  const decide = async (key: string, id: number, action: 'confirm' | 'reject') => {
    try {
      const isProposal = key.startsWith('p:')
      if (action === 'confirm') {
        if (isProposal) await api.confirmProposal(id)
        else await api.confirmEvent(id)
      } else if (isProposal) await api.rejectProposal(id)
      else await api.rejectEvent(id)
      setDecided((d) => ({ ...d, [key]: action === 'confirm' ? '已生效' : '已驳回' }))
      toast(action === 'confirm' ? `#${id} 已生效` : `#${id} 已驳回`)
    } catch (e) {
      toast((e as Error).message, 'bad')
    }
  }

  if (sessions == null) return <Spinner />

  return (
    <div className="flex h-[calc(100dvh-6rem)] min-h-[26rem] gap-4 md:h-[calc(100dvh-7rem)]">
      <aside className="hidden w-60 shrink-0 flex-col rounded-lg border border-[var(--color-line)] bg-[var(--color-card)] md:flex">
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3 py-2.5">
          <span className="text-[13px] font-medium">会话</span>
          <Btn small onClick={create}>＋ 新会话</Btn>
        </div>
        <div className="flex-1 overflow-auto p-2 text-[13px]">
          {sessions.length === 0 && <div className="px-2 py-4 text-[12px] text-[var(--color-ink-soft)]">还没有会话，点「新会话」开始。</div>}
          {sessions.map((s) => (
            <div key={s.id}
              className={`mb-1 rounded-md px-2 py-1.5 ${s.id === activeId ? 'bg-[var(--color-brand-soft)]' : 'hover:bg-[var(--color-bg)]'}`}>
              {editingId === s.id ? (
                <input className={inputCls} value={editTitle} autoFocus
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void rename(s.id); if (e.key === 'Escape') setEditingId(null) }}
                  onBlur={() => void rename(s.id)} />
              ) : (
                <div className="flex items-center gap-1">
                  <button className="min-w-0 flex-1 truncate text-left" title={s.title}
                    onClick={() => setActiveId(s.id)}>{s.title}</button>
                  <button className="shrink-0 text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-brand)]"
                    title="改名" onClick={() => { setEditingId(s.id); setEditTitle(s.title) }}>✎</button>
                  <button className="shrink-0 text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-brand)]"
                    title="删除（软删，历史保留）" onClick={() => void remove(s.id)}>✕</button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="border-t border-[var(--color-line)] px-3 py-2 text-[11px] text-[var(--color-ink-soft)]">
          与飞书机器人同一大脑：先查后答；建议型变更待你确认后生效。
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col rounded-lg border border-[var(--color-line)] bg-[var(--color-card)]">
        {/* 移动端会话切换条（<768px，桌面用左栏）：下拉选会话 + 新建 */}
        <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-3 py-2 md:hidden">
          <select
            data-nav="chat-sessions" aria-label="切换会话"
            className="min-w-0 flex-1 rounded-md border border-[var(--color-line)] bg-white px-2 py-1 text-[13px] outline-none"
            value={activeId ?? ''} onChange={(e) => setActiveId(Number(e.target.value))}
          >
            {sessions.length === 0 && <option value="">（暂无会话）</option>}
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
          <Btn small onClick={() => void create()}>＋ 新会话</Btn>
        </div>
        {activeId == null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[var(--color-ink-soft)]">
            <div className="text-[13px]">选择一个会话，或新建开始对话。</div>
            <Btn kind="primary" onClick={create}>＋ 新会话</Btn>
          </div>
        ) : (
          <>
            <div className="flex-1 space-y-3 overflow-auto p-4">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-lg px-3 py-2 text-[13px] ${m.role === 'user'
                    ? 'bg-[var(--color-brand-soft)] text-[var(--color-ink)]'
                    : 'border border-[var(--color-line)] bg-[var(--color-bg)]'}`}>
                    <div className="whitespace-pre-wrap break-words">{m.content}</div>
                    {m.role === 'assistant' && (m.meta?.eventId || m.meta?.proposalId) && (() => {
                      const isProposal = !!m.meta?.proposalId
                      const id = (isProposal ? m.meta!.proposalId : m.meta!.eventId)!
                      const key = `${isProposal ? 'p' : 'e'}:${id}`
                      return (
                        <div className="mt-2 flex items-center gap-2 border-t border-[var(--color-line)] pt-2">
                          <span className="text-[11px] text-[var(--color-ink-soft)]">{isProposal ? '操作提议' : '建议事件'} #{id}</span>
                          {decided[key] ? (
                            <span className="text-[11px] text-[var(--color-ink-soft)]">{decided[key]}</span>
                          ) : (
                            <>
                              <Btn small kind="primary" onClick={() => void decide(key, id, 'confirm')}>生效</Btn>
                              <Btn small kind="ghost" onClick={() => void decide(key, id, 'reject')}>驳回</Btn>
                            </>
                          )}
                        </div>
                      )
                    })()}
                    <div className="mt-1 text-right text-[10px] text-[var(--color-ink-soft)]">
                      {fmtDateTime(m.created_at)}{m.role === 'assistant' && m.meta?.llmCalls ? ` · ${m.meta.llmCalls} 轮${m.meta.queries ? ` · ${m.meta.queries} 查` : ''}` : ''}
                    </div>
                  </div>
                </div>
              ))}
              {busy && <div className="text-[12px] text-[var(--color-ink-soft)]">助手思考中…（先查后答，多轮可能要几秒）</div>}
              <div ref={bottomRef} />
            </div>
            <div className="flex items-end gap-2 border-t border-[var(--color-line)] p-3">
              <textarea className={inputCls + ' min-h-[2.6rem] resize-y'} rows={2} maxLength={2000}
                placeholder={'试试：「现在有几个进行中的项目」「客户X系统登记风险：接口联调卡住」「1 号任务做完了」'}
                value={input} disabled={busy}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} />
              <Btn kind="primary" disabled={busy || !input.trim()} onClick={send}>发送</Btn>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
