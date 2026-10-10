import { describe, it, expect, afterAll } from 'vitest'
import { setupDb, seedMembers } from './helpers.mjs'
import { createProject } from '../engine/projects.js'
import { addEvent, getEvent } from '../engine/events.js'
import { pushSuggestion } from '../brain/extract.js'
import { handleCardAction } from '../brain/bot/command.js'
import { BOT_SECRET, makeRecorder } from './bot-kit.mjs'

// PRD S55（v0.60，K38）— 抽取面建议在 IM 内确认闭环：建议推送升级为飞书确认卡，
// 点按走 confirmEvent/rejectEvent 既有口子；未绑定/未配置/缺密钥/发卡失败降级文本推送。

let db
let members
afterAll(() => db?.close())

function mkSuggestion(projectId, taskId) {
  return addEvent(db, {
    projectId, businessTime: Date.now(), nature: 'suggestion', eventType: 'status_change',
    summary: '任务「创建本场连麦记录」状态 → 完成', targetTaskId: taskId, targetField: 'status', targetValue: 'done',
    generatedBy: 'extraction', confidence: 0.9,
  })
}

describe('S55 IM 建议确认卡闭环', () => {
  it('S55-1: 绑定飞书+凭证+密钥齐备 → 发确认卡（按钮含事件 id+HMAC 签名），pushes 落 sent+message_id', async () => {
    ;({ db } = setupDb())
    members = seedMembers(db)
    const p = createProject(db, { name: '卡片项目', typeCode: 'lianmai_365', leadMemberId: members.lead.id }, members.admin.id)
    const evt = mkSuggestion(p.id, p.tasks[0].id)
    const { send, sent } = makeRecorder()()
    await pushSuggestion(db, getEvent(db, evt.id), { send, secret: BOT_SECRET })
    const cardMsg = sent.find((m) => m.card)
    expect(cardMsg).toBeTruthy()
    expect(cardMsg.openId).toBe('fs_zhang') // 牵头人（任务未指派，S38 口径只推牵头人）
    const btn = cardMsg.card.elements.flatMap((e) => e.actions || []).find((a) => a.value?.a === 'confirm')
    expect(btn).toBeTruthy()
    expect(btn.value.e).toBe(String(evt.id))
    expect(btn.value.s).toMatch(/^[0-9a-f]{16}$/) // HMAC 签名
    const row = db.prepare('SELECT * FROM pushes WHERE related_project_id = ?').get(p.id)
    expect(row.status).toBe('sent')
    expect(row.message_id).toMatch(/^bot_/)
  })

  it('S55-2: 点按确认卡 → confirmEvent 生效（decided_by=点按人）+ 回执；伪造签名拒绝', async () => {
    const p = db.prepare('SELECT id FROM projects WHERE name = ?').get('卡片项目')
    const evt = db.prepare('SELECT * FROM project_events WHERE project_id = ? AND nature = ? ORDER BY id DESC').get(p.id, 'suggestion')
    const taskBefore = db.prepare('SELECT status FROM tasks WHERE id = ?').get(evt.target_task_id)
    expect(taskBefore.status).toBe('todo')

    const { send, sent } = makeRecorder()()
    // 伪造签名先拒绝
    const bad = await handleCardAction(db, {
      operatorOpenId: 'fs_zhang', chatId: 'oc_x',
      value: { a: 'confirm', e: String(evt.id), s: 'f'.repeat(16) },
    }, { send, secret: BOT_SECRET })
    expect(bad.text).toContain('签名')
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(evt.target_task_id).status).toBe('todo')

    // 真实签名点按（取 S55-1 推送卡片的 value 形态，重算合法签名走同一口子）
    const crypto = await import('node:crypto')
    const s = crypto.createHmac('sha256', BOT_SECRET).update(`confirm:${evt.id}`).digest('hex').slice(0, 16)
    const ok = await handleCardAction(db, {
      operatorOpenId: 'fs_zhang', chatId: 'oc_x',
      value: { a: 'confirm', e: String(evt.id), s },
    }, { send, secret: BOT_SECRET })
    expect(ok.result).toBe('confirmed')
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(evt.target_task_id).status).toBe('done') // 生效
    const evtRow = db.prepare('SELECT status, decided_by FROM project_events WHERE id = ?').get(evt.id)
    expect(evtRow.status).toBe('effective')
    expect(evtRow.decided_by).toBe(members.lead.id)
    expect(sent.length).toBeGreaterThanOrEqual(2) // 拒绝回执 + 生效回执
  })

  it('S55-3: 缺签名密钥 → 降级文本推送；卡片发送失败 → 降级 post/text 补发；未绑定成员 → skipped 落行', async () => {
    const p = db.prepare('SELECT id FROM projects WHERE name = ?').get('卡片项目')
    // 缺密钥：纯文本
    const evtA = mkSuggestion(p.id, null)
    const { send: sendA, sent: sentA } = makeRecorder()()
    await pushSuggestion(db, getEvent(db, evtA.id), { send: sendA, secret: '' })
    expect(sentA[0].card).toBeUndefined()
    expect(sentA[0].text || sentA[0].post).toBeTruthy()
    // 卡片发送失败 → 降级文本补发（必达）
    const evtB = mkSuggestion(p.id, null)
    const { send: sendB, sent: sentB } = makeRecorder()()
    const flaky = async (m) => {
      if (m.card) throw new Error('飞书发送失败(230002): card rejected')
      return sendB(m)
    }
    await pushSuggestion(db, getEvent(db, evtB.id), { send: flaky, secret: BOT_SECRET })
    const fallback = sentB.find((m) => !m.card)
    expect(fallback).toBeTruthy()
    const rowB = db.prepare('SELECT * FROM pushes WHERE related_project_id = ? ORDER BY id DESC').get(p.id)
    expect(rowB.status).toBe('sent') // 降级补发成功，状态如实
    // 未绑定成员：牵头人换成无 IM 身份的管理员 → skipped
    const evtC = addEvent(db, {
      projectId: p.id, businessTime: Date.now(), nature: 'suggestion', eventType: 'schedule_change',
      summary: '交付日建议后移', targetTaskId: null, targetField: 'plan_end_date', targetValue: '2026-12-31', generatedBy: 'extraction',
    })
    db.prepare('UPDATE projects SET lead_member_id = ? WHERE id = ?').run(members.admin.id, p.id)
    await pushSuggestion(db, getEvent(db, evtC.id), { send: sendA, secret: BOT_SECRET })
    const rowC = db.prepare('SELECT * FROM pushes WHERE related_project_id = ? ORDER BY id DESC').get(p.id)
    expect(rowC.status).toBe('skipped')
    expect(rowC.error).toContain('未绑定')
    db.prepare('UPDATE projects SET lead_member_id = ? WHERE id = ?').run(members.lead.id, p.id) // 还原
  })

  it('S55-4: 里程碑建议卡片只推牵头人，点按生效里程碑状态', async () => {
    const p = db.prepare('SELECT id FROM projects WHERE name = ?').get('卡片项目')
    db.prepare(`INSERT INTO milestones (project_id, name, plan_date, status, created_at, updated_at) VALUES (?, '上线', '2026-12-20', 'planned', ?, ?)`).run(p.id, Date.now(), Date.now())
    const ms = db.prepare('SELECT * FROM milestones WHERE project_id = ?').get(p.id)
    const evt = addEvent(db, {
      projectId: p.id, businessTime: Date.now(), nature: 'suggestion', eventType: 'status_change',
      summary: '里程碑「上线」已达成', targetObject: 'milestone', targetTaskId: ms.id, targetField: 'status', targetValue: 'met', generatedBy: 'extraction',
    })
    const { send, sent } = makeRecorder()()
    await pushSuggestion(db, getEvent(db, evt.id), { send, secret: BOT_SECRET })
    const cards = sent.filter((m) => m.card)
    expect(cards.length).toBe(1) // 只推牵头人（不按同 id 任务误 JOIN 责任人，S35）
    expect(cards[0].openId).toBe('fs_zhang')
    // 点按生效
    const crypto = await import('node:crypto')
    const s = crypto.createHmac('sha256', BOT_SECRET).update(`confirm:${evt.id}`).digest('hex').slice(0, 16)
    await handleCardAction(db, { operatorOpenId: 'fs_zhang', chatId: 'oc_x', value: { a: 'confirm', e: String(evt.id), s } }, { send, secret: BOT_SECRET })
    expect(db.prepare('SELECT status FROM milestones WHERE id = ?').get(ms.id).status).toBe('met')
  })
})
