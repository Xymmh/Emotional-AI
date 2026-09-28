/**
 * 后端侧车（FastAPI）生命周期管理。
 *
 * 开发态：优先复用已在 8765 端口运行的 uvicorn（便于 --reload 调试），
 *        否则自动用项目 venv 里的 Python 拉起一个；
 * 生产态：spawn 打包在 resources/sidecar 下的可执行文件，
 *        使用随机空闲端口 + 随机令牌，并通过环境变量把解密后的 Key 注入。
 */

import { app } from 'electron'
import { ChildProcess, spawn } from 'node:child_process'
import { loadSecureValue } from './secure-store'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DEV_SIDECAR_URL = 'http://127.0.0.1:8765'
const DEV_SIDECAR_TOKEN = 'dev-token'

export interface SidecarInfo {
  url: string
  token: string
}

let sidecarProc: ChildProcess | null = null

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

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${url}/health`)
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

function getStoredApiKey(): string {
  // 仅在 app ready 后的生产态侧车启动流程中调用，safeStorage 此时已可用
  return loadSecureValue('arkApiKey') ?? ''
}

export async function startSidecar(): Promise<SidecarInfo> {
  if (!app.isPackaged) {
    // 开发态：先看用户是否已手动启动了 uvicorn
    if (await isSidecarRunning(DEV_SIDECAR_URL)) {
      return { url: DEV_SIDECAR_URL, token: DEV_SIDECAR_TOKEN }
    }
    const pythonExe = join(app.getAppPath(), 'server', '.venv', 'Scripts', 'python.exe')
    if (!existsSync(pythonExe)) {
      throw new Error('未找到 server/.venv，请先创建 Python 虚拟环境并安装依赖')
    }
    sidecarProc = spawn(
      pythonExe,
      ['-m', 'uvicorn', 'app.main:app', '--port', '8765', '--app-dir', 'server'],
      {
        cwd: app.getAppPath(),
        env: { ...process.env, SIDECAR_TOKEN: DEV_SIDECAR_TOKEN },
        stdio: 'ignore',
      },
    )
    if (!(await waitForHealth(DEV_SIDECAR_URL))) {
      throw new Error('开发态侧车启动失败，请改用 npm run dev:server 查看错误日志')
    }
    return { url: DEV_SIDECAR_URL, token: DEV_SIDECAR_TOKEN }
  }

  // 生产态
  const port = await pickFreePort()
  const token = randomUUID()
  const exePath = join(process.resourcesPath, 'sidecar', 'server.exe')
  if (!existsSync(exePath)) {
    throw new Error(`侧车可执行文件不存在：${exePath}`)
  }
  sidecarProc = spawn(exePath, ['--port', String(port)], {
    env: {
      ...process.env,
      SIDECAR_TOKEN: token,
      ARK_API_KEY: getStoredApiKey(),
    },
    stdio: 'ignore',
  })
  const url = `http://127.0.0.1:${port}`
  if (!(await waitForHealth(url))) {
    throw new Error('侧车启动超时')
  }
  return { url, token }
}

export function stopSidecar(): void {
  if (sidecarProc && !sidecarProc.killed) {
    sidecarProc.kill()
    sidecarProc = null
  }
}
