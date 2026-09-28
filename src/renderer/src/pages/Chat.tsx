import { useEffect, useRef, useState } from 'react'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  thought?: string
}

interface Conversation {
  id: string
  persona_id: string
  mode: string
}

interface ChatPaneProps {
  personaId: string
  personaName: string
}

/** 历史消息里存的是含 <thought> 标签的原文，加载时拆成正文 + 心路历程 */
function parseThought(raw: string): { content: string; thought: string } {
  const m = raw.match(/<thought>([\s\S]*?)<\/thought>/)
  if (!m) return { content: raw, thought: '' }
  const idx = m.index ?? 0
  const content = (raw.slice(0, idx) + raw.slice(idx + m[0].length)).trim()
  return { content, thought: m[1].trim() }
}

/** 主视角：与「对方」（扮演）对话；每条回复附分析师心路历程注解 */
export default function ChatPane({ personaId, personaName }: ChatPaneProps) {
  const [convId, setConvId] = useState('')
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const convs = await window.appApi.request<Conversation[]>(
          `/api/conversations?persona_id=${personaId}`,
        )
        const conv = (convs ?? []).find((c) => c.mode === 'roleplay')
        if (cancelled) return
        if (conv) {
          const history = await window.appApi.request<Msg[]>(
            `/api/messages?conversation_id=${conv.id}`,
          )
          if (cancelled) return
          setMessages(
            (history ?? [])
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m) =>
                m.role === 'assistant'
                  ? { role: 'assistant', ...parseThought(m.content) }
                  : { role: 'user', content: m.content },
              ),
          )
        }
      } catch {
        // 首次对话时再创建
      }
    })()
    return () => {
      cancelled = true
    }
  }, [personaId])

  const ensureConversation = async (): Promise<string> => {
    if (convId) return convId
    const conv = await window.appApi.request<Conversation>('/api/conversations', 'POST', {
      persona_id: personaId,
      mode: 'roleplay',
      title: '主视角',
    })
    setConvId(conv.id)
    return conv.id
  }

  const send = async () => {
    const content = input.trim()
    if (!content || streaming) return
    setError('')
    setInput('')
    if (taRef.current) taRef.current.style.height = 'auto'
    setMessages((prev) => [
      ...prev,
      { role: 'user', content },
      { role: 'assistant', content: '', thought: '' },
    ])
    setStreaming(true)
    try {
      const cid = await ensureConversation()
      const append = (field: 'content' | 'thought', delta: string) => {
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last && last.role === 'assistant') {
            next[next.length - 1] = { ...last, [field]: (last[field] ?? '') + delta }
          }
          return next
        })
      }
      await window.appApi.chat.stream(
        '/api/chat/stream',
        { conversation_id: cid, content },
        (delta) => append('content', delta),
        (thought) => append('thought', thought),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败')
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'assistant' && !last.content && !last.thought)
          return prev.slice(0, -1)
        return prev
      })
    } finally {
      setStreaming(false)
    }
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  return (
    <div className="chat-page">
      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">与「{personaName}」对话</div>
            <div className="chat-empty-hint">
              以你自己的身份发消息，「对方」会按塑造出的性格回应，每条回复下方有分析师注解
              TA 说话时的心路历程。先到第三视角发聊天记录，能让 TA 更像本人。
            </div>
          </div>
        ) : (
          <div className="chat-messages-inner">
            {messages.map((m, i) => (
              <div key={i} className="msg-row">
                {m.role === 'assistant' ? (
                  <>
                    <div className="msg-label">{personaName.toUpperCase()}</div>
                    <div className="msg-assistant-row">
                      <div className="msg-bubble">
                        {m.content}
                        {streaming && i === messages.length - 1 && !m.thought && (
                          <span className="msg-caret" />
                        )}
                      </div>
                      {(m.thought || (streaming && i === messages.length - 1)) && (
                        <details className="msg-thought" open={!!m.thought || streaming}>
                          <summary>ANALYST · 心路历程</summary>
                          <div className="msg-thought-body">
                            {m.thought || '…'}
                            {streaming && i === messages.length - 1 && m.thought && (
                              <span className="msg-caret" />
                            )}
                          </div>
                        </details>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="msg-user-row">
                    <div className="msg-user">{m.content}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="chat-composer">
        {error && <div className="chat-error">{error}</div>}
        <div className="chat-composer-inner">
          <textarea
            ref={taRef}
            className="chat-input"
            rows={1}
            placeholder={`对「${personaName}」说点什么…（Enter 发送，Shift+Enter 换行）`}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              const el = e.target
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <button
            type="button"
            className="chat-send"
            disabled={!input.trim() || streaming}
            onClick={() => void send()}
            aria-label="发送"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
