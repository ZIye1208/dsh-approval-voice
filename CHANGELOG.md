# Changelog

本文件记录 `dsh-approval-voice` 的重要变更。版本号遵循语义化版本（SemVer）。

## [0.3.0] - 2026-10-04

### 修复

- **自定义提示音会静默丢失（本次的核心 bug）**。三个原因叠在一起，只堵一个修不干净：
  1. 上限设在 **4MB（二进制）**，但 `FileReader.readAsDataURL` 产出的是 base64，
     **膨胀约 1.33 倍 → ≈5.33M 字符**，正好压在 localStorage 常见的 5MB 配额线上；
  2. `setConfig` 里是 `try { setItem } catch { /* ignore */ }` —— 配额异常被**静默吞掉**；
  3. 面板读的是**内存里的 `config`**，所以选完文件立刻显示「已自定义」，
     刷新后提示音消失，全程零提示。
  - 上限降到 **2MB**（留足余量），二进制超限时面板直接报错；
  - 新增 `writeVerified()`：写入后**回读比对**（有些环境 `setItem` 不抛错却没真正落盘），
    失败时**回滚内存配置**、还原磁盘上的提示音、把原因写进 `console.warn`；
  - 面板新增红色错误行，并区分「配额不足」与「其它失败」两种文案；
  - `window.__approvalVoice.set()` 的返回值由 `config` 改为 `{ ok, error, config }` ——
    **`ok:false` 表示没存住**，调用方不该忽略它。
- **拖动音量滑块会卡**：提示音和音量存在同一个 key（`dsh.approvalVoice.v1`）里，
  而 `<input type="range" step={0.05}>` 的 `onChange` 在拖动时**每步都触发** →
  每次都 `JSON.stringify` 整个含几 MB base64 的配置再**同步**写 localStorage。
  - 提示音拆到独立 key `dsh.approvalVoice.sound.v1`，主配置回到 **<1KB**
    （实测迁移后同源占用 207 字符），滑块拖动不再有 MB 级同步写。
  - 老版本的数据在首次启动时**自动迁移**（`migrateSoundOut()`）。迁移任一步失败就整体放弃、
    旧数据原样留着下次再试；读取侧（`readSound()`）也会回退读老位置，
    所以**已选的提示音不会因为迁移而凭空消失**。
- **已提醒键表无界增长**：`alertedKeys` 只在 `bell-failed` 分支才 `delete`，
  长时间开着的标签页里每个新审批事件都永久驻留。改为 FIFO 上限 1000 条
  （`markAlerted()`）—— 既不会被同一事件重复打扰，也不会一路涨到几十万条。
- **`localStorage.clear()` 后本页不归位**：`onStorage` 不处理 `event.key === null`，
  本页会继续抱着一份已经不在磁盘上的配置。现在 `key === null` 与 `key === STORAGE_KEY`
  走同一条重置路径。
- 顺带修正两处：`CLAIM_TTL` 的注释写「秒级去重窗口」，实际单位是**毫秒**；
  新增 `SOUND_KEY` 的 storage 监听，跨标签页改/清提示音时其它页签也会跟上。

### 测试

- `test-global-scope.mjs` 断言总数 **27 → 45 条，全部通过**。
  - 共享 localStorage 支持模拟配额（`sizeLimit`，超限抛 `QuotaExceededError`）与 `clear()`。
  - 新增 4 组场景：老数据迁移与新 key 拆分、**配额不足时不许假装保存成功**
    （回滚 + 磁盘不留半套数据 + 打印原因；同时验证配额充足时确实落盘）、
    已提醒键表被上限夹住、`storage.clear()` 后回到出厂默认。
  - 新增调试接口 `alertedCount()` / `soundBytes()` 供断言与排障用。
- **A/B 对照**：用同一份新测试跑**旧版** `lib/client.js`（`git show HEAD:...`）会 **12 条 FAIL**，
  跑新版 45 条全过 —— 证明这些断言确实咬得住上面三个 bug，不是摆设。
- `test-cross-tab.mjs` 7 条断言仍全过。

## [0.2.2] - 2026-09-30

### 修复

- **桌面端（dsh-desktop 0.2.0-rc.2）的「所有会话」全局提醒恢复生效**。
  0.2.1 订阅的全局源是**网页版**核心的 `ctx.uiSession.pendingInteractions`，而桌面端客户端核心
  **没有这个属性**——它只有 `ctx.uiSession.sessionStatus`
  （`Map<sessionId, {running, pendingInteraction, completionUnread}>`，待处理交互藏在
  `pendingInteraction` 字段，桌面端侧边栏「等待审批」用的就是它）。于是 `startGlobalWatcher`
  取源失败 → 退回 DOM 卡片监听 → **只有「当前正在显示的会话」会响**，现象与 0.2.1 修复前一模一样
  （诊断依据：桌面端 localStorage 里的响铃记录 eventKey 全是 `${tabId}:…` 前缀，
  而网页版那次是 `session:${sessionId}:…` 前缀）。
  - 新增 `resolveGlobalSource()`：优先 `uiSession.pendingInteractions`（网页版 dsh 0.1.5-rc.3），
    否则把 `uiSession.sessionStatus` 适配成同形状（桌面端 dsh-desktop 0.2.0-rc.2）；
    两者都取不到才退回 DOM 监听并打印明确告警。
  - `window.__approvalVoice.pending()` 同样走该解析，桌面端也能列出所有会话的待处理交互。
- **会话作用域 eventKey 在桌面端生效**：桌面端 `sessions.list.getSnapshot()` 返回
  `{byId, phase}`，没有网页版的 `.current`，导致 `currentSessionId()` 一直取不到值、
  eventKey 退化成 `${tabId}:${kind}:${key}`（跨标签页去重被架空）。现在会回退到
  `uiSession.adapter.current.getSnapshot().key`。

### 测试

- `test-global-scope.mjs` 新增 3 组「桌面端核心形状」场景：非当前会话提醒 + 会话作用域 eventKey、
  仅当前会话模式（验证 adapter.current 回退）、DOM 兜底路径的 eventKey 作用域；
  断言总数 17 → **27 条，全部通过**（`test-cross-tab.mjs` 5 组也仍全过）。

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

[0.2.2]: https://github.com/ZIye1208/dsh-approval-voice/releases/tag/v0.2.2
[0.2.0]: https://github.com/ZIye1208/dsh-approval-voice/releases/tag/v0.2.0
