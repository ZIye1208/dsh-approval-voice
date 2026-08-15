window.__ModuleLoader__.load({
	id: "dsh-approval-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		// ---------------------------------------------------------------
		// 配置（持久化到 localStorage，与设置面板共享）
		// ---------------------------------------------------------------
		const STORAGE_KEY = "dsh.approvalVoice.v1";
		const DEFAULTS = Object.freeze({
			enabled: true, // 总开关
			mode: "both", // beep | speech | both | off
			volume: 0.6, // 0..1
			text: "有新的审批请求，请查看"
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
		// 声音：Web Audio 提示音 + SpeechSynthesis 语音播报
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
		/** 按当前配置触发一次提醒（每个请求 key 只提醒一次）。 */
		function alertOnce(key) {
			if (!config.enabled || config.mode === "off") return;
			if (alertedKeys.has(key)) return;
			alertedKeys.add(key);
			ensureAudioContext();
			const mode = config.mode;
			if (mode === "beep" || mode === "both") playChime(config.volume);
			if (mode === "speech" || mode === "both") speak(config.text);
		}
		const alertedKeys = new Set();

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
				if (key) alertOnce(key);
			}
			if (node.querySelectorAll) {
				const found = node.querySelectorAll(CARD_SELECTOR);
				for (const el of found) {
					const key = keyOf(el);
					if (key) alertOnce(key);
				}
			}
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
			"preview": "试听"
		};
		const en = {
			"title": "Approval voice alerts",
			"desc": "Play a chime / spoken notice when an approval or question is waiting for you",
			"mode.label": "Alert mode",
			"mode.beep": "Chime only",
			"mode.speech": "Speech only",
			"mode.both": "Chime + speech",
			"volume.label": "Volume",
			"preview": "Preview"
		};

		const h = react.createElement;
		function ApprovalVoiceRow({ t }) {
			const [state, setState] = react.useState(config);
			react.useEffect(() => subscribeConfig((next) => setState(next)), []);
			const change = (patch) => setConfig(patch);
			const preview = () => {
				const mode = state.mode;
				if (mode === "beep" || mode === "both") playChime(state.volume);
				if (mode === "speech" || mode === "both") speak(state.text);
			};
			const rowStyle = {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "12px",
				padding: "14px 0"
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
			return h("div", { style: rowStyle },
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
			// 控制台调试接口：window.__approvalVoice.get() / set(...) / test()
			try {
				window.__approvalVoice = {
					get: () => ({ ...config }),
					set: (patch) => setConfig(patch),
					test: () => {
						ensureAudioContext();
						const mode = config.mode;
						if (mode === "beep" || mode === "both") playChime(config.volume);
						if (mode === "speech" || mode === "both") return speak(config.text);
						return true;
					}
				};
			} catch { /* ignore */ }
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
