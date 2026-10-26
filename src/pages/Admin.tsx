import { useEffect } from 'react'
import { useStore } from '../store'
import ProjectAdmin from './admin/ProjectAdmin'
import UserAdmin from './admin/UserAdmin'
import IntegrationAdmin from './admin/IntegrationAdmin'
import OpsAdmin from './admin/OpsAdmin'
import SchedulerAdmin from './admin/SchedulerAdmin'
import { PageMasthead } from '../components/editorial'
import { ADMIN_SECTIONS } from './admin/sections'

// S17 配置台（PRD v0.5）：仅系统管理员；二级菜单 + 每页 Tab（#/admin/<section>/<tab> 直达可收藏）
// 菜单与 Tab 清单见 ./admin/sections.ts（唯一配置处）

export default function Admin({ section, tab }: { section?: string; tab?: string }) {
  const { member } = useStore()
  const sec = ADMIN_SECTIONS.find((s) => s.key === section) ?? ADMIN_SECTIONS[0]
  const effTab = sec.tabs.some((t) => t.key === tab) ? tab! : sec.tabs[0].key
  // 归一化 URL：缺省/非法段补全为该 section 第一个 Tab
  useEffect(() => {
    const want = `#/admin/${sec.key}/${effTab}`
    if (location.hash !== want) location.hash = want
  }, [sec.key, effTab])

  const SectionPage = sec.key === 'project' ? ProjectAdmin : sec.key === 'scheduler' ? SchedulerAdmin : sec.key === 'users' ? UserAdmin : sec.key === 'ops' ? OpsAdmin : IntegrationAdmin

  return (
    <div>
      <PageMasthead
        kicker="Studio / 05"
        title="配置台"
        description="系统参数、成员与外部依赖的编辑工作台。仅系统管理员可见，所有变更都会留下审计记录。"
        aside={<div className="text-[11px] text-[var(--color-ink-soft)]">当前编辑者<br /><span className="mt-1 inline-block text-[13px] text-[var(--color-ink)]">{member?.name}</span></div>}
      />
      {/* 移动端分区菜单（<768px）：横排胶囊替代桌面左侧竖栏 */}
      <div data-nav="admin-sections" className="mb-5 mt-7 flex gap-1.5 overflow-x-auto md:hidden">
        {ADMIN_SECTIONS.map((s) => (
          <a
            key={s.key} href={`#/admin/${s.key}`}
            className={`whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[12px] transition-colors ${
              s.key === sec.key ? 'border-[var(--color-ink)] bg-[var(--color-ink)] font-medium text-[var(--color-card)]' : 'border-[var(--color-line-strong)] text-[var(--color-ink-soft)]'
            }`}
          >{s.label}</a>
        ))}
      </div>
      <div className="mt-8 flex gap-6 md:mt-10">
        <aside className="hidden w-36 shrink-0 flex-col gap-1 border-t border-[var(--color-ink)] pt-3 md:flex">
          <div className="editorial-kicker mb-3 px-3">Sections</div>
          {ADMIN_SECTIONS.map((s, index) => (
            <a
              key={s.key} href={`#/admin/${s.key}`}
              className={`flex items-baseline gap-2 rounded-[3px] px-3 py-2.5 text-[13px] transition-colors ${
                s.key === sec.key ? 'bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand-deep)]' : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-panel)] hover:text-[var(--color-ink)]'
              }`}
            ><span aria-hidden="true" className="num text-[9px] opacity-55">0{index + 1}</span>{s.label}</a>
          ))}
        </aside>
        <div className="min-w-0 flex-1">
          <SectionPage tab={effTab} />
        </div>
      </div>
    </div>
  )
}
