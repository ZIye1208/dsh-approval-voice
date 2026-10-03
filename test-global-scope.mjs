// 回归测试：直接加载真实的 lib/client.js，在受控的假浏览器里验证
//   1) 全局待处理交互源（uiSession.pendingInteractions）能覆盖「没开在任何标签页里」的会话；
//   2) 多标签页共享同一 session 作用域 eventKey，全浏览器只响一次（聚焦页签优先）；
//   3) 「仅当前会话」模式只为本页显示的会话响；
//   4) 自定义提示音播放失败时自动回退内置提示音（不再静默）；
//   5) 本页彻底出不了声时让出 claim，请已解锁音频的页签补响一次；
//   6) uiSession 不可用时退回 DOM 卡片监听，且与全局源不会重复响；
//   7) 桌面端核心形状（只有 sessionStatus）下同样成立（0.2.2 起）；
//   8) 提示音与主配置分家 + 老数据自动迁移（0.3.0 起）；
//   9) 配额不足时**不许假装保存成功**：回滚内存配置 + 磁盘不留半套数据 + 打印失败原因（0.3.0 起）；
//  10) 已提醒键表有 FIFO 上限，不随运行时长无界增长（0.3.0 起）；
//  11) localStorage.clear() 后本页回到出厂默认（0.3.0 起）。
// 运行：node test-global-scope.mjs
import fs from "node:fs";

const SRC = fs.readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");

// ---------------- 从真实源码里取出 factory 源码（不带它的词法作用域） ----------------
let factorySrc = null;
new Function("window", SRC)({
	__ModuleLoader__: { load: (m) => { factorySrc = m.factory.toString(); } }
});
if (factorySrc === null) throw new Error("无法从 lib/client.js 里取出 factory");

// ---------------- 共享 localStorage（同源所有标签页共享） ----------------
// options.sizeLimit：模拟配额上限（按 UTF-16 字符数近似），超了就像浏览器那样抛
// QuotaExceededError —— 这是 0.2.2 里"提示音看着存住了、刷新后消失"的成因，必须能复现。
function makeSharedStorage(options) {
	const limit = options && typeof options.sizeLimit === "number" ? options.sizeLimit : Infinity;
	const data = new Map();
	const listeners = new Set();
	function used() { let n = 0; for (const [k, v] of data) n += k.length + v.length; return n; }
	function notify(source, key, newValue, oldValue) {
		for (const l of [...listeners]) {
			if (l.name === source) continue; // storage 事件不投给写入者自己
			queueMicrotask(() => { try { l.fn({ key, newValue, oldValue }); } catch { /* ignore */ } });
		}
	}
	return {
		seed(key, value) { data.set(key, String(value)); },
		raw(key) { return data.get(key); },
		used,
		/** 模拟 localStorage.clear()：只发一个 key === null 的事件（真实浏览器就是这个行为）。 */
		clear() { data.clear(); notify(null, null, null, null); },
		storageFor(name) {
			return {
				getItem: (k) => (data.has(k) ? data.get(k) : null),
				setItem: (k, v) => {
					const value = String(v);
					const old = data.has(k) ? data.get(k) : null;
					if (limit !== Infinity) {
						const projected = used() - (old === null ? 0 : k.length + old.length) + k.length + value.length;
						if (projected > limit) {
							const error = new Error("Failed to execute 'setItem' on 'Storage': exceeded the quota.");
							error.name = "QuotaExceededError";
							error.code = 22;
							throw error;
						}
					}
					data.set(k, value);
					if (old !== value) notify(name, k, value, old);
				},
				removeItem: (k) => { const old = data.get(k); data.delete(k); notify(name, k, null, old ?? null); }
			};
		},
		onStorage(name, fn) { const rec = { name, fn }; listeners.add(rec); return () => listeners.delete(rec); }
	};
}

// ---------------- BroadcastChannel：同源跨标签页 ----------------
const channels = new Map();
function makeBroadcastChannel(name) {
	if (!channels.has(name)) channels.set(name, new Set());
	const pool = channels.get(name);
	const self = {
		onmessage: null,
		postMessage(msg) {
			for (const other of [...pool]) {
				if (other === self) continue;
				queueMicrotask(() => { if (other.onmessage) other.onmessage({ data: msg }); });
			}
		},
		close() { pool.delete(self); }
	};
	pool.add(self);
	return self;
}

// ---------------- 全局待处理交互源（uiSession.pendingInteractions 的形状） ----------------
function makePendingSource() {
	const map = new Map();
	const listeners = new Set();
	const flush = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* ignore */ } } };
	return {
		getSnapshot: () => map,
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		publish(sessionId, interaction) { map.set(sessionId, interaction); flush(); },
		settle(sessionId) { map.delete(sessionId); flush(); }
	};
}

// ---------------- 假 DOM ----------------
function makeCard(attrs) {
	return {
		nodeType: 1,
		matches: (sel) => Object.keys(attrs).some((a) => sel.includes(a)),
		getAttribute: (n) => (n in attrs ? attrs[n] : null),
		querySelectorAll: () => []
	};
}

// ---------------- 单个「标签页」环境 ----------------
// core: "web"（dsh 0.1.5-rc.3 形状：pendingInteractions + sessions.list.getSnapshot().current）
//       | "desktop"（dsh-desktop 0.2.0-rc.2 形状：只有 sessionStatus，快照没有 current，
//                    当前会话在 uiSession.adapter.current）
function makeTab(name, { focused, audioUnlocked, mediaBlocked, core = "web", uiSessionAvailable, sessionId, shared, pending, waits }) {
	const env = {
		played: 0,        // <audio>.play() 真正起播次数
		playCalls: 0,
		chimeNotes: 0,    // 内置提示音（Web Audio）实际发声的音符数
		warnings: [],
		audios: []
	};
	const storage = shared.storageFor(name);
	const storageHandlers = new Set();

	const AudioCtor = class FakeAudio {
		constructor(src) {
			this.src = src;
			this.volume = 1;
			this.env = env;
			this.listeners = {};
			env.audios.push(this);
		}
		addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
		play() {
			env.playCalls++;
			if (mediaBlocked) {
				const error = new Error("play() failed because the user didn't interact with the document first");
				error.name = "NotAllowedError";
				return Promise.reject(error);
			}
			env.played++;
			setTimeout(() => { for (const fn of this.listeners.playing || []) fn(); }, 0);
			return Promise.resolve();
		}
		pause() {}
	};
	const AudioContextCtor = class FakeAudioContext {
		constructor() {
			this.state = audioUnlocked ? "running" : "suspended";
			this.currentTime = 0;
			this.destination = {};
		}
		resume() {
			if (audioUnlocked) { this.state = "running"; return Promise.resolve(); }
			return Promise.reject(new Error("not allowed to start AudioContext"));
		}
		createOscillator() {
			const ctx = this;
			return {
				type: "sine",
				frequency: { value: 0 },
				connect() {},
				start() {},
				stop(at) { if (at >= 0.2 && ctx.state === "running") env.chimeNotes++; }
			};
		}
		createGain() {
			return {
				gain: {
					value: 0,
					setValueAtTime() {},
					exponentialRampToValueAtTime() {}
				},
				connect() {}
			};
		}
	};
	const spoken = [];
	const speechSynthesis = {
		getVoices: () => [{ lang: "zh-CN", name: "Fake" }],
		cancel() {},
		speak: (u) => spoken.push(u)
	};
	const windowStub = {
		crypto: { randomUUID: () => `${name}-${Math.random().toString(36).slice(2, 10)}` },
		AudioContext: AudioContextCtor,
		speechSynthesis,
		alert() {},
		addEventListener(type, fn) { if (type === "storage") storageHandlers.add(fn); },
		removeEventListener(type, fn) { if (type === "storage") storageHandlers.delete(fn); }
	};
	shared.onStorage(name, (event) => { for (const fn of [...storageHandlers]) fn(event); });

	const cards = [];
	const observers = [];
	const documentStub = {
		documentElement: { nodeType: 1, matches: () => false, querySelectorAll: () => cards },
		hasFocus: () => focused,
		addEventListener() {},
		removeEventListener() {}
	};
	const MutationObserverStub = class {
		constructor(cb) { this.cb = cb; this.observing = false; observers.push(this); }
		observe() { this.observing = true; }
		disconnect() { this.observing = false; }
	};

	const tab = { name, env, cards, observers, spoken, storage, pending, window: windowStub };
	tab.currentSessionId = sessionId;
	tab.setCurrentSession = (id) => { tab.currentSessionId = id; };

	// 每「标签页」一个独立的插件模块实例（独立 tabId / alertedKeys）
	const factory = new Function(
		"require", "window", "document", "localStorage", "BroadcastChannel", "Audio",
		"MutationObserver", "speechSynthesis", "SpeechSynthesisUtterance", "setTimeout", "clearTimeout", "console", "queueMicrotask",
		`return (${factorySrc});`
	)(
		() => ({ createElement: () => null }),
		windowStub, documentStub, storage, makeBroadcastChannel, AudioCtor,
		MutationObserverStub, speechSynthesis, class FakeUtterance { constructor(text) { this.text = text; } },
		setTimeout, clearTimeout,
		{ log() {}, warn: (...a) => env.warnings.push(a.join(" ")), error() {} },
		queueMicrotask
	);
	const mod = factory(() => ({ createElement: () => null }));

	// 桌面端形状的 sessionStatus：Map<sessionId, {running, pendingInteraction, completionUnread}>
	const statusSource = {
		getSnapshot: () => {
			const out = new Map();
			const base = pending && pending.getSnapshot ? pending.getSnapshot() : new Map();
			base.forEach((interaction, id) => out.set(id, { running: undefined, pendingInteraction: interaction, completionUnread: false }));
			return out;
		},
		subscribe: (fn) => (pending && pending.subscribe ? pending.subscribe(fn) : () => {})
	};
	const ctx = {
		effect(fn) { const dispose = fn(); waits.push(dispose); },
		locale: { register: () => () => {} },
		slots: { inject: (_n, cb) => { cb(); }, register: () => () => {} },
		uiSession: !uiSessionAvailable
			? undefined
			: core === "desktop"
				? { sessionStatus: statusSource, adapter: { current: { getSnapshot: () => ({ key: tab.currentSessionId }) } } }
				: { pendingInteractions: pending },
		sessions: {
			list: {
				getSnapshot: () => (core === "desktop"
					? { byId: {}, phase: "ready" } // 桌面端快照没有 current
					: { current: tab.currentSessionId })
			}
		}
	};
	mod.apply(ctx);
	tab.module = mod;
	tab.addCard = (attrs) => { const card = makeCard(attrs); cards.push(card); for (const o of observers) if (o.observing) o.cb([{ addedNodes: [card] }]); return card; };
	tab.audible = () => env.played > 0 || env.chimeNotes > 0;
	tab.sounds = () => env.played + (env.chimeNotes > 0 ? 1 : 0);
	return tab;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond, msg) {
	if (cond) console.log(`PASS  ${msg}`);
	else { console.log(`FAIL  ${msg}`); failures += 1; }
}
function reset(tabs) {
	for (const t of tabs) { t.env.played = 0; t.env.playCalls = 0; t.env.chimeNotes = 0; t.env.warnings = []; }
}

const CONFIG = JSON.stringify({
	enabled: true, mode: "beep", volume: 0.75, text: "有新的审批请求，请查看", scope: "all",
	sound: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA="
});

// ===============================================================
// 场景 1（核心回归）：只有一个页签、且审批属于「非当前显示」的会话
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", CONFIG);
	const pending = makePendingSource();
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, uiSessionAvailable: true, sessionId: "session-cur", shared, pending, waits });
	assert(A.module ? true : false, "插件在页签 A 激活");
	assert(A.env.warnings.every((w) => !w.includes("取不到")), "页签 A 挂上了全局源（没有退回 DOM 监听）");
	pending.publish("session-bg", { kind: "approval", key: "approval:4", sessionId: "session-bg" });
	await wait(600);
	assert(A.sounds() === 1, `非当前会话的审批也响 1 次（实际 ${A.sounds()}；修复前为 0）`);
	pending.publish("session-bg2", { kind: "question", key: "question:1" });
	await wait(600);
	assert(A.sounds() === 2, "另一个后台会话的提问同样会响");
	reset([A]);
	pending.publish("session-cur", { kind: "plan-review", key: "plan-review:1" });
	await wait(600);
	assert(A.sounds() === 1, "当前会话的计划审批照旧会响");
}

// ===============================================================
// 场景 2：两个页签（A 聚焦 / B 后台）都想为同一个后台会话响 → 全浏览器只响一次，且来自 A
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", CONFIG);
	const pending = makePendingSource();
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, uiSessionAvailable: true, sessionId: "s-a", shared, pending, waits });
	const B = makeTab("B", { focused: false, audioUnlocked: true, mediaBlocked: false, uiSessionAvailable: true, sessionId: "s-b", shared, pending, waits });
	pending.publish("s-bg", { kind: "approval", key: "approval:9" });
	await wait(900);
	const total = A.sounds() + B.sounds();
	assert(total === 1, `两个页签同时看到同一事件，全浏览器只响 1 次（实际 ${total}）`);
	assert(A.sounds() === 1, "由聚焦页签 A 出声（声音最可靠）");
}

// ===============================================================
// 场景 3：提醒范围 = 仅当前会话 → 只为本页显示的会话响
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", JSON.stringify({ ...JSON.parse(CONFIG), scope: "current" }));
	const pending = makePendingSource();
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, uiSessionAvailable: true, sessionId: "s-a", shared, pending, waits });
	pending.publish("s-other", { kind: "approval", key: "approval:1" });
	await wait(600);
	assert(A.sounds() === 0, "仅当前会话：其它会话的审批不响");
	pending.publish("s-a", { kind: "approval", key: "approval:2" });
	await wait(600);
	assert(A.sounds() === 1, "仅当前会话：本页显示的会话照旧响");
}

// ===============================================================
// 场景 4：自定义提示音被浏览器拒绝（自动播放策略）→ 自动回退内置提示音
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", CONFIG);
	const pending = makePendingSource();
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: true, uiSessionAvailable: true, sessionId: "s-a", shared, pending, waits });
	pending.publish("s-bg", { kind: "approval", key: "approval:7" });
	await wait(800);
	assert(A.env.playCalls === 1, "确实尝试播放过自定义提示音");
	assert(A.env.chimeNotes >= 6, `自定义提示音失败后回退内置提示音（实际音符 ${A.env.chimeNotes}）`);
	assert(A.env.warnings.some((w) => w.includes("自定义提示音未起播")), "失败原因写进了 console.warn（不再静默吞掉）");
}

// ===============================================================
// 场景 5：本页彻底出不了声（自定义被拒 + AudioContext 未解锁）→ 让出 claim，请已解锁页签补响
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", CONFIG);
	const pending = makePendingSource();
	const waits = [];
	// 两个页签都后台：抢到 claim 的可能是未解锁的那个；聚焦页签 A 已解锁
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, uiSessionAvailable: true, sessionId: "s-a", shared, pending, waits });
	const B = makeTab("B", { focused: false, audioUnlocked: false, mediaBlocked: true, uiSessionAvailable: true, sessionId: "s-b", shared, pending, waits });
	assert(B.sounds() === 0, "（前置）页签 B 当前无法出声");
	pending.publish("s-bg", { kind: "approval", key: "approval:11" });
	await wait(1600);
	assert(A.sounds() + B.sounds() >= 1, `全浏览器至少响 1 次（A=${A.sounds()} B=${B.sounds()}）`);
}

// ===============================================================
// 场景 6：uiSession 不可用（老版本）→ 退回 DOM 卡片监听；同一事件不会重复响
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", CONFIG);
	const pending = makePendingSource();
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, uiSessionAvailable: false, sessionId: "s-a", shared, pending, waits });
	assert(A.env.warnings.some((w) => w.includes("取不到 uiSession.pendingInteractions")), "uiSession 缺失时给出明确告警并退回 DOM 监听");
	A.addCard({ "data-approval-key": "approval:3" });
	await wait(600);
	assert(A.sounds() === 1, "DOM 卡片照旧触发提醒（兜底路径可用）");
	A.addCard({ "data-approval-key": "approval:3" }); // 同一张卡片被重复扫描
	await wait(600);
	assert(A.sounds() === 1, "同一卡片重复扫描只响一次");
}

// ===============================================================
// 场景 7（0.2.2 核心回归）：桌面端核心形状 dsh-desktop 0.2.0-rc.2
//   只有 ctx.uiSession.sessionStatus（没有 pendingInteractions），会话快照没有 current
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", CONFIG);
	const pending = makePendingSource();
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, core: "desktop", uiSessionAvailable: true, sessionId: "session-cur", shared, pending, waits });
	assert(A.module ? true : false, "桌面端形状：插件在页签 A 激活");
	assert(A.env.warnings.every((w) => !w.includes("取不到")), "桌面端形状：挂上了 sessionStatus 全局源（修复前会退回 DOM 监听）");
	pending.publish("session-bg", { kind: "approval", key: "approval:5", sessionId: "session-bg" });
	await wait(600);
	assert(A.sounds() === 1, `桌面端形状：非当前会话的审批也响 1 次（实际 ${A.sounds()}；修复前为 0）`);
	const claim = shared.raw("dsh.approvalVoice.bell.v1") || "";
	assert(claim.includes("session:session-bg:approval:approval:5"), "桌面端形状：eventKey 是会话作用域（修复前是 tabId 前缀）");
	reset([A]);
	pending.publish("session-bg2", { kind: "question", key: "question:1" });
	await wait(600);
	assert(A.sounds() === 1, "桌面端形状：另一个后台会话的提问同样会响");
	reset([A]);
	pending.settle("session-bg");
	pending.settle("session-bg2");
	pending.publish("session-cur", { kind: "approval", key: "approval:2" });
	await wait(600);
	assert(A.sounds() === 1, "桌面端形状：当前会话的审批照旧会响");
}

// ===============================================================
// 场景 8：桌面端形状 + 提醒范围「仅当前会话」→ 当前会话 id 要能从 adapter.current 取到
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", JSON.stringify({ ...JSON.parse(CONFIG), scope: "current" }));
	const pending = makePendingSource();
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, core: "desktop", uiSessionAvailable: true, sessionId: "session-cur", shared, pending, waits });
	pending.publish("session-other", { kind: "approval", key: "approval:1" });
	await wait(600);
	assert(A.sounds() === 0, "桌面端形状 + 仅当前会话：其它会话的审批不响");
	pending.publish("session-cur", { kind: "approval", key: "approval:3" });
	await wait(600);
	assert(A.sounds() === 1, "桌面端形状 + 仅当前会话：本页显示的会话照旧响");
}

// ===============================================================
// 场景 9：桌面端形状下 DOM 兜底路径的 eventKey 也要会话作用域
//   （修复前 currentSessionId() 取不到，退化成 tabId，跨标签去重被架空）
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", CONFIG);
	const pending = makePendingSource();
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, core: "desktop", uiSessionAvailable: true, sessionId: "session-cur", shared, pending, waits });
	A.addCard({ "data-approval-key": "approval:8" });
	await wait(600);
	assert(A.sounds() === 1, "桌面端形状：DOM 兜底卡片照旧触发提醒");
	const claim = shared.raw("dsh.approvalVoice.bell.v1") || "";
	assert(claim.includes("session:session-cur:approval:approval:8"), `桌面端形状：DOM 路径 eventKey 带会话作用域（实际 ${claim.slice(0, 90)}）`);
}

// ===============================================================
// 场景 10（0.3.0 新增）：提示音与主配置分家 —— 老数据自动迁移，主配置不再被大字符串拖累
//   0.2.2 及以前把提示音和别的配置挤在同一个 key 里，音量滑块每次 onChange 都要
//   重写整份含 base64 的配置（同步、主线程）→ 拖一下就卡。
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", CONFIG); // 老格式：提示音就在主配置里
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, uiSessionAvailable: true, sessionId: "s-a", shared, pending: makePendingSource(), waits });
	const api = A.window.__approvalVoice;
	assert(shared.raw("dsh.approvalVoice.sound.v1") !== undefined, "老格式里的提示音被迁移到独立 key");
	assert(!String(shared.raw("dsh.approvalVoice.v1")).includes("sound"), "迁移后主配置里不再残留提示音（主配置回到 <1KB）");
	assert(api.get().sound !== "", "迁移后提示音照旧可用（没丢用户已选的音）");
	assert(api.get().volume === 0.75, "迁移不影响其它配置项（CONFIG 里 volume=0.75）");
	assert(shared.used() < 2000, `分家后 localStorage 占用很小（实际 ${shared.used()} 字符）`);
}

// ===============================================================
// 场景 11（0.3.0 核心回归）：配额不足时**不许假装保存成功**
//   修复前：setItem 抛 QuotaExceededError 被 catch{} 吞掉，面板照样显示「已自定义」，
//   刷新后提示音消失，全程零提示。这是本次要根治的 bug。
// ===============================================================
{
	const shared = makeSharedStorage({ sizeLimit: 500 }); // 配额只够存一份主配置，存不下提示音
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, uiSessionAvailable: true, sessionId: "s-a", shared, pending: makePendingSource(), waits });
	const api = A.window.__approvalVoice;
	const before = api.get();
	const huge = "data:audio/wav;base64," + "A".repeat(4000); // 远超 500 字符配额
	const result = api.set({ sound: huge });
	assert(result && result.ok === false, "配额不足时 set() 明确报告失败（不再静默吞掉）");
	assert(result.error && result.error.name === "QuotaExceededError", "失败原因是 QuotaExceededError（面板能识别成「配额」而不是「未知错误」）");
	assert(api.get().sound === before.sound, "保存失败后内存配置回滚到上一个值（面板不会显示「已自定义」）");
	assert(shared.raw("dsh.approvalVoice.sound.v1") === undefined, "保存失败时磁盘上没留下半套新数据");
	assert(A.env.warnings.some((w) => w.includes("设置保存失败")), "失败原因写进了 console.warn（不再静默吞掉）");
	// 反过来：配额够的时候必须真的存住，别矫枉过正
	const okResult = api.set({ sound: "data:audio/wav;base64,QUJD" });
	assert(okResult && okResult.ok === true, "配额充足时 set() 报告成功");
	assert(api.get().sound === "data:audio/wav;base64,QUJD", "成功路径确实写进了内存配置");
	assert(shared.raw("dsh.approvalVoice.sound.v1") === "data:audio/wav;base64,QUJD", "成功路径确实落到了磁盘");
}

// ===============================================================
// 场景 12（0.3.0 新增）：已提醒键表有 FIFO 上限，不随运行时长无界增长
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", CONFIG);
	const pending = makePendingSource();
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, uiSessionAvailable: true, sessionId: "s-a", shared, pending, waits });
	const api = A.window.__approvalVoice;
	// 一次性灌入 1500 个不同的待处理交互（真实场景是长期累积出来的）
	const snapshot = pending.getSnapshot();
	for (let i = 0; i < 1500; i++) snapshot.set("s-bg-" + i, { kind: "approval", key: "approval:" + i });
	pending.publish("s-trigger", { kind: "approval", key: "approval:t" }); // 触发一轮 flush
	await wait(500);
	// 用存在性判断而不是直接调用：老版本没有这个调试方法，应当"FAIL 掉"而不是把整套测试崩掉，
	// 否则它后面的场景根本没机会跑，诊断价值大打折扣。
	const count = typeof api.alertedCount === "function" ? api.alertedCount() : -1;
	assert(count === 1000, `已提醒键表被上限夹住、没有无界增长（实际 ${count}）`);
}

// ===============================================================
// 场景 13（0.3.0 新增）：localStorage.clear() → 本页回到出厂默认
//   修复前 onStorage 不处理 key === null，本页会继续抱着一份已不在磁盘上的配置。
// ===============================================================
{
	const shared = makeSharedStorage();
	shared.seed("dsh.approvalVoice.v1", JSON.stringify({ ...JSON.parse(CONFIG), volume: 0.2, scope: "current" }));
	const waits = [];
	const A = makeTab("A", { focused: true, audioUnlocked: true, mediaBlocked: false, uiSessionAvailable: true, sessionId: "s-a", shared, pending: makePendingSource(), waits });
	const api = A.window.__approvalVoice;
	assert(api.get().volume === 0.2 && api.get().scope === "current", "（前置）自定义配置已生效");
	shared.clear();
	await wait(100);
	assert(api.get().volume === 0.6, "storage.clear() 后音量回到默认（不再抱着失效配置）");
	assert(api.get().scope === "all", "storage.clear() 后提醒范围回到默认");
	assert(api.get().sound === "", "storage.clear() 后自定义提示音清空");
}

console.log("\n" + (failures === 0 ? "ALL PASSED" : `${failures} FAILED`));
process.exit(failures === 0 ? 0 : 1);
