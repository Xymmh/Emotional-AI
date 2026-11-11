import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import { join } from 'node:path'
import { readConfig, writeConfig } from './plain-config'
import {
  hasSecureValue,
  loadSecureValue,
  maskSecret,
  saveSecureValue,
} from './secure-store'
import { onSidecarExit, SidecarInfo, startSidecar, stopSidecar } from './sidecar'

// 统一用户数据目录为 %APPDATA%\emotional-ai：安装版 productName 是 "Emotional AI"，
// 不固定的话会落到另一个目录，开发态里保存过的 Key / 设置在安装版里就「消失」了。
// 必须在 app ready 之前设置。
app.setPath('userData', join(app.getPath('appData'), 'emotional-ai'))
app.setAppUserModelId('com.xymmh.emotionalai')

// 单实例：重复打开时聚焦已有窗口，避免两个进程各拉一个侧车同时写同一份数据库
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
}
app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

let mainWindow: BrowserWindow | null = null
let sidecar: SidecarInfo | null = null
let starting: Promise<SidecarInfo> | null = null
let quitting = false

// ---- 侧车生命周期：懒启动 + 崩溃后自动重启 ----

/**
 * 取可用的侧车连接；未启动（或上次启动失败 / 进程崩溃）时尝试启动一次。
 * 并发调用共享同一个启动过程，避免重复 spawn。
 */
async function ensureSidecar(): Promise<SidecarInfo> {
  if (sidecar) return sidecar
  if (quitting) throw new Error('应用正在退出')
  if (!starting) {
    starting = (async () => {
      const info = await startSidecar()
      sidecar = info
      await syncRuntime(info)
      return info
    })().finally(() => {
      starting = null
    })
  }
  return starting
}

onSidecarExit(() => {
  sidecar = null
})

/**
 * 把本地保存的 Key 与扮演模型推送给侧车。
 * 开发态拉起的侧车不注入 Key、生产态也不注入模型选择，若不推送，
 * 重启应用后设置页保存过的配置就「失效」了。
 */
async function syncRuntime(info: SidecarInfo): Promise<void> {
  const apiKey = loadSecureValue('arkApiKey')
  const roleplayModel = readConfig().roleplayModel
  if (!apiKey && !roleplayModel) return
  try {
    await rawCall(info, '/api/settings/runtime', {
      method: 'PUT',
      body: { api_key: apiKey || null, roleplay_model: roleplayModel || null },
    })
  } catch (error) {
    console.error('同步运行时配置失败', error)
  }
}

// ---- 侧车 HTTP 调用（令牌只在主进程内存中，渲染进程拿不到）----

interface FetchOptions {
  method?: string
  body?: unknown
}

async function rawCall<T>(info: SidecarInfo, path: string, options: FetchOptions = {}): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(`${info.url}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': info.token,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch {
    // 连接被拒：侧车多半已退出，清掉连接信息让下次请求自动重启
    if (sidecar === info) sidecar = null
    throw new Error('无法连接本地服务，请稍后重试')
  }
  const data = (await resp.json().catch(() => null)) as (T & { detail?: unknown }) | null
  if (!resp.ok) {
    throw new Error(formatDetail(data?.detail) ?? `本地服务请求失败（HTTP ${resp.status}）`)
  }
  return data as T
}

/** FastAPI 的 detail 可能是字符串，也可能是 422 校验错误数组 */
function formatDetail(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as { msg?: string; loc?: unknown[] }
    return `请求参数有误：${first.loc?.slice(1).join('.') ?? ''} ${first.msg ?? ''}`.trim()
  }
  return undefined
}

async function callSidecar<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const info = await ensureSidecar()
  return rawCall<T>(info, path, options)
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
    const newKey = payload.apiKey?.trim()
    if (newKey) {
      saveSecureValue('arkApiKey', newKey)
    }
    if (payload.roleplayModel) {
      writeConfig({ roleplayModel: payload.roleplayModel })
    }
    // 推送给后端使其立即生效（模型切换 / Key 更新都不用重启）
    const effectiveKey = newKey || loadSecureValue('arkApiKey') || ''
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
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new Error('非法的请求路径')
  }
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
  async (event, payload: { streamId?: string; path?: string; content: string; conversation_id?: string; persona_id?: string }) => {
    const info = await ensureSidecar()
    const { path = '/api/chat/stream', streamId = '', ...body } = payload
    // 只允许转发两条流式接口，防止渲染层借此访问任意路径
    if (path !== '/api/chat/stream' && path !== '/api/analyst/stream') {
      throw new Error('不支持的流式接口')
    }
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
      let resp: Response
      try {
        resp = await fetch(`${info.url}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sidecar-Token': info.token,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) throw error
        if (sidecar === info) sidecar = null
        throw new Error('无法连接本地服务，请稍后重试')
      }
      if (!resp.ok) {
        const data = (await resp.json().catch(() => null)) as { detail?: unknown } | null
        throw new Error(formatDetail(data?.detail) ?? `本地服务请求失败（HTTP ${resp.status}）`)
      }
      if (!resp.body) throw new Error('本地服务未返回流')

      reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let sseBuf = ''
      let errorText: string | null = null

      // 事件均携带 streamId：并发多路流时由 preload 按ID认领，避免互相串扰
      // 发给发起请求的那个页面；窗口已关闭时静默丢弃，避免 "Object has been destroyed"
      const sender = event.sender
      const send = (channel: string, text: string) => {
        if (!sender.isDestroyed()) sender.send(channel, streamId, text)
      }
      const emit = (text: string) => send('chat:delta', text)
      const emitThought = (text: string) => send('chat:thought', text)
      const emitStatus = (text: string) => send('chat:status', text)

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
  if (!gotInstanceLock) return
  Menu.setApplicationMenu(null)
  // 先开窗口再起侧车：Python 冷启动要好几秒，不让用户对着空白等待。
  // 渲染层的首个请求会经 ensureSidecar 等待同一个启动过程。
  createWindow()
  ensureSidecar().catch((error) => {
    // 侧车起不来不阻塞窗口，界面会提示本地服务离线并可重试
    console.error(error)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  quitting = true
  for (const s of activeStreams.values()) s.controller.abort()
  activeStreams.clear()
  stopSidecar()
})
