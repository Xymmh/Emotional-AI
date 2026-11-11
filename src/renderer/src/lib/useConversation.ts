import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from './util'

export interface RawMessage {
  id: string
  role: string
  content: string
}

interface Conversation {
  id: string
}

/**
 * 加载某人格某模式下的会话与历史消息。
 * 会话由服务端 get-or-create（/api/conversations/ensure），客户端始终拿到同一个会话 ID——
 * 旧版主视角没记住已有会话 ID，每次重启都新建一个，历史看起来像「丢了」。
 */
export function useConversation(personaId: string, mode: 'analyst' | 'roleplay') {
  const [convId, setConvId] = useState('')
  const [history, setHistory] = useState<RawMessage[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const reqRef = useRef(0)

  const load = useCallback(async () => {
    const req = ++reqRef.current
    setLoading(true)
    setLoadError('')
    try {
      const conv = await window.appApi.request<Conversation>('/api/conversations/ensure', 'POST', {
        persona_id: personaId,
        mode,
      })
      const rows = await window.appApi.request<RawMessage[]>(
        `/api/messages?conversation_id=${encodeURIComponent(conv.id)}`,
      )
      if (req !== reqRef.current) return
      setConvId(conv.id)
      setHistory((rows ?? []).filter((m) => m.role === 'user' || m.role === 'assistant'))
    } catch (e) {
      if (req !== reqRef.current) return
      setLoadError(errorText(e, '加载历史失败'))
    } finally {
      if (req === reqRef.current) setLoading(false)
    }
  }, [personaId, mode])

  useEffect(() => {
    void load()
    return () => {
      reqRef.current++
    }
  }, [load])

  const clear = useCallback(async () => {
    if (!convId) return
    await window.appApi.request(`/api/conversations/${convId}/messages`, 'DELETE')
  }, [convId])

  return { convId, history, loading, loadError, reload: load, clear }
}

/**
 * 消息列表自动滚底：仅当用户本来就停在底部附近时才跟随，
 * 往上翻看历史时不会被流式输出强行拽回底部。
 */
export function useStickToBottom<T>(dep: T) {
  const ref = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [dep])

  /** 发送新消息时强制回到底部 */
  const stick = () => {
    stickRef.current = true
  }

  return { ref, stick }
}
