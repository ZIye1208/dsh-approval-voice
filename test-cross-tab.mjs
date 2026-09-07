// 独立校验跨标签页协调算法（与 client.js 中的逻辑保持一致）：
// 断言：一次审批事件，全浏览器只响一次；聚焦标签页优先响；后台标签页兜底。
// 注意：这是对 client.js 内 maybePlay / claimBell / onBellMessage / onCardDetected 的
// 忠实复刻测试（playNow 被打桩为计数），用于验证设计不变量，非端到端浏览器测试。

// ---------- 共享存储：模拟同源多标签页共享 localStorage ----------
const sharedLocalStorage = new Map();
function makeLS() {
	const store = sharedLocalStorage;
	return {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => { store.set(k, String(v)); },
		removeItem: (k) => { store.delete(k); }
	};
}

// ---------- BroadcastChannel 注册表：消息投递给其它标签页 ----------
const registry = new Map(); // channel -> Set<tab>
const CHANNEL_NAME = "dsh-approval-voice";
registry.set(CHANNEL_NAME, new Set());
function makeBC(tab) {
	return {
		postMessage: (msg) => {
			for (const other of registry.get(CHANNEL_NAME) || []) {
				if (other === tab) continue; // 不投给自己
				queueMicrotask(() => {
					if (other.onmessage) other.onmessage({ data: msg });
				});
			}
		}
	};
}

const STORAGE_KEY = "dsh.approvalVoice.v1";
const BELL_KEY = "dsh.approvalVoice.bell.v1";
const CLAIM_TTL = 2500;
let tabSeq = 0;
function makeTab({ focused }) {
	const id = "tab-" + (++tabSeq);
	const tab = {
		id,
		focused,
		plays: 0,
		alertedKeys: new Set(),
		config: { enabled: true, mode: "both", volume: 0.6, text: "有新的审批请求，请查看", scope: "all", sound: "" },
		localStorage: makeLS(),
		document: { hasFocus: () => tab.focused }
	};
	tab.channel = makeBC(tab);
	registry.get(CHANNEL_NAME).add(tab.channel);

	// ---- 以下为 client.js 对应逻辑的复刻 ----
	function claimBell(eventKey) {
		try {
			const raw = tab.localStorage.getItem(BELL_KEY);
			let claim = null;
			if (raw) { try { claim = JSON.parse(raw); } catch {} }
			if (claim && claim.eventKey === eventKey && Date.now() - claim.ts < CLAIM_TTL) return false;
			tab.localStorage.setItem(BELL_KEY, JSON.stringify({ eventKey, ts: Date.now() }));
			return true;
		} catch { return true; }
	}
	function playNow() { tab.plays += 1; }
	function maybePlay(eventKey, bell) {
		if (tab.alertedKeys.has(eventKey)) return;
		tab.alertedKeys.add(eventKey);
		if (!tab.config.enabled) return;
		const delay = tab.document.hasFocus() ? 0 : 200 + Math.random() * 300;
		setTimeout(() => {
			if (!tab.config.enabled) return;
			if (claimBell(eventKey)) playNow();
		}, delay);
	}
	function onBellMessage(msg) {
		if (!msg || msg.type !== "bell" || !msg.eventKey) return;
		if (tab.config.scope !== "all") return;
		if (msg.source === tab.id) return;
		maybePlay(msg.eventKey, { mode: msg.mode, text: msg.text, volume: msg.volume });
	}
	function onCardDetected(key) {
		if (!tab.config.enabled || tab.config.mode === "off") return;
		if (tab.config.scope === "current") {
			if (tab.alertedKeys.has(key)) return;
			tab.alertedKeys.add(key);
			playNow();
			return;
		}
		const eventKey = `${tab.id}:${key}`;
		if (tab.alertedKeys.has(eventKey)) return;
		const bell = { type: "bell", eventKey, source: tab.id, mode: tab.config.mode, text: tab.config.text, volume: tab.config.volume };
		tab.channel.postMessage(bell);
		tab.localStorage.setItem(BELL_KEY, JSON.stringify(bell)); // writeLocalBell
		maybePlay(eventKey, null);
	}
	// channel 消息处理器（在函数定义后挂载）
	tab.channel.onmessage = (event) => { queueMicrotask(() => onBellMessage(event.data)); };

	return { tab, onBellMessage, onCardDetected };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond, msg) {
	if (cond) { console.log("PASS  " + msg); } else { console.log("FAIL  " + msg); failures += 1; }
}

async function run(name, tabsArr, trigger, expectPlays) {
	const totalPlays = () => tabsArr.reduce((s, t) => s + t.tab.plays, 0);
	// reset play counters and alertedKeys etc.
	for (const t of tabsArr) { t.tab.plays = 0; t.tab.alertedKeys.clear(); }
	registry.get(CHANNEL_NAME).clear();
	for (const t of tabsArr) registry.get(CHANNEL_NAME).add(t.tab.channel);

	trigger(tabsArr);
	await sleep(1200); // 等待 200-500ms 后台延迟与 0ms 聚焦延迟都触发

	console.log(`\n[scenario] ${name}`);
	for (const t of tabsArr) console.log(`   ${t.tab.id} focused=${t.tab.focused} plays=${t.tab.plays}`);
	assert(totalPlays() === expectPlays, `${name} => 全浏览器恰好响 ${expectPlays} 次（实际 ${totalPlays()}）`);
}

// ---------- 场景 1：审批在聚焦标签页 A，A 自己响，B 忽略 ----------
{
	const A = makeTab({ focused: true });
	const B = makeTab({ focused: false });
	await run("聚焦标签页触发", [A, B], (tabs) => tabs[0].onCardDetected("approval:1"), 1);
}

// ---------- 场景 2：审批在后台标签页 A，聚焦标签页 B 抢先响（只响一次，B） ----------
{
	const A = makeTab({ focused: false });
	const B = makeTab({ focused: true });
	await run("后台触发+前台聚焦", [A, B], (tabs) => tabs[0].onCardDetected("approval:2"), 1);
	const playsB = B.tab.plays;
	assert(playsB === 1, "后台触发时由聚焦标签页 B 播放（b）");
}

// ---------- 场景 3：全部后台，只有一个兜底标签页响 ----------
{
	const A = makeTab({ focused: false });
	const B = makeTab({ focused: false });
	await run("全部后台", [A, B], (tabs) => tabs[0].onCardDetected("approval:3"), 1);
}

// ---------- 场景 4：同一标签页重复检测同一卡片，只响一次 ----------
{
	const A = makeTab({ focused: true });
	await run("重复检测去重", [A], (tabs) => {
		tabs[0].onCardDetected("approval:4");
		tabs[0].onCardDetected("approval:4");
		tabs[0].onCardDetected("approval:4");
	}, 1);
}

// ---------- 场景 5：仅当前会话（scope=current）不跨标签页广播，各看各的 ----------
{
	const A = makeTab({ focused: true });
	const B = makeTab({ focused: true });
	A.tab.config.scope = "current";
	B.tab.config.scope = "current";
	await run("仅当前会话", [A, B], (tabs) => {
		tabs[0].onCardDetected("approval:5");
		// B 不应收到 A 的提醒
	}, 1);
	assert(B.tab.plays === 0, "仅当前会话模式下其它标签页不响（b）");
}

console.log("\n" + (failures === 0 ? "ALL PASSED" : `${failures} FAILED`));
process.exit(failures === 0 ? 0 : 1);
