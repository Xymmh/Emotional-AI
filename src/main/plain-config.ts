/**
 * 非敏感配置（模型选择等）以明文 JSON 存于 userData/config.json。
 * 密钥绝不放这里。
 */

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PlainConfig {
  roleplayModel?: string
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function readConfig(): PlainConfig {
  const file = configPath()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as PlainConfig
  } catch {
    return {}
  }
}

export function writeConfig(patch: Partial<PlainConfig>): PlainConfig {
  const next = { ...readConfig(), ...patch }
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
