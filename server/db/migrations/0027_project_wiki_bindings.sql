-- S61（v0.66，design.md K45）：项目 ↔ 飞书知识库页面绑定——每个项目可绑定一个 wiki 页面
-- （贴链接绑定已有页面，或在指定页面下新建子页）；机器人「记一下」类指令把内容追加到绑定页面。
-- 侧表存法镜像 task_refs（外链 title+url 模式），一项目绑一页（project_id 唯一）。
CREATE TABLE IF NOT EXISTS project_wiki_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id), -- 一项目绑一页
  space_id TEXT NOT NULL,          -- wiki 空间 id
  node_token TEXT NOT NULL,        -- wiki 节点 token（绑定目标页面）
  obj_token TEXT NOT NULL,         -- get_node 换出的 document_id（docx 写入用）
  title TEXT,                      -- 页面标题（展示/回执用）
  created_by INTEGER REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_wiki_bindings_project ON project_wiki_bindings(project_id);
