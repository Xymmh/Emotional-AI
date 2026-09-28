import { useEffect, useRef, useState } from 'react'

interface Msg {
  role: 'user' | 'assistant'
  content: string
}

interface Conversation {
  id: string
  persona_id: string
  mode: string
}

interface AnalystPaneProps {
  personaId: string
  personaName: string
  onProfileUpdated: () => void
}

/** 第三视角：发聊天记录 / 描述情况，分析师流式解读，画像自动塑造 */
export default function AnalystPane({ personaId, personaName, onProfileUpdated }: AnalystPaneProps) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const [agentStatus, setAgentStatus] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // 在途流凭据：中断按钮据此调用 stop；stopRequested 区分「主动中断」与「真实报错」
  const streamIdRef = useRef('')
  const stopRequestedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const convs = await window.appApi.request<Conversation[]>(
          `/api/conversations?persona_id=${personaId}`,
        )
        const conv = (convs ?? []).find((c) => c.mode === 'analyst')
        if (cancelled) return
        if (conv) {
          const history = await window.appApi.request<Msg[]>(
            `/api/messages?conversation_id=${conv.id}`,
          )
          if (cancelled) return
          setMessages(
            (history ?? [])
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m) => ({ role: m.role, content: m.content })),
          )
        }
      } catch {
        // 首次发送时由后端自建
      }
    })()
    return () => {
      cancelled = true
    }
  }, [personaId])

  const send = async () => {
    const content = input.trim()
    if (!content || streaming) return
    setError('')
    setInput('')
    if (taRef.current) taRef.current.style.height = 'auto'
    // 记录发送前的消息数：中断时据此回滚到上一轮结束的状态
    const prevCount = messages.length
    setMessages((prev) => [
      ...prev,
      { role: 'user', content },
      { role: 'assistant', content: '' },
    ])
    setStreaming(true)
    setAgentStatus('准备中')
    const sid = crypto.randomUUID()
    streamIdRef.current = sid
    stopRequestedRef.current = false
    try {
      await window.appApi.chat.stream(
        '/api/analyst/stream',
        { persona_id: personaId, content },
        (delta) => {
          setAgentStatus('') // 正文开始输出，隐藏 agent 状态
          setMessages((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, content: last.content + delta }
            }
            return next
          })
        },
        undefined,
        (status) => setAgentStatus(status),
        sid,
      )
      onProfileUpdated()
    } catch (e) {
      if (stopRequestedRef.current) {
        // 主动中断：丢弃本轮未完成内容并回滚服务端已落库的消息。
        // 分析师会话由服务端创建，客户端无ID，按 persona_id + mode 定位
        setMessages((prev) => prev.slice(0, prevCount))
        void window.appApi
          .request('/api/chat/rollback', 'POST', {
            persona_id: personaId,
            mode: 'analyst',
            keep: prevCount,
          })
          .catch(() => {})
      } else {
        setError(e instanceof Error ? e.message : '生成失败')
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant' && !last.content) return prev.slice(0, -1)
          return prev
        })
      }
    } finally {
      setStreaming(false)
      setAgentStatus('')
      streamIdRef.current = ''
    }
  }

  /** 中断当前生成：后台请求一并取消；重复点击幂等（流结束后凭据已清空） */
  const stopStream = () => {
    if (!streaming || !streamIdRef.current) return
    stopRequestedRef.current = true
    void window.appApi.chat.stop({ streamId: streamIdRef.current })
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
            <div className="chat-empty-title">第三视角 · 分析「{personaName}」</div>
            <div className="chat-empty-hint">
              直接粘贴你与 TA 的聊天记录（保持「名字：内容」格式最好），或描述你们之间的情况。
              分析师会解读 TA 的性格与心理，画像会随每次分析自动沉淀。
            </div>
          </div>
        ) : (
          <div className="chat-messages-inner">
            {messages.map((m, i) => (
              <div key={i} className="msg-row">
                {m.role === 'assistant' ? (
                  <>
                    <div className="msg-label">ANALYST</div>
                    <div className="msg-assistant">
                      {m.content}
                      {streaming && i === messages.length - 1 && <span className="msg-caret" />}
                    </div>
                  </>
                ) : (
                  <div className="msg-user-row">
                    <div className="msg-user">{m.content}</div>
                  </div>
                )}
              </div>
            ))}
            {streaming && agentStatus && (
              <div className="agent-status">
                <span className="agent-status-spinner" />
                {agentStatus}
              </div>
            )}
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
            placeholder="粘贴聊天记录或描述情况…（Enter 发送，Shift+Enter 换行）"
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
          {streaming ? (
            <button
              type="button"
              className="chat-send stop"
              onClick={stopStream}
              aria-label="停止生成"
              title="停止生成"
            >
              <svg width="11" height="11" viewBox="0 0 11 11">
                <rect x="1.5" y="1.5" width="8" height="8" rx="2" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="chat-send"
              disabled={!input.trim()}
              onClick={() => void send()}
              aria-label="发送"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
