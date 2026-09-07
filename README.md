# dsh-approval-voice（审批语音提示）

DSH Web GUI 插件：当需要你审批或回答的弹窗（沙箱权限升级审批、`ask_user_question` 提问、计划审批等）出现时，自动播放提示音并用语音播报，避免漏看。

## 工作原理

客户端插件监听 DOM 中审批/提问卡片的稳定标记：

| 标记 | 对应界面 |
| --- | --- |
| `data-approval-key` | 沙箱权限升级等审批（ApprovalPanel） |
| `data-question-key` | 提问 / 选择题（QuestionComposer） |
| `data-plan-review-key` | 计划审批（PlanReviewPanel） |

卡片出现时，按配置播放升调提示音（Web Audio，C5-E5-G5）和/或语音播报（SpeechSynthesis，中文语音）。每个请求只提醒一次。

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

- 默认开启「提示音 + 语音播报」，且**默认对所有会话提醒**（多会话/多标签页用户也能听到任何会话的审批 / 提问 / 计划审批）。
- 设置入口：**设置 → 常规 → 审批语音提示**，可配置：
  - 总开关；
  - 提醒方式：仅提示音 / 仅语音播报 / 提示音 + 语音播报；
  - 音量；
  - **提醒范围**：`所有会话`（跨标签页广播，默认）或 `仅当前会话`（只在当前标签页响应）；
  - **提示音文件**：选择本地音频文件（mp3/wav/ogg 等，≤4MB）替换内置提示音；点「恢复默认」回到内置提示音。
- 试听按钮：按当前设置播放一次（含自定义提示音）。
- 控制台调试：`window.__approvalVoice.get()` / `set({...})` / `test()` / `tabId`。
- 配置保存在浏览器 localStorage（键 `dsh.approvalVoice.v1`），同一浏览器所有标签页共享。

## 多会话（跨标签页）提醒原理

DSH Web GUI 中每个会话通常是一个独立标签页。插件按以下方式让**任一**会话的审批都能被听到：

- 每个标签页监听自身 DOM 中的审批 / 提问 / 计划审批卡片。
- 某标签页检测到卡片时，通过 `BroadcastChannel`（并写入 localStorage 作为兜底）通知同一浏览器所有标签页；`仅当前会话` 模式则只本地响应，不广播。
- 全浏览器内**一次提醒只响一次**：优先由**当前聚焦的标签页**播放（声音最可靠），若没有任何聚焦标签页，则由最先到时的后台标签页兜底播放。

## 注意事项

- 语音播报依赖系统安装的中文 TTS 语音；找不到中文语音时自动退化为仅提示音（避免用英文语音念中文）。
- 浏览器自动播放策略：首次点击/按键后音频才解锁；审批通常发生在你已与页面交互之后，因此正常可用。
- 自定义提示音以 data URL 存入 localStorage（≤4MB），请选择短促音频；跨标签页共享。
- 若所有 DSH 标签页都在后台且使用「仅语音播报」，浏览器可能限制后台标签页的语音合成（提示音不受影响）。
- 卸载：`dsh plugin --profile web remove dsh-approval-voice`，重启服务即可。

## 文件结构

```
dsh-approval-voice/
├── package.json        # dsh.bundle + dsh.client 声明（免构建）
├── cordis.patch.yml    # 插件名册插入行
├── lib/index.js        # 宿主侧空插件（浏览器专用插件无需宿主行为）
└── lib/client.js       # 浏览器端实现（模块加载器格式，纯 JS）
```