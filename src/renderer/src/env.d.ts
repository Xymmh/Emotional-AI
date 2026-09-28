export interface ModelOptions {
  chat: string
  analyst: string
  roleplay_lite: string
  roleplay_character: string
  embedding: string
}

export interface SettingsStatus {
  has_key: boolean
  key_hint: string
  /** 已保存 Key 的字符数，用于生成等长圆点占位符 */
  key_length: number
  roleplay_model: string
  models: ModelOptions | null
  sidecar_offline?: boolean
}

export interface VerifyResult {
  ok: boolean
  message: string
}

declare global {
  interface Window {
    appApi: {
      settings: {
        get: () => Promise<SettingsStatus>
        save: (payload: {
          apiKey?: string
          roleplayModel?: string
        }) => Promise<SettingsStatus>
        verify: (apiKey?: string) => Promise<VerifyResult>
      }
      request: <T>(path: string, method?: string, body?: unknown) => Promise<T>
      win: {
        minimize: () => void
        toggleMaximize: () => void
        close: () => void
      }
      chat: {
        stream: (
          path: string,
          body: Record<string, unknown>,
          onDelta: (text: string) => void,
          onThought?: (text: string) => void,
          onStatus?: (text: string) => void,
          /** 由渲染层生成的流ID：并发认领 + 中断凭据 */
          streamId?: string,
        ) => Promise<{ ok: boolean }>
        stop: (q: {
          streamId?: string
          conversationId?: string
          personaId?: string
        }) => Promise<{ aborted: number }>
      }
    }
  }
}
