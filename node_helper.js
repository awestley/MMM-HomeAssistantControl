/* MagicMirror² — MMM-HomeAssistantControl node helper
 * Optional HTTP + MQTT ingress; forwards JSON commands to the browser module.
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const NodeHelper = require("node_helper");

const JSON_CT = "application/json; charset=utf-8";
const LOG_TAG = "[MMM-HomeAssistantControl]";
const THEME_STORE = path.join(__dirname, "..", "..", "config", "mmm-hac-theme.json");

function normalizePersistedThemeMode(raw) {
	const m = String(raw || "")
		.toLowerCase()
		.trim();
	return ["auto", "light", "dark"].includes(m) ? m : null;
}

/** Same aliases as the browser module’s normalizeThemeMode (for HTTP/legacy JSON parity). */
function normalizeThemeModeForIngress(raw) {
	const s = String(raw || "")
		.toLowerCase()
		.trim();
	const aliases = {
		system: "auto",
		automatic: "auto",
		default: "auto",
		night: "dark",
		day: "light"
	};
	const mode = aliases[s] || s;
	return normalizePersistedThemeMode(mode);
}

function themeModeFromCommand(cmd) {
	if (!cmd || typeof cmd !== "object") {
		return null;
	}
	const action = String(cmd.action || "")
		.toLowerCase()
		.trim()
		.replace(/-/g, "_");
	const aliases = { settheme: "theme", set_theme: "theme" };
	const a = aliases[action] || action;
	if (a !== "theme") {
		return null;
	}
	const raw = cmd.mode !== undefined && cmd.mode !== null ? cmd.mode : cmd.value;
	if (raw === undefined || raw === null) {
		return null;
	}
	return normalizeThemeModeForIngress(raw);
}

function parseJsonBody(req, maxBytes) {
	return new Promise((resolve, reject) => {
		let buf = "";
		let len = 0;
		req.on("data", (chunk) => {
			len += chunk.length;
			if (len > maxBytes) {
				reject(new Error("payload too large"));
				req.destroy();
				return;
			}
			buf += chunk.toString("utf8");
		});
		req.on("end", () => {
			if (!buf) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(buf));
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

function sendJson(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, {
		"Content-Type": JSON_CT,
		"Content-Length": Buffer.byteLength(body)
	});
	res.end(body);
}

function authOk(req, token) {
	if (!token) {
		return true;
	}
	const h = req.headers.authorization;
	if (h && h.startsWith("Bearer ") && h.slice(7) === token) {
		return true;
	}
	return req.headers["x-mm-token"] === token;
}

function sanitizeObjectId(s) {
	const o = String(s || "module")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "");
	return o || "module";
}

function titleCaseButton(id) {
	return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeRegex(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let mqttDiscoveryOriginCache;
function getMqttDiscoveryOrigin() {
	if (!mqttDiscoveryOriginCache) {
		let sw = "";
		try {
			sw = require(path.join(__dirname, "package.json")).version || "";
		} catch (e) {
			sw = "";
		}
		mqttDiscoveryOriginCache = {
			name: "MMM-HomeAssistantControl",
			sw_version: sw || "0.0.0"
		};
	}
	return mqttDiscoveryOriginCache;
}

module.exports = NodeHelper.create({
	start() {
		this.httpServer = null;
		this.mqttClient = null;
		this.controlConfig = null;
		this.fileLogPath = null;
		this.lastControlFingerprint = null;
		this.lastControlAppliedAt = 0;
		this.moduleRegistry = [];
		this.moduleRegistryFingerprint = "";
		this.lastThemeState = "auto";
		const bootTheme = this.readPersistedTheme();
		if (bootTheme) {
			this.lastThemeState = bootTheme;
		}
		this.initFileLog({});
		if (this.fileLogPath) {
			this.log("info", LOG_TAG, "node_helper started (logging via MMM_HAC_LOG_FILE)");
		}
	},

	readPersistedTheme() {
		try {
			const raw = fs.readFileSync(THEME_STORE, "utf8");
			const o = JSON.parse(raw);
			return normalizePersistedThemeMode(o.mode);
		} catch (e) {
			return null;
		}
	},

	writePersistedTheme(mode) {
		const m = normalizePersistedThemeMode(mode) || "auto";
		try {
			fs.writeFileSync(THEME_STORE, `${JSON.stringify({ mode: m })}\n`, "utf8");
		} catch (e) {
			this.log("warn", LOG_TAG, "theme persist write failed:", e.message);
		}
	},

	initFileLog(control) {
		const fromEnv = process.env.MMM_HAC_LOG_FILE;
		let p = null;
		if (fromEnv && String(fromEnv).trim()) {
			p = path.resolve(String(fromEnv).trim());
		} else if (control && control.logFile === true) {
			p = path.join(__dirname, "..", "..", "config", "mmm-homeassistant-control.log");
		} else if (control && typeof control.logFile === "string" && control.logFile.trim()) {
			p = path.resolve(control.logFile.trim());
		}
		this.fileLogPath = p;
	},

	persistThemeFromIngress(mode) {
		const m = normalizePersistedThemeMode(mode) || "auto";
		this.lastThemeState = m;
		this.writePersistedTheme(m);
		if (this.activeMqttCfg) {
			this.publishThemeState(this.activeMqttCfg, m);
		}
	},

	forwardHaCommand(source, cmd) {
		if (!cmd || typeof cmd !== "object") {
			this.log("warn", LOG_TAG, "forwardHaCommand skipped (invalid cmd)", "source=" + source, String(cmd));
			return;
		}
		const themeFromCmd = themeModeFromCommand(cmd);
		if (themeFromCmd) {
			this.persistThemeFromIngress(themeFromCmd);
		}
		this.log(
			"info",
			LOG_TAG,
			"-> socket HA_COMMAND",
			"source=" + source,
			"action=" + (cmd.action != null ? cmd.action : ""),
			JSON.stringify(cmd)
		);
		this.sendSocketNotification("HA_COMMAND", cmd);
	},

	log(level, ...parts) {
		const msg = parts
			.map((a) => {
				if (a instanceof Error) {
					return a.message;
				}
				return typeof a === "object" ? JSON.stringify(a) : String(a);
			})
			.join(" ");
		const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
		const trimmed = line.trim();
		if (level === "error") {
			console.error(trimmed);
		} else if (level === "warn") {
			console.warn(trimmed);
		} else {
			console.log(trimmed);
		}
		if (this.fileLogPath) {
			try {
				fs.appendFileSync(this.fileLogPath, line);
			} catch (e) {
				console.error(LOG_TAG, "Cannot write log file:", this.fileLogPath, e.message);
				this.fileLogPath = null;
			}
		}
	},

	stop() {
		this.stopHttp();
		this.stopMqtt();
	},

	stopHttp() {
		if (this.httpServer) {
			this.httpServer.close();
			this.httpServer = null;
		}
	},

	stopMqtt() {
		if (this.mqttClient) {
			try {
				this.mqttClient.end(true);
			} catch (e) {
				// ignore
			}
			this.mqttClient = null;
		}
	},

	applyControlConfig(control) {
		const c = control || {};
		this.initFileLog(c);
		const fingerprint = JSON.stringify(c);
		const now = Date.now();
		if (
			fingerprint === this.lastControlFingerprint &&
			now - this.lastControlAppliedAt < 3000
		) {
			return;
		}
		this.lastControlFingerprint = fingerprint;
		this.lastControlAppliedAt = now;
		this.controlConfig = c;
		this.moduleRegistry = [];
		this.moduleRegistryFingerprint = "";
		this.log("info", LOG_TAG, "CONFIG applied; HTTP/MQTT will (re)start if enabled");
		this.stopHttp();
		this.stopMqtt();

		const httpCfg = this.controlConfig.http || {};
		if (httpCfg.enabled !== false && httpCfg.port > 0) {
			this.startHttp(httpCfg);
		}

		const mqttCfg = this.controlConfig.mqtt || {};
		if (mqttCfg.enabled && mqttCfg.url) {
			this.startMqtt(mqttCfg);
		}
	},

	startHttp(httpCfg) {
		const host = httpCfg.host || "127.0.0.1";
		const port = httpCfg.port;
		const token = httpCfg.token || "";
		const maxBody = Math.min(Math.max(httpCfg.maxBodyBytes || 4096, 256), 65536);

		this.httpServer = http.createServer(async (req, res) => {
			if (req.method === "OPTIONS") {
				res.writeHead(204, {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization, X-MM-Token"
				});
				res.end();
				return;
			}

			const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

			if (req.method === "GET" && url.pathname === "/api/health") {
				sendJson(res, 200, { ok: true, module: "MMM-HomeAssistantControl" });
				return;
			}

			if (req.method !== "POST" || url.pathname !== "/api/command") {
				sendJson(res, 404, { error: "not_found" });
				return;
			}

			if (!authOk(req, token)) {
				sendJson(res, 401, { error: "unauthorized" });
				return;
			}

			let body;
			try {
				body = await parseJsonBody(req, maxBody);
			} catch (e) {
				sendJson(res, 400, { error: "invalid_json", detail: String(e.message || e) });
				return;
			}

			this.forwardHaCommand("http:/api/command", body);
			sendJson(res, 200, { ok: true, received: body.action || null });
		});

		this.httpServer.on("error", (err) => {
			this.log("error", LOG_TAG, "HTTP server error:", err.message);
		});

		this.httpServer.listen(port, host, () => {
			this.log("info", LOG_TAG, `Control HTTP listening on http://${host}:${port}/api/command`);
		});
	},

	startMqtt(mqttCfg) {
		let mqtt;
		try {
			mqtt = require("mqtt");
		} catch (e) {
			this.log("error", LOG_TAG, "MQTT enabled but dependency missing. Run: npm install");
			return;
		}

		this.activeMqttCfg = mqttCfg;
		const prefix = mqttCfg.topicPrefix || "mmm_ha";
		const discoveryOn = mqttCfg.discovery !== false;

		const opts = {
			clientId: mqttCfg.clientId || "magicmirror-mmm-hac",
			username: mqttCfg.username || undefined,
			password: mqttCfg.password || undefined,
			reconnectPeriod: mqttCfg.reconnectPeriod ?? 5000
		};

		this.mqttClient = mqtt.connect(mqttCfg.url, opts);

		this.mqttClient.on("error", (err) => {
			this.log("error", LOG_TAG, "MQTT error:", err.message);
		});

		this.mqttClient.on("connect", () => {
			const subs = [];
			if (mqttCfg.topic) {
				subs.push(mqttCfg.topic);
			}
			if (discoveryOn) {
				subs.push(`${prefix}/number/brightness/set`);
				subs.push(`${prefix}/select/theme/set`);
				subs.push(`${prefix}/button/+/set`);
				subs.push(`${prefix}/switch/+/set`);
			}

			if (subs.length === 0) {
				this.log("warn", LOG_TAG, "MQTT: set topic and/or enable discovery (expose device in HA)");
				return;
			}

			this.mqttClient.subscribe(subs, (err) => {
				if (err) {
					this.log("error", LOG_TAG, "MQTT subscribe failed:", err.message);
					return;
				}
				this.log("info", LOG_TAG, "MQTT subscribed:", subs.join(", "));
				if (discoveryOn) {
					this.publishHaDiscovery(mqttCfg);
					this.publishBrightnessState(mqttCfg, 100);
					this.publishThemeState(mqttCfg, this.lastThemeState || "auto");
				}
			});
		});

		this.mqttClient.on("message", (topic, message) => {
			this.handleMqttMessage(mqttCfg, topic, message);
		});
	},

	publishBrightnessState(mqttCfg, value) {
		if (!this.mqttClient || !this.mqttClient.connected) {
			return;
		}
		const prefix = mqttCfg.topicPrefix || "mmm_ha";
		const v = Math.max(0, Math.min(100, Number(value)));
		this.mqttClient.publish(`${prefix}/number/brightness/state`, String(v), { qos: 0, retain: true }, (err) => {
			if (err) {
				this.log("error", LOG_TAG, "Brightness state publish failed:", err.message);
			}
		});
	},

	publishThemeState(mqttCfg, mode) {
		if (!this.mqttClient || !this.mqttClient.connected) {
			return;
		}
		const prefix = mqttCfg.topicPrefix || "mmm_ha";
		const m = String(mode || "auto").toLowerCase().trim();
		const ok = ["auto", "light", "dark"].includes(m);
		const payload = ok ? m : "auto";
		this.mqttClient.publish(`${prefix}/select/theme/state`, payload, { qos: 0, retain: true }, (err) => {
			if (err) {
				this.log("error", LOG_TAG, "Theme state publish failed:", err.message);
			}
		});
	},

	publishHaDiscovery(mqttCfg) {
		if (!this.mqttClient || mqttCfg.discovery === false) {
			return;
		}

		const disc = mqttCfg.discoveryPrefix || "homeassistant";
		const prefix = mqttCfg.topicPrefix || "mmm_ha";
		const devId = mqttCfg.deviceIdentifier || "magicmirror_mmm_ha";
		const devName = mqttCfg.deviceName || "MagicMirror";

		const device = {
			identifiers: [devId],
			name: devName,
			manufacturer: "MagicMirror",
			model: "MMM-HomeAssistantControl"
		};
		const origin = getMqttDiscoveryOrigin();

		const publishConfig = (component, objectId, payload) => {
			const t = `${disc}/${component}/${devId}_${objectId}/config`;
			const body = JSON.stringify({ ...payload, origin });
			this.mqttClient.publish(t, body, { retain: true, qos: 0 }, (err) => {
				if (err) {
					this.log("error", LOG_TAG, `Discovery publish failed (${t}):`, err.message);
				}
			});
		};

		publishConfig("number", "brightness", {
			name: "Brightness",
			command_topic: `${prefix}/number/brightness/set`,
			state_topic: `${prefix}/number/brightness/state`,
			min: 0,
			max: 100,
			step: 1,
			unit_of_measurement: "%",
			unique_id: `${devId}_brightness`,
			device
		});

		const themeDiscTopic = `${disc}/select/${devId}_theme/config`;
		publishConfig("select", "theme", {
			name: "Theme",
			command_topic: `${prefix}/select/theme/set`,
			state_topic: `${prefix}/select/theme/state`,
			options: ["auto", "light", "dark"],
			unique_id: `${devId}_select_theme`,
			device
		});
		this.log("info", LOG_TAG, "MQTT Theme discovery topic:", themeDiscTopic);

		["reload", "show_all", "hide_all"].forEach((bid) => {
			publishConfig("button", bid, {
				name: titleCaseButton(bid),
				command_topic: `${prefix}/button/${bid}/set`,
				payload_press: "PRESS",
				unique_id: `${devId}_btn_${bid}`,
				device
			});
		});

		const expose = Array.isArray(mqttCfg.exposeModules) ? mqttCfg.exposeModules : [];
		expose.forEach((row, i) => {
			const modName = row.module;
			if (!modName) {
				return;
			}
			const oid = sanitizeObjectId(row.objectId || row.module || `mod_${i}`);
			publishConfig("switch", oid, {
				name: row.name || modName,
				command_topic: `${prefix}/switch/${oid}/set`,
				payload_on: "ON",
				payload_off: "OFF",
				optimistic: true,
				unique_id: `${devId}_sw_${oid}`,
				device
			});
		});

		const reg = Array.isArray(this.moduleRegistry) ? this.moduleRegistry : [];
		reg.forEach((entry) => {
			if (!entry || !entry.identifier) {
				return;
			}
			const oid = sanitizeObjectId(entry.identifier);
			const swName = entry.haName || entry.name || oid;
			publishConfig("switch", oid, {
				name: swName,
				command_topic: `${prefix}/switch/${oid}/set`,
				payload_on: "ON",
				payload_off: "OFF",
				optimistic: true,
				unique_id: `${devId}_swreg_${oid}`,
				device
			});
		});

		this.log(
			"info",
			LOG_TAG,
			"Published Home Assistant MQTT discovery (device:",
			devName +
				`, prefix=${disc}, entities=brightness+theme+buttons+${expose.length + reg.length} switches)`
		);
	},

	handleMqttMessage(mqttCfg, topic, message) {
		const prefix = mqttCfg.topicPrefix || "mmm_ha";
		const msg = message.toString("utf8").trim();
		const payloadPreview = msg.length > 240 ? `${msg.slice(0, 240)}…` : msg;
		this.log("info", LOG_TAG, "MQTT rx", `topic=${topic}`, `len=${msg.length}`, `payload=${payloadPreview}`);

		if (mqttCfg.topic && topic === mqttCfg.topic) {
			let body;
			try {
				body = JSON.parse(msg);
			} catch (e) {
				this.log("error", LOG_TAG, "MQTT message is not valid JSON on legacy topic");
				return;
			}
			if (mqttCfg.token && body.token !== mqttCfg.token) {
				this.log("warn", LOG_TAG, "MQTT legacy topic rejected (token mismatch)");
				return;
			}
			if (mqttCfg.token && body.token) {
				delete body.token;
			}
			this.forwardHaCommand(`mqtt:${mqttCfg.topic}`, body);
			return;
		}

		if (mqttCfg.discovery === false) {
			this.log("warn", LOG_TAG, "MQTT rx ignored (discovery disabled)", `topic=${topic}`);
			return;
		}

		const brightSet = `${prefix}/number/brightness/set`;
		if (topic === brightSet) {
			const val = parseFloat(msg);
			if (Number.isNaN(val)) {
				this.log("warn", LOG_TAG, "MQTT brightness ignored (NaN)", `raw=${JSON.stringify(msg)}`);
				return;
			}
			this.forwardHaCommand(`mqtt:${brightSet}`, { action: "brightness", value: val });
			this.publishBrightnessState(mqttCfg, val);
			return;
		}

		const themeSet = `${prefix}/select/theme/set`;
		if (topic === themeSet) {
			const mode = msg.toLowerCase();
			if (!["auto", "light", "dark"].includes(mode)) {
				this.log("warn", LOG_TAG, "MQTT theme ignored (invalid)", `raw=${JSON.stringify(msg)}`);
				return;
			}
			this.forwardHaCommand(`mqtt:${themeSet}`, { action: "theme", mode });
			return;
		}

		const btnMatch = topic.match(new RegExp(`^${escapeRegex(prefix)}/button/([^/]+)/set$`));
		if (btnMatch) {
			const bid = btnMatch[1];
			const map = {
				reload: { action: "reload" },
				show_all: { action: "show_all" },
				hide_all: { action: "hide_all" }
			};
			const cmd = map[bid];
			if (cmd) {
				this.forwardHaCommand(`mqtt:button/${bid}`, cmd);
			} else {
				this.log("warn", LOG_TAG, "MQTT button topic not mapped", `buttonId=${bid}`, `topic=${topic}`);
			}
			return;
		}

		const swMatch = topic.match(new RegExp(`^${escapeRegex(prefix)}/switch/([^/]+)/set$`));
		if (swMatch) {
			const oid = swMatch[1];
			const on = msg === "ON" || msg === "on" || msg === "1" || msg === "true";
			const regEntry = (this.moduleRegistry || []).find(
				(e) => e && sanitizeObjectId(e.identifier) === oid
			);
			if (regEntry && regEntry.identifier) {
				this.forwardHaCommand(`mqtt:switch/reg/${oid}`, {
					action: on ? "show" : "hide",
					identifier: regEntry.identifier
				});
				return;
			}
			const expose = Array.isArray(mqttCfg.exposeModules) ? mqttCfg.exposeModules : [];
			const row = expose.find(
				(r) => sanitizeObjectId(r.objectId || r.module) === oid || sanitizeObjectId(r.module) === oid
			);
			if (!row || !row.module) {
				this.log("warn", LOG_TAG, "MQTT switch no registry/exposeModules match", `objectId=${oid}`);
				return;
			}
			this.forwardHaCommand(`mqtt:switch/${oid}`, {
				action: on ? "show" : "hide",
				module: row.module
			});
			return;
		}

		this.log("warn", LOG_TAG, "MQTT rx no handler", `topic=${topic}`);
	},

	socketNotificationReceived(notification, payload) {
		if (notification === "CONFIG") {
			this.applyControlConfig(payload.control);
			const fromFile = this.readPersistedTheme();
			const mode = fromFile || this.lastThemeState || "auto";
			this.lastThemeState = mode;
			this.sendSocketNotification("SAVED_THEME", { mode });
		}
		if (notification === "PUBLISH_BRIGHTNESS_STATE" && this.activeMqttCfg) {
			this.publishBrightnessState(this.activeMqttCfg, payload && payload.value);
		}
		if (notification === "PUBLISH_THEME_STATE") {
			const mode = payload && payload.mode;
			if (mode) {
				this.lastThemeState = mode;
				this.writePersistedTheme(mode);
			}
			if (this.activeMqttCfg) {
				this.publishThemeState(this.activeMqttCfg, mode || this.lastThemeState);
			}
		}
		if (notification === "HA_COMMAND_ACK") {
			this.log(
				"info",
				LOG_TAG,
				"HA_COMMAND_ACK (browser executed command)",
				JSON.stringify(payload || {})
			);
		}
		if (notification === "MODULE_REGISTRY") {
			const modules = payload && Array.isArray(payload.modules) ? payload.modules : [];
			const fp = JSON.stringify(modules);
			if (fp === this.moduleRegistryFingerprint) {
				return;
			}
			this.moduleRegistryFingerprint = fp;
			this.moduleRegistry = modules;
			this.log("info", LOG_TAG, "MODULE_REGISTRY updated", `count=${modules.length}`);
			if (
				this.mqttClient &&
				this.mqttClient.connected &&
				this.activeMqttCfg &&
				this.activeMqttCfg.discovery !== false
			) {
				this.publishHaDiscovery(this.activeMqttCfg);
			}
		}
	}
});
