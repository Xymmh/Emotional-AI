import { useState } from 'react'
import type { PersonaLite } from '../App'
import ChatPane from './Chat'
import AnalystPane from './AnalystPane'

interface WorkspaceProps {
  persona: PersonaLite
  onProfileUpdated: () => void
}

type Tab = 'analyst' | 'roleplay'

/** 解析 traits JSON，失败时返回空数组 */
function parseTraits(raw: string): string[] {
  try {
    const arr = JSON.parse(raw || '[]')
    return Array.isArray(arr) ? arr.map((t) => String(t)).filter(Boolean) : []
  } catch {
    return []
  }
}

export default function Workspace({ persona, onProfileUpdated }: WorkspaceProps) {
  const [tab, setTab] = useState<Tab>('analyst')
  const [refreshing, setRefreshing] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')

  const refreshProfile = async () => {
    if (refreshing) return
    setRefreshing(true)
    setProfileMsg('')
    try {
      await window.appApi.request(
        `/api/personas/${persona.id}/profile/refresh`,
        'POST',
      )
      setProfileMsg('画像已更新')
      onProfileUpdated()
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : '画像更新失败')
    } finally {
      setRefreshing(false)
      setTimeout(() => setProfileMsg(''), 6000)
    }
  }

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
            disabled={refreshing}
            onClick={() => void refreshProfile()}
          >
            {refreshing ? '生成中…' : '更新画像'}
          </button>
          {/* 悬停显示完整画像（标签栏只有一行空间，放不下全部内容） */}
          <div className="profile-pop">
            <div className="profile-pop-title">{persona.name} · 当前画像</div>
            <div className="profile-pop-summary">
              {persona.summary || '暂无概述，在第三视角发聊天记录后自动生成'}
            </div>
            {parseTraits(persona.traits_json).length > 0 && (
              <div className="profile-pop-traits">
                {parseTraits(persona.traits_json).map((t, i) => (
                  <span key={i} className="profile-pop-tag">
                    {t}
                  </span>
                ))}
              </div>
            )}
            {persona.background && (
              <div className="profile-pop-bg">{persona.background}</div>
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
    </div>
  )
}
