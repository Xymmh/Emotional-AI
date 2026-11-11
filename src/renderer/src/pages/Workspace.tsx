import { useEffect, useRef, useState } from 'react'
import type { PersonaLite } from '../App'
import AppModal from '../components/AppModal'
import { errorText, parseTraits } from '../lib/util'
import ChatPane from './Chat'
import AnalystPane from './AnalystPane'

interface WorkspaceProps {
  persona: PersonaLite
  onProfileUpdated: () => void
}

type Tab = 'analyst' | 'roleplay'

interface EditForm {
  name: string
  summary: string
  traits: string
  background: string
}

function toForm(p: PersonaLite): EditForm {
  return {
    name: p.name,
    summary: p.summary,
    traits: parseTraits(p.traits_json).join('、'),
    background: p.background,
  }
}

/** observations 每行形如「#轮次 短句」，展示时去掉轮次号，取最近几条 */
function recentObservations(raw: string, n = 5): string[] {
  return (raw || '')
    .split('\n')
    .map((l) => l.trim().replace(/^#\d+\s+/, ''))
    .filter(Boolean)
    .slice(-n)
    .reverse()
}

export default function Workspace({ persona, onProfileUpdated }: WorkspaceProps) {
  const [tab, setTab] = useState<Tab>('analyst')
  const [refreshing, setRefreshing] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')
  const msgTimer = useRef<number | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<EditForm>(() => toForm(persona))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => () => window.clearTimeout(msgTimer.current), [])

  const flash = (text: string) => {
    setProfileMsg(text)
    window.clearTimeout(msgTimer.current)
    msgTimer.current = window.setTimeout(() => setProfileMsg(''), 6000)
  }

  const refreshProfile = async () => {
    if (refreshing) return
    setRefreshing(true)
    setProfileMsg('')
    try {
      await window.appApi.request(`/api/personas/${persona.id}/profile/refresh`, 'POST')
      flash('画像已更新')
      onProfileUpdated()
    } catch (e) {
      flash(errorText(e, '画像更新失败'))
    } finally {
      setRefreshing(false)
    }
  }

  const openEditor = () => {
    setForm(toForm(persona))
    setSaveError('')
    setEditing(true)
  }

  const saveEdit = async () => {
    if (saving) return
    const name = form.name.trim()
    if (!name) {
      setSaveError('名字不能为空')
      return
    }
    const traits = form.traits
      .split(/[、，,;；\n]/)
      .map((t) => t.trim())
      .filter(Boolean)
    setSaving(true)
    setSaveError('')
    try {
      await window.appApi.request(`/api/personas/${persona.id}`, 'PATCH', {
        name,
        summary: form.summary.trim(),
        traits_json: JSON.stringify(traits),
        background: form.background.trim(),
      })
      setEditing(false)
      onProfileUpdated()
    } catch (e) {
      setSaveError(errorText(e, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const traits = parseTraits(persona.traits_json)
  const observations = recentObservations(persona.observations)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="ws-tabs">
        <button
          type="button"
          className={`ws-tab${tab === 'analyst' ? ' active' : ''}`}
          onClick={() => setTab('analyst')}
        >
          第三视角
        </button>
        <button
          type="button"
          className={`ws-tab${tab === 'roleplay' ? ' active' : ''}`}
          onClick={() => setTab('roleplay')}
        >
          主视角
        </button>
        <div className="ws-tab-spacer" />
        <div className="profile-area">
          <div className="profile-line">
            {profileMsg || persona.summary || '画像待塑造：在第三视角发聊天记录，自动生成'}
          </div>
          <button
            type="button"
            className="profile-refresh-btn"
            onClick={openEditor}
            title="手动编辑名字、概述、性格标签与背景"
          >
            编辑
          </button>
          <button
            type="button"
            className="profile-refresh-btn"
            disabled={refreshing}
            onClick={() => void refreshProfile()}
            title="根据第三视角的分析重新生成画像"
          >
            {refreshing ? '生成中…' : '更新画像'}
          </button>
          {/* 悬停显示完整画像（标签栏只有一行空间，放不下全部内容） */}
          <div className="profile-pop">
            <div className="profile-pop-title">{persona.name} · 当前画像</div>
            <div className="profile-pop-summary">
              {persona.summary || '暂无概述，在第三视角发聊天记录后自动生成'}
            </div>
            {traits.length > 0 && (
              <div className="profile-pop-traits">
                {traits.map((t, i) => (
                  <span key={i} className="profile-pop-tag">
                    {t}
                  </span>
                ))}
              </div>
            )}
            {persona.background && <div className="profile-pop-bg">{persona.background}</div>}
            {observations.length > 0 && (
              <div className="profile-pop-obs">
                <div className="profile-pop-obs-title">近期观察</div>
                {observations.map((o, i) => (
                  <div key={i} className="profile-pop-obs-item">
                    {o}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: tab === 'analyst' ? 'flex' : 'none' }}>
        <AnalystPane
          personaId={persona.id}
          personaName={persona.name}
          onProfileUpdated={onProfileUpdated}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'roleplay' ? 'flex' : 'none' }}>
        <ChatPane personaId={persona.id} personaName={persona.name} />
      </div>

      <AppModal
        visible={editing}
        title="编辑画像"
        okText="保存"
        loading={saving}
        loadingText="保存中…"
        onOk={() => void saveEdit()}
        onCancel={() => setEditing(false)}
      >
        <div className="edit-form">
          <label className="edit-field">
            <span className="set-label">名字</span>
            <input
              className="set-input"
              value={form.name}
              maxLength={40}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="edit-field">
            <span className="set-label">一句话概述</span>
            <input
              className="set-input"
              value={form.summary}
              maxLength={200}
              placeholder="例如：外冷内热，嘴硬心软"
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
            />
          </label>
          <label className="edit-field">
            <span className="set-label">性格标签（用顿号或逗号分隔）</span>
            <input
              className="set-input"
              value={form.traits}
              placeholder="例如：敏感、慢热、回避冲突"
              onChange={(e) => setForm({ ...form, traits: e.target.value })}
            />
          </label>
          <label className="edit-field">
            <span className="set-label">背景</span>
            <textarea
              className="set-input edit-textarea"
              value={form.background}
              maxLength={1000}
              rows={3}
              placeholder="年龄、职业、你们的关系……"
              onChange={(e) => setForm({ ...form, background: e.target.value })}
            />
          </label>
        </div>
        {saveError && <div className="app-modal-error">{saveError}</div>}
      </AppModal>
    </div>
  )
}
