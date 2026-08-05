<p align="center">
  <img src="docs/images/hash-icon.png" alt="hashcode" width="128" />
</p>

<h1 align="center">hashcode</h1>

<p align="center">
  <strong>Cursor 用 AI 编辑代码，我们用 AI 编辑 AI 的上下文。🪆</strong>
</p>

<p align="center">
  <a href="#-核心功能">核心功能</a> •
  <a href="#-技术架构">架构</a> •
  <a href="#-安装与运行">安装</a> •
  <a href="#-路线图">路线图</a> •
  <a href="#join-us">加入我们</a> •
  <a href="#-常见问题">FAQ</a>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>中文</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/electron-37-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 37" />
  <img src="https://img.shields.io/badge/python-3.10+-blue?style=flat-square&logo=python&logoColor=white" alt="Python 3.10+" />
  <img src="https://img.shields.io/badge/react-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React 19" />
  <img src="https://img.shields.io/badge/typescript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/status-alpha-orange?style=flat-square" alt="Alpha" />
</p>

> [!WARNING]
> **Alpha 阶段声明**：hashcode 目前处于早期开发阶段，仍有不少功能尚未完善，也存在已知的 bug。我们公开这个项目是因为相信这个方向值得被更多人看到，而不是因为它已经完成了。如果你愿意参与测试、反馈问题或者贡献代码，非常欢迎。

<h2 id="join-us">加入我们</h2>

如果你想参与测试、反馈问题、贡献想法，或者一起把这个方向做下去，可以邮件联系：<a href="mailto:3455744878@qq.com">3455744878@qq.com</a>。

### Codex 版

Codex 版已上线。如果你在使用 Codex，也想获得同样的上下文编辑工作流，可以查看 [codex-context-editor-proxy](https://github.com/HaShiShark/codex-context-editor-proxy)。

---

## 🤔 问题在哪

你和 AI 的对话会不断分散方向。话题已经换了，之前的讨论和工具输出还堆在上下文里。虽然 `/compact` 能压缩，但它太暴力——你没法决定留什么、删什么。

**问题从来不只是"上下文太长"，而是你对它没有任何控制权。**

这在真实使用中经常发生：

- 🔄 **话题转换** — 你刚用 AI 修完一个 bug，接着开始了一段高质量的项目讨论。但上下文已经被 bug 修复占满了，继续聊可能触发全文压缩、注意力下降。你想保住心流，但没法精准压缩前面的内容。
- 📦 **无关内容堆积** — 聊了 30 轮，中间的工具输出早就和当前话题无关了。它们一直占着上下文，拖慢模型，但你连它们具体在哪都不知道。
- 🔍 **上下文诊断** — 上下文突然满得很快，你想知道到底哪里出了问题。传统工具只能告诉你"窗口还剩多少"，没法帮你精准定位和是哪些节点在吃空间和修复。

> **如果你能像编辑一份源代码那样，看到、编辑、版本管理 AI 的上下文呢？**

这就是 hashcode 在做的事情。

## 💡 灵感来源

Cursor 能用 AI 来编辑你的**代码**，那为什么不能用 AI 来编辑 AI 的**上下文**？

```
Cursor:     AI  →  编辑  →  代码
                                         
我们:       AI  →  编辑  →  AI 的上下文  🪆
```

**hashcode** 是第一个做到以下三点的桌面客户端：

1. **可视化**主模型实际消耗的整个上下文——以结构化的**上下文地图**呈现，而不是一串聊天记录。
2. **部署第二个 AI 模型**来精准编辑上下文——你说了算留什么、删什么、压缩什么，而不是交给一个粗暴的 compact 指令。
3. **版本管理**每一次编辑，支持随时回退到任意一个历史版本。

一个 AI 负责思考回答，另一个 AI 负责打理它的上下文——由你掌控。🪆

---

## 🌟 核心功能

### 📍 上下文地图 — 看到模型吃进去的一切

<p align="center">
  <img src="docs/images/screenshot-context-map.png" alt="上下文地图" width="800" />
</p>

右侧边栏把原始对话记录变成一张结构化、可滚动的地图：

- **编号节点** — `#1 #2 #3 ...` — 每一轮用户/助手对话就是一个节点
- **Token 权重着色** — 🟢 正常 / 🟡 偏重 / 🔴 很重 — 一眼看到哪里在吃 token
- **小地图** — 鸟瞰式概览，带可拖动的视口矩形，像 VS Code 的 minimap
- **点击展开** — 默认折叠为单行预览，点击可看完整 Markdown 或工具调用详情
- **多选** — `Ctrl+点击` 或在编号栏拖动来批量选中节点，供 AI 编辑器操作

### 🪆 上下文工作台 — AI 编辑 AI 的上下文

<p align="center">
  <img src="docs/images/screenshot-workbench-1.png" alt="workbench-manual" width="800" />
</p>

<p align="center">
  <img src="docs/images/screenshot-workbench-2.png" alt="workbench-suggest" width="800" />
</p>

右侧面板是第二个 AI 模型的操作台，包含五个页面：

| 页面 | 做什么 |
|------|-------|
| **💡 建议** | 生成待审核的整理提案；预览和丢弃不改正式上下文，应用后生成可恢复版本 |
| **✏️ 手动** | 和上下文模型对话——"压缩第 4-7 个节点" 或 "删掉天气工具的输出" |
| **📊 用量** | 查看当前会话中主 Agent 与上下文模型由 Provider 上报的真实 Token 用量 |
| **⏪ 恢复** | 浏览每一次上下文提交记录，点击即可恢复到任意历史版本 |
| **⚙️ 设置** | 独立配置上下文模型（可以用不同的模型、不同的 provider） |

### 🔧 精准编辑工具

上下文模型使用三个互补工具：先读取，优先批量编辑节点，只在必要时深入 item：

| 工具 | 功能 | 举例 |
|------|------|------|
| `get_nodes` | 按需读取一个或多个节点的完整协议层结构 | "看看第 4 个节点里有什么" |
| `write_nodes` | 一次批量删除和插入节点，可表达替换、压缩与合并 | "把第 2-5 个节点整理成一个摘要" |
| `write_items` | 读取节点详情后，编辑单个节点内部的 item | "保留回答，只整理其中的工具输出" |

### ⏪ 上下文版本管理

每一轮编辑都会生成一个 **revision（修订版本）**——一份完整的上下文快照：

```
修订 #1  ← "压缩了天气工具的输出"             [恢复]
修订 #2  ← "删除了多余的 shell 命令"           [恢复] ← 当前
修订 #3  ← "把第 2-5 节点合并成摘要"           [恢复]
```

- **线性回退** — 点击任意修订即可恢复
- **撤回恢复** — 后悔了？一键撤回刚才的恢复操作（在下一次操作之前有效）
- **完整快照** — 不是 patch，不用 merge。每个修订都是完整副本，稳定可靠

### 🔌 多 Provider 支持

同时接入多个大模型厂商——主模型和上下文编辑模型可以各自独立配置：

| 厂商 | 协议 | 状态 |
|------|------|------|
| **OpenAI** | Responses API | ✅ 内置 |
| **Claude** | Messages API | ✅ 内置 |
| **Gemini** | GenerateContent API | ✅ 内置 |
| **自定义** | Chat Completions | ✅ 支持任何 OpenAI 兼容端点 |

可以混搭使用：用 GPT 聊天，用 Claude 编辑上下文。每个 provider 有独立的 API Key 和接入地址配置。

### 🎨 桌面客户端

- **原生窗口**：Electron 桌面应用，支持 Windows（macOS / Linux 计划中）
- **三栏布局**：侧边栏 → 聊天区 → 上下文地图 + 工作台
- **暗色主题**：深黑底色，专为长时间使用设计，不刺眼
- **流式响应**：主聊天和上下文模型都支持逐 token 实时流式输出
- **文件附件**：拖拽图片和文件到聊天框即可发送
- **Markdown 渲染**：完整 GFM 支持，代码语法高亮，Mermaid 流程图
- **项目工作区**：按项目组织对话，支持文件树浏览

---

## 🏗️ 技术架构

### "双模型"架构

1. **主模型** — 你聊天的对象。它读写文件、执行命令、回答问题。
2. **上下文模型** — 一个独立的 AI，它只看得到主模型的上下文。它负责分析、压缩和重组上下文结构。

两者永远不会在同一个会话上并行运行。当上下文模型在编辑时，主聊天暂停（反之亦然）。这样可以防止写冲突。

### 技术栈

| 层级 | 技术选型 | 为什么选它 |
|------|---------|-----------|
| **桌面容器** | Electron 37 | 跨平台原生窗口，内嵌 Python 后端随窗口启停 |
| **前端** | React 19 + TypeScript + Vite | 开发快、类型安全、现代 DX |
| **后端** | Python（子进程） | 零框架、极少依赖，由 Electron 自动管理生命周期 |
| **LLM 运行时** | 自研 `agent_runtime` | Provider 无关的适配器层（OpenAI / Claude / Gemini） |
| **存储** | 本地 SQLite + JSON 设置（用户数据目录） | 单文件本地数据库，数据完全在本地 |
| **流式传输** | Server-Sent Events (SSE) | 实时逐 token 流式推送 |

### 运行原理

```
┌──────────────────────────────────────────────────────┐
│                   Electron 主进程                      │
│                                                      │
│   app.whenReady()                                    │
│     ├── 1. 找到可用端口                                │
│     ├── 2. 启动 Python 子进程 (web_server.py)          │
│     ├── 3. 等待后端 /api/init 就绪                     │
│     └── 4. 创建 BrowserWindow → 加载前端               │
│                                                      │
│   app.on('before-quit')                              │
│     └── 杀掉 Python 子进程                             │
└──────────┬───────────────────────────────────────────┘
           │
    ┌──────▼──────┐     HTTP + SSE     ┌──────────────┐
    │  渲染进程    │ ◄────────────────► │ Python 后端  │
    │  React App  │                    │ web_server   │
    │             │                    │              │
    │ · 聊天区    │                    │ · 主 Agent   │
    │ · 上下文地图 │                    │ · 上下文Agent│
    │ · 工作台    │                    │ · 状态管理   │
    │ · 设置      │                    │ · 本地存储   │
    └─────────────┘                    └──────────────┘
```

---

## 📦 安装与运行

### 方式一：从源码运行（开发者）

#### 前置要求

- Python 3.10+
- Node.js 18+
- 至少一个大模型 API Key（OpenAI / Anthropic / Google）

```bash
git clone https://github.com/YOUR_USERNAME/context-editor-agent.git
cd context-editor-agent

# Python 环境
python -m venv .venv
# Windows:
.venv\Scripts\Activate.ps1
# macOS / Linux:
source .venv/bin/activate
pip install -r requirements.txt

# 前端依赖
npm install

# 启动 Electron 桌面客户端
npm run dev:electron
```

启动后在应用内的设置页面配置你的 API Key 即可使用。

### 方式二：打包成安装程序

```bash
# 构建 Windows .exe 安装包
npm run dist:win
```

生成的安装程序在 `release/` 目录下。双击安装，开箱即用。

---

## 🗺️ 路线图

### ✅ 已完成（v0.1 — 当前版本）

- [x] 主聊天 + 流式响应
- [x] 上下文地图 + minimap + 节点选择
- [x] 上下文工作台（建议 / 手动 / 恢复 / 设置）
- [x] Working snapshot + 原子提交生命周期
- [x] 修订历史 + 线性回退 + 撤回恢复
- [x] 多 Provider 支持（OpenAI、Claude、Gemini、自定义）
- [x] 上下文模型工具：查看详情、删除、替换、压缩、总结
- [x] 聊天支持文件附件
- [x] 项目工作区 + 文件树
- [x] 完整 Markdown 渲染 + 语法高亮
- [x] Electron 桌面客户端 + Windows 安装包

### 🔜 下一步

- [ ] 引入上下文监控模型自动判断上下文重要性并维护
- [ ] 补充更多主流 agent 产品能力

---

## ❓ 常见问题

<details>
<summary><strong>这跟 Claude Code 和 Codex 的 /compact 有什么区别？</strong></summary>

compact 是一个黑盒——你不知道它压缩了什么、保留了什么，也没法回退。它解决的是"上下文太长"，但解决不了"上下文里有我不想要的东西"。

hashcode 解决的是**上下文自由度**：你能看到每一个节点占了多少 token，精确删掉某条工具输出，压缩某几轮旧讨论，或者在话题转换时一句话清理前面的内容——然后随时回退。不是暴力压缩，而是精准控制。

</details>

<details>
<summary><strong>上下文模型真的能改变主模型看到的内容吗？</strong></summary>

是的。当上下文模型压缩或删除了某些条目后，这些改动会被提交到正式的 transcript。下一次主模型回复时，它看到的就是编辑过的版本。这不是 UI 层面的障眼法——而是真正的上下文工程。

</details>

<details>
<summary><strong>会不会降低缓存命中？</strong></summary>

理论上是会的，不过在 agent 频繁调用 API 时，每次操作上下文将最多重算一次缓存，这比一直带着无用上下文会省钱得多。

</details>

---

## 🤝 参与贡献

这个项目目前处于早期 alpha 阶段。欢迎提交贡献、想法和 Bug 报告！

1. Fork 这个仓库
2. 创建你的特性分支（`git checkout -b feature/amazing-thing`）
3. 提交你的修改
4. 推送并发起 Pull Request

---

---

<p align="center">
  <strong>🪆 AI 编辑 AI —— 套娃一路到底。</strong>
</p>

<p align="center">
  <sub>如果你觉得这个项目有意思，考虑给一个 ⭐ —— 它能帮助更多人发现这里。</sub>
</p>
