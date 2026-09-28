import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * 渲染进程能访问的唯一 API 面。
 * 所有后端调用都经主进程代理（附带侧车令牌），渲染进程不直连端口、不接触令牌。
 */
const appApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (payload: { apiKey?: string; roleplayModel?: string }) =>
      ipcRenderer.invoke('settings:save', payload),
    verify: (apiKey?: string) => ipcRenderer.invoke('settings:verify', apiKey),
  },
  request: <T>(path: string, method?: string, body?: unknown): Promise<T> =>
    ipcRenderer.invoke('sidecar:request', path, method, body),
  win: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  chat: {
    stream: (
      path: string,
      body: Record<string, unknown>,
      onDelta: (text: string) => void,
      onThought?: (text: string) => void,
      onStatus?: (text: string) => void,
      streamId?: string,
    ): Promise<{ ok: boolean }> => {
      // 每路流分配唯一 ID：并发流的 delta 广播按 ID 认领，防止内容串到别的对话；
      // 同一 ID 也是中断的凭据（chat.stop / chat:abort）
      const sid = streamId ?? crypto.randomUUID()
      const deltaListener = (_e: IpcRendererEvent, eid: string, text: string) => {
        if (eid === sid) onDelta(text)
      }
      const thoughtListener = (_e: IpcRendererEvent, eid: string, text: string) => {
        if (eid === sid) onThought?.(text)
      }
      const statusListener = (_e: IpcRendererEvent, eid: string, text: string) => {
        if (eid === sid) onStatus?.(text)
      }
      ipcRenderer.on('chat:delta', deltaListener)
      ipcRenderer.on('chat:thought', thoughtListener)
      ipcRenderer.on('chat:status', statusListener)
      return ipcRenderer
        .invoke('chat:stream', { streamId: sid, path, ...body })
        .finally(() => {
          ipcRenderer.removeListener('chat:delta', deltaListener)
          ipcRenderer.removeListener('chat:thought', thoughtListener)
          ipcRenderer.removeListener('chat:status', statusListener)
        })
    },
    // 中断在途流：按 streamId 精确中断，或按 conversationId / personaId 级联中断。
    // 幂等：无匹配返回 { aborted: 0 }，重复调用安全
    stop: (q: {
      streamId?: string
      conversationId?: string
      personaId?: string
    }): Promise<{ aborted: number }> => ipcRenderer.invoke('chat:abort', q),
  },
}

contextBridge.exposeInMainWorld('appApi', appApi)

export type AppApi = typeof appApi
