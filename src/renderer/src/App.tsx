import { useCallback, useEffect, useState } from 'react'
import { IconPlus, IconSettings } from '@arco-design/web-react/icon'
import AppModal from './components/AppModal'
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
  const [createError, setCreateError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<PersonaLite | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

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
    setCreateError('')
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
      setCreateError(e instanceof Error ? e.message : '创建失败，请重试')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    setDeleteError('')
    try {
      // 先级联中断该人格下所有在途生成，再删数据：避免流结束时往已删除的会话写消息
      await window.appApi.chat.stop({ personaId: deleteTarget.id })
      await window.appApi.request(
        `/api/personas/${deleteTarget.id}`,
        'DELETE',
      )
      // 先摘掉挂载视图再清选中态，避免残留一个空 workspace
      setMountedIds((prev) => prev.filter((id) => id !== deleteTarget.id))
      if (selectedId === deleteTarget.id) setSelectedId('')
      setDeleteTarget(null)
      await refresh()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : '删除失败，请重试')
    } finally {
      setDeleting(false)
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
              <div key={p.id} className="conv-item-wrap">
                <button
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
                {!collapsed && (
                  <button
                    type="button"
                    className="conv-del-btn"
                    title="删除对话"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteError('')
                      setDeleteTarget(p)
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <path d="M1.5 3h9" strokeLinecap="round" />
                      <path d="M4.5 3V1.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V3" />
                      <path
                        d="M2.8 3l.5 7a1 1 0 0 0 1 .9h3.4a1 1 0 0 0 1-.9l.5-7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
              </div>
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

      <AppModal
        visible={modalOpen}
        title="新建对话"
        okText="创建"
        loading={creating}
        loadingText="创建中…"
        onOk={() => void createConversation()}
        onCancel={() => setModalOpen(false)}
      >
        <div className="app-modal-desc">
          给「对方」起个名字（之后可以随时补充 TA 的资料）
        </div>
        <input
          className="set-input app-modal-input"
          placeholder="例如：小林"
          value={newName}
          autoFocus
          onChange={(e) => setNewName(e.target.value)}
        />
        {createError && <div className="app-modal-error">{createError}</div>}
      </AppModal>

      <AppModal
        visible={deleteTarget !== null}
        title="删除对话"
        okText="删除"
        danger
        loading={deleting}
        loadingText="删除中…"
        onOk={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      >
        <div className="app-modal-desc">
          将删除「{deleteTarget?.name}」及其全部聊天记录、导入数据与画像记忆，
          <b>此操作不可恢复</b>。确定要删除吗？
        </div>
        {deleteError && <div className="app-modal-error">{deleteError}</div>}
      </AppModal>
    </div>
  )
}
