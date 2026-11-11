import { useEffect, useState } from 'react'
import type { SettingsStatus, VerifyResult } from '../env'
import { errorText } from '../lib/util'

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
  const [saving, setSaving] = useState(false)
  const [saveTip, setSaveTip] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const next = await window.appApi.settings.get()
      setStatus(next)
      if (next.roleplay_model) setRoleplayModel(next.roleplay_model)
    } catch (e) {
      setStatus({
        has_key: false,
        key_hint: '',
        key_length: 0,
        roleplay_model: '',
        models: null,
        sidecar_offline: true,
      })
      setSaveTip({ ok: false, text: errorText(e, '读取设置失败') })
    } finally {
      setLoading(false)
    }
  }

  const keyChanged = apiKey.trim().length > 0
  const modelChanged = !!status && !!roleplayModel && roleplayModel !== status.roleplay_model
  const dirty = keyChanged || modelChanged

  const save = async (silent = false): Promise<boolean> => {
    if (!status || !dirty) return true
    setSaving(true)
    if (!silent) setSaveTip(null)
    try {
      const next = await window.appApi.settings.save({
        apiKey: keyChanged ? apiKey.trim() : undefined,
        roleplayModel: modelChanged ? roleplayModel : undefined,
      })
      setStatus(next)
      setApiKey('')
      if (next.roleplay_model) setRoleplayModel(next.roleplay_model)
      if (!silent) setSaveTip({ ok: true, text: '已保存，立即生效' })
      return true
    } catch (e) {
      if (!silent) setSaveTip({ ok: false, text: errorText(e, '保存失败') })
      return false
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  // 离开设置页时兜底自动保存（有未保存修改才提交）；回到设置页时重新读取实际状态
  useEffect(() => {
    if (visible) {
      if (status) void refresh()
      return
    }
    setSaveTip(null)
    setVerifyResult(null)
    if (dirty && status && !status.sidecar_offline) void save(true)
    // 仅在可见性翻转时触发；依赖里的 state 都取当次渲染最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const handleVerify = async () => {
    setVerifying(true)
    setVerifyResult(null)
    try {
      // 输入框有值就测试刚输入的（不落盘），为空则测试已保存的 Key
      const result = await window.appApi.settings.verify(apiKey.trim() || undefined)
      setVerifyResult(result)
    } catch (error) {
      setVerifyResult({ ok: false, message: errorText(error, '测试失败') })
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
            <div className="set-hint">
              {status.has_key
                ? `已保存（${status.key_hint}）。输入新 Key 可替换；Key 经系统加密保存在本机。`
                : '未配置。到火山方舟控制台创建 API Key 后粘贴到这里。'}
            </div>
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
                  onClick={() => {
                    setRoleplayModel(m.id)
                    setSaveTip(null)
                  }}
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

        <div className="set-save-row">
          <button
            type="button"
            className="set-primary-btn"
            disabled={!dirty || saving || status.sidecar_offline}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
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
          <div className="set-footer-line">V1.0.3</div>
        </footer>
      </div>
    </div>
  )
}
