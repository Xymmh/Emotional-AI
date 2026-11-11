import { useEffect, useRef, useState } from 'react'
import AppModal from '../components/AppModal'
import Composer from '../components/Composer'
import { useConversation, useStickToBottom } from '../lib/useConversation'
import { errorText, parseThought } from '../lib/util'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  thought?: string
}

interface ChatPaneProps {
  personaId: string
  personaName: string
}

/** 主视角：与「对方」（扮演）对话；每条回复附分析师心路历程注解 */
export default function ChatPane({ personaId, personaName }: ChatPaneProps) {
  const { convId, history, loading, loadError, reload, clear } = useConversation(
    personaId,
    'roleplay',
  )
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const { ref: scrollRef, stick } = useStickToBottom(messages)
  // 在途流凭据：中断按钮据此调用 stop；stopRequested 区分「主动中断」与「真实报错」
  const streamIdRef = useRef('')
  const stopRequestedRef = useRef(false)

  useEffect(() => {
    if (!history) return
    setMessages(
      history.map((m) =>
        m.role === 'assistant'
          ? { role: 'assistant', ...parseThought(m.content) }
          : { role: 'user', content: m.content },
      ),
    )
  }, [history])

  const send = async () => {
    const content = input.trim()
    if (!content || streaming || !convId) return
    setError('')
    setInput('')
    stick()
    // 记录发送前的消息数：中断时据此丢弃本轮（服务端会同步撤销已落库的本轮消息）
    const prevCount = messages.length
    setMessages((prev) => [
      ...prev,
      { role: 'user', content },
      { role: 'assistant', content: '', thought: '' },
    ])
    setStreaming(true)
    const sid = crypto.randomUUID()
    streamIdRef.current = sid
    stopRequestedRef.current = false
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
    try {
      await window.appApi.chat.stream(
        '/api/chat/stream',
        { conversation_id: convId, persona_id: personaId, content },
        (delta) => append('content', delta),
        (thought) => append('thought', thought),
        undefined,
        sid,
      )
    } catch (e) {
      if (stopRequestedRef.current) {
        // 主动中断：丢弃本轮未完成内容，并把输入还给用户方便修改后重发
        setMessages((prev) => prev.slice(0, prevCount))
        setInput((cur) => cur || content)
      } else {
        setError(errorText(e, '生成失败'))
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant' && !last.content && !last.thought)
            return prev.slice(0, -1)
          return prev
        })
      }
    } finally {
      setStreaming(false)
      streamIdRef.current = ''
    }
  }

  /** 中断当前生成：后台请求一并取消；重复点击幂等（流结束后凭据已清空） */
  const stopStream = () => {
    if (!streaming || !streamIdRef.current) return
    stopRequestedRef.current = true
    void window.appApi.chat.stop({ streamId: streamIdRef.current })
  }

  const handleClear = async () => {
    if (clearing) return
    setClearing(true)
    try {
      await clear()
      setMessages([])
      setError('')
      setConfirmClear(false)
    } catch (e) {
      setError(errorText(e, '清空失败'))
      setConfirmClear(false)
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="chat-page">
      <div className="chat-messages" ref={scrollRef}>
        {loading && messages.length === 0 ? (
          <div className="chat-empty">
            <div className="agent-status-spinner" />
          </div>
        ) : loadError ? (
          <div className="chat-empty">
            <div className="chat-empty-title">历史加载失败</div>
            <div className="chat-empty-hint">{loadError}</div>
            <button type="button" className="set-secondary-btn" onClick={() => void reload()}>
              重试
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">与「{personaName}」对话</div>
            <div className="chat-empty-hint">
              以你自己的身份发消息，「对方」会按塑造出的性格回应，每条回复下方有分析师注解
              TA 说话时的心路历程。先到第三视角发聊天记录，能让 TA 更像本人。
            </div>
          </div>
        ) : (
          <div className="chat-messages-inner">
            {messages.map((m, i) => {
              const live = streaming && i === messages.length - 1
              return (
                <div key={i} className="msg-row">
                  {m.role === 'assistant' ? (
                    <>
                      <div className="msg-label">{personaName}</div>
                      <div className="msg-assistant-row">
                        <div className="msg-bubble">
                          {m.content}
                          {live && !m.thought && <span className="msg-caret" />}
                        </div>
                        {(m.thought || live) && (
                          <details className="msg-thought" open>
                            <summary>ANALYST · 心路历程</summary>
                            <div className="msg-thought-body">
                              {m.thought || '…'}
                              {live && m.thought && <span className="msg-caret" />}
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
              )
            })}
          </div>
        )}
      </div>

      <Composer
        value={input}
        onChange={setInput}
        onSend={() => void send()}
        onStop={stopStream}
        streaming={streaming}
        disabled={!convId}
        error={error}
        placeholder={`对「${personaName}」说点什么…（Enter 发送，Shift+Enter 换行）`}
        actions={
          messages.length > 0 && !streaming ? (
            <button
              type="button"
              className="chat-action-btn"
              onClick={() => setConfirmClear(true)}
            >
              重新开始预演
            </button>
          ) : null
        }
      />

      <AppModal
        visible={confirmClear}
        title="重新开始预演"
        okText="清空"
        danger
        loading={clearing}
        loadingText="清空中…"
        onOk={() => void handleClear()}
        onCancel={() => setConfirmClear(false)}
      >
        <div className="app-modal-desc">
          将清空与「{personaName}」的主视角对话记录。画像、第三视角分析与记忆不受影响。
        </div>
      </AppModal>
    </div>
  )
}
