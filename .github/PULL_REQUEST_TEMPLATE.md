## 变更说明

<!-- 一句话：这个 PR 改了什么、为什么 -->

## 需求追踪（engineering-standards §1，必填）

- PRD 场景/验收标准编号：<!-- 如 S20-19；纯工程防线改动填「工程防线」并说明 -->
- [ ] 先改了 PRD / scenarios.md（需求变更必须 PRD 先行）
- [ ] 测试名带场景编号，scenarios.md 锚点已同步

## TDD 红 → 绿证据（engineering-standards §2，必填）

<!-- 贴新测试首次失败的输出（红），再贴通过（绿）。顺序无法被工具强制，靠这里的证据链。 -->
- 红：
- 绿：

## 自检清单

- [ ] `npm run lint && npm run typecheck && npm test` 全绿
- [ ] `npm run check:scenarios` / `npm run check:skill` 通过
- [ ] 没有为凑绿修改既有测试断言（如改了，PR 里说明了理由并等人裁决）
- [ ] 负面清单核对（无 JWT/Redis/ORM/组件库等 AGENTS.md §5 禁项）
