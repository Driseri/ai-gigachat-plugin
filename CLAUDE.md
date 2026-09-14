# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Super Productivity desktop plugin (manifest v1) that provides an AI chat panel for task management via GigaChat API. Single-file architecture — all CSS, HTML, and JS live inline in `index.html`. No build system or runtime dependencies.

## File map

| File | Role |
|------|------|
| `manifest.json` | Plugin metadata, Super Productivity API permissions, hooks |
| `plugin.js` | Host-side bridge for local-only secret storage |
| `index.html` | The entire plugin: CSS, settings modal, chat UI, tool definitions, AI loop, markdown renderer |
| `icon.svg` | Plugin icon |

## Key architecture (index.html)

**Runtime environment:** The Super Productivity host injects `PluginAPI` globally. All data operations go through it — there are no direct DB or filesystem calls.

**Data flow:**
1. `sendMessage()` appends user message + `buildContext()` snapshot to `messages[]`
2. `getAccessToken()` obtains/caches a PERS OAuth token through `executeNodeScript()`; settings load `GET /v1/models` and validate new keys before saving; `callGigaChat()` sends the conversation and `functions` to the model
3. If the model returns `function_call`, `executeTool()` dispatches to matching `PluginAPI` calls; assistant state and function results are appended and the loop continues (max 10 calls)
4. Final text response rendered via custom `renderMarkdown()` and displayed

**Persistence:** Non-secret config and conversations (last 50 messages) use `PluginAPI.loadSyncedData()` / `PluginAPI.persistDataSynced()`. The Authorization Key uses local-only `setSecret` / `getSecret` through a host-side bridge in `plugin.js` (the iframe API does not expose secret methods). Access tokens live in memory. Version 2 clears old OpenAI config and conversations once.

**Tool definitions** (`var tools = [...]`): task, project, tag, app-context, and notification tools. Their `function` payloads are passed to GigaChat's function-calling API.

**Markdown rendering:** Custom regex-based renderer in `renderMarkdown()` — not a library. Handles headers, bold/italic, links, blockquotes, tables, code blocks, ordered/unordered lists. Code blocks/content are HTML-escaped.

**Transport:** The iframe calls `PluginAPI.executeNodeScript()` on desktop because the GigaChat OAuth endpoint does not accept browser CORS preflight. Node scripts are static and receive credentials and content via `args`; HTTPS requests combine Node default and OS trusted CAs to handle local HTTPS inspection without disabling certificate checks. OAuth retries the documented `ngw.devices.sberbank.ru:9443` endpoint only when `api.giga.chat` returns an HTML 403 gateway page. Failures surface sanitized underlying errors. Web UI shows a desktop-only notice. The manifest requests `nodeExecution` and requires Super Productivity 18.13.1+.

## CI/CD

Push to `master` triggers `.github/workflows/release.yml`: runs Node integration tests, reads version from `manifest.json`, and creates a GitHub Release with a zipped plugin package (manifest + index.html + plugin.js + icon.svg + README). No-op if the version tag already exists.

**Release flow:** bump `version` in `manifest.json` → commit → push to master. CI handles the rest.

## Build / Package

```bash
python3 -c "
import zipfile
with zipfile.ZipFile('gigachat-assistant-plugin.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    for f in ['manifest.json', 'plugin.js', 'index.html', 'icon.svg']:
        zf.write(f, f)
"
```

## Version history convention

Commit messages follow the pattern `vX.Y.Z: short description`. Tags are `vX.Y.Z`.
