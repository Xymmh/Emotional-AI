import { useEffect, useRef, useState } from 'react'
import AppModal from '../components/AppModal'
import Composer from '../components/Composer'
import { useConversation, useStickToBottom } from '../lib/useConversation'
import { errorText } from '../lib/util'

interface Msg {
  role: 'user' | 'assistant'
  content: string
}

interface AnalystPaneProps {
  personaId: string
  personaName: string
  onProfileUpdated: () => void
}

/** 画像在后台异步沉淀（观察提炼 + 每 4 轮自动重塑），分几次刷新侧栏以拿到最新结果 */
const PROFILE_REFRESH_DELAYS = [0, 5000, 15000]

/** 第三视角：发聊天记录 / 描述情况，分析师流式解读，画像自动塑造 */
export default function AnalystPane({ personaId, personaName, onProfileUpdated }: AnalystPaneProps) {
  const { history, loading, loadError, reload, clear, convId } = useConversation(
    personaId,
    'analyst',
  )
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const [agentStatus, setAgentStatus] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const { ref: scrollRef, stick } = useStickToBottom(messages)
  // 在途流凭据：中断按钮据此调用 stop；stopRequested 区分「主动中断」与「真实报错」
  const streamIdRef = useRef('')
  const stopRequestedRef = useRef(false)
  const timersRef = useRef<number[]>([])

  useEffect(() => {
    if (!history) return
    setMessages(history.map((m) => ({ role: m.role as Msg['role'], content: m.content })))
  }, [history])

  useEffect(() => () => timersRef.current.forEach((t) => window.clearTimeout(t)), [])

  const scheduleProfileRefresh = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t))
    timersRef.current = PROFILE_REFRESH_DELAYS.map((d) => window.setTimeout(onProfileUpdated, d))
  }

  const send = async () => {
    const content = input.trim()
    if (!content || streaming) return
    setError('')
    setInput('')
    stick()
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
      scheduleProfileRefresh()
    } catch (e) {
      if (stopRequestedRef.current) {
        // 主动中断：服务端已撤销本轮（不存半截分析、不沉淀记忆），这里同步丢弃本地内容，
        // 并把原文还给输入框，长段聊天记录不用重新粘贴
        setMessages((prev) => prev.slice(0, prevCount))
        setInput((cur) => cur || content)
      } else {
        setError(errorText(e, '生成失败'))
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

  const handleClear = async () => {
    if (clearing) return
    setClearing(true)
    try {
      await clear()
      setMessages([])
      setError('')
    } catch (e) {
      setError(errorText(e, '清空失败'))
    } finally {
      setClearing(false)
      setConfirmClear(false)
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
                    {(m.content || !(streaming && i === messages.length - 1 && agentStatus)) && (
                      <div className="msg-assistant">
                        {m.content}
                        {streaming && i === messages.length - 1 && <span className="msg-caret" />}
                      </div>
                    )}
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

      <Composer
        value={input}
        onChange={setInput}
        onSend={() => void send()}
        onStop={stopStream}
        streaming={streaming}
        disabled={!convId}
        error={error}
        placeholder="粘贴聊天记录或描述情况…（Enter 发送，Shift+Enter 换行）"
        actions={
          messages.length > 0 && !streaming ? (
            <button
              type="button"
              className="chat-action-btn"
              onClick={() => setConfirmClear(true)}
            >
              清空分析记录
            </button>
          ) : null
        }
      />

      <AppModal
        visible={confirmClear}
        title="清空分析记录"
        okText="清空"
        danger
        loading={clearing}
        loadingText="清空中…"
        onOk={() => void handleClear()}
        onCancel={() => setConfirmClear(false)}
      >
        <div className="app-modal-desc">
          将清空第三视角的对话记录。已沉淀的画像、观察与记忆会保留，主视角扮演不受影响。
        </div>
      </AppModal>
    </div>
  )
}
