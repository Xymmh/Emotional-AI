import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import { join } from 'node:path'
import { readConfig, writeConfig } from './plain-config'
import {
  hasSecureValue,
  loadSecureValue,
  maskSecret,
  saveSecureValue,
} from './secure-store'
import { SidecarInfo, startSidecar, stopSidecar } from './sidecar'

let mainWindow: BrowserWindow | null = null
let sidecar: SidecarInfo | null = null

// ---- 侧车 HTTP 调用（令牌只在主进程内存中，渲染进程拿不到）----

interface FetchOptions {
  method?: string
  body?: unknown
}

async function callSidecar<T>(path: string, options: FetchOptions = {}): Promise<T> {
  if (!sidecar) throw new Error('本地服务未启动')
  const resp = await fetch(`${sidecar.url}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': sidecar.token,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const data = (await resp.json().catch(() => null)) as T & { detail?: string } | null
  if (!resp.ok) {
    throw new Error(data?.detail ?? `本地服务请求失败（HTTP ${resp.status}）`)
  }
  return data as T
}

// ---- IPC：设置 ----

ipcMain.handle('settings:get', async () => {
  try {
    return await callSidecar('/api/settings/status')
  } catch {
    // 侧车不可用时返回本地缓存状态，界面仍可展示已保存的掩码
    const stored = loadSecureValue('arkApiKey')
    return {
      has_key: hasSecureValue('arkApiKey'),
      key_hint: maskSecret(stored ?? ''),
      key_length: stored?.length ?? 0,
      roleplay_model: readConfig().roleplayModel ?? '',
      models: null,
      sidecar_offline: true,
    }
  }
})

ipcMain.handle('settings:verify', async (_event, apiKey?: string) => {
  return callSidecar('/api/settings/verify', {
    method: 'POST',
    body: { api_key: apiKey || null },
  })
})

ipcMain.handle(
  'settings:save',
  async (_event, payload: { apiKey?: string; roleplayModel?: string }) => {
    if (payload.apiKey) {
      saveSecureValue('arkApiKey', payload.apiKey.trim())
    }
    if (payload.roleplayModel) {
      writeConfig({ roleplayModel: payload.roleplayModel })
    }
    // 推送给后端使其立即生效（模型切换 / Key 更新都不用重启）
    const effectiveKey = payload.apiKey ?? loadSecureValue('arkApiKey') ?? ''
    return callSidecar('/api/settings/runtime', {
      method: 'PUT',
      body: {
        api_key: effectiveKey || null,
        roleplay_model: payload.roleplayModel ?? null,
      },
    })
  },
)

// ---- IPC：通用代理（人格 / 会话 / 消息等） ----

ipcMain.handle('sidecar:request', (_event, path: string, method?: string, body?: unknown) => {
  return callSidecar(path, { method, body })
})

// ---- IPC：流式对话。主进程拉 SSE 并逐块转发渲染进程，令牌不出主进程 ----

// 在途流注册表：streamId → 中断控制器 + 会话/人格定位。
// chat:abort 按 streamId 精确中断，删除对话时按 personaId 级联中断。
const activeStreams = new Map<
  string,
  { controller: AbortController; conversationId?: string; personaId?: string }
>()

ipcMain.handle(
  'chat:stream',
  async (_event, payload: { streamId?: string; path?: string; content: string; conversation_id?: string; persona_id?: string }) => {
    if (!sidecar) throw new Error('本地服务未启动')
    const { path = '/api/chat/stream', streamId = '', ...body } = payload
    const controller = new AbortController()
    if (streamId) {
      activeStreams.set(streamId, {
        controller,
        conversationId: payload.conversation_id,
        personaId: payload.persona_id,
      })
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    try {
      const resp = await fetch(`${sidecar.url}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sidecar-Token': sidecar.token,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!resp.ok) {
        const data = (await resp.json().catch(() => null)) as { detail?: string } | null
        throw new Error(data?.detail ?? `本地服务请求失败（HTTP ${resp.status}）`)
      }
      if (!resp.body) throw new Error('本地服务未返回流')

      reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let sseBuf = ''
      let errorText: string | null = null

      // 事件均携带 streamId：并发多路流时由 preload 按ID认领，避免互相串扰
      const emit = (text: string) => mainWindow?.webContents.send('chat:delta', streamId, text)
      const emitThought = (text: string) => mainWindow?.webContents.send('chat:thought', streamId, text)
      const emitStatus = (text: string) => mainWindow?.webContents.send('chat:status', streamId, text)

      // <thought> 标签分流状态机：正文 → chat:delta，心路历程 → chat:thought。
      // 处理标签被网络分块截断的情况：结尾若是标签前缀则暂存，下一块再判断。
      // 模式切换后剥掉紧随标签的空白（模型习惯在 <thought> 后输出换行），
      // 否则心路历程开头会多出一行空行。
      const OPEN = '<thought>'
      const CLOSE = '</thought>'
      let mode: 'text' | 'thought' = 'text'
      let pending = ''
      let leadPending = true
      const stripLead = (s: string): string => {
        if (!leadPending) return s
        const stripped = s.replace(/^\s+/, '')
        if (stripped) leadPending = false
        return stripped
      }
      const splitThought = (chunk: string) => {
        pending += chunk
        for (;;) {
          if (mode === 'text') {
            const i = pending.indexOf(OPEN)
            if (i === -1) {
              // 结尾保留可能是标签前缀的部分
              const keep = longestTagSuffix(pending, OPEN)
              const out = stripLead(pending.slice(0, pending.length - keep))
              pending = pending.slice(pending.length - keep)
              if (out) emit(out)
              return
            }
            if (i > 0) {
              const out = stripLead(pending.slice(0, i))
              if (out) emit(out)
            }
            pending = pending.slice(i + OPEN.length)
            mode = 'thought'
            leadPending = true
          } else {
            const i = pending.indexOf(CLOSE)
            if (i === -1) {
              const keep = longestTagSuffix(pending, CLOSE)
              const out = stripLead(pending.slice(0, pending.length - keep))
              pending = pending.slice(pending.length - keep)
              if (out) emitThought(out)
              return
            }
            if (i > 0) {
              const out = stripLead(pending.slice(0, i))
              if (out) emitThought(out)
            }
            pending = pending.slice(i + CLOSE.length)
            mode = 'text'
            leadPending = true
          }
        }
      }
      const longestTagSuffix = (s: string, tag: string): number => {
        for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
          if (s.endsWith(tag.slice(0, n))) return n
        }
        return 0
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        sseBuf += decoder.decode(value, { stream: true })
        const frames = sseBuf.split('\n\n')
        sseBuf = frames.pop() ?? ''
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          try {
            const evt = JSON.parse(line.slice(6)) as { type: string; text?: string }
            if (evt.type === 'delta' && evt.text) splitThought(evt.text)
            else if (evt.type === 'status' && evt.text) emitStatus(evt.text)
            else if (evt.type === 'error') errorText = evt.text ?? '生成失败'
          } catch {
            // 忽略不完整帧
          }
        }
      }
      // 收尾：把滞留的 pending 冲出去
      {
        const out = stripLead(pending)
        if (out) {
          if ((mode as 'text' | 'thought') === 'thought') emitThought(out)
          else emit(out)
        }
      }
      if (errorText) throw new Error(errorText)
      return { ok: true }
    } finally {
      if (streamId) activeStreams.delete(streamId)
      // 取消 reader 以尽快断开与服务端的连接（服务端随之取消生成任务）
      void reader?.cancel().catch(() => {})
    }
  },
)

// 中断在途流。幂等：无匹配时直接返回 { aborted: 0 }，重复调用无副作用
ipcMain.handle(
  'chat:abort',
  (_event, q: { streamId?: string; conversationId?: string; personaId?: string }) => {
    let aborted = 0
    for (const [sid, s] of activeStreams) {
      const match =
        (q.streamId !== undefined && sid === q.streamId) ||
        (q.conversationId !== undefined && s.conversationId === q.conversationId) ||
        (q.personaId !== undefined && s.personaId === q.personaId)
      if (match) {
        s.controller.abort()
        activeStreams.delete(sid)
        aborted += 1
      }
    }
    return { aborted }
  },
)

// ---- IPC：窗口控制（无边框窗口的自定义标题栏按钮） ----

ipcMain.on('window:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize()
})

ipcMain.on('window:toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})

ipcMain.on('window:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})

// ---- 窗口 ----

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Emotional AI',
    frame: false, // 无边框：隐藏系统标题栏，控制按钮在 UI 内实现
    backgroundColor: '#ffffff',
    webPreferences: {
      // preload 显式构建为 CJS（见 electron.vite.config.ts）
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 开发期：F12 / Ctrl+Shift+I 打开开发者工具（菜单已移除）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      (input.key === 'F12' ||
        (input.control && input.shift && input.key.toLowerCase() === 'i'))
    ) {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
  })
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  try {
    sidecar = await startSidecar()
  } catch (error) {
    // 侧车起不来不阻塞窗口，设置页会提示本地服务离线
    console.error(error)
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  stopSidecar()
})
