# 数据库入门与本项目的 SQLite 状态存储

这篇文档写给还没有系统学过数据库的人。目标不是一上来背 SQL，而是先理解：为什么项目从 JSON 状态文件换到 SQLite，以及现在这套设计在代码里是怎么工作的。

## 1. 先用产品视角理解数据库

数据库本质上是一个“有结构的数据管理系统”。

如果说 JSON 文件像一个大笔记本：

```json
{
  "projects": [],
  "sessions": {}
}
```

那么数据库更像一组表格：

| 表 | 放什么 |
|---|---|
| `projects` | 项目名称、项目路径、排序 |
| `sessions` | 会话标题、会话类型、聊天内容 |
| `chat_session_order` | 普通聊天会话的侧边栏顺序 |
| `project_session_order` | 项目内会话和归档会话的顺序 |

JSON 的优点是简单，打开文件就能看。缺点是只要改一点点，通常也要把整个文件重新写一遍。

SQLite 的优点是仍然是本地单文件，但它有表、主键、事务这些数据库能力。它不需要单独安装数据库服务，很适合桌面应用和本地工具。

## 2. 几个最重要的数据库概念

### 表

表就是一类数据的集合。比如 `projects` 表专门放项目。

### 行

一行就是一条记录。比如一个项目就是 `projects` 表里的一行。

### 列

列是每条记录里的字段。比如项目有 `id`、`title`、`root_path`。

### 主键

主键是每条记录的唯一身份。比如：

```sql
id TEXT PRIMARY KEY
```

意思是 `id` 这一列不能重复，可以用它准确找到某个项目或会话。

### 事务

事务可以理解为“一组修改要么全部成功，要么全部失败”。

比如保存状态时，要同时保存项目、会话、排序。如果中间失败，只保存了一半，应用状态就会坏掉。SQLite 的事务可以避免这种半成功状态。

## 3. 当前项目以前是怎么存状态的

以前核心状态在：

```text
data/hash_web_state.json
```

后端启动时：

```text
AppState._load_state()
```

会把整个 JSON 文件读进内存。

用户创建项目、发消息、删除会话后：

```text
AppState._save_state_locked()
```

会把整个状态重新写回 JSON。

这个方式适合早期开发，因为简单直接。但随着会话、上下文修订、工具调用记录变多，JSON 文件会越来越大，后面想做搜索、统计、迁移也不方便。

## 4. 现在为什么没有把所有聊天内容都拆成表

这次改造采用了“半结构化 SQLite”。

也就是：

| 数据 | 当前怎么存 |
|---|---|
| 项目 | 拆成 `projects` 表 |
| 会话基础信息 | 拆成 `sessions` 表里的普通列 |
| 侧边栏排序 | 拆成顺序表 |
| 聊天 transcript | 暂时仍然作为 JSON 存在 `sessions.transcript_json` |
| 上下文修订 | 暂时仍然作为 JSON 存在 `sessions.context_revisions_json` |

这样做是为了控制复杂度。

聊天记录里包含普通文本、附件、工具调用、模型原始协议片段。现在强行拆成很多张表，会让代码变化很大，也会让你刚开始学数据库时被细节淹没。

所以第一步只把“外层结构”数据库化，把最复杂的消息内容先稳定保存为 JSON 字段。

这是很多产品早期演进里很常见的做法：先把边界切清楚，再根据真实需求继续细拆。

## 5. 当前 SQLite 文件在哪里

路径常量在：

```text
web_server_modules/paths.py
```

现在有两个状态文件概念：

```text
hash_web_state.sqlite3   新的 SQLite 状态数据库
hash_web_state.json      旧的 JSON 状态文件，作为迁移来源保留
```

开发环境默认在项目的 `data` 目录下。

Electron 正式运行时会把 `HASH_DATA_DIR` 指到用户数据目录，所以用户数据不会写到安装目录里。

## 6. 状态仓库负责什么

新增的核心模块是：

```text
web_server_modules/state_store.py
```

它提供一个类：

```text
SQLiteStateStore
```

可以理解成“状态仓库”。它只负责两件事：

```text
load_state()   从 SQLite 读出应用状态
save_state()   把应用状态保存进 SQLite
```

`AppState` 仍然负责业务逻辑，比如创建项目、追加聊天、删除会话。

这是一条很重要的工程边界：

```text
AppState 负责“业务规则”
StateStore 负责“怎么落盘”
```

如果以后想继续优化数据库结构，优先改 `SQLiteStateStore`，不应该到处散落 SQL。

## 7. 自动迁移逻辑

启动时大致流程是：

```text
1. 先创建/检查 SQLite 表结构
2. 如果 SQLite 里已经有数据，就直接读 SQLite
3. 如果 SQLite 是空的，并且旧 JSON 存在，就读取旧 JSON
4. 把旧 JSON 的状态写入 SQLite
5. 后续保存都写 SQLite
```

这个迁移不会删除旧 JSON。旧文件先保留更稳，方便回查。

## 8. 当前数据库表结构

### `projects`

项目表。

| 列 | 含义 |
|---|---|
| `id` | 项目唯一 ID |
| `title` | 项目标题 |
| `root_path` | 项目路径 |
| `sort_order` | 项目在侧边栏里的顺序 |

### `sessions`

会话表。

| 列 | 含义 |
|---|---|
| `id` | 会话唯一 ID |
| `title` | 会话标题 |
| `scope` | `chat` 或 `project` |
| `project_id` | 所属项目 ID |
| `transcript_json` | 聊天记录 JSON |
| `context_workbench_history_json` | 上下文工作区聊天历史 JSON |
| `context_revisions_json` | 上下文修订历史 JSON |
| `pending_context_restore_json` | 待撤销的上下文恢复状态 JSON |

### `chat_session_order`

普通聊天会话排序表。

| 列 | 含义 |
|---|---|
| `session_id` | 会话 ID |
| `sort_order` | 排序位置 |

### `project_session_order`

项目内会话排序表。

| 列 | 含义 |
|---|---|
| `project_id` | 项目 ID |
| `session_id` | 会话 ID |
| `list_type` | `active` 或 `archived` |
| `sort_order` | 排序位置 |

### `metadata`

数据库元信息表。目前主要记录 schema 版本。

## 9. 如何自己观察 SQLite

如果你安装了 `sqlite3` 命令行，可以这样看：

```powershell
sqlite3 data\hash_web_state.sqlite3 ".tables"
sqlite3 data\hash_web_state.sqlite3 "select id, title from projects;"
sqlite3 data\hash_web_state.sqlite3 "select id, title, scope from sessions;"
```

如果没有安装，也可以用 Python：

```powershell
python -c "import sqlite3; c=sqlite3.connect('data/hash_web_state.sqlite3'); print(c.execute('select name from sqlite_master where type=\"table\"').fetchall())"
```

看项目：

```powershell
python -c "import sqlite3; c=sqlite3.connect('data/hash_web_state.sqlite3'); print(c.execute('select id,title,root_path from projects').fetchall())"
```

看会话：

```powershell
python -c "import sqlite3; c=sqlite3.connect('data/hash_web_state.sqlite3'); print(c.execute('select id,title,scope,project_id from sessions').fetchall())"
```

## 10. 以后可以怎么继续演进

现在这一步是“从 JSON 文件升级到 SQLite 状态仓库”。

后续如果产品上需要这些能力，就值得继续拆表：

| 需求 | 可能的数据库演进 |
|---|---|
| 搜索所有聊天内容 | 新增 `messages` 表，按消息存 |
| 查看工具调用历史 | 新增 `tool_events` 表 |
| 附件管理 | 新增 `attachments` 表，记录文件路径和 MIME |
| 统计每个项目消息数量 | 消息拆表后可以直接 SQL 聚合 |
| 数据迁移版本管理 | 扩展 `metadata` 或新增 `schema_migrations` |

目前还没到必须全拆的时候。先保持轻量，等真实需求出现后再拆，会更稳。

## 11. 你现在应该记住的重点

数据库不是神秘的新东西，它就是更有结构的数据保存方式。

SQLite 特别适合本地桌面应用，因为它：

- 是单文件
- 不需要独立服务
- 支持表和查询
- 支持事务
- Python 内置 `sqlite3` 可以直接使用

本项目现在的设计重点是：

```text
前端协议不变
业务逻辑不变
存储层从 JSON 文件换成 SQLite
复杂聊天内容暂时继续作为 JSON 字段保存
```

这是一种偏稳妥的工程迁移方式，也比较适合作为数据库入门的第一步。
