/**
 * 敏感信息加密存储。
 *
 * 使用 Electron 内置 safeStorage：
 * - Windows 上底层为 DPAPI，密文绑定当前 Windows 用户；
 * - 落盘文件 userData/secure.json 里只有 base64 密文，不存任何明文。
 */

import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function storePath(): string {
  return join(app.getPath('userData'), 'secure.json')
}

function readAll(): Record<string, string> {
  const file = storePath()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}

function writeAll(data: Record<string, string>): void {
  writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function saveSecureValue(key: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统不支持安全加密存储（safeStorage 不可用）')
  }
  const all = readAll()
  all[key] = safeStorage.encryptString(value).toString('base64')
  writeAll(all)
}

export function loadSecureValue(key: string): string | null {
  const all = readAll()
  const encrypted = all[key]
  if (!encrypted) return null
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return null
  }
}

export function hasSecureValue(key: string): boolean {
  return Boolean(readAll()[key])
}

/** 生成掩码展示，如 6dce...dc1d */
export function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}
