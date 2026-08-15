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

## 安装（GitHub）

```powershell
dsh plugin --profile web add https://github.com/ZIye1208/dsh-approval-voice
```

安装后**重启 dsh web 服务**，刷新页面即可生效。

本地开发安装（改代码即时生效）：

```powershell
dsh plugin --profile web add link:C:\path\to\dsh-approval-voice
```

## 使用

- 默认开启「提示音 + 语音播报」。
- 设置入口：**设置 → 常规 → 审批语音提示**（可开关、选提醒方式、调音量、试听）。
- 控制台调试：`window.__approvalVoice.get()` / `set({...})` / `test()`。
- 配置保存在浏览器 localStorage（键 `dsh.approvalVoice.v1`）。

## 注意事项

- 语音播报依赖系统安装的中文 TTS 语音；找不到中文语音时自动退化为仅提示音（避免用英文语音念中文）。
- 浏览器自动播放策略：首次点击/按键后音频才解锁；审批通常发生在你已与页面交互之后，因此正常可用。
- 卸载：`dsh plugin --profile web remove dsh-approval-voice`，重启服务即可。

## 文件结构

```
dsh-approval-voice/
├── package.json        # dsh.bundle + dsh.client 声明（免构建）
├── cordis.patch.yml    # 插件名册插入行
├── lib/index.js        # 宿主侧空插件（浏览器专用插件无需宿主行为）
└── lib/client.js       # 浏览器端实现（模块加载器格式，纯 JS）
```
