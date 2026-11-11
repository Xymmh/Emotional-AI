/**
 * 后端侧车（FastAPI）生命周期管理。
 *
 * 开发态：优先复用已在 8765 端口运行的 uvicorn（便于 --reload 调试），
 *        否则自动用项目 venv 里的 Python 拉起一个；
 * 生产态：spawn 打包在 resources/sidecar 下的可执行文件，
 *        使用随机空闲端口 + 随机令牌，并通过环境变量把解密后的 Key 注入。
 *
 * 侧车输出写入 userData/sidecar.log，启动失败时可据此排查（不再 stdio: ignore 吞掉错误）。
 */

import { app } from 'electron'
import { ChildProcess, spawn } from 'node:child_process'
import { loadSecureValue } from './secure-store'
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DEV_SIDECAR_URL = 'http://127.0.0.1:8765'
const DEFAULT_DEV_TOKEN = 'dev-token'

export interface SidecarInfo {
  url: string
  token: string
}

let sidecarProc: ChildProcess | null = null
let logStream: WriteStream | null = null
let exitListener: (() => void) | null = null

/** 侧车进程意外退出时回调（主进程据此清空连接信息，下次请求自动重启） */
export function onSidecarExit(listener: () => void): void {
  exitListener = listener
}

export function sidecarLogPath(): string {
  return join(app.getPath('userData'), 'sidecar.log')
}

function openLog(): WriteStream {
  if (!logStream) {
    mkdirSync(app.getPath('userData'), { recursive: true })
    logStream = createWriteStream(sidecarLogPath(), { flags: 'a' })
    logStream.write(`\n==== sidecar start ${new Date().toISOString()} ====\n`)
  }
  return logStream
}

function pipeToLog(proc: ChildProcess): void {
  const log = openLog()
  proc.stdout?.on('data', (d: Buffer) => log.write(d))
  proc.stderr?.on('data', (d: Buffer) => log.write(d))
  proc.on('exit', (code) => {
    log.write(`==== sidecar exit code=${code} ====\n`)
    if (sidecarProc === proc) {
      sidecarProc = null
      exitListener?.()
    }
  })
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('无法获取空闲端口'))
      })
    })
  })
}

async function waitForHealth(url: string, proc: ChildProcess, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false // 进程已退出，不必再等
    try {
      const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
      if (resp.ok) return true
    } catch {
      // 侧车尚未启动完成，继续轮询
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function isSidecarRunning(url: string): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) })
    return resp.ok
  } catch {
    return false
  }
}

/** 开发态令牌：与 server/.env 的 SIDECAR_TOKEN 保持一致，复用手动启动的 uvicorn 时才不会 401 */
function devToken(): string {
  const envFile = join(app.getAppPath(), 'server', '.env')
  if (existsSync(envFile)) {
    try {
      const m = readFileSync(envFile, 'utf-8').match(/^\s*SIDECAR_TOKEN\s*=\s*(.*?)\s*$/m)
      const v = m?.[1]?.replace(/^["']|["']$/g, '')
      if (v) return v
    } catch {
      // 读不到就用默认值
    }
  }
  return DEFAULT_DEV_TOKEN
}

function getStoredApiKey(): string {
  return loadSecureValue('arkApiKey') ?? ''
}

export async function startSidecar(): Promise<SidecarInfo> {
  if (!app.isPackaged) {
    const token = devToken()
    // 开发态：先看用户是否已手动启动了 uvicorn
    if (await isSidecarRunning(DEV_SIDECAR_URL)) {
      return { url: DEV_SIDECAR_URL, token }
    }
    const pythonExe = join(app.getAppPath(), 'server', '.venv', 'Scripts', 'python.exe')
    if (!existsSync(pythonExe)) {
      throw new Error('未找到 server/.venv，请先创建 Python 虚拟环境并安装依赖')
    }
    const proc = spawn(
      pythonExe,
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8765', '--app-dir', 'server'],
      {
        cwd: app.getAppPath(),
        env: { ...process.env, SIDECAR_TOKEN: token, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    sidecarProc = proc
    pipeToLog(proc)
    if (!(await waitForHealth(DEV_SIDECAR_URL, proc))) {
      stopSidecar()
      throw new Error(`开发态侧车启动失败，详见日志：${sidecarLogPath()}`)
    }
    return { url: DEV_SIDECAR_URL, token }
  }

  // 生产态
  const port = await pickFreePort()
  const token = randomUUID()
  const exePath = join(process.resourcesPath, 'sidecar', 'server.exe')
  if (!existsSync(exePath)) {
    throw new Error(`侧车可执行文件不存在：${exePath}`)
  }
  const dataDir = join(app.getPath('userData'), 'data')
  mkdirSync(dataDir, { recursive: true })
  const proc = spawn(exePath, ['--port', String(port)], {
    env: {
      ...process.env,
      SIDECAR_TOKEN: token,
      ARK_API_KEY: getStoredApiKey(),
      // 数据放到用户数据目录：打包后程序目录可能只读，或在 PyInstaller 临时目录里随退出被清空
      DB_PATH: join(dataDir, 'emotional_ai.db'),
      LANCEDB_PATH: join(dataDir, 'lancedb'),
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  sidecarProc = proc
  pipeToLog(proc)
  const url = `http://127.0.0.1:${port}`
  if (!(await waitForHealth(url, proc))) {
    stopSidecar()
    throw new Error(`侧车启动超时，详见日志：${sidecarLogPath()}`)
  }
  return { url, token }
}

export function stopSidecar(): void {
  const proc = sidecarProc
  sidecarProc = null
  if (proc && proc.exitCode === null && !proc.killed) {
    proc.kill()
  }
}
