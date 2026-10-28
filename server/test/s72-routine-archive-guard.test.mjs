import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { setSetting } from '../engine/settings.js'
import { upsertChannel } from '../engine/tasks.js'
import { bindProjectWiki } from '../engine/wiki.js'
import { startWikiArchive, getLatestWikiArchiveRun } from '../engine/wikiArchive.js'

// PRD S72（v0.84，K68）— 常态项目关闭「生成项目汇总」全量归档：
// 引擎 startWikiArchive 对 kind='routine' 直接 400（文案指明替代：周视图/打卡记录），
// 不落 wiki_archive_runs 行；交付项目原样；守卫只挡新触发。

let db
let members
beforeAll(() => {
  ;({ db } = setupDb())
  members = seedMembers(db)
  setSetting(db, 'im.feishu', { appId: 'a', appSecret: 's' }, members.admin.id)
})
afterAll(() => db?.close())
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const okJson = (data) => ({ ok: true, json: async () => ({ code: 0, data }) })

/** 绑定 wiki 页 + 专题群（S63 全部前置通过，只剩 kind 差异）。 */
async function readyProject(name, kind) {
  const p = createProject(db, { name, typeCode: 'lianmai_365', leadMemberId: members.lead.id, kind }, members.admin.id)
  await bindProjectWiki(db, p.id, {
    parentNodeToken: 'parenttok', newTitle: `${name}页`,
  }, members.admin.id)
  upsertChannel(db, { platform: 'feishu', groupKey: `oc_${p.id}`, channelType: 'dedicated', projectId: p.id }, members.admin.id)
  return p
}

describe('S72 常态项目关闭全量汇总归档', () => {
  it('S72-1: 常态项目触发 startWikiArchive → 400 且文案指明替代，不落台账行', async () => {
    // 让 bindProjectWiki 走通（父页 get_node + 建子页）
    globalThis.fetch = async (rawUrl) => {
      const url = String(rawUrl)
      if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tok' }) }
      if (url.includes('/wiki/v2/spaces/get_node')) return okJson({ node: { node_token: 'parenttok', obj_token: 'pdoc', obj_type: 'docx', title: '父页', space_id: 'sp1' } })
      if (url.includes('/wiki/v2/spaces/sp1/nodes')) return okJson({ node: { node_token: `np_${Date.now()}`, obj_token: 'nd', obj_type: 'docx', title: '页', space_id: 'sp1' } })
      return okJson({})
    }
    const p = await readyProject('常态归档禁区', 'routine')
    await expect(startWikiArchive(db, p.id, members.admin.id, { defer: false }))
      .rejects.toMatchObject({ statusCode: 400 })
    try {
      await startWikiArchive(db, p.id, members.admin.id, { defer: false })
      expect.unreachable('应抛 400')
    } catch (e) {
      expect(e.message).toContain('常态项目')
      expect(e.message).toContain('周视图')
    }
    // 未进入触发路径：无台账行、无审计行
    expect(db.prepare('SELECT COUNT(*) AS n FROM wiki_archive_runs WHERE project_id = ?').get(p.id).n).toBe(0)
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'project.wiki.archive' AND object_id = ?").get(String(p.id)).n).toBe(0)
  })

  it('S72-2: 交付项目原样可触发（落 running 台账）；守卫只挡新触发', async () => {
    globalThis.fetch = async (rawUrl) => {
      const url = String(rawUrl)
      if (url.includes('tenant_access_token')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'tok' }) }
      if (url.includes('/wiki/v2/spaces/get_node')) return okJson({ node: { node_token: 'parenttok', obj_token: 'pdoc', obj_type: 'docx', title: '父页', space_id: 'sp1' } })
      if (url.includes('/wiki/v2/spaces/sp1/nodes')) return okJson({ node: { node_token: `np2_${Date.now()}`, obj_token: 'nd2', obj_type: 'docx', title: '页', space_id: 'sp1' } })
      // 归档执行：空消息列表（快速走完）
      if (url.includes('/im/v1/messages')) return okJson({ items: [], has_more: false })
      return okJson({})
    }
    const p = await readyProject('交付归档照常', undefined)
    const run = await startWikiArchive(db, p.id, members.admin.id, { defer: false })
    expect(run.status).not.toBe('pending') // 正常落台账并执行（空消息 → done/failed 皆可，关键是未守卫拦截）
    expect(getLatestWikiArchiveRun(db, p.id).id).toBe(run.id)
  })
})
