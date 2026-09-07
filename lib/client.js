window.__ModuleLoader__.load({
	id: "dsh-approval-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		// ---------------------------------------------------------------
		// 配置（持久化到 localStorage，与设置面板共享；所有标签页共享同一份）
		// ---------------------------------------------------------------
		const STORAGE_KEY = "dsh.approvalVoice.v1";
		const BELL_KEY = "dsh.approvalVoice.bell.v1";
		const CHANNEL_NAME = "dsh-approval-voice";
		const DEFAULTS = Object.freeze({
			enabled: true, // 总开关
			mode: "both", // beep | speech | both | off
			volume: 0.6, // 0..1
			text: "有新的审批请求，请查看",
			scope: "all", // all（所有会话，跨标签页）| current（仅当前会话）
			sound: "" // 自定义提示音 data URL；空字符串 = 使用内置提示音
		});
		function readConfig() {
			let saved = {};
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (raw) saved = JSON.parse(raw);
			} catch { /* ignore */ }
			const merged = { ...DEFAULTS };
			for (const key of Object.keys(DEFAULTS)) {
				if (typeof saved[key] === typeof DEFAULTS[key]) merged[key] = saved[key];
			}
			return merged;
		}
		let config = readConfig();
		const configListeners = new Set();
		function setConfig(patch) {
			config = { ...config, ...patch };
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
			} catch { /* ignore */ }
			for (const listener of [...configListeners]) {
				try { listener(config); } catch { /* ignore */ }
			}
			return config;
		}
		function subscribeConfig(listener) {
			configListeners.add(listener);
			return () => configListeners.delete(listener);
		}

		// ---------------------------------------------------------------
		// 跨标签页协作：BroadcastChannel 为主，storage 事件兜底
		// ---------------------------------------------------------------
		const tabId = (() => {
			try {
				if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
			} catch { /* ignore */ }
			return "tab-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
		})();

		let channel = null;
		function initChannel() {
			if (channel) return channel;
			try {
				if (typeof BroadcastChannel !== "undefined") {
					channel = new BroadcastChannel(CHANNEL_NAME);
					channel.onmessage = (event) => onBellMessage(event.data);
				}
			} catch {
				channel = null;
			}
			return channel;
		}
		function broadcastBell(msg) {
			try { if (channel) channel.postMessage(msg); } catch { /* ignore */ }
		}
		function writeLocalBell(msg) {
			try { localStorage.setItem(BELL_KEY, JSON.stringify(msg)); } catch { /* ignore */ }
		}

		// 其他标签页改了配置（scope/sound/mode/音量等）时同步到本页。
		function onStorage(event) {
			if (event.key === STORAGE_KEY) {
				config = readConfig();
				for (const listener of [...configListeners]) {
					try { listener(config); } catch { /* ignore */ }
				}
			} else if (event.key === BELL_KEY && event.newValue && config.scope === "all") {
				try {
					const msg = JSON.parse(event.newValue);
					if (msg && msg.type === "bell" && msg.eventKey && msg.source !== tabId) {
						onBellMessage(msg);
					}
				} catch { /* ignore */ }
			}
		}
		if (typeof window !== "undefined") {
			window.addEventListener("storage", onStorage);
		}
		initChannel();

		// ---------------------------------------------------------------
		// 声音：内置 Web Audio 提示音 / 自定义提示音 / SpeechSynthesis
		// ---------------------------------------------------------------
		let audioContext = null;
		function ensureAudioContext() {
			if (audioContext === null) {
				try {
					const Ctor = window.AudioContext || window.webkitAudioContext;
					audioContext = Ctor ? new Ctor() : undefined;
				} catch {
					audioContext = undefined;
				}
			}
			if (audioContext && audioContext.state === "suspended") {
				audioContext.resume().catch(() => {});
			}
			return audioContext;
		}
		/** 升调三音提示（C5-E5-G5，两遍），比单音更易察觉。 */
		function playChime(volume) {
			const ctx = ensureAudioContext();
			if (!ctx) return;
			const level = Math.max(0.01, Math.min(1, volume));
			const notes = [523.25, 659.25, 783.99, 523.25, 659.25, 783.99];
			const now = ctx.currentTime;
			notes.forEach((freq, index) => {
				const t0 = now + index * 0.14;
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = "sine";
				osc.frequency.value = freq;
				gain.gain.setValueAtTime(0.0001, t0);
				gain.gain.exponentialRampToValueAtTime(level, t0 + 0.02);
				gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
				osc.connect(gain);
				gain.connect(ctx.destination);
				osc.start(t0);
				osc.stop(t0 + 0.24);
			});
		}
		/** 播放自定义提示音文件（支持 mp3/wav/ogg 等，浏览器 `<audio>` 可解码的格式）。 */
		function playSoundFile(dataUrl, volume) {
			try {
				const audio = new Audio(dataUrl);
				audio.volume = Math.max(0, Math.min(1, volume));
				audio.play().catch(() => {});
			} catch { /* ignore */ }
		}
		/** 语音播报；找不到中文语音时放弃（避免用英文语音念中文）。返回是否真的播报了。 */
		function speak(text) {
			if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
			try {
				const voices = window.speechSynthesis.getVoices();
				const zhVoice = voices.find((voice) => voice.lang && voice.lang.toLowerCase().replace("_", "-").startsWith("zh"));
				if (zhVoice === undefined) return false;
				window.speechSynthesis.cancel();
				const utterance = new SpeechSynthesisUtterance(text);
				utterance.lang = zhVoice.lang;
				utterance.voice = zhVoice;
				utterance.rate = 1.0;
				utterance.pitch = 1.05;
				window.speechSynthesis.speak(utterance);
				return true;
			} catch {
				return false;
			}
		}
		/** 按一次提醒实际发声：提示音（自定义优先，否则内置）+ 语音播报。 */
		function playNow(overrides) {
			const cfg = { ...config, ...(overrides || {}) };
			if (!cfg.enabled || cfg.mode === "off") return;
			const mode = cfg.mode;
			if (mode === "beep" || mode === "both") {
				if (cfg.sound) playSoundFile(cfg.sound, cfg.volume);
				else playChime(cfg.volume);
			}
			if (mode === "speech" || mode === "both") speak(cfg.text);
		}
		/** 在首次用户手势时预热音频/语音，规避浏览器自动播放限制。 */
		function primeAudio() {
			const ctx = ensureAudioContext();
			if (ctx && ctx.state === "running") {
				try {
					const osc = ctx.createOscillator();
					const gain = ctx.createGain();
					gain.gain.value = 0.0001;
					osc.connect(gain);
					gain.connect(ctx.destination);
					osc.start(0);
					osc.stop(0.01);
				} catch { /* ignore */ }
			}
			try {
				if ("speechSynthesis" in window) window.speechSynthesis.getVoices();
			} catch { /* ignore */ }
		}

		// ---------------------------------------------------------------
		// 去重与跨标签页协调：一次提醒全浏览器只响一次，优先聚焦标签页响
		// ---------------------------------------------------------------
		const alertedKeys = new Set();
		const CLAIM_TTL = 2500; // 秒级去重窗口（跨标签页 claims 用）
		function claimBell(eventKey) {
			try {
				const raw = localStorage.getItem(BELL_KEY);
				let claim = null;
				if (raw) { try { claim = JSON.parse(raw); } catch { /* ignore */ } }
				if (claim && claim.eventKey === eventKey && Date.now() - claim.ts < CLAIM_TTL) return false;
				localStorage.setItem(BELL_KEY, JSON.stringify({ eventKey, ts: Date.now() }));
				return true;
			} catch {
				return true; // localStorage 不可用时退化为直接播放
			}
		}
		/**
		 * 协调一次提醒。聚焦标签页立刻响（delay 0），后台标签页稍等，
		 * 这样若有其它聚焦的 DSH 标签页，它会抢先响；否则由最先到时的后台标签页响。
		 */
		function maybePlay(eventKey, bell) {
			if (alertedKeys.has(eventKey)) return;
			alertedKeys.add(eventKey);
			if (!config.enabled) return;
			const delay = document.hasFocus() ? 0 : 200 + Math.random() * 300;
			setTimeout(() => {
				if (!config.enabled) return;
				if (claimBell(eventKey)) playNow(bell || null);
			}, delay);
		}
		/** 收到其它标签页广播的“响铃”消息。 */
		function onBellMessage(msg) {
			if (!msg || msg.type !== "bell" || !msg.eventKey) return;
			if (config.scope !== "all") return; // “仅当前会话”模式忽略跨会话提醒
			if (msg.source === tabId) return; // 忽略自己的广播
			maybePlay(msg.eventKey, { mode: msg.mode, text: msg.text, volume: msg.volume });
		}

		// ---------------------------------------------------------------
		// 检测：审批/提问卡片在 DOM 中的稳定标记
		//   data-approval-key    沙箱权限升级等审批（ApprovalPanel）
		//   data-question-key    提问/选择题（QuestionComposer）
		//   data-plan-review-key 计划审批（PlanReviewPanel）
		// ---------------------------------------------------------------
		const CARD_ATTRIBUTES = ["data-approval-key", "data-question-key", "data-plan-review-key"];
		const CARD_SELECTOR = "[data-approval-key], [data-question-key], [data-plan-review-key]";
		function keyOf(el) {
			for (const attr of CARD_ATTRIBUTES) {
				const value = el.getAttribute(attr);
				if (value) return value;
			}
			return null;
		}
		function scanNode(node) {
			if (!node || node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
			if (node.nodeType === 1 && node.matches && node.matches(CARD_SELECTOR)) {
				const key = keyOf(node);
				if (key) onCardDetected(key);
			}
			if (node.querySelectorAll) {
				const found = node.querySelectorAll(CARD_SELECTOR);
				for (const el of found) {
					const key = keyOf(el);
					if (key) onCardDetected(key);
				}
			}
		}
		/** 当前标签页的 DOM 检测到一张待处理卡片。 */
		function onCardDetected(key) {
			if (!config.enabled || config.mode === "off") return;
			if (config.scope === "current") {
				// 仅当前会话：只在本地响（原行为）
				if (alertedKeys.has(key)) return;
				alertedKeys.add(key);
				ensureAudioContext();
				playNow();
				return;
			}
			// 所有会话：广播给其它标签页 + 本地协调播放
			const eventKey = `${tabId}:${key}`;
			if (alertedKeys.has(eventKey)) return;
			broadcastBell({
				type: "bell",
				eventKey,
				source: tabId,
				mode: config.mode,
				text: config.text,
				volume: config.volume
			});
			writeLocalBell({
				type: "bell",
				eventKey,
				source: tabId,
				mode: config.mode,
				text: config.text,
				volume: config.volume
			});
			maybePlay(eventKey, null);
		}

		// ---------------------------------------------------------------
		// 设置面板行（设置 → 常规）
		// ---------------------------------------------------------------
		const NS = "approvalVoice";
		const zh = {
			"title": "审批语音提示",
			"desc": "需要你审批或回答时播放提示音 / 语音播报，避免漏看弹窗",
			"mode.label": "提醒方式",
			"mode.beep": "仅提示音",
			"mode.speech": "仅语音播报",
			"mode.both": "提示音 + 语音播报",
			"volume.label": "音量",
			"preview": "试听",
			"scope.label": "提醒范围",
			"scope.all": "所有会话",
			"scope.current": "仅当前会话",
			"sound.label": "提示音",
			"sound.choose": "选择音频文件",
			"sound.default": "恢复默认",
			"sound.set": "已自定义",
			"sound.toolarge": "提示音文件过大（>4MB），请选择更短音频。"
		};
		const en = {
			"title": "Approval voice alerts",
			"desc": "Play a chime / spoken notice when an approval or question is waiting for you",
			"mode.label": "Alert mode",
			"mode.beep": "Chime only",
			"mode.speech": "Speech only",
			"mode.both": "Chime + speech",
			"volume.label": "Volume",
			"preview": "Preview",
			"scope.label": "Alert scope",
			"scope.all": "All sessions",
			"scope.current": "Current session only",
			"sound.label": "Alert sound",
			"sound.choose": "Choose audio file",
			"sound.default": "Reset to default",
			"sound.set": "Custom",
			"sound.toolarge": "Sound file too large (>4MB). Pick a shorter clip."
		};

		const h = react.createElement;
		function ApprovalVoiceRow({ t }) {
			const [state, setState] = react.useState(config);
			react.useEffect(() => subscribeConfig((next) => setState(next)), []);
			const change = (patch) => setConfig(patch);
			const preview = () => playNow();
			const onPickSound = (event) => {
				const file = event.target.files && event.target.files[0];
				event.target.value = ""; // 允许再次选择同一个文件
				if (!file) return;
				if (file.size > 4000000) {
					try { window.alert(t("sound.toolarge")); } catch { /* ignore */ }
					return;
				}
				const reader = new FileReader();
				reader.onload = () => {
					if (typeof reader.result === "string") change({ sound: reader.result });
				};
				reader.onerror = () => { /* ignore */ };
				reader.readAsDataURL(file);
			};

			const rowStyle = {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "12px",
				padding: "14px 0 8px"
			};
			const textStyle = { minWidth: 0, flex: 1 };
			const titleStyle = { fontSize: "14px", fontWeight: 500, lineHeight: "20px", color: "var(--dsw-alias-label-primary, inherit)" };
			const descStyle = { fontSize: "12px", lineHeight: "18px", marginTop: "2px", color: "var(--dsw-alias-label-secondary, rgba(127,127,127,.8))" };
			const controlsStyle = { display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 };
			const switchStyle = {
				position: "relative",
				width: "36px",
				height: "20px",
				borderRadius: "999px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
				background: state.enabled ? "var(--dsw-alias-state-ok-primary, #34c759)" : "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))",
				cursor: "pointer",
				transition: "background .15s",
				padding: 0,
				flexShrink: 0
			};
			const knobStyle = {
				position: "absolute",
				top: "2px",
				left: "2px",
				width: "14px",
				height: "14px",
				borderRadius: "50%",
				background: "#fff",
				transition: "transform .15s",
				transform: state.enabled ? "translateX(16px)" : "translateX(0)"
			};
			const selectStyle = {
				background: "transparent",
				color: "inherit",
				border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
				borderRadius: "8px",
				padding: "4px 6px",
				fontSize: "12px",
				maxWidth: "140px"
			};
			const rangeStyle = { width: "84px", accentColor: "var(--dsw-alias-state-ok-primary, #34c759)" };
			const buttonStyle = {
				background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.15))",
				color: "inherit",
				border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
				borderRadius: "8px",
				padding: "4px 12px",
				fontSize: "12px",
				cursor: "pointer"
			};
			const secondRowStyle = {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "12px",
				flexWrap: "wrap",
				padding: "0 0 14px",
				borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.14))"
			};
			const groupStyle = { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 };
			const fieldLabelStyle = { fontSize: "12px", color: "var(--dsw-alias-label-secondary, rgba(127,127,127,.8))", flexShrink: 0 };
			const soundHintStyle = { fontSize: "12px", color: "var(--dsw-alias-label-secondary, rgba(127,127,127,.8))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "120px" };

			return h("div", { style: { width: "100%" } },
				h("div", { style: rowStyle },
					h("div", { style: textStyle },
						h("div", { style: titleStyle }, t("title")),
						h("div", { style: descStyle }, t("desc"))
					),
					h("div", { style: controlsStyle },
						h("button", {
							type: "button",
							role: "switch",
							"aria-checked": state.enabled,
							"aria-label": t("title"),
							style: switchStyle,
							onClick: () => change({ enabled: !state.enabled })
						}, h("span", { style: knobStyle })),
						h("select", {
							value: state.mode,
							disabled: !state.enabled,
							"aria-label": t("mode.label"),
							style: selectStyle,
							onChange: (event) => change({ mode: event.target.value })
						},
							h("option", { value: "both" }, t("mode.both")),
							h("option", { value: "beep" }, t("mode.beep")),
							h("option", { value: "speech" }, t("mode.speech"))
						),
						h("input", {
							type: "range",
							min: 0,
							max: 1,
							step: 0.05,
							value: state.volume,
							disabled: !state.enabled,
							"aria-label": t("volume.label"),
							style: rangeStyle,
							onChange: (event) => change({ volume: Number(event.target.value) })
						}),
						h("button", {
							type: "button",
							disabled: !state.enabled,
							style: buttonStyle,
							onClick: preview
						}, t("preview"))
					)
				),
				h("div", { style: secondRowStyle },
					h("div", { style: groupStyle },
						h("span", { style: fieldLabelStyle }, t("scope.label")),
						h("select", {
							value: state.scope,
							disabled: !state.enabled,
							"aria-label": t("scope.label"),
							style: selectStyle,
							onChange: (event) => change({ scope: event.target.value })
						},
							h("option", { value: "all" }, t("scope.all")),
							h("option", { value: "current" }, t("scope.current"))
						)
					),
					h("div", { style: groupStyle },
						h("span", { style: fieldLabelStyle }, t("sound.label")),
						state.sound
							? h("span", { style: soundHintStyle }, t("sound.set"))
							: null,
						h("label", { style: { ...buttonStyle, cursor: "pointer", display: "inline-flex", alignItems: "center" } },
							h("input", { type: "file", accept: "audio/*", style: { display: "none" }, disabled: !state.enabled, onChange: onPickSound }),
							t("sound.choose")
						),
						h("button", {
							type: "button",
							disabled: !state.enabled || !state.sound,
							style: buttonStyle,
							onClick: () => change({ sound: "" })
						}, t("sound.default"))
					)
				)
			);
		}

		// ---------------------------------------------------------------
		// 插件主体
		// ---------------------------------------------------------------
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "approval-voice: dictionaries");
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "approval-voice",
				order: 10,
				locale: NS
			}, ApprovalVoiceRow));
			ctx.effect(() => {
				primeAudio();
				const onGesture = () => primeAudio();
				window.addEventListener("pointerdown", onGesture, { capture: true, passive: true });
				window.addEventListener("keydown", onGesture, { capture: true, passive: true });
				window.addEventListener("touchstart", onGesture, { capture: true, passive: true });
				const observer = new MutationObserver((mutations) => {
					for (const mutation of mutations) {
						for (const node of mutation.addedNodes) scanNode(node);
					}
				});
				const start = () => {
					scanNode(document.documentElement);
					observer.observe(document.documentElement, { childList: true, subtree: true });
				};
				if (document.documentElement) start();
				else document.addEventListener("DOMContentLoaded", start);
				return () => {
					observer.disconnect();
					window.removeEventListener("pointerdown", onGesture, { capture: true });
					window.removeEventListener("keydown", onGesture, { capture: true });
					window.removeEventListener("touchstart", onGesture, { capture: true });
					document.removeEventListener("DOMContentLoaded", start);
				};
			}, "approval-voice: watcher");
			// 控制台调试接口：window.__approvalVoice.get() / set(...) / test() / tabId
			try {
				window.__approvalVoice = {
					get: () => ({ ...config }),
					set: (patch) => setConfig(patch),
					test: () => {
						ensureAudioContext();
						playNow();
						return true;
					},
					tabId
				};
			} catch { /* ignore */ }
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
