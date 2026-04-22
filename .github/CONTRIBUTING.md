# Contributing to MMM-HomeAssistantControl

Thanks for your interest in contributing!

## Before you start

- Check [existing issues](../../issues) and [open PRs](../../pulls) to avoid duplicates.
- For significant changes, open an issue first to discuss the approach before writing code.

## Development setup

1. Clone the repo into your MagicMirror `modules` directory:
   ```bash
   git clone https://github.com/awestley/MMM-HomeAssistantControl
   cd MMM-HomeAssistantControl
   npm install
   ```
2. Make your changes and test with a running MagicMirror² instance.

## Submitting a pull request

1. Fork the repo and create a branch from `main`:
   ```bash
   git checkout -b fix/short-description
   ```
2. Make focused, minimal commits. One logical change per PR is preferred.
3. Update `README.md` if you add or change config options or behaviour.
4. Open a PR against `main` and fill in the pull request template.

## Commit style

Use short, imperative subject lines (50 chars max), e.g.:

```
Fix brightness overlay not resetting on reload
Add excludeModuleNames support to exposeAllModules
```

## Reporting bugs

Please include:
- MagicMirror² version and Node.js version
- Relevant section of `config.js` (redact any secrets/tokens)
- Whether you use MQTT, HTTP, or both
- Log output from `config/mmm-homeassistant-control.log` if available

## Code style

- Follow the existing patterns in `MMM-HomeAssistantControl.js` and `node_helper.js`.
- No external runtime dependencies beyond what is already in `package.json` without discussion first.

## License

By contributing you agree that your changes will be released under the [MIT License](../LICENSE).
