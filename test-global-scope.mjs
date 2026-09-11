// 回归测试：直接加载真实的 lib/client.js，在受控的假浏览器里验证
//   1) 全局待处理交互源（uiSession.pendingInteractions）能覆盖「没开在任何标签页里」的会话；
//   2) 多标签页共享同一 session 作用域 eventKey，全浏览器只响一次（聚焦页签优先）；
//   3) 「仅当前会话」模式只为本页显示的会话响；
//   4) 自定义提示音播放失败时自动回退内置提示音（不再静默）；
//   5) 本页彻底出不了声时让出 claim，请已解锁音频的页签补响一次；
//   6) uiSession 不可用时退回 DOM 卡片监听，且与全局源不会重复响。
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
function makeSharedStorage() {
	const data = new Map();
	const listeners = new Set();
	function notify(source, key, newValue, oldValue) {
		for (const l of [...listeners]) {
			if (l.name === source) continue; // storage 事件不投给写入者自己
			queueMicrotask(() => { try { l.fn({ key, newValue, oldValue }); } catch { /* ignore */ } });
		}
	}
	return {
		seed(key, value) { data.set(key, String(value)); },
		raw(key) { return data.get(key); },
		storageFor(name) {
			return {
				getItem: (k) => (data.has(k) ? data.get(k) : null),
				setItem: (k, v) => {
					const value = String(v);
					const old = data.has(k) ? data.get(k) : null;
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
function makeTab(name, { focused, audioUnlocked, mediaBlocked, uiSessionAvailable, sessionId, shared, pending, waits }) {
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

	const tab = { name, env, cards, observers, spoken, storage, pending };
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

	const ctx = {
		effect(fn) { const dispose = fn(); waits.push(dispose); },
		locale: { register: () => () => {} },
		slots: { inject: (_n, cb) => { cb(); }, register: () => () => {} },
		uiSession: uiSessionAvailable ? { pendingInteractions: pending } : undefined,
		sessions: { list: { getSnapshot: () => ({ current: tab.currentSessionId }) } }
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

console.log("\n" + (failures === 0 ? "ALL PASSED" : `${failures} FAILED`));
process.exit(failures === 0 ? 0 : 1);
