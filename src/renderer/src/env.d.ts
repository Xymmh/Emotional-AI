export interface SettingsStatus {
  has_key: boolean
  key_hint: string
  /** 已保存 Key 的字符数，用于生成等长圆点占位符 */
  key_length: number
  roleplay_model: string
  sidecar_offline?: boolean
}

export type EmbeddingApi = 'auto' | 'multimodal' | 'text'

/** 后端 services/model_config.py 的 ModelConfig */
export interface ModelConfig {
  base_url: string
  roleplay_model: string
  analyst_model: string
  utility_model: string
  embedding_model: string
  embedding_api: EmbeddingApi
  embedding_dimensions: number | null
  roleplay_temperature: number
  analyst_temperature: number
  recent_models: string[]
}

export interface EmbeddingSignature {
  model: string
  api: 'multimodal' | 'text'
  dimensions: number | null
}

export interface MemoryStatus {
  count: number
  pending: number
  stale: boolean
  built_with: EmbeddingSignature | null
  dim: number | null
  current: EmbeddingSignature
  rebuild: { running: boolean; done: number; total: number; error: string }
}

export interface ModelsResponse {
  config: ModelConfig
  defaults: ModelConfig
  suggestions: string[]
  memory: MemoryStatus
}

export interface ModelTestResult {
  ok: boolean
  message: string
  latency_ms: number
  dim?: number | null
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
        save: (payload: { apiKey?: string }) => Promise<SettingsStatus>
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
