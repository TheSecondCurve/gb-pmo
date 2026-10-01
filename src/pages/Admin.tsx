import { useEffect } from 'react'
import { useStore } from '../store'
import ProjectAdmin from './admin/ProjectAdmin'
import UserAdmin from './admin/UserAdmin'
import IntegrationAdmin from './admin/IntegrationAdmin'
import OpsAdmin from './admin/OpsAdmin'
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

  const SectionPage = sec.key === 'project' ? ProjectAdmin : sec.key === 'users' ? UserAdmin : sec.key === 'ops' ? OpsAdmin : IntegrationAdmin

  return (
    <div>
      <h1 className="mb-3 text-lg font-bold">
        配置台 <span className="text-[12px] font-normal text-[var(--color-ink-soft)]">仅系统管理员 · 变更即审计留痕（S17）</span>
      </h1>
      <div className="flex gap-5">
        <aside className="hidden w-32 shrink-0 flex-col gap-0.5 md:flex">
          {ADMIN_SECTIONS.map((s) => (
            <a
              key={s.key} href={`#/admin/${s.key}`}
              className={`rounded-md px-3 py-2 text-[13px] ${
                s.key === sec.key ? 'bg-[var(--color-brand-soft)] font-medium text-[var(--color-brand)]' : 'hover:bg-[var(--color-bg)]'
              }`}
            >{s.label}</a>
          ))}
          <div className="mt-3 px-3 text-[11px] leading-5 text-[var(--color-ink-soft)]">{member?.name}</div>
        </aside>
        <div className="min-w-0 flex-1">
          <SectionPage tab={effTab} />
        </div>
      </div>
    </div>
  )
}
