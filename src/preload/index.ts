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
    ): Promise<{ ok: boolean }> => {
      const deltaListener = (_e: IpcRendererEvent, text: string) => onDelta(text)
      const thoughtListener = (_e: IpcRendererEvent, text: string) => onThought?.(text)
      const statusListener = (_e: IpcRendererEvent, text: string) => onStatus?.(text)
      ipcRenderer.on('chat:delta', deltaListener)
      ipcRenderer.on('chat:thought', thoughtListener)
      ipcRenderer.on('chat:status', statusListener)
      return ipcRenderer
        .invoke('chat:stream', { path, ...body })
        .finally(() => {
          ipcRenderer.removeListener('chat:delta', deltaListener)
          ipcRenderer.removeListener('chat:thought', thoughtListener)
          ipcRenderer.removeListener('chat:status', statusListener)
        })
    },
  },
}

contextBridge.exposeInMainWorld('appApi', appApi)

export type AppApi = typeof appApi
