# MMM-HomeAssistantControl

**MMM-HomeAssistantControl** is a [MagicMirror²](https://magicmirror.builders/) module that lets you drive the mirror from [Home Assistant](https://www.home-assistant.io/) over **MQTT** (with automatic MQTT discovery) and optionally over a small **HTTP** API. It does **not** fetch or display Home Assistant entity states on the mirror; it only handles **remote control** (theme, dimming, showing/hiding modules, reload, and notifications).

Typical uses:

- Expose a **MagicMirror** device in Home Assistant with controls for brightness, light/dark/auto theme, reload, and hide/show all.
- Add **per-module switches** so automations or the UI can toggle individual mirror modules.
- Call the same commands from **Node-RED**, **AppDaemon**, or any client that can publish MQTT or POST JSON.

---

## Features

- **MQTT** — Connects to your broker, subscribes to a legacy JSON command topic (optional), and discovery command topics under a configurable prefix.
- **Home Assistant MQTT discovery** — Publishes entities for brightness (number), theme (select: auto / light / dark), buttons (reload, show all, hide all), and optional per-module switches.
- **HTTP API** — `GET /api/health` and `POST /api/command` with optional bearer or header token.
- **Theme persistence** — Saves the selected theme to `config/mmm-hac-theme.json` on the server so it survives reboots and weak or cleared browser storage; syncs with Home Assistant state over MQTT.
- **Brightness overlay** — Dims the whole UI with a fullscreen overlay (not hardware backlight).
- **Tracing** — Optional verbose logging of incoming commands and browser acknowledgements (useful when multiple displays hit the same mirror URL).

The module’s **DOM is hidden**; it only needs a `position` entry in `config.js` to satisfy MagicMirror. All behavior runs through the node helper and browser command handler.

---

## Requirements

- MagicMirror² (Node.js runtime as required by your MM version).
- Network reachability from the MagicMirror host to your **MQTT broker** (if MQTT is enabled).
- For Home Assistant discovery: broker permission for MagicMirror to **publish** to the discovery prefix (default `homeassistant/`).
- Optional: `curl`, `rest_command`, or another HTTP client if you use the HTTP API from another machine (set `http.host` / firewall accordingly).

---

## Installation

1. Copy this folder into your MagicMirror `modules` directory:

   ```text
   MagicMirror/modules/MMM-HomeAssistantControl/
   ```

2. Install dependencies:

   ```bash
   cd modules/MMM-HomeAssistantControl
   npm install
   ```

3. Add the module to `config/config.js` (see [Configuration](#configuration)).

4. Restart MagicMirror.

---

## Configuration

Add an entry similar to:

```javascript
{
  module: "MMM-HomeAssistantControl",
  position: "top_left",
  config: {
    animationSpeed: 500,
    logFile: true,
    traceCommands: true,
    clientLabel: "",
    http: { /* see table */ },
    mqtt: { /* see table */ }
  }
}
```

### Top-level options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `animationSpeed` | number | `500` | Hide/show animation duration in milliseconds when not overridden per command. |
| `logFile` | boolean \| string | `true` | `true`: append to `config/mmm-homeassistant-control.log`. String: absolute path to a log file. `false`: file logging off (console only). |
| `traceCommands` | boolean | `true` | When `true`, logs command handling in the browser console (`Log.log`). |
| `clientLabel` | string | `""` | Optional label included in command ACK messages (defaults to current page URL without query string). |

### `http`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | When `false`, the HTTP server is not started. |
| `host` | string | `127.0.0.1` | Bind address. Use `0.0.0.0` only if you need LAN access and understand the risk. |
| `port` | number | `8787` | Listening port. |
| `token` | string | `""` | If set, clients must send `Authorization: Bearer <token>` or `X-MM-Token: <token>`. |
| `maxBodyBytes` | number | `4096` | Maximum JSON body size for `POST /api/command`. |

### `mqtt`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable MQTT client. |
| `url` | string | `""` | Broker URL, e.g. `mqtt://192.168.1.10:1883`. |
| `username` / `password` | string | `""` | Broker credentials if required. |
| `topic` | string | `magicmirror/cmd` | Legacy topic: payload must be JSON with an `action` field (and optional `token` if `mqtt.token` is set). |
| `token` | string | `""` | Shared secret; if set, JSON on `topic` must include `"token": "<same value>"` (stripped before the command runs). |
| `clientId` | string | `magicmirror-mmm-hac` | MQTT client id. |
| `reconnectPeriod` | number | `5000` | Reconnect interval in ms. |
| `topicPrefix` | string | `mmm_ha` | Prefix for discovery command/state topics (`<prefix>/number/brightness/set`, etc.). |
| `discovery` | boolean | `true` | Publish Home Assistant MQTT discovery and subscribe to discovery command topics. |
| `discoveryPrefix` | string | `homeassistant` | Must match your Home Assistant MQTT discovery prefix. |
| `deviceName` | string | `MagicMirror` | Friendly device name in Home Assistant. |
| `deviceIdentifier` | string | `magicmirror_mmm_ha` | Stable id used in discovery topics and `unique_id`; change if you run multiple mirrors on one broker. |
| `exposeModules` | array | `[]` | Manual list of `{ module, name?, objectId? }` for extra MQTT switches. |
| `exposeAllModules` | boolean | `false` | When `true`, publishes a switch per loaded MagicMirror module (except this one), using live registry updates. |
| `excludeModuleNames` | array | `[]` | Module **names** to omit when `exposeAllModules` is true (e.g. `["alert"]`). |

### Environment

| Variable | Effect |
|----------|--------|
| `MMM_HAC_LOG_FILE` | Absolute path to the log file; overrides default path when `logFile` is `true`. |

### Files created at runtime

| Path | Purpose |
|------|---------|
| `config/mmm-homeassistant-control.log` | Optional append log (when enabled). |
| `config/mmm-hac-theme.json` | Persisted theme: `{"mode":"auto"\|"light"\|"dark"}`. Safe to delete to reset. |

These paths are next to your MagicMirror `config` folder. You may want to exclude them from version control.

---

## How it works

1. The **node helper** opens MQTT and/or HTTP, normalizes ingress into JSON commands, and sends them to the browser as `HA_COMMAND`.
2. The **browser module** runs the command (theme, brightness, `MM.hideModule` / `MM.showModule`, etc.) and may send `PUBLISH_THEME_STATE`, `PUBLISH_BRIGHTNESS_STATE`, or `HA_COMMAND_ACK` back to the helper.
3. The helper **republishes retained MQTT state** where needed so Home Assistant stays in sync.

Commands are executed **per connected browser** (each tab or kiosk has its own Socket.IO client). If you use one mirror URL on a TV and a laptop, both may receive broadcasts; ACK lines in the log show which clients ran a command.

---

## Home Assistant

### MQTT discovery

With `discovery: true`, entities appear under your MQTT device (name from `deviceName`). Typical entities:

- **Brightness** — number 0–100.
- **Theme** — select `auto`, `light`, `dark`.
- **Reload**, **Show all**, **Hide all** — buttons.
- **Switches** — one per module when `exposeAllModules` or `exposeModules` is configured.

Ensure your broker ACL allows the mirror user to **publish** to `homeassistant/#` (or your custom discovery prefix). After changing `deviceIdentifier` or discovery layout, restart MagicMirror or reload MQTT in Home Assistant so entities update.

### Legacy MQTT JSON topic

Publish JSON to `topic` (default `magicmirror/cmd`), for example:

```json
{"action":"theme","mode":"light"}
```

If `mqtt.token` is set, include `"token":"your-secret"` in the object.

### REST / `rest_command` (HTTP)

Example `configuration.yaml` snippet:

```yaml
rest_command:
  magicmirror_theme_dark:
    url: "http://127.0.0.1:8787/api/command"
    method: POST
    headers:
      Content-Type: application/json
      X-MM-Token: "your-long-random-token"
    payload: '{"action":"theme","mode":"dark"}'
```

Use the machine that actually runs MagicMirror, or set `http.host` to `0.0.0.0` and point the URL at the mirror host (with token strongly recommended).

---

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Returns JSON `{ ok: true, module: "MMM-HomeAssistantControl" }`. |
| `POST` | `/api/command` | Body: JSON object with `action` and fields as in the [command reference](#command-reference). |

CORS preflight (`OPTIONS`) is answered for simple browser-based tools.

---

## Command reference

All of these work over **HTTP POST** and **MQTT JSON** (`topic`). Discovery topics map to the same actions internally.

| `action` | Fields | Description |
|----------|--------|-------------|
| `brightness` | `value` (0–100) | UI dimming via fullscreen overlay; 100 is fully bright. |
| `theme` | `mode` or `value` | `auto`, `light`, or `dark`. Sets `data-theme` on `document.documentElement` and persists to disk + MQTT state. |
| `hide` | `module` and/or `position`, or `identifier`, optional `index` | Hide matching module instances. |
| `show` | same | Show matches (`force: true` in MagicMirror API). |
| `toggle` | same | Toggle visibility. |
| `hide_all` | optional `speed` | Hide every module except this control module. |
| `show_all` | optional `speed` | Show all other modules. |
| `send_notification` / `notify` | `notification` (string), optional `payload` | Calls `sendNotification` to all modules. |
| `reload` | — | Full page reload. |

Aliases accepted on the wire include `setbrightness` → `brightness`, `settheme` → `theme`, `hideall` → `hide_all`, etc. (see source `normalizeAction`).

---

## Theme persistence

Theme is stored in:

- **`config/mmm-hac-theme.json`** (authoritative across reboots).
- Browser **`localStorage`** key `mmm-hac-theme-mode` (fast path; may be cleared per profile or URL).

On startup the helper loads the JSON file so MQTT retained theme matches before the UI connects. The browser receives `SAVED_THEME` after configuration is applied and applies the saved mode. A legacy read of `mmm-ha-theme-mode` is still performed once when reading preferences, for migration from older setups.

---

## Troubleshooting

- **No entities in Home Assistant** — Confirm MQTT discovery is enabled in HA, the discovery prefix matches `discoveryPrefix`, and the broker allows publishing under that prefix. Listen with `homeassistant/#` and look for topics ending in `.../config` for your `deviceIdentifier`.
- **Commands only affect one screen** — Each browser session is independent; check logs for `HA_COMMAND_ACK` to see which client ran the command.
- **HTTP 401** — Set `token` in config and send the same value in headers.
- **Theme wrong after boot** — Ensure the MagicMirror process can write `config/mmm-hac-theme.json` (permissions, read-only filesystem).

---

## License

MIT — see `package.json`.

---

## Contributing

Issues and pull requests are welcome. When reporting bugs, include MagicMirror version, Node version, relevant `config` (redact secrets), and whether you use MQTT, HTTP, or both.
