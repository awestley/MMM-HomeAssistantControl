/* global MM, Log, Module */

Module.register("MMM-HomeAssistantControl", {
	defaults: {
		animationSpeed: 500,
		logFile: true,
		traceCommands: true,
		clientLabel: "",
		http: {
			enabled: true,
			host: "127.0.0.1",
			port: 8787,
			token: "",
			maxBodyBytes: 4096
		},
		mqtt: {
			enabled: false,
			url: "",
			username: "",
			password: "",
			topic: "magicmirror/cmd",
			clientId: "magicmirror-mmm-hac",
			token: "",
			reconnectPeriod: 5000,
			topicPrefix: "mmm_ha",
			discovery: true,
			discoveryPrefix: "homeassistant",
			deviceName: "MagicMirror",
			deviceIdentifier: "magicmirror_mmm_ha",
			exposeModules: [],
			exposeAllModules: false,
			excludeModuleNames: []
		}
	},

	start() {
		const initialTheme = this.loadThemePreference();
		if (initialTheme) {
			this.applyTheme(initialTheme);
		}

		const control = {
			logFile: this.config.logFile,
			traceCommands: this.config.traceCommands,
			clientLabel: this.config.clientLabel,
			http: this.config.http,
			mqtt: this.config.mqtt
		};
		setTimeout(() => {
			this.sendSocketNotification("CONFIG", { control });
		}, 0);
	},

	getDom() {
		const wrapper = document.createElement("div");
		wrapper.className = "mmm-hac";
		wrapper.style.cssText = "display:none;width:0;height:0;overflow:hidden;";
		return wrapper;
	},

	notificationReceived(notification, payload, sender) {
		if (notification === "ALL_MODULES_STARTED" || notification === "DOM_OBJECTS_CREATED") {
			const mqtt = this.config.mqtt;
			if (mqtt && mqtt.exposeAllModules) {
				if (this.moduleRegistryDebounceTimer) {
					clearTimeout(this.moduleRegistryDebounceTimer);
				}
				this.moduleRegistryDebounceTimer = setTimeout(() => {
					this.moduleRegistryDebounceTimer = null;
					this.pushModuleRegistry();
				}, 400);
			}
		}
	},

	pushModuleRegistry() {
		const mqtt = this.config.mqtt;
		if (!mqtt || !mqtt.exposeAllModules) {
			return;
		}
		const exclude = new Set(
			Array.isArray(mqtt.excludeModuleNames) ? mqtt.excludeModuleNames.map(String) : []
		);
		const selfId = this.identifier;
		const modules = [];
		const list = MM.getModules();
		for (let i = 0; i < list.length; i++) {
			const m = list[i];
			if (!m || m.identifier === selfId) {
				continue;
			}
			if (exclude.has(m.name)) {
				continue;
			}
			const pos = (m.data && m.data.position) || "";
			const header = (m.data && m.data.header) || "";
			const label = header ? `${m.name} (${header})` : m.name;
			modules.push({
				identifier: m.identifier,
				name: m.name,
				position: pos,
				haName: pos ? `${label} · ${pos}` : label
			});
		}
		this.haTrace("pushModuleRegistry", `count=${modules.length}`);
		this.sendSocketNotification("MODULE_REGISTRY", { modules });
	},

	haTrace(...args) {
		if (this.config.traceCommands === false) {
			return;
		}
		Log.log("[MMM-HomeAssistantControl]", ...args);
	},

	ackCommand(action) {
		const label =
			this.config.clientLabel ||
			(typeof location !== "undefined" ? location.href.replace(/\?.*$/, "") : "");
		const ua =
			typeof navigator !== "undefined" && navigator.userAgent
				? navigator.userAgent.slice(0, 120)
				: "";
		this.sendSocketNotification("HA_COMMAND_ACK", {
			action,
			clientLabel: label,
			userAgent: ua
		});
	},

	socketNotificationReceived(notification, payload) {
		if (notification === "SAVED_THEME") {
			const mode = this.normalizeThemeMode(payload && payload.mode) || "auto";
			this.applyTheme(mode);
		}
		if (notification === "HA_COMMAND") {
			this.haTrace(
				"socket HA_COMMAND received",
				"payloadType=" + typeof payload,
				typeof payload === "string" ? `stringLen=${payload.length}` : ""
			);
			let cmd = payload;
			if (typeof cmd === "string") {
				try {
					cmd = JSON.parse(cmd);
				} catch (e) {
					Log.error("[MMM-HomeAssistantControl] HA_COMMAND is not valid JSON", e);
					return;
				}
				this.haTrace("socket HA_COMMAND parsed from string", "action=" + (cmd && cmd.action));
			}
			this.runCommand(cmd);
		}
	},

	forEachOtherModule(fn) {
		const selfId = this.identifier;
		const list = MM.getModules();
		for (let i = 0; i < list.length; i++) {
			const m = list[i];
			if (m.identifier !== selfId) {
				fn(m);
			}
		}
	},

	normalizeAction(raw) {
		const a = String(raw || "")
			.toLowerCase()
			.trim()
			.replace(/-/g, "_");
		const aliases = {
			hideall: "hide_all",
			showall: "show_all",
			sendnotification: "send_notification",
			setbrightness: "brightness",
			settheme: "theme"
		};
		return aliases[a] || a;
	},

	normalizeThemeMode(raw) {
		const mode = String(raw || "")
			.toLowerCase()
			.trim();
		const aliases = {
			system: "auto",
			automatic: "auto",
			default: "auto",
			night: "dark",
			day: "light"
		};
		const normalized = aliases[mode] || mode;
		return ["auto", "light", "dark"].includes(normalized) ? normalized : "";
	},

	getThemeStorageKey() {
		return "mmm-hac-theme-mode";
	},

	loadThemePreference() {
		if (typeof localStorage !== "undefined") {
			try {
				let stored = localStorage.getItem(this.getThemeStorageKey());
				if (!stored) {
					stored = localStorage.getItem("mmm-ha-theme-mode");
				}
				const normalized = this.normalizeThemeMode(stored);
				if (normalized) {
					return normalized;
				}
			} catch (e) {
				Log.warn("[MMM-HomeAssistantControl] unable to read saved theme", e);
			}
		}
		return "";
	},

	saveThemePreference(mode) {
		if (typeof localStorage === "undefined") {
			return;
		}
		try {
			localStorage.setItem(this.getThemeStorageKey(), mode);
		} catch (e) {
			Log.warn("[MMM-HomeAssistantControl] unable to save theme", e);
		}
	},

	applyTheme(rawMode) {
		const mode = this.normalizeThemeMode(rawMode);
		if (!mode) {
			Log.warn("[MMM-HomeAssistantControl] theme requires one of: auto, light, dark");
			return "";
		}
		if (typeof document === "undefined" || !document.documentElement) {
			return "";
		}
		const root = document.documentElement;
		if (mode === "auto") {
			root.removeAttribute("data-theme");
		} else {
			root.setAttribute("data-theme", mode);
		}
		this.saveThemePreference(mode);
		this.haTrace("theme applied", `mode=${mode}`);
		this.syncThemeStateToHa(mode);
		return mode;
	},

	syncThemeStateToHa(mode) {
		const m = this.normalizeThemeMode(mode) || "auto";
		this.sendSocketNotification("PUBLISH_THEME_STATE", { mode: m });
	},

	ensureBrightnessOverlay() {
		let el = document.getElementById("mmm-hac-brightness");
		if (!el) {
			el = document.createElement("div");
			el.id = "mmm-hac-brightness";
			el.style.cssText =
				"position:fixed;inset:0;background:#000;pointer-events:none;z-index:2147483646;opacity:0;transition:opacity 0.3s ease";
			document.body.appendChild(el);
		}
		return el;
	},

	setBrightness(percent) {
		const el = this.ensureBrightnessOverlay();
		const p = Math.max(0, Math.min(100, Number(percent)));
		el.style.opacity = String((100 - p) / 100);
	},

	resolveTargets(spec) {
		const all = MM.getModules();
		const self = this;
		if (spec.identifier) {
			const mod = all.find((m) => m.identifier === spec.identifier);
			return mod ? [mod] : [];
		}
		if (typeof spec.index === "number" && spec.module) {
			const matches = all.filter((m) => m.name === spec.module);
			const mod = matches[spec.index];
			return mod ? [mod] : [];
		}
		let list = all.filter((m) => m !== self);
		if (spec.module) {
			list = list.filter((m) => m.name === spec.module);
		}
		if (spec.position) {
			list = list.filter((m) => m.data.position === spec.position);
		}
		return list;
	},

	runCommand(cmd) {
		if (!cmd || typeof cmd !== "object") {
			this.haTrace("runCommand ignored (not a non-null object)", "typeof=" + typeof cmd, cmd);
			return;
		}
		const action = this.normalizeAction(cmd.action);
		const speed = typeof cmd.speed === "number" ? cmd.speed : this.config.animationSpeed;
		const list = MM.getModules();
		this.haTrace(
			"runCommand",
			`rawAction=${cmd.action}`,
			`normalized=${action}`,
			`speed=${speed}`,
			`self.identifier=${this.identifier}`,
			`self.name=${this.name}`,
			`MM.getModules().length=${list.length}`
		);

		switch (action) {
			case "brightness": {
				const v = cmd.value;
				if (v === undefined || v === null) {
					Log.warn("[MMM-HomeAssistantControl] brightness requires value (0–100)");
					return;
				}
				this.setBrightness(v);
				this.haTrace("brightness applied", `value=${v}`);
				this.sendSocketNotification("PUBLISH_BRIGHTNESS_STATE", {
					value: Math.max(0, Math.min(100, Number(v)))
				});
				this.ackCommand("brightness");
				break;
			}
			case "theme": {
				const mode = cmd.mode !== undefined ? cmd.mode : cmd.value;
				const applied = this.applyTheme(mode);
				if (!applied) {
					return;
				}
				this.ackCommand("theme");
				break;
			}
			case "hide": {
				const targets = this.resolveTargets(cmd);
				this.haTrace(
					"hide",
					cmd.identifier ? `identifier=${cmd.identifier}` : "",
					`targets=${targets.length}`,
					this.summarizeModules(targets)
				);
				targets.forEach((m) => {
					MM.hideModule(m, speed, () => {}, {});
				});
				this.ackCommand("hide");
				break;
			}
			case "show": {
				const targets = this.resolveTargets(cmd);
				this.haTrace(
					"show",
					cmd.identifier ? `identifier=${cmd.identifier}` : "",
					`targets=${targets.length}`,
					this.summarizeModules(targets)
				);
				targets.forEach((m) => {
					MM.showModule(m, speed, () => {}, { force: true });
				});
				this.ackCommand("show");
				break;
			}
			case "toggle": {
				const targets = this.resolveTargets(cmd);
				this.haTrace("toggle", `targets=${targets.length}`, this.summarizeModules(targets));
				targets.forEach((m) => {
					if (m.hidden) {
						MM.showModule(m, speed, () => {}, { force: true });
					} else {
						MM.hideModule(m, speed, () => {}, {});
					}
				});
				this.ackCommand("toggle");
				break;
			}
			case "hide_all": {
				const others = this.listOtherModules();
				this.haTrace("hide_all", `otherCount=${others.length}`, JSON.stringify(others));
				this.forEachOtherModule((m) => {
					const el = document.getElementById(m.identifier);
					this.haTrace("hide_all → hideModule", m.identifier, m.name, `dom=${el ? "yes" : "no"}`);
					MM.hideModule(m, speed, () => {}, {});
				});
				this.ackCommand("hide_all");
				break;
			}
			case "show_all": {
				const others = this.listOtherModules();
				this.haTrace("show_all", `otherCount=${others.length}`, JSON.stringify(others));
				this.forEachOtherModule((m) => {
					const el = document.getElementById(m.identifier);
					this.haTrace("show_all → showModule", m.identifier, m.name, `hidden=${m.hidden}`, `dom=${el ? "yes" : "no"}`);
					MM.showModule(m, speed, () => {}, { force: true });
				});
				this.ackCommand("show_all");
				break;
			}
			case "send_notification":
			case "notify": {
				const n = cmd.notification;
				if (!n || typeof n !== "string") {
					Log.warn("[MMM-HomeAssistantControl] send_notification requires notification string");
					return;
				}
				this.haTrace("send_notification", n);
				this.sendNotification(n, cmd.payload !== undefined ? cmd.payload : {});
				this.ackCommand("send_notification");
				break;
			}
			case "reload": {
				this.haTrace("reload requested");
				this.ackCommand("reload");
				window.location.reload();
				break;
			}
			default:
				Log.warn(`[MMM-HomeAssistantControl] unknown action: ${cmd.action}`);
		}
	},

	listOtherModules() {
		const selfId = this.identifier;
		const out = [];
		const list = MM.getModules();
		for (let i = 0; i < list.length; i++) {
			const m = list[i];
			if (m.identifier !== selfId) {
				const el = document.getElementById(m.identifier);
				out.push({
					name: m.name,
					identifier: m.identifier,
					position: m.data && m.data.position,
					hidden: !!m.hidden,
					dom: el ? "yes" : "no"
				});
			}
		}
		return out;
	},

	summarizeModules(mods) {
		return JSON.stringify(
			mods.map((m) => ({
				name: m.name,
				identifier: m.identifier,
				hidden: !!m.hidden,
				dom: document.getElementById(m.identifier) ? "yes" : "no"
			}))
		);
	}
});
