import { useRef, type ReactNode } from 'react'
import { autoGrow, isSendEnter } from '../lib/util'

interface ComposerProps {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  streaming: boolean
  disabled?: boolean
  placeholder: string
  error?: string
  /** 输入框下方左侧的辅助操作（如「清空对话」） */
  actions?: ReactNode
}

/** 对话输入区：Enter 发送 / Shift+Enter 换行（输入法组字中不发送），生成中显示停止按钮 */
export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  disabled = false,
  placeholder,
  error,
  actions,
}: ComposerProps) {
  const taRef = useRef<HTMLTextAreaElement>(null)

  const send = () => {
    if (!value.trim() || streaming || disabled) return
    onSend()
    // 清空后把高度复位
    requestAnimationFrame(() => autoGrow(taRef.current))
  }

  return (
    <div className="chat-composer">
      {error && <div className="chat-error">{error}</div>}
      <div className="chat-composer-inner">
        <textarea
          ref={taRef}
          className="chat-input"
          rows={1}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value)
            autoGrow(e.target)
          }}
          onKeyDown={(e) => {
            if (isSendEnter(e)) {
              e.preventDefault()
              send()
            }
          }}
        />
        {streaming ? (
          <button
            type="button"
            className="chat-send stop"
            onClick={onStop}
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
            disabled={!value.trim() || disabled}
            onClick={send}
            aria-label="发送"
            title="发送"
          >
            ↑
          </button>
        )}
      </div>
      {actions && <div className="chat-actions">{actions}</div>}
    </div>
  )
}
