# Changelog

本文件记录 `dsh-approval-voice` 的重要变更。版本号遵循语义化版本（SemVer）。

## [0.2.1] - 2026-09

### 修复

- **「所有会话」现在真的覆盖所有会话**：旧实现只监听 DOM 里的 `data-approval-key` /
  `data-question-key` / `data-plan-review-key` 卡片，而 DSH 只会在「当前正在显示该会话」
  的那个视图里渲染这张卡片。因此**没有开在任何标签页里的会话**（只在侧边栏显示
  「等待审批」状态）永远不会触发提醒——单页签切换会话的用户会感觉「全局提醒没生效」。
  - 新实现首选订阅 DSH 客户端的全局待处理交互源 `ctx.uiSession.pendingInteractions`
    （就是侧边栏用的 `sessionPendingInteraction` root hook），按 `Map<sessionId, {kind,key}>`
    快照对所有会话的 approval / question / plan-review 变化触发提醒；
  - 取不到该源时（更老的 DSH）自动退回原来的 DOM 卡片监听，并打印一条明确告警。
- **跨标签页去重修正**：eventKey 由「标签页作用域」`${tabId}:${kind}:${key}` 改为
  「会话作用域」`session:${sessionId}:${kind}:${key}`（拿不到会话 id 时才退化）。旧写法下
  两个标签页显示同一会话时会各自响一次；现在全浏览器仍然只响一次，且优先由聚焦页签出声。
- **自定义提示音不再静默失效**：`playSoundFile` 现在保留 `<audio>` 引用（避免被 GC 提前
  回收导致截断），并在自定义提示音未起播（自动播放被拒、解码失败、1 秒内没有 `playing` 事件）
  时**自动回退内置提示音**，同时把失败原因写进 `console.warn`。
- **播放失败会让出 claim**：本页确实出不了声（自定义音失败且 `AudioContext` 未解锁）时，
  释放跨标签页 claim 并广播 `bell-failed`，请已解锁音频的其它页签补响一次（只补一次，避免互弹）。

### 新增

- 调试接口补充：`window.__approvalVoice.global()`（是否挂上全局源）、
  `window.__approvalVoice.pending()`（**所有**会话的待处理交互快照）、
  `window.__approvalVoice.currentSessionId()`。
- 新增回归测试 `test-global-scope.mjs`：直接加载真实的 `lib/client.js`，在假浏览器里覆盖
  「单页签 + 非当前会话」「多页签只响一次」「仅当前会话」「自定义音失败回退」「播放失败补响」
  「uiSession 缺失退回 DOM」共 6 组场景（17 条断言）。

## [0.2.0] - 2026-04

### 新增

- **默认对所有会话提醒（跨标签页）**：多会话 / 多标签页用户的任意会话出现审批、提问、计划审批时，都能听到提醒。
  - 实现：某标签页检测到待处理卡片时，通过 `BroadcastChannel`（并写入 localStorage 作为兜底）广播给同浏览器所有标签页。
  - 全浏览器内一次提醒只响一次：优先由当前聚焦的标签页播放（声音最可靠）；若没有聚焦标签页，则由最先到时的后台标签页兜底播放。
  - 通过共享 localStorage（键 `dsh.approvalVoice.v1`）在所有标签页间同步配置。
- **提醒范围设置**：设置 → 常规 → 审批语音提示 新增「提醒范围」下拉，可选：
  - `所有会话`（默认值，跨标签页广播）；
  - `仅当前会话`（只在当前标签页响应，即旧行为）。
- **自定义提示音文件**：新增「提示音」配置，允许从本地选择音频文件（mp3 / wav / ogg 等浏览器可解码格式，≤4MB）替换内置提示音。
  - 未设置自定义提示音时，默认仍使用内置 Web Audio 升调提示音（C5-E5-G5），行为不变。
  - 提供「恢复默认」按钮重置为内置提示音。
  - 自定义提示音以 data URL 存入 localStorage，跨标签页共享；调试接口新增 `window.__approvalVoice.tabId`。

### 变更

- 配置结构新增 `scope`（`"all"` | `"current"`，默认 `"all"`）与 `sound`（自定义提示音 data URL，默认空字符串）。
- 旧版配置里没有 `scope` / `sound` 字段时，自动补齐为 `scope: "all"`、`sound: ""`，无需迁移操作。
- `window.__approvalVoice.test()` 现在按当前模式播放（含自定义提示音）。

### 兼容性 / 升级指南

- 升级到 0.2.0 后**默认即所有会话提醒**；若更喜欢原来“仅当前会话”的行为，请在 设置 → 常规 → 审批语音提示 里把「提醒范围」切到 `仅当前会话`。
- 自定义提示音需要在浏览器里手动选择一次音频文件；文件仅保存在本浏览器 localStorage，不随包分发。
- 语音播报仍依赖系统中文 TTS；找不到中文语音时自动退化为提示音。
- 若所有 DSH 标签页都处于后台且使用「仅语音播报」，浏览器可能限制后台标签页的语音合成（提示音不受影响）。

### 测试

- 新增跨标签页协调回归测试 `test-cross-tab.mjs`（仅随源码仓库分发，不随 npm 包发布），覆盖：聚焦标签页触发、后台触发 + 前台聚焦、全后台兜底、重复检测去重、仅当前会话不跨页共 5 个场景。
- 已通过 `node --check` 语法校验与上述协调逻辑测试。

[0.2.0]: https://github.com/ZIye1208/dsh-approval-voice/releases/tag/v0.2.0
