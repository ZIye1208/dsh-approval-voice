# dsh-approval-voice（审批语音提示）

DSH Web GUI 插件：当需要你审批或回答的弹窗（沙箱权限升级审批、`ask_user_question` 提问、计划审批等）出现时，自动播放提示音并用语音播报，避免漏看。

## 工作原理

插件有两条检测路径，两条路径统一使用**会话作用域**的事件标识
（`session:<sessionId>:<kind>:<key>`），因此不会重复提醒：

1. **全局待处理交互源（首选）**：订阅 DSH 客户端的
   `ctx.uiSession.pendingInteractions`（即侧边栏「等待审批」状态所用的 root hook
   `sessionPendingInteraction`），按 `Map<sessionId, {kind, key}>` 快照感知**所有会话**的
   approval / question / plan-review —— 包括**没有开在任何标签页里**的会话。
2. **DOM 标记（兜底）**：仅在取不到上述源时（更老的 DSH）才使用，监听当前视图渲染出来的卡片：

| 标记 | 对应界面 |
| --- | --- |
| `data-approval-key` | 沙箱权限升级等审批（ApprovalPanel） |
| `data-question-key` | 提问 / 选择题（QuestionComposer） |
| `data-plan-review-key` | 计划审批（PlanReviewPanel） |

命中时按配置播放升调提示音（Web Audio，C5-E5-G5）和/或语音播报（SpeechSynthesis，中文语音）。每个请求只提醒一次。


## 安装

### 方式一：npm（推荐，已发布到 npmjs）

```powershell
dsh plugin --profile web add dsh-approval-voice
```

### 方式二：GitHub（备选）

```powershell
dsh plugin --profile web add github:ZIye1208/dsh-approval-voice
```

安装后**重启 dsh web 服务**，刷新页面即可生效。

本地开发安装（改代码即时生效）：

```powershell
dsh plugin --profile web add link:C:\path\to\dsh-approval-voice
```

## 使用

- 默认开启「提示音 + 语音播报」，且**默认对所有会话提醒**（多会话 / 单页签切换会话 / 多标签页都能听到任何会话的审批、提问、计划审批）。
- 设置入口：**设置 → 常规 → 审批语音提示**，可配置：
  - 总开关；
  - 提醒方式：仅提示音 / 仅语音播报 / 提示音 + 语音播报；
  - 音量；
  - **提醒范围**：`所有会话`（默认，覆盖所有会话，含没开在任何标签页里的会话）或 `仅当前会话`（只在当前标签页响应本页显示的会话）；
  - **提示音文件**：选择本地音频文件（mp3/wav/ogg 等，≤4MB）替换内置提示音；点「恢复默认」回到内置提示音。
- 试听按钮：按当前设置播放一次（含自定义提示音）。
- 控制台调试：`window.__approvalVoice.get()` / `set({...})` / `test()` / `pending()` / `global()` / `currentSessionId()` / `tabId`。
- 配置保存在浏览器 localStorage（键 `dsh.approvalVoice.v1`），同一浏览器所有标签页共享。


## 多会话提醒原理

DSH Web GUI 里每个会话可能是一个独立标签页，也可能只是同一页签侧边栏里的一条。插件按以下方式让**任一**会话的审批都能被听到：

- 每个页签订阅 DSH 客户端的**全局**待处理交互源 `ctx.uiSession.pendingInteractions`，因此
  任何会话（哪怕没开在任何页签里、只在侧边栏显示「等待审批」）出现审批 / 提问 / 计划审批时，
  每个页签都会感知到；取不到该源时退回监听本页 DOM 里的卡片。
- 事件标识是**会话作用域**的（`session:<sessionId>:<kind>:<key>`），配合 `BroadcastChannel`
  （并写入 localStorage 作为兜底）在全浏览器内**一次提醒只响一次**：优先由**当前聚焦的标签页**
  播放（声音最可靠），若没有任何聚焦标签页，则由最先到时的后台标签页兜底播放。
- 若抢到播放权的页签实际没能出声（浏览器拒绝自动播放且音频未解锁），它会释放 claim 并广播
  `bell-failed`，请已解锁音频的其它页签补响一次。
- `仅当前会话` 模式不广播，只在本地为本页正在显示的那个会话出声。

## 注意事项

- 语音播报依赖系统安装的中文 TTS 语音；找不到中文语音时自动退化为仅提示音（避免用英文语音念中文）。
- 浏览器自动播放策略：首次点击/按键后音频才解锁；设置在自定义提示音且未起播时会自动回退内置提示音，
  并把失败原因打到 `console.warn`（不再静默无声）。
- 自定义提示音以 data URL 存入 localStorage（≤4MB），请选择短促音频；跨标签页共享。
- 若所有 DSH 标签页都在后台且使用「仅语音播报」，浏览器可能限制后台标签页的语音合成（提示音不受影响）。
- 卸载：`dsh plugin --profile web remove dsh-approval-voice`，重启服务即可。

## 文件结构

```
dsh-approval-voice/
├── package.json            # dsh.bundle + dsh.client 声明（免构建）
├── cordis.patch.yml        # 插件名册插入行
├── lib/index.js            # 宿主侧空插件（浏览器专用插件无需宿主行为）
├── lib/client.js           # 浏览器端实现（模块加载器格式，纯 JS）
├── test-global-scope.mjs   # 回归测试：直接加载真实 lib/client.js 的假浏览器测试
└── test-cross-tab.mjs      # 旧版跨标签页协调逻辑复刻测试
```
