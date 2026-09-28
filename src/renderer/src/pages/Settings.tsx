import { useEffect, useState } from 'react'
import type { SettingsStatus, VerifyResult } from '../env'

interface SettingsPageProps {
  /** 当前页是否可见；切走时自动保存未提交的修改 */
  visible: boolean
}

export default function SettingsPage({ visible }: SettingsPageProps) {
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<SettingsStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [roleplayModel, setRoleplayModel] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const next = await window.appApi.settings.get()
      setStatus(next)
      if (next.roleplay_model) setRoleplayModel(next.roleplay_model)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  // 离开设置页时自动保存：Key 输入框有值、或模型切换过，才需要提交
  useEffect(() => {
    if (visible) return
    if (!status || status.sidecar_offline) return
    const keyChanged = apiKey.trim().length > 0
    const modelChanged = roleplayModel !== status.roleplay_model
    if (!keyChanged && !modelChanged) return
    void (async () => {
      try {
        const next = await window.appApi.settings.save({
          apiKey: apiKey.trim() || undefined,
          roleplayModel: modelChanged ? roleplayModel : undefined,
        })
        setStatus(next)
        setApiKey('')
      } catch {
        // 自动保存失败不打扰用户；回到设置页时看到的是服务端实际值
      }
    })()
    // 仅在「可见→不可见」这一跳触发；依赖里的 state 都取当次渲染最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const handleVerify = async () => {
    setVerifying(true)
    setVerifyResult(null)
    try {
      // 输入框有值就测试刚输入的（不落盘），为空则测试已保存的 Key
      const result = await window.appApi.settings.verify(apiKey || undefined)
      setVerifyResult(result)
    } catch (error) {
      setVerifyResult({ ok: false, message: String(error) })
    } finally {
      setVerifying(false)
    }
  }

  if (loading || !status) {
    return (
      <div className="settings-page">
        <div className="settings-inner" style={{ alignItems: 'center' }}>
          <div className="agent-status-spinner" />
          <div className="settings-loading-text">加载设置中…</div>
        </div>
      </div>
    )
  }

  const models = status.models
  const modelOptions = models
    ? [
        {
          id: models.roleplay_lite,
          name: 'Doubao Seed 2.0 Lite',
          desc: '通用对话模型，响应快、成本低',
        },
        {
          id: models.roleplay_character,
          name: 'Doubao Seed-Character',
          desc: '角色扮演专用模型，情感表达更自然',
        },
      ]
    : []

  return (
    <div className="settings-page">
      <div className="settings-inner">
        {status.sidecar_offline && (
          <div className="settings-warn">
            本地服务未运行，当前显示的是已保存配置；启动后端后可测试连接与保存。
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
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  status.has_key
                    ? '●'.repeat(status.key_length || 24)
                    : '请输入火山方舟 API Key'
                }
              />
              <button
                type="button"
                className="set-secondary-btn"
                disabled={verifying || status.sidecar_offline}
                onClick={() => void handleVerify()}
              >
                {verifying ? '测试中…' : '测试连接'}
              </button>
            </div>
            {!status.has_key && <div className="set-hint">未配置</div>}
            {verifyResult && (
              <div className={`set-verify${verifyResult.ok ? ' ok' : ' bad'}`}>
                {verifyResult.ok ? '✓ ' : '✕ '}
                {verifyResult.message}
              </div>
            )}
          </div>
        </section>

        {/* ── 扮演模型 ─────────────────────────────── */}
        <section className="set-card">
          <div className="set-card-head">
            <div className="set-card-title">主视角扮演模型</div>
            <div className="set-card-sub">ROLEPLAY MODEL</div>
          </div>
          {modelOptions.length > 0 ? (
            <div className="set-model-list">
              {modelOptions.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`set-model-opt${roleplayModel === m.id ? ' selected' : ''}`}
                  onClick={() => setRoleplayModel(m.id)}
                >
                  <span
                    className={`set-model-radio${roleplayModel === m.id ? ' on' : ''}`}
                  />
                  <span className="set-model-text">
                    <span className="set-model-name">{m.name}</span>
                    <span className="set-model-id">{m.id}</span>
                    <span className="set-model-desc">{m.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="set-hint">
              本地服务离线时无法获取模型列表，启动后恢复
            </div>
          )}
        </section>

        {/* ── 版权信息 ─────────────────────────────── */}
        <footer className="set-footer">
          <div className="set-footer-line">
            © 2026 Nanyang Technological University · WANG QIALUN
          </div>
          <div className="set-footer-line">V1.0.1</div>
        </footer>
      </div>
    </div>
  )
}
