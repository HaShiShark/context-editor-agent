# 后端 web_server 入门教学：从一个接口看懂 Hash Code 后端

这份文档接着前端教学文档写。

如果前端的本质是：

```text
展示界面
响应用户操作
向后端请求数据
```

那后端的本质就是：

```text
接收前端请求
处理业务逻辑
读写本地状态
调用模型或工具
把结果返回给前端
```

在这个项目里，后端核心是：

```text
web_server.py
web_server_modules/
simple_agent/
agent_runtime/
data/
```

你可以先记住一句话：

> `web_server.py` 是产品动作的总调度台；`web_server_modules/` 是从总调度台拆出去的专业工具箱。

---

## 1. 先从最小后端开始

一个最简单的后端接口，可以想象成这样：

```python
def hello():
    return {"message": "hello"}
```

前端请求：

```ts
fetch('/api/hello')
```

后端返回：

```json
{
  "message": "hello"
}
```

这就是 API。

API 可以理解成：

> 前端和后端约定好的一个能力入口。

比如：

```text
/api/init              获取初始化数据
/api/settings          获取或保存设置
/api/sessions          创建会话
/api/send-message      发送消息
/api/send-message-stream  流式发送消息
```

前端不是直接改后端内存，也不是直接读写本地文件，而是通过这些 `/api/*` 路径告诉后端要做什么。

---

## 2. 这个项目没有用 Flask/FastAPI

很多 Python 后端会用框架，例如：

```text
Flask
FastAPI
Django
```

但这个项目当前用的是 Python 标准库里的 HTTP 服务：

```python
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
```

对应文件是：

```text
web_server.py
```

里面最关键的类是：

```python
class HashHTTPRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        ...

    def do_POST(self) -> None:
        ...
```

你可以这样理解：

```text
HashHTTPRequestHandler = 前台接待员
do_GET                 = 处理“我要读取数据”的请求
do_POST                = 处理“我要提交/修改数据”的请求
```

举例：

```text
GET  /api/init       读取初始化数据
GET  /api/settings   读取设置
POST /api/settings   保存设置
POST /api/sessions   创建会话
```

---

## 3. 一次普通 API 请求怎么走

先看最简单、最典型的一次请求：前端启动时获取初始化数据。

前端在 `react_app/src/api.ts` 里有：

```ts
export function fetchInit(): Promise<InitPayload> {
  return apiFetch<InitPayload>('/api/init');
}
```

意思是：

```text
前端请求 /api/init
希望后端返回 InitPayload 这种结构的数据
```

后端在 `web_server.py` 里处理：

```python
if parsed.path == "/api/init":
    self._send_json(self.app_state.bootstrap_payload())
    return
```

翻译成产品语言：

```text
如果用户打开应用，前端请求初始化数据
后端就调用 app_state.bootstrap_payload()
把应用启动需要的完整数据打包返回
```

这一次链路是：

```text
React App.tsx
  调用 fetchInit()
    ↓
api.ts
  请求 GET /api/init
    ↓
web_server.py
  do_GET 收到请求
    ↓
AppState.bootstrap_payload()
  组织项目、会话、设置、历史消息
    ↓
_send_json()
  返回 JSON 给前端
    ↓
App.tsx
  把数据放进 state，界面刷新
```

这就是最基本的前后端通信。

---

## 4. `_send_json` 是后端版的统一封装

前端有 `apiFetch`，它统一处理：

```text
headers
fetch
JSON 解析
错误处理
返回类型
```

后端也有类似的统一出口：

```python
def _send_json(self, payload: dict[str, object], *, status: HTTPStatus = HTTPStatus.OK) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Cache-Control", "no-store")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)
```

你不用背代码，只要理解它做了什么：

```text
把 Python dict 变成 JSON
设置返回状态码
告诉前端这是 JSON
写入响应内容
```

所以普通接口的模式基本都是：

```python
self._send_json({
    "key": value,
})
```

产品视角：

> 后端处理完产品动作后，统一把结果包装成 JSON 返回给前端。

---

## 5. 后端的核心状态：AppState 和 SessionState

前端教学文档里讲过，`App.tsx` 里有很多 state。

后端也有自己的 state。

最重要的是两个：

```text
AppState       全局状态
SessionState   单个会话状态
```

### AppState 是整个应用的大账本

`AppState` 管这些东西：

```text
settings           全局设置
projects           项目列表
chat_session_ids   普通聊天会话顺序
sessions           所有会话详情
lock               并发保护锁
```

你可以把它理解成：

> AppState 是后端手里的“全局数据库对象”，虽然它不是数据库，而是内存 + JSON 文件。

它负责：

```text
创建项目
重命名项目
创建会话
删除会话
保存设置
读取初始化数据
把状态写入 data/hash_web_state.json
```

### SessionState 是一条会话的档案袋

`SessionState` 管这些东西：

```text
session_id                  会话 ID
title                       会话标题
scope                       chat 或 project
project_id                  所属项目
agent                       当前会话对应的 SimpleAgent
transcript                  主聊天记录
context_input               当前模型真实输入上下文的可视化记录
context_workbench_history   右侧上下文工作区聊天记录
context_revisions           上下文版本历史
pending_context_restore     恢复版本后的可撤回状态
active_request_mode         当前是否有请求正在跑
active_cancel_event         取消请求用的信号
```

产品视角：

```text
AppState     管整个应用
SessionState 管某一条聊天
```

如果你在前端看到 `session_id`，后端基本都会先用：

```python
session = self.app_state.get_session(payload.get("session_id"))
```

找到这条会话，再继续处理。

---

## 6. 数据不是凭空来的：会持久化到 data/

这个后端没有数据库服务。

它把主要状态存在本地 JSON 文件：

```text
data/hash_web_state.json
```

相关逻辑在 `AppState` 里：

```text
_load_state()        启动时读取
_save_state_locked() 修改后保存
```

流程是：

```text
启动 web_server.py
  ↓
AppState 初始化
  ↓
_load_state() 读取 data/hash_web_state.json
  ↓
用户创建/删除/聊天/恢复版本
  ↓
_save_state_locked() 写回 JSON
```

所以你可以这样理解：

> `AppState` 是运行中的内存状态，`data/hash_web_state.json` 是落盘后的长期记忆。

这也是为什么 Electron 启动 Python 后端后，用户之前的会话还能恢复。

---

## 7. 文件树：后端 web_server 这一层怎么读

核心技术文档第 9 点里的后端层，可以这样拆：

```text
web_server.py
web_server_modules/
  __init__.py
  paths.py
  serialization.py
  attachments.py
  providers.py
  transcript.py
  context_workbench.py
simple_agent/
agent_runtime/
data/
```

它们各自职责如下。

| 文件 | 产品级理解 | 技术职责 |
|---|---|---|
| `web_server.py` | 后端总调度台 | HTTP 路由、状态管理、会话调度、流式返回、静态资源服务 |
| `paths.py` | 路径地图 | 定义项目根目录、React dist、data 目录、附件目录 |
| `serialization.py` | 出口清洗器 | 递归清洗要返回/保存的数据，避免坏字符串污染 JSON |
| `attachments.py` | 附件处理器 | 解析上传文件、保存附件、生成模型可用的输入 |
| `providers.py` | 模型供应商助手 | 处理 provider 类型、base URL、模型列表拉取 |
| `transcript.py` | 聊天记录翻译器 | 在展示用消息、模型输入、工具调用记录之间转换 |
| `context_workbench.py` | 上下文工作区大脑 | Draft、节点、工具、revision、token 估算、上下文修改 |
| `simple_agent/` | Agent 执行层 | 组织模型请求、工具调用循环、provider client |
| `agent_runtime/` | 模型协议适配层 | 把统一格式转成 OpenAI/Claude/Gemini 等不同格式 |
| `data/` | 本地持久化 | 保存会话、项目、设置、附件 |

一个非常粗的分工是：

```text
web_server.py          接请求，调度业务
web_server_modules/    处理后端业务细节
simple_agent/          管一轮模型对话和工具调用
agent_runtime/         适配不同模型 API
data/                  存本地数据
```

---

## 8. `web_server.py` 为什么这么大

它现在承担了很多职责：

```text
HTTP 路由
项目管理
会话管理
设置管理
普通聊天
流式聊天
上下文工作区聊天
上下文版本恢复
静态资源服务
状态持久化
并发和取消控制
```

这不是说它一定错，但它确实是后端复杂度最高的文件。

更健康的长期方向是继续拆：

```text
routes/
  settings_routes.py
  session_routes.py
  chat_routes.py
  context_routes.py

services/
  app_state.py
  session_service.py
  chat_service.py
  context_service.py
```

但现在为了快速推进，项目采用的是：

```text
一个主服务文件
逐步把复杂逻辑拆到 web_server_modules/
```

这就是你之前提醒我的重点：

> 不要一直打补丁；如果一个文件开始承担太多职责，就要考虑从根上重构边界。

当前 `web_server_modules/` 就是已经开始做的拆分。

---

## 9. 普通请求和流式请求的后端区别

前端教学文档里讲过：

```text
普通请求 = 等后端一次性返回
流式请求 = 后端边生成边返回
```

后端也对应两种写法。

### 普通请求

比如创建会话：

```text
POST /api/sessions
```

后端处理方式：

```text
读取 JSON body
创建 SessionState
保存状态
_send_json 一次性返回
```

产品效果：

```text
用户点“新建会话”
前端等待一下
新会话出现在侧边栏
```

### 流式请求

比如发送聊天消息：

```text
POST /api/send-message-stream
```

后端处理方式：

```text
读取 JSON body
找到 session
启动流式响应
调用 session.agent.run_turn()
模型每返回一小段，就 _write_stream_event 一次
最后发送 done
保存完整会话记录
```

产品效果：

```text
用户点发送
模型回复逐字出现
工具调用过程可以实时显示
最后消息落盘保存
```

后端里对应两个方法：

```python
def _start_stream_response(self) -> None:
    ...

def _write_stream_event(self, payload: dict[str, object]) -> None:
    ...
```

你可以把它们理解成：

```text
_start_stream_response  打开一条可以持续写入的返回通道
_write_stream_event     往这条通道里塞一条事件
```

当前项目用的是 NDJSON：

```text
一行 JSON
一行 JSON
一行 JSON
```

前端一行一行读，然后更新界面。

---

## 10. 主聊天：一次发送消息发生了什么

用户在产品里做的是：

```text
输入问题
点击发送
看模型回复
```

后端发生的是：

```text
POST /api/send-message-stream
  ↓
读取 session_id、message、attachments、model、reasoning_effort
  ↓
persist_request_attachments() 保存附件
  ↓
AppState.acquire_session_request(session, "main") 加锁
  ↓
_start_stream_response() 开始流式返回
  ↓
session.agent.run_turn() 调用模型
  ↓
收到文本 delta 就写给前端
  ↓
收到 tool_event 就写给前端
  ↓
模型完成后 AppState.append_turn() 保存 transcript
  ↓
发送 done 事件
  ↓
release_session_request() 解锁
```

这里有三个关键点。

第一，后端不是只负责“转发模型回答”。

它还负责：

```text
附件保存
会话命名
并发控制
工具事件整理
消息 blocks 构建
上下文输入更新
最终 transcript 落盘
```

第二，真正调用模型的是：

```text
session.agent.run_turn()
```

也就是 `simple_agent/agent.py` 里的 `SimpleAgent`。

第三，后端会把模型输出拆成前端能展示的事件：

```text
model_start
delta
reasoning_start
reasoning_done
tool_event
reset
model_done
done
error
```

所以前端看到的“逐字生成、推理块、工具调用卡片”，不是自然出现的，而是后端按事件喂给前端的。

---

## 11. 上下文工作区：为什么比普通聊天复杂

主聊天的目标是：

```text
用户问一句，模型答一句
```

上下文工作区的目标是：

```text
用户让模型整理当前上下文
模型可以查看节点详情
模型可以删除、压缩、替换上下文
最后生成一个可恢复的 revision
```

所以它不是普通聊天，而是一套“让模型编辑上下文”的业务系统。

相关接口：

```text
POST /api/context-chat-stream
POST /api/context-restore
POST /api/context-undo-restore
POST /api/context-workbench-history-clear
POST /api/context-workbench-history-message-delete
```

最核心的模块是：

```text
web_server_modules/context_workbench.py
```

里面有几个关键概念：

```text
ContextWorkbenchDraft        工作草稿
ContextWorkbenchDraftNode    草稿里的一个节点
ContextWorkbenchToolRegistry 上下文工具注册表
context_revisions            版本历史
```

你可以把上下文工作区想成：

```text
当前 transcript
  ↓
复制成一个可编辑的 Draft
  ↓
模型通过工具修改 Draft
  ↓
确认最终快照
  ↓
后端把 Draft 应用回真正 transcript
  ↓
生成一个 revision，方便恢复
```

这个设计的价值是：

> 模型不是直接随便改真实会话，而是先在草稿里做操作，最后确认后再提交。

这和产品里的“草稿/发布”很像。

---

## 12. `transcript.py`：为什么需要聊天记录翻译器

一条聊天消息，在不同场景下长得不一样。

给用户看时，前端关心：

```text
role
text
blocks
toolEvents
attachments
```

给模型请求时，模型关心：

```text
message
function_call
function_call_output
image input
file input
```

保存到本地时，又要尽量完整：

```text
text
blocks
toolEvents
providerItems
attachments
```

这就是 `transcript.py` 的作用。

它做的事情可以理解成：

```text
展示格式 ↔ 模型格式 ↔ 持久化格式
```

比如：

```text
blocks_from_text_and_tools()
```

把文本和工具调用整理成前端能渲染的 blocks。

```text
build_provider_items_for_record()
```

把一条 transcript record 重新构造成模型请求需要的 provider items。

```text
normalize_transcript()
```

把历史数据清洗成当前代码认可的标准结构。

产品视角：

> `transcript.py` 保证“聊天记录”这件事在展示、保存、继续请求模型时都能对得上。

这也是前端 `types.ts` 和后端数据结构必须一致的后端原因。

---

## 13. `attachments.py`：附件不是只传给前端显示

附件上传后，后端要同时服务两个目的：

```text
1. 前端能看到附件记录
2. 模型能收到附件内容
```

所以 `persist_request_attachments()` 返回两类数据：

```text
transcript_attachments  保存到会话记录里，给前端展示
agent_inputs            传给模型，作为模型输入
```

附件处理流程：

```text
前端把附件转成 data_url
  ↓
后端 parse_data_url() 解码
  ↓
保存到 data/uploads/
  ↓
生成 transcript attachment 记录
  ↓
生成模型可用 input_image 或 input_file
```

这里产品上要注意一个限制：

```text
单个附件最大 50 MB
单轮附件总大小最大 50 MB
```

这不是 UI 限制，而是后端业务规则。

---

## 14. `providers.py`：为什么需要 provider 层

用户设置页里可以配置不同模型供应商。

但不同供应商的模型列表接口和鉴权方式不一样：

```text
OpenAI/兼容接口  Authorization: Bearer xxx
Gemini           x-goog-api-key: xxx
Claude           x-api-key: xxx
```

`providers.py` 负责把这些差异包起来。

它主要做：

```text
判断 provider_type
清洗 api_base_url
拼出 /models 地址
请求模型列表
把不同 provider 返回的模型格式统一成 { id, label, group, provider }
```

所以设置页点击“拉取模型列表”时，大致是：

```text
前端 SettingsProvidersPanel
  ↓
api.ts fetchProviderModelsRequest()
  ↓
POST /api/provider-models
  ↓
providers.py fetch_models_from_provider()
  ↓
外部模型供应商 /models
  ↓
统一模型列表返回前端
```

产品视角：

> `providers.py` 是“多模型服务商管理”的后端基础设施。

---

## 15. 并发控制：为什么有些操作不能同时做

后端有一个很重要的规则：

```text
同一条会话里，主聊天和上下文工作区不能同时跑
同一种请求也不能重复并行跑
```

对应代码：

```text
AppState.acquire_session_request()
AppState.release_session_request()
AppState.cancel_session_request()
```

为什么要这样？

因为两边都可能改同一条 `transcript`：

```text
主聊天生成新消息
上下文工作区删除/压缩/替换上下文节点
```

如果同时发生，就可能出现：

```text
消息顺序错乱
上下文版本基于旧数据生成
刚生成的消息被旧快照覆盖
前端显示和后端保存不一致
```

所以后端用：

```text
active_request_mode
active_request_id
active_cancel_event
```

来控制当前会话是否已经有请求在运行。

产品视角：

> 这不是技术洁癖，而是为了避免用户在同一条会话里同时做两个会修改历史的动作。

---

## 16. 静态资源服务：后端也负责打开前端页面

Electron 启动时会打开类似：

```text
http://127.0.0.1:8765/react
```

这不是 Vite 开发服务器，而是 `web_server.py` 自己在服务构建后的 React 文件。

相关方法：

```text
_serve_static()
_resolve_react_asset()
```

它会从这里找前端构建产物：

```text
react_app/dist/
```

所以桌面应用正式运行时大概是：

```text
Electron main.js 启动 Python web_server.py
  ↓
web_server.py 提供 /react 页面
  ↓
Electron 窗口加载 http://127.0.0.1:{port}/react
  ↓
React 页面再请求 /api/*
```

这就是为什么后端不只提供 API，也提供前端页面文件。

---

## 17. 启动链路

本地直接启动后端：

```text
npm run start
```

对应 `package.json`：

```text
python web_server.py
```

`web_server.py` 的启动逻辑：

```python
def main() -> None:
    load_dotenv(REPO_ROOT / ".env")
    settings = load_settings()
    port = int(os.getenv("HASH_WEB_PORT", "8765"))
    host = os.getenv("HASH_WEB_HOST", "127.0.0.1")
    app_state = AppState(settings)
    server = HashHTTPServer((host, port), app_state)
    server.serve_forever()
```

翻译一下：

```text
读取 .env
加载设置
决定监听哪个 host/port
创建 AppState
创建 HTTP Server
一直运行，等待前端请求
```

默认地址：

```text
http://127.0.0.1:8765
```

---

## 18. 新需求来了应该先看哪里

如果需求是：

```text
启动时多返回一个字段
```

先看：

```text
AppState.bootstrap_payload()
react_app/src/types.ts
react_app/src/api.ts
App.tsx 使用初始化数据的位置
```

如果需求是：

```text
新增一个按钮，点击后保存某个设置
```

先看：

```text
react_app/src/components/SettingsView.tsx
react_app/src/api.ts
web_server.py 的 /api/settings
simple_agent/config.py
```

如果需求是：

```text
新增一个会话操作，比如归档、置顶、重命名
```

先看：

```text
web_server.py 里的 AppState
web_server.py 里的 do_POST 路由
react_app/src/api.ts
Sidebar.tsx 或 App.tsx
```

如果需求是：

```text
模型回复显示不对，工具调用记录不对
```

先看：

```text
web_server_modules/transcript.py
simple_agent/agent.py
agent_runtime/core/
MessageContent.tsx
```

如果需求是：

```text
上下文地图、压缩、恢复版本不对
```

先看：

```text
web_server_modules/context_workbench.py
web_server.py 的 context 相关接口
ContextMapSidebar.tsx
ContextWorkbench.tsx
```

---

## 19. 你现在需要建立的后端心智模型

先不要被函数名淹没。

看后端时，先问五个问题：

```text
1. 这个请求从哪个 /api 路径进来？
2. 它是 GET、普通 POST，还是流式 POST？
3. 它要操作全局状态 AppState，还是单个会话 SessionState？
4. 它会不会调用 SimpleAgent 或 context_workbench？
5. 它最后返回 JSON，还是一行一行返回流式事件？
```

最小链路图：

```text
前端 api.ts
  ↓
web_server.py 的 do_GET / do_POST
  ↓
AppState / SessionState
  ↓
web_server_modules 处理细节
  ↓
需要模型时调用 SimpleAgent
  ↓
需要 provider 时进入 agent_runtime/adapters
  ↓
返回 JSON 或流式事件
  ↓
前端更新界面
```

对应文件：

```text
web_server.py                  后端入口和总调度
web_server_modules/paths.py    路径常量
web_server_modules/attachments.py 附件
web_server_modules/providers.py   模型供应商
web_server_modules/transcript.py  聊天记录转换
web_server_modules/context_workbench.py 上下文工作区
simple_agent/agent.py          一轮模型对话
agent_runtime/adapters/        不同模型 API 适配
data/hash_web_state.json       本地状态保存
```

记住这个模型后，再看具体代码会轻松很多：

> API 入口在 `web_server.py`，业务数据在 `AppState/SessionState`，复杂专业逻辑逐步下沉到 `web_server_modules/`。

