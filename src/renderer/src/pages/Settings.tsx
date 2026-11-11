import { useEffect, useRef, useState } from 'react'
import type {
  EmbeddingApi,
  MemoryStatus,
  ModelConfig,
  ModelsResponse,
  ModelTestResult,
  SettingsStatus,
  VerifyResult,
} from '../env'
import { errorText } from '../lib/util'

interface SettingsPageProps {
  /** 当前页是否可见；切走时自动保存未提交的修改 */
  visible: boolean
}

/** 表单草稿：数字字段用字符串，便于输入中间态（如清空、输入一半） */
interface Draft {
  base_url: string
  roleplay_model: string
  analyst_model: string
  utility_model: string
  embedding_model: string
  embedding_api: EmbeddingApi
  embedding_dimensions: string
  roleplay_temperature: number
  analyst_temperature: number
}

type ChatRole = 'roleplay_model' | 'analyst_model' | 'utility_model'

const CHAT_ROLES: { key: ChatRole; title: string; desc: string }[] = [
  {
    key: 'roleplay_model',
    title: '扮演模型',
    desc: '主视角里扮演「对方」与你对话。角色扮演类模型情感表达通常更自然。',
  },
  {
    key: 'analyst_model',
    title: '分析师模型',
    desc: '第三视角解读聊天记录、生成画像。推荐用推理能力强的模型。',
  },
  {
    key: 'utility_model',
    title: '辅助模型',
    desc: '判断输入类型、整理对话、提炼观察、测试连接。调用频繁，选便宜快速的即可。',
  },
]

const EMBEDDING_APIS: { value: EmbeddingApi; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'multimodal', label: '多模态' },
  { value: 'text', label: '文本' },
]

function toDraft(c: ModelConfig): Draft {
  return {
    base_url: c.base_url,
    roleplay_model: c.roleplay_model,
    analyst_model: c.analyst_model,
    utility_model: c.utility_model,
    embedding_model: c.embedding_model,
    embedding_api: c.embedding_api,
    embedding_dimensions: c.embedding_dimensions ? String(c.embedding_dimensions) : '',
    roleplay_temperature: c.roleplay_temperature,
    analyst_temperature: c.analyst_temperature,
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (Object.keys(a) as (keyof Draft)[]).every(
    (k) => String(a[k]).trim() === String(b[k]).trim(),
  )
}

function dimsOf(d: Draft): number | null {
  const n = parseInt(d.embedding_dimensions, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function apiLabel(api: string): string {
  return api === 'multimodal' ? '多模态接口' : api === 'text' ? '文本接口' : api
}

export default function SettingsPage({ visible }: SettingsPageProps) {
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<SettingsStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null)

  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [tests, setTests] = useState<Record<string, ModelTestResult | 'running'>>({})
  const [memory, setMemory] = useState<MemoryStatus | null>(null)

  const [saving, setSaving] = useState(false)
  const [saveTip, setSaveTip] = useState<{ ok: boolean; text: string } | null>(null)
  const pollRef = useRef<number | undefined>(undefined)

  const offline = !status || !!status.sidecar_offline

  const applyModels = (m: ModelsResponse) => {
    setModels(m)
    setDraft(toDraft(m.config))
    setMemory(m.memory)
  }

  const refresh = async () => {
    setLoading(true)
    try {
      const next = await window.appApi.settings.get()
      setStatus(next)
      if (!next.sidecar_offline) {
        applyModels(await window.appApi.request<ModelsResponse>('/api/settings/models'))
      }
    } catch (e) {
      setStatus({ has_key: false, key_hint: '', key_length: 0, roleplay_model: '', sidecar_offline: true })
      setSaveTip({ ok: false, text: errorText(e, '读取设置失败') })
    } finally {
      setLoading(false)
    }
  }

  // 记忆库重建进行中：轮询进度
  const pollMemory = () => {
    window.clearTimeout(pollRef.current)
    pollRef.current = window.setTimeout(async () => {
      try {
        const m = await window.appApi.request<MemoryStatus>('/api/settings/memory')
        setMemory(m)
        if (m.rebuild.running) pollMemory()
      } catch {
        pollMemory()
      }
    }, 800)
  }

  useEffect(() => {
    void refresh()
    return () => window.clearTimeout(pollRef.current)
  }, [])

  const keyChanged = apiKey.trim().length > 0
  const modelsChanged = !!draft && !!models && !sameDraft(draft, toDraft(models.config))
  const dirty = keyChanged || modelsChanged

  const save = async (silent = false): Promise<boolean> => {
    if (!dirty || offline || !draft) return true
    setSaving(true)
    if (!silent) setSaveTip(null)
    try {
      if (keyChanged) {
        setStatus(await window.appApi.settings.save({ apiKey: apiKey.trim() }))
        setApiKey('')
      }
      if (modelsChanged) {
        const dims = dimsOf(draft)
        const next = await window.appApi.request<ModelsResponse>('/api/settings/models', 'PUT', {
          base_url: draft.base_url.trim(),
          roleplay_model: draft.roleplay_model.trim(),
          analyst_model: draft.analyst_model.trim(),
          utility_model: draft.utility_model.trim(),
          embedding_model: draft.embedding_model.trim(),
          embedding_api: draft.embedding_api,
          embedding_dimensions: dims,
          clear_embedding_dimensions: dims === null,
          roleplay_temperature: draft.roleplay_temperature,
          analyst_temperature: draft.analyst_temperature,
        })
        applyModels(next)
      }
      if (!silent) setSaveTip({ ok: true, text: '已保存，立即生效' })
      return true
    } catch (e) {
      if (!silent) setSaveTip({ ok: false, text: errorText(e, '保存失败') })
      return false
    } finally {
      setSaving(false)
    }
  }

  // 离开设置页时兜底自动保存；回到设置页时重新读取实际状态
  useEffect(() => {
    if (visible) {
      if (status) void refresh()
      return
    }
    setSaveTip(null)
    setVerifyResult(null)
    if (dirty) void save(true)
    // 仅在可见性翻转时触发；依赖里的 state 都取当次渲染最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [k]: v } : d))
    setSaveTip(null)
  }

  const handleVerify = async () => {
    setVerifying(true)
    setVerifyResult(null)
    try {
      setVerifyResult(await window.appApi.settings.verify(apiKey.trim() || undefined))
    } catch (error) {
      setVerifyResult({ ok: false, message: errorText(error, '测试失败') })
    } finally {
      setVerifying(false)
    }
  }

  /** 用表单里尚未保存的值测试单个模型 */
  const testModel = async (field: ChatRole | 'embedding_model') => {
    if (!draft) return
    setTests((t) => ({ ...t, [field]: 'running' }))
    const isEmb = field === 'embedding_model'
    try {
      const r = await window.appApi.request<ModelTestResult>('/api/settings/models/test', 'POST', {
        kind: isEmb ? 'embedding' : 'chat',
        model: draft[field].trim(),
        base_url: draft.base_url.trim() || null,
        api_key: apiKey.trim() || null,
        embedding_api: draft.embedding_api,
        embedding_dimensions: dimsOf(draft),
      })
      setTests((t) => ({ ...t, [field]: r }))
    } catch (e) {
      setTests((t) => ({ ...t, [field]: { ok: false, message: errorText(e, '测试失败'), latency_ms: 0 } }))
    }
  }

  const rebuildMemory = async () => {
    try {
      setMemory(await window.appApi.request<MemoryStatus>('/api/settings/memory/rebuild', 'POST'))
      pollMemory()
    } catch (e) {
      setSaveTip({ ok: false, text: errorText(e, '重建失败') })
    }
  }

  const resetModels = async () => {
    try {
      applyModels(await window.appApi.request<ModelsResponse>('/api/settings/models/reset', 'POST'))
      setTests({})
      setSaveTip({ ok: true, text: '已恢复默认模型设置' })
    } catch (e) {
      setSaveTip({ ok: false, text: errorText(e, '恢复默认失败') })
    }
  }

  if (loading && !status) {
    return (
      <div className="settings-page">
        <div className="settings-inner" style={{ alignItems: 'center' }}>
          <div className="agent-status-spinner" />
          <div className="settings-loading-text">加载设置中…</div>
        </div>
      </div>
    )
  }
  if (!status) return null

  const renderTest = (field: string) => {
    const t = tests[field]
    if (!t) return null
    if (t === 'running') return <div className="set-hint">测试中…</div>
    return (
      <div className={`set-verify${t.ok ? ' ok' : ' bad'}`}>
        {t.ok ? '✓ ' : '✕ '}
        {t.message}
        {t.latency_ms > 0 && <span className="set-latency">{t.latency_ms} ms</span>}
      </div>
    )
  }

  const embeddingDirty =
    !!draft &&
    !!models &&
    (draft.embedding_model.trim() !== models.config.embedding_model ||
      draft.embedding_api !== models.config.embedding_api ||
      dimsOf(draft) !== (models.config.embedding_dimensions ?? null))
  const memTotal = memory ? memory.count + memory.pending : 0
  const rebuild = memory?.rebuild

  return (
    <div className="settings-page">
      <div className="settings-inner">
        {status.sidecar_offline && (
          <div className="settings-warn">
            本地服务未运行，暂时无法读取或修改模型设置。
            <button type="button" className="set-secondary-btn" onClick={() => void refresh()}>
              重新连接
            </button>
          </div>
        )}

        {/* ── 模型服务 ─────────────────────────────── */}
        <section className="set-card">
          <div className="set-card-head">
            <div className="set-card-title">模型服务</div>
            <div className="set-card-sub">VOLCANO ARK</div>
          </div>

          <div className="set-field">
            <div className="set-label">API Key</div>
            <div className="set-key-row">
              <input
                type="password"
                className={`set-input${status.has_key && !apiKey ? ' masked' : ''}`}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setVerifyResult(null)
                  setSaveTip(null)
                }}
                placeholder={
                  status.has_key ? '●'.repeat(status.key_length || 24) : '请输入火山方舟 API Key'
                }
              />
              <button
                type="button"
                className="set-secondary-btn"
                disabled={verifying || offline}
                onClick={() => void handleVerify()}
              >
                {verifying ? '测试中…' : '测试连接'}
              </button>
            </div>
            <div className="set-hint">
              {status.has_key
                ? `已保存（${status.key_hint}）。输入新 Key 可替换；Key 经系统加密保存在本机。`
                : '未配置。到火山方舟控制台「API Key 管理」创建后粘贴到这里。'}
            </div>
            {verifyResult && (
              <div className={`set-verify${verifyResult.ok ? ' ok' : ' bad'}`}>
                {verifyResult.ok ? '✓ ' : '✕ '}
                {verifyResult.message}
              </div>
            )}
          </div>

          {draft && models && (
            <div className="set-field">
              <div className="set-label-row">
                <span className="set-label">接口地址</span>
                {draft.base_url !== models.defaults.base_url && (
                  <button
                    type="button"
                    className="set-link-btn"
                    onClick={() => set('base_url', models.defaults.base_url)}
                  >
                    恢复默认
                  </button>
                )}
              </div>
              <input
                className="set-input set-input-full"
                value={draft.base_url}
                spellCheck={false}
                onChange={(e) => set('base_url', e.target.value)}
              />
              <div className="set-hint">
                默认为火山方舟北京区域。也可填写其他兼容 OpenAI 格式的服务地址。
              </div>
            </div>
          )}
        </section>

        {/* ── 对话模型 ─────────────────────────────── */}
        {draft && models && (
          <section className="set-card">
            <div className="set-card-head">
              <div className="set-card-title">对话模型</div>
              <div className="set-card-sub">CHAT MODELS</div>
            </div>
            <div className="set-hint set-card-note">
              填写方舟控制台里的 Model ID（如 doubao-seed-…），或推理接入点 ID（ep- 开头）。
              模型下线时，只需在这里换成新的 ID，无需更新软件。
            </div>

            <datalist id="model-suggestions">
              {models.suggestions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>

            {CHAT_ROLES.map((role) => (
              <div key={role.key} className="set-field set-model-field">
                <div className="set-label-row">
                  <span className="set-label">{role.title}</span>
                  {draft[role.key] !== models.defaults[role.key] && (
                    <button
                      type="button"
                      className="set-link-btn"
                      onClick={() => set(role.key, models.defaults[role.key])}
                    >
                      恢复默认
                    </button>
                  )}
                </div>
                <div className="set-field-desc">{role.desc}</div>
                <div className="set-key-row">
                  <input
                    className="set-input"
                    list="model-suggestions"
                    value={draft[role.key]}
                    spellCheck={false}
                    placeholder={models.defaults[role.key]}
                    onChange={(e) => {
                      set(role.key, e.target.value)
                      setTests((t) => ({ ...t, [role.key]: undefined as never }))
                    }}
                  />
                  <button
                    type="button"
                    className="set-secondary-btn"
                    disabled={offline || tests[role.key] === 'running' || !draft[role.key].trim()}
                    onClick={() => void testModel(role.key)}
                  >
                    测试
                  </button>
                </div>
                {renderTest(role.key)}
                {role.key !== 'utility_model' && (
                  <div className="set-range-row">
                    <span className="set-range-label">温度</span>
                    <input
                      type="range"
                      min={0}
                      max={1.5}
                      step={0.1}
                      value={
                        role.key === 'roleplay_model'
                          ? draft.roleplay_temperature
                          : draft.analyst_temperature
                      }
                      onChange={(e) =>
                        set(
                          role.key === 'roleplay_model' ? 'roleplay_temperature' : 'analyst_temperature',
                          Number(e.target.value),
                        )
                      }
                    />
                    <span className="set-range-value">
                      {(role.key === 'roleplay_model'
                        ? draft.roleplay_temperature
                        : draft.analyst_temperature
                      ).toFixed(1)}
                    </span>
                    <span className="set-range-hint">
                      {role.key === 'roleplay_model' ? '越高越随性多变' : '越低越稳定严谨'}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        {/* ── 向量记忆 ─────────────────────────────── */}
        {draft && models && (
          <section className="set-card">
            <div className="set-card-head">
              <div className="set-card-title">向量记忆</div>
              <div className="set-card-sub">EMBEDDING</div>
            </div>
            <div className="set-hint set-card-note">
              聊天记录与分析洞察会被向量化存入本地记忆库，对话时检索相关片段。
              更换向量模型后需要重建记忆库（用新模型重新向量化全部记忆，原文不会丢失）。
            </div>

            <div className="set-field">
              <div className="set-label-row">
                <span className="set-label">向量模型</span>
                {draft.embedding_model !== models.defaults.embedding_model && (
                  <button
                    type="button"
                    className="set-link-btn"
                    onClick={() => set('embedding_model', models.defaults.embedding_model)}
                  >
                    恢复默认
                  </button>
                )}
              </div>
              <div className="set-key-row">
                <input
                  className="set-input"
                  value={draft.embedding_model}
                  spellCheck={false}
                  placeholder={models.defaults.embedding_model}
                  onChange={(e) => {
                    set('embedding_model', e.target.value)
                    setTests((t) => ({ ...t, embedding_model: undefined as never }))
                  }}
                />
                <button
                  type="button"
                  className="set-secondary-btn"
                  disabled={offline || tests.embedding_model === 'running' || !draft.embedding_model.trim()}
                  onClick={() => void testModel('embedding_model')}
                >
                  测试
                </button>
              </div>
              {renderTest('embedding_model')}
            </div>

            <div className="set-inline-fields">
              <div className="set-field">
                <div className="set-label">接口类型</div>
                <div className="set-seg">
                  {EMBEDDING_APIS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      className={`set-seg-btn${draft.embedding_api === o.value ? ' on' : ''}`}
                      onClick={() => set('embedding_api', o.value)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <div className="set-hint">
                  自动：模型名含 vision 用多模态接口，否则用文本接口
                </div>
              </div>
              <div className="set-field">
                <div className="set-label">输出维度</div>
                <input
                  className="set-input set-input-narrow"
                  inputMode="numeric"
                  value={draft.embedding_dimensions}
                  placeholder="模型默认"
                  onChange={(e) => set('embedding_dimensions', e.target.value.replace(/\D/g, ''))}
                />
                <div className="set-hint">留空使用模型默认；部分模型不支持自定义</div>
              </div>
            </div>

            {memory && (
              <div className={`mem-status${memory.stale ? ' stale' : ''}`}>
                <div className="mem-status-line">
                  记忆库：{memory.count} 条
                  {memory.pending > 0 && `，另有 ${memory.pending} 条等待向量化`}
                  {memory.built_with && memory.count > 0 && (
                    <span className="mem-status-sub">
                      由 {memory.built_with.model}（{apiLabel(memory.built_with.api)}
                      {memory.dim ? `，${memory.dim} 维` : ''}）生成
                    </span>
                  )}
                </div>
                {rebuild?.running ? (
                  <div className="mem-progress">
                    <div className="mem-progress-bar">
                      <div
                        className="mem-progress-fill"
                        style={{
                          width: `${rebuild.total ? (rebuild.done / rebuild.total) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <span className="mem-progress-text">
                      重建中 {rebuild.done} / {rebuild.total}
                    </span>
                  </div>
                ) : memory.stale && memTotal > 0 ? (
                  <div className="mem-stale">
                    <span>
                      向量设置已更改，记忆检索暂停（对话照常，只是不引用记忆）。新记忆会先暂存。
                    </span>
                    <button
                      type="button"
                      className="set-secondary-btn"
                      disabled={offline || modelsChanged}
                      title={modelsChanged ? '请先保存设置' : undefined}
                      onClick={() => void rebuildMemory()}
                    >
                      重建记忆库（{memTotal} 条）
                    </button>
                  </div>
                ) : null}
                {rebuild?.error && !rebuild.running && (
                  <div className="set-verify bad">✕ 上次重建失败：{rebuild.error}</div>
                )}
              </div>
            )}
            {embeddingDirty && memTotal > 0 && (
              <div className="set-hint set-warn-text">
                保存后需要重建记忆库（{memTotal} 条），会按新模型重新调用向量接口。
              </div>
            )}
          </section>
        )}

        <div className="set-save-row">
          <button
            type="button"
            className="set-primary-btn"
            disabled={!dirty || saving || offline}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          {models && (
            <button
              type="button"
              className="set-link-btn"
              disabled={saving || offline}
              onClick={() => void resetModels()}
            >
              恢复全部默认模型
            </button>
          )}
          {saveTip && (
            <span className={`set-saved-tip${saveTip.ok ? '' : ' bad'}`}>{saveTip.text}</span>
          )}
          {!saveTip && dirty && <span className="set-hint">有未保存的修改</span>}
        </div>

        {/* ── 版权信息 ─────────────────────────────── */}
        <footer className="set-footer">
          <div className="set-footer-line">
            © 2026 Nanyang Technological University · WANG QIALUN
          </div>
          <div className="set-footer-line">V1.0.4</div>
        </footer>
      </div>
    </div>
  )
}
