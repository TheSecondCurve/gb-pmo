import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { createTask, upsertChannel } from '../engine/tasks.js'
import { addEvent } from '../engine/events.js'
import { dailyProjectMorningPush } from '../brain/morningPush.js'
import { getLlm } from '../brain/llm.js'
import { today, addDays } from '../db/time.js'

// PRD S68（v0.75，K54）— 每日项目群晨报：向每个绑定飞书专题群的在跑项目群推送当日盘面。
// 数据底座复用 S28 engine/morning.js 确定性块 + 近期开工窗口（7 天）；LLM 只写综述段
// （purpose=morning 记账）；正文骨架代码拼装（分节 + list）；项目级日幂等；LLM 缺席降级。

let db
let members
afterAll(() => db?.close())

function fakeSend(sink) {
  return async (payload) => {
    sink.push(payload)
    return { messageId: `om_${sink.length}` }
  }
}

// 模板任务清场（口径断言要精确基数；被测数据全部显式创建）
function seedProject(name, { channel = true } = {}) {
  const p = createProject(db, { name, typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
  db.prepare(`UPDATE tasks SET deleted_at = ? WHERE project_id = ? AND deleted_at IS NULL`).run(Date.now(), p.id)
  if (channel) upsertChannel(db, { platform: 'feishu', groupKey: `oc_${p.id}`, channelType: 'dedicated', projectId: p.id })
  return p
}

async function seedMorningProject(name) {
  const p = seedProject(name)
  createTask(db, { projectId: p.id, title: '逾期联调', responsibleMemberId: members.dev.id, planEndDate: addDays(today(), -1) }, members.admin.id)
  createTask(db, { projectId: p.id, title: '下周开工的部署', responsibleMemberId: members.dev.id, planStartDate: addDays(today(), 3) }, members.admin.id)
  addEvent(db, { projectId: p.id, nature: 'record', eventType: 'progress', summary: '完成了登录模块联调', sourcePlatform: 'feishu', speakerLabel: '张三' })
  return p
}

describe('S68 每日项目群晨报', () => {
  it('S68-1: 绑定专题群的在跑项目收到结构化晨报——分节 + list，逾期带天数责任人、近期开工带日期、动态带说话人', async () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    const p = await seedMorningProject('晨报主项目')

    let llmInput = null
    const fakeLlm = { name: 'fake', complete: async (msgs) => { llmInput = msgs; return '整体可控，但逾期联调需今天拉平，关注部署排期。' } }
    const sent = []
    const out = await dailyProjectMorningPush(db, { llm: fakeLlm, send: fakeSend(sent) })

    const row = db.prepare(`SELECT * FROM pushes WHERE push_type = 'morning' AND related_project_id = ?`).get(p.id)
    expect(row).toBeTruthy()
    expect(row.group_key).toBe(`oc_${p.id}`)
    expect(row.status).toBe('sent')
    expect(row.recipient_member_id).toBeNull()
    expect(row.title).toContain('晨报主项目')
    expect(sent).toHaveLength(1)
    expect(sent[0].chatId).toBe(`oc_${p.id}`)
    expect(sent[0].post).toBeTruthy() // 多行正文走 post 富文本

    // 结构化分节 + list 行（不糊成一坨）
    const body = row.body
    for (const section of ['【项目概况】', '【逾期任务】', '【近期开工】', '【昨日以来动态】']) {
      expect(body).toContain(section)
    }
    expect(body).toContain('- 逾期联调（李四，超 1 天')
    expect(body).toContain('- 下周开工的部署（计划')
    expect(body).toContain(addDays(today(), 3))
    expect(body).toContain('张三：完成了登录模块联调')
    expect(body).toContain('综述：整体可控')

    // LLM 只拿确定性数据写综述（转述不拼口径），purpose=morning 记账
    expect(llmInput[0].role).toBe('system')
    expect(llmInput[1].content).toContain('逾期联调')
    expect(llmInput[1].content).toContain('下周开工的部署')
    const usage = db.prepare(`SELECT purpose FROM llm_calls WHERE purpose = 'morning'`).all()
    expect(usage.length).toBe(1)
    expect(out.results.find((r) => r.projectId === p.id).pushed).toBe(true)
  })

  it('S68-2: LLM 未配置综述降级但分节结构不变；LLM 抛错单项目降级不阻塞其余项目', async () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    const p1 = await seedMorningProject('无LLM项目')

    // 无 LLM（未注入且未配置 apiKey）→ 综述确定性一句，分节齐全
    const sent = []
    await dailyProjectMorningPush(db, { send: fakeSend(sent) })
    const body = db.prepare(`SELECT body FROM pushes WHERE push_type = 'morning' AND related_project_id = ?`).get(p1.id).body
    expect(body).toContain('【项目概况】')
    expect(body).toMatch(/综述：.*(无逾期任务|逾期)/)
    expect(body).toContain('【逾期任务】')
    expect(getLlm(db, undefined, { purpose: 'morning' })).toBeNull()

    // LLM 抛错 → 该项目降级推送，另一项目不受阻塞
    const p2 = seedProject('另一个项目')
    const throwing = { name: 'bad', complete: async () => { throw new Error('boom') } }
    const sent2 = []
    const out = await dailyProjectMorningPush(db, { llm: throwing, send: fakeSend(sent2) })
    expect(out.results.find((r) => r.projectId === p2.id).pushed).toBe(true)
    const body2 = db.prepare(`SELECT body FROM pushes WHERE push_type = 'morning' AND related_project_id = ?`).get(p2.id).body
    expect(body2).toContain('【项目概况】')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE push_type = 'morning'`).get().n).toBe(2)
  })

  it('S68-3: 项目级日幂等（同日重跑不重发）；无绑定群与终态项目静默跳过不落行', async () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    await seedMorningProject('幂等项目')
    const noChannel = seedProject('无群项目', { channel: false })
    const closed = seedProject('已结项项目')
    db.prepare(`UPDATE projects SET status = 'closed' WHERE id = ?`).run(closed.id)

    const sent = []
    await dailyProjectMorningPush(db, { llm: null, send: fakeSend(sent) })
    expect(sent).toHaveLength(1) // 只有无群项目被跳过、结项项目不在扫描面

    // 同日重跑：全部跳过，不新增推送
    const sent2 = []
    const again = await dailyProjectMorningPush(db, { llm: null, send: fakeSend(sent2) })
    expect(sent2).toHaveLength(0)
    expect(again.results.every((r) => r.skipped)).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE push_type = 'morning'`).get().n).toBe(1)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE related_project_id = ?`).get(noChannel.id).n).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pushes WHERE related_project_id = ?`).get(closed.id).n).toBe(0)
  })
})
