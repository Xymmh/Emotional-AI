import { useCallback, useEffect, useState } from 'react'
import { Input, Modal } from '@arco-design/web-react'
import { IconPlus, IconSettings } from '@arco-design/web-react/icon'
import Workspace from './pages/Workspace'
import SettingsPage from './pages/Settings'

export interface PersonaLite {
  id: string
  name: string
  summary: string
  traits_json: string
  background: string
}

export default function App() {
  const [personas, setPersonas] = useState<PersonaLite[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [view, setView] = useState<'workspace' | 'settings'>('workspace')
  // 侧栏收缩态：对话只留首字、按钮只留图标
  const [collapsed, setCollapsed] = useState(false)
  // 打开过的对话常驻挂载（用 display 切换），切走不卸载，流式状态不丢
  const [mountedIds, setMountedIds] = useState<string[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const rows = await window.appApi.request<PersonaLite[]>('/api/personas')
      setPersonas(rows ?? [])
    } catch {
      setPersonas([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openPersona = (id: string) => {
    setMountedIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setSelectedId(id)
    setView('workspace')
  }

  const createConversation = async () => {
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    try {
      const p = await window.appApi.request<PersonaLite>('/api/personas', 'POST', {
        name,
        summary: '',
        traits_json: '[]',
        background: '',
      })
      setModalOpen(false)
      setNewName('')
      await refresh()
      openPersona(p.id)
    } catch (e) {
      setNewName('')
      setModalOpen(false)
      window.alert(e instanceof Error ? e.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const selected = personas.find((p) => p.id === selectedId) ?? null

  return (
    <div className="app-shell">
      <aside className={`app-sidebar${collapsed ? ' collapsed' : ''}`}>
          <div className="app-logo">
            {!collapsed && <span className="app-logo-name">Emotional AI</span>}
            <button
              type="button"
              className="sidebar-toggle-btn"
              title={collapsed ? '展开侧栏' : '收起侧栏'}
              onClick={() => setCollapsed((c) => !c)}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
                {collapsed ? (
                  <path d="M4.5 2.5 8 6.5 4.5 10.5" strokeLinecap="round" strokeLinejoin="round" />
                ) : (
                  <path d="M8.5 2.5 5 6.5 8.5 10.5" strokeLinecap="round" strokeLinejoin="round" />
                )}
              </svg>
            </button>
          </div>

          <button
            type="button"
            className="new-chat-btn"
            title="新建对话"
            onClick={() => setModalOpen(true)}
          >
            <IconPlus />
            {!collapsed && '新建对话'}
          </button>

          <div className="conv-list">
            {personas.length === 0 && !collapsed && (
              <div className="conv-empty">还没有对话。点上方「新建对话」开始。</div>
            )}
            {personas.map((p) => (
              <button
                key={p.id}
                type="button"
                title={collapsed ? p.name : undefined}
                className={`conv-item${selectedId === p.id && view === 'workspace' ? ' active' : ''}`}
                onClick={() => openPersona(p.id)}
              >
                {collapsed ? (
                  <span className="conv-avatar">{p.name.charAt(0)}</span>
                ) : (
                  <>
                    <span className="conv-name">{p.name}</span>
                    <span className="conv-sub">{p.summary || '画像待塑造'}</span>
                  </>
                )}
              </button>
            ))}
          </div>

          <button
            type="button"
            title="设置"
            className={`app-nav-item${view === 'settings' ? ' active' : ''}`}
            onClick={() => setView('settings')}
          >
            <span className="nav-icon">
              <IconSettings />
            </span>
            {!collapsed && '设置'}
          </button>
        </aside>

        <main className="app-main">
          {/* 标题栏只覆盖内容区上方；按钮在标题栏内部，与拖拽区是父子关系，可点性稳定 */}
          <div className="titlebar">
            <div className="titlebar-spacer" />
            <div className="win-controls">
              <button
                type="button"
                className="win-btn"
                title="最小化"
                onClick={() => window.appApi.win.minimize()}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" stroke="currentColor" strokeWidth="1.4">
                  <line x1="1.5" y1="6.5" x2="11.5" y2="6.5" />
                </svg>
              </button>
              <button
                type="button"
                className="win-btn"
                title="最大化/还原"
                onClick={() => window.appApi.win.toggleMaximize()}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <rect x="1.8" y="1.8" width="9.4" height="9.4" rx="1" />
                </svg>
              </button>
              <button
                type="button"
                className="win-btn win-close"
                title="关闭"
                onClick={() => window.appApi.win.close()}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" stroke="currentColor" strokeWidth="1.4">
                  <line x1="2.2" y1="2.2" x2="10.8" y2="10.8" />
                  <line x1="10.8" y1="2.2" x2="2.2" y2="10.8" />
                </svg>
              </button>
            </div>
          </div>

          <div className={`app-view${view === 'settings' ? ' view-on' : ''}`}>
            {/* 不再放「设置」标题栏；切走时由 SettingsPage 自行自动保存 */}
            <div className="app-content">
              <SettingsPage visible={view === 'settings'} />
            </div>
          </div>

          {personas
            .filter((p) => mountedIds.includes(p.id))
            .map((p) => (
              <div
                key={p.id}
                className={`app-view${view === 'workspace' && selectedId === p.id ? ' view-on' : ''}`}
              >
                <Workspace persona={p} onProfileUpdated={refresh} />
              </div>
            ))}

          {view === 'workspace' && !selected && (
            <div className="app-view view-on placeholder-page">
              <div className="ph-title">选择或新建一个对话</div>
              <div className="ph-desc">
                每个对话对应一位「对方」。在第三视角里发聊天记录，画像会自动塑造；
                切到主视角即可与「对方」预演对话。
              </div>
            </div>
          )}
        </main>

      <Modal
        title="新建对话"
        visible={modalOpen}
        confirmLoading={creating}
        onOk={() => void createConversation()}
        onCancel={() => setModalOpen(false)}
        okText="创建"
        cancelText="取消"
        autoFocus={false}
        escToExit
      >
        <div style={{ paddingTop: 8 }}>
          <div style={{ marginBottom: 10, color: 'var(--text-dim)', fontSize: 13 }}>
            给「对方」起个名字（之后可以随时补充 TA 的资料）
          </div>
          <Input
            placeholder="例如：小林"
            value={newName}
            onChange={setNewName}
            onPressEnter={() => void createConversation()}
          />
        </div>
      </Modal>
    </div>
  )
}
