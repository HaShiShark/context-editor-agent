# 上下文工作台产品逻辑迁移记录

> 状态：迁移完成，已通过自动化与本地界面验收  
> 基线项目：`codex-context-studio` 1.1.3 之后的上下文工作台  
> 目标项目：`hash-code-electron` 0.4.0 现有 Agent 架构  
> 最后更新：2026-07-26

## 1. 迁移目标

这次迁移追求产品心智一致，不追求技术实现逐文件一致：

- 上下文地图展示主 Agent 下一轮真正会携带的上下文。
- 手动页中的上下文模型是一个独立维护 Agent，先读取快照，再通过受控工具编辑单轮草稿，回合结束时一次提交。
- 建议页生成的是待审查提案。预览、丢弃都不修改正式上下文，只有明确应用才落盘。
- HashCode 原有版本恢复继续保留，而且覆盖手动编辑和建议应用两种改动来源。
- 主聊天与上下文模型保持单写者互斥，避免两个 Agent 同时覆盖同一份上下文。

## 2. 两个项目的事实差异

| 主题 | Codex Context Studio | HashCode 的迁移边界 |
| --- | --- | --- |
| 主 Agent | 外部 Codex，工作台通过代理截获请求 | HashCode 自己拥有 Agent 与会话状态，直接读取和提交 transcript |
| 请求对齐 | 需要 cursor 与 input diff | 不移植。HashCode 不存在外部请求对齐问题 |
| 上下文建议 | 临时提案，应用前不改 transcript | 保留该语义；应用后额外生成 HashCode revision |
| 版本恢复 | 当前产品明确不提供 restore 状态 | 保留 HashCode 的完整快照 revision 和一次性撤销恢复 |
| 自动触发 | 依赖 Codex/ChatGPT 进程探测、代理请求时间 | 改为 HashCode 主 Agent 成功结束一轮后开始会话级闲置计时 |
| 失效判断 | transcript version | 使用规范化 transcript 指纹；任何主聊天、恢复或上下文提交都会使旧提案失效 |
| 节点锁定 | developer 默认锁定，其他节点可手动锁 | 本轮不迁移。HashCode 的可编辑 transcript 只含 user/assistant，系统人格不在其中；误改由 revision 完整恢复兜底 |
| 用量 | 代理汇总主 Codex 和上下文模型调用 | 已直接汇总 HashCode Provider 返回的 usage，不引入代理，不估算缺失 Token 或费用 |
| 通知 | Electron 监控全部代理 session 并发系统通知 | 本轮先保证工作台内可发现；不复制外部进程 watcher |

## 3. 功能映射与优先级

### P0：本次必须完成

1. 建议页从静态 Token 排行升级为 AI 维护提案：立即分析、预览、应用、丢弃。
2. 提案只保存一份，绑定生成时的 transcript 指纹；过期时拒绝应用，不做自动合并。
3. 自动建议开关和闲置时间进入上下文工作台设置。
4. 主聊天继续后立即删除旧提案；自动生成中的请求不能覆盖更新后的上下文。
5. 建议应用走 HashCode 正式上下文提交入口，并生成新 revision，因此可以从恢复页回退。
6. 手动工作台工具收敛为：
   - `get_nodes`：按需读取 assistant 节点完整内容；
   - `write_nodes`：一次批量删除、插入、替换或压缩节点；
   - `write_items`：只有确实需要时才编辑节点内部 item。
7. 保留现有手动历史、流式输出、停止、主聊天互斥、revision 恢复和撤销恢复。

### P1：已完成

1. 会话用量页，区分主 Agent 与上下文模型。
2. 为建议、版本恢复和新工具契约补齐后端测试，并完成本地真实界面契约验收。
3. 统一建议、手动、恢复、设置页面的空状态、错误状态和操作反馈。

### 当前明确不做

- Codex 代理、cursor、input diff、remote/local compact 路由。
- Codex/ChatGPT 外部进程探测和 session 存档扫描。
- 为旧工作台工具名保留兼容别名。迁移后只维护新的三工具契约。
- selective revert、多分支版本树。恢复继续使用现有线性 revision。
- 建议历史。每个会话同时最多一条待审查提案。

## 4. 状态模型

HashCode 仍只有一份正式 `transcript`。新增的建议是临时提案，不是第二份可编辑正式上下文：

```text
Session
├─ transcript                  # 唯一正式上下文
├─ context_workbench_history   # 上下文模型对话历史
├─ context_revisions           # HashCode 完整快照版本
├─ pending_context_restore     # 最近一次恢复的临时撤销入口
├─ pending_context_review      # 最多一条待审查提案
└─ usage_summary               # Provider 实报用量，按请求来源和模型分桶
```

`pending_context_review` 至少包含：

- 提案 ID、来源、创建时间和模型；
- 生成时 transcript 指纹；
- 修改前后的节点数与 Token 估算；
- 面向用户的提案理由；
- proposed transcript 与实际操作记录。

应用时必须重新计算当前 transcript 指纹。指纹不一致就删除旧提案并返回冲突，不猜测如何合并。

持久化 schema 已升级到 v3。旧数据库启动时只补齐 `pending_context_review` 和 `usage_summary` 字段，不保留旧工具名或旧产品行为的运行时兼容层。

## 5. 建议生命周期

```text
主聊天完成
→ 开始闲置计时
→ 上下文模型基于当前 transcript 创建单轮草稿
→ 有实质改动才保存 pending review
→ 用户预览（只切换地图显示）
→ 用户应用
→ 校验 transcript 指纹
→ 正式提交 transcript
→ 生成 HashCode revision
→ 删除 pending review
```

以下事件会让旧建议失效：

- 同一会话发送新的主聊天消息；
- 手动上下文模型提交修改；
- 恢复或撤销恢复；
- 重置、截断、删除会话内容；
- 应用或明确丢弃建议。

## 6. 工具与提交边界

- Node 编号只在当前工作台回合的初始快照中有效。
- 非 assistant 节点在轻量快照中给全文；assistant 节点默认给预览、Token 和工具概览。
- 修改 assistant 节点前先调用 `get_nodes`，不能根据预览编造摘要。
- `write_nodes` 的删除目标和插入锚点始终引用初始 Node 编号，即使锚点本身也被删除。
- `write_items` 必须先用 `get_nodes` 取得当前详情。任何节点编辑后，已读取的 item 详情立即失效，必须重新读取，避免 item 编号漂移后误改。
- 删除不存在的节点会明确失败，不静默忽略模型错误。
- 工具只修改内存 draft。用户停止、模型失败且无可靠结果、或正式提交前发生冲突时，draft 整体丢弃。
- 自动建议只开放一次完整 `write_nodes`，并要求模型同时给出面向用户的提案理由；它不复用手动页聊天历史。
- 手动页有修改时直接生成 revision；建议页有修改时先进入 pending review，用户应用后才生成 revision。

## 7. 版本恢复的融合规则

版本恢复是 HashCode 的产品资产，迁移后按以下规则继续：

1. 初始版本仍保存完整 transcript 和手动工作台历史。
2. 每次有实质修改的手动工作台回合生成一条 revision。
3. 每次应用 AI 建议生成一条 revision，摘要来自提案理由，改动节点来自提案操作。
4. 恢复到旧 revision 时，同时恢复 transcript 和该版本保存的手动历史。
5. 恢复后仍只保留一次性的“撤回本次恢复”。继续主聊天或上下文操作后立即失效。
6. 恢复操作本身不生成新 revision，避免历史列表被导航行为污染。

恢复页会在一次恢复后明确显示“撤销这次恢复”。撤销会完整回到恢复操作前的 transcript、手动历史和 active revision；完成后入口立即消失。

## 8. 并发与取消边界

- 主 Agent 和上下文模型共享会话级单写者锁。自动建议的 request ID 与会话请求状态在同一个临界区登记，避免“自动任务已开始、主聊天却看不见”的竞态。
- 用户显式发起主聊天、手动整理或立即分析时，会先取消同会话 scheduled/running 的自动建议，并等待它释放写入权。
- Provider 的底层流不一定支持即时物理断开；取消会在下一次流回调或模型轮次检查时生效。等待上限为 30 秒，超时后明确报互斥冲突，不让两个结果同时提交。
- 后台自动建议只在主聊天成功结束后开始闲置计时；关闭开关会取消已安排的 timer，但不影响手动“立即分析”。

## 9. 用量边界

- 用量来自 Provider 实际返回字段，已归一化 OpenAI Responses、Chat Completions、Anthropic Messages 和 Gemini 的输入、缓存输入、缓存写入、输出、推理和总 Token。
- 页面分为总用量、主 Agent、上下文模型，并保留按模型分桶的数据；用户可以刷新或清空当前会话计数。
- Provider 没有返回 usage 时不猜测补齐；当前不估算费用，因为不同兼容服务的实际价格不可由协议可靠判断。
- Anthropic 的 cache read/write 计入输入总量；OpenAI/Gemini 的缓存字段按输入子集处理，避免重复计数。

## 10. 验收清单

- [x] 无待审查提案时，建议页给出明确空状态和“立即分析”。
- [x] 没有可安全整理的内容时不生成空提案。
- [x] 预览只影响上下文地图显示；本地界面验收时地图从 4 个可见节点切到 2 个提案节点，数据库正式 transcript 仍为 3 条。
- [x] 切页、切会话、主聊天开始和组件卸载会退出预览，恢复正式地图。
- [x] 应用过期提案会明确失败并删除旧提案，不覆盖新对话。
- [x] 建议应用后生成新 revision；已实测恢复到应用前版本，并从恢复页撤销恢复回到应用后版本。
- [x] 手动工具目录只有 `get_nodes`、`write_nodes`、`write_items`。
- [x] 自动建议只拿当前快照，不携带手动页历史。
- [x] 主聊天与上下文模型不能并行写同一会话。
- [x] 关闭自动建议后不再启动新的闲置分析，手动“立即分析”仍可用。
- [x] 用量页正确区分总量、主 Agent 与上下文模型，只展示 Provider 实报 Token。
- [x] 五个页签在窄窗口使用横向滚动，页面本身不产生横向溢出。
- [x] TypeScript 类型检查通过，React 生产构建通过（只有原有大 chunk 警告），Python 测试 43 项全部通过。

## 11. 后续维护原则

1. 新能力先判断属于正式 transcript、临时 review、revision 还是 UI 投影，不新增含义重叠的状态。
2. 建议预览、版本恢复和手动草稿是三个不同生命周期，不互相复用字段。
3. Provider 适配只做协议翻译，不在 adapter 内实现产品状态。
4. 发现工具数量继续膨胀时，优先增强批量操作表达力，不增加同义工具。
5. 出现过期、并发或恢复问题时，以 transcript 指纹、active request 和 revision 快照为证据排查，不靠前端状态猜测。
