# Contributing

## Adding a new script

1. Name the file `<site>_<feature>.user.js` (e.g. `reddit_collapse_automoderator.user.js`).
2. Start the file with a metadata block:

```js
// ==UserScript==
// @name         Human-readable name
// @namespace    https://github.com/perdrizat/userscripts
// @version      1.0
// @description  One sentence description
// @author       Markus Perdrizat
// @license      MIT
// @match        https://example.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==
```

Use `@grant none` unless you need a specific GM API (e.g. `GM_addStyle`, `GM_xmlhttpRequest`). List only what the script actually uses.

3. Add a row to the scripts table in `README.md`:

```md
| [Name](https://github.com/perdrizat/userscripts/raw/refs/heads/main/your_script.user.js) | site.com | One-line description. |
```

## Script guidelines

- **No personal infra in code.** Never hardcode private hostnames, IPs, or credentials. Store user config in Tampermonkey script storage (`GM_getValue`/`GM_setValue`): prompt on first use and register a `GM_registerMenuCommand` entry for changing it later. Stored settings survive script updates; constants in the code don't.
- **Docs live in the script header.** Setup or usage notes go as comments below the metadata block. The README table row stays a single sentence.

## Local testing

Load the script directly from your filesystem in Tampermonkey:

- Open the Tampermonkey dashboard → **Utilities** → **Install from file**, or
- Drag the `.user.js` file onto the Tampermonkey dashboard.

Changes to the local file are not picked up automatically; re-install after each edit.

## Build / Test / Deploy

These scripts have no build step. There is no automated test suite — test manually in the target browser before committing.
