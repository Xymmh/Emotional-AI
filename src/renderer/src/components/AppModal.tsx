import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { isComposing } from '../lib/util'

interface AppModalProps {
  visible: boolean
  title: string
  children: ReactNode
  okText: string
  cancelText?: string
  /** 危险操作：确认按钮显示为红色 */
  danger?: boolean
  loading?: boolean
  loadingText?: string
  onOk: () => void
  onCancel: () => void
}

/**
 * 应用内统一弹窗：与整体设计语言一致的白底卡片 + 遮罩模糊。
 * 浮层显式声明 no-drag，避免 Electron 拖拽区 hit-test 吞掉点击。
 */
export default function AppModal({
  visible,
  title,
  children,
  okText,
  cancelText = '取消',
  danger = false,
  loading = false,
  loadingText = '处理中…',
  onOk,
  onCancel,
}: AppModalProps) {
  // 键盘监听只在 visible/loading 变化时重绑，回调必须经 ref 取最新值：
  // 否则 Enter 触发的是弹窗打开那一刻的 onOk，读到的输入框内容是空的
  const handlersRef = useRef({ onOk, onCancel })
  handlersRef.current = { onOk, onCancel }

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (loading) return
      const { onOk, onCancel } = handlersRef.current
      if (e.key === 'Escape') onCancel()
      // 输入法组字中的 Enter 是上屏；多行输入框里的 Enter 是换行，都不能当「确定」
      if (
        e.key === 'Enter' &&
        !isComposing(e) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault()
        onOk()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, loading])

  if (!visible) return null

  return (
    <div
      className="app-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel()
      }}
    >
      <div className="app-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-modal-title">{title}</div>
        <div className="app-modal-body">{children}</div>
        <div className="app-modal-footer">
          <button
            type="button"
            className="app-modal-btn"
            disabled={loading}
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={`app-modal-btn primary${danger ? ' danger' : ''}`}
            disabled={loading}
            onClick={onOk}
          >
            {loading ? loadingText : okText}
          </button>
        </div>
      </div>
    </div>
  )
}
