import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * 输入法（拼音等）组字过程中按 Enter 是「上屏」，不是发送。
 * keyCode 229 兜底部分 Chromium 版本在 compositionend 后补发的那次 keydown。
 */
export function isComposing(e: ReactKeyboardEvent | KeyboardEvent): boolean {
  const native = 'nativeEvent' in e ? e.nativeEvent : e
  return native.isComposing || native.keyCode === 229
}

/** Enter 发送、Shift+Enter 换行（组字中的 Enter 不算） */
export function isSendEnter(e: ReactKeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey && !isComposing(e)
}

/** 解析 traits JSON，失败时返回空数组 */
export function parseTraits(raw: string): string[] {
  try {
    const arr = JSON.parse(raw || '[]')
    return Array.isArray(arr) ? arr.map((t) => String(t).trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

/** 历史消息里存的是含 <thought> 标签的原文，加载时拆成正文 + 心路历程（兼容缺失闭合标签） */
export function parseThought(raw: string): { content: string; thought: string } {
  const m = raw.match(/<thought>([\s\S]*?)(?:<\/thought>|$)/)
  if (!m) return { content: raw.trim(), thought: '' }
  const idx = m.index ?? 0
  const content = (raw.slice(0, idx) + raw.slice(idx + m[0].length)).trim()
  return { content, thought: m[1].trim() }
}

export function errorText(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) {
    // ipcRenderer.invoke 的报错会带上 "Error invoking remote method 'xxx': Error: " 前缀
    return e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  }
  return fallback
}

/** 自适应高度的 textarea：内容变化时调用 */
export function autoGrow(el: HTMLTextAreaElement | null, max = 160): void {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, max)}px`
}
