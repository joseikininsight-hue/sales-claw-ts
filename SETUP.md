# Sales Claw — Setup Guide

> Japanese version: [docs/ja/SETUP.md](./docs/ja/SETUP.md)

This guide walks you from "downloaded the installer" to "first message
awaiting human approval" in about 15 minutes. It covers all three supported
platforms (Windows / macOS / Linux) and all three supported AI CLIs
(Claude Code / Codex / Gemini).

If you are already familiar with Node.js and just want a one-liner, jump to
[Section 5: First Outreach](#5-first-outreach-5-minutes).

---

## Table of contents

1. [System Requirements](#1-system-requirements)
2. [Installation](#2-installation)
3. [First Launch](#3-first-launch)
4. [AI Provider Setup](#4-ai-provider-setup)
5. [First Outreach (5 minutes)](#5-first-outreach-5-minutes)
6. [Bilingual Setup (v2.0.37+)](#6-bilingual-setup-v2037)
7. [Auto-Update](#7-auto-update)
8. [Update from older versions](#8-update-from-older-versions)
9. [Uninstall](#9-uninstall)

---

## 1. System Requirements

### Operating system

| OS | Status | Installer | Notes |
|----|--------|-----------|-------|
| **Windows 10 (1809+) / Windows 11** | Primary | NSIS `.exe` | Per-user install (no admin required) |
| **macOS 11 (Big Sur) and newer** | Supported | `.dmg` (arm64 & x64) | Apple Silicon recommended |
| **Linux (x86_64, glibc 2.31+)** | Supported | `.AppImage` | Tested on Ubuntu 22.04 / Fedora 38 |

> Windows on ARM, 32-bit Linux, and older macOS (≤ 10.15 Catalina) are not
> tested. Ubuntu 20.04 works in practice but is not officially supported.

### Runtime

| Component | Required for | Minimum version |
|-----------|--------------|-----------------|
| **Node.js** | Building from source only (the installer bundles its own runtime) | 20.0.0 |
| **Claude Code CLI** | Default AI driver | 2.0.0 |
| **Codex CLI** | Alternate AI driver | 0.128.0 (gpt-5.5 support) |
| **Gemini CLI** | Alternate AI driver | 0.5.0 |
| **Git** | Source builds + `npm run preflight` | 2.30+ |

You only need **one** of the three CLIs, not all three. Claude Code is the
default and the most thoroughly tested.

### Browser

The Electron build ships with Chromium, so no separate browser install is
required for form filling. MCP Playwright will additionally download a
headless Chromium on first run (~150 MB).

### Disk and memory

| Resource | Recommended |
|----------|-------------|
| Disk (app) | ~500 MB |
| Disk (runtime data + screenshots) | ~1 GB (grows with usage) |
| RAM | 4 GB minimum, 8 GB recommended |

> Heavy List Builder runs (1,000+ candidate companies) can briefly use
> 1.5 GB of RAM. If you plan that scale, allocate 16 GB.

Need help? See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) /
[FAQ.md](./FAQ.md) / [SUPPORT.md](./SUPPORT.md).

---

## 2. Installation

### Option A: Pre-built installer (recommended)

Download the latest release from
**[GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases)**.

#### Windows

1. Download `Sales-Claw-Setup-2.0.37.exe`.
2. Double-click to launch the installer.
3. **SmartScreen warning** — the build is currently signed with a
   self-managed certificate, so Windows Defender SmartScreen may show
   "Windows protected your PC". Click **More info** → **Run anyway**.
4. The installer is per-user; no admin elevation is required.
5. Default install location:
   `%LOCALAPPDATA%\Programs\Sales Claw\` (e.g.
   `C:\Users\you\AppData\Local\Programs\Sales Claw\`).
6. A shortcut is added to the Start menu and (optionally) to the desktop.

To install for **all users** instead (admin required):

```powershell
# Run from an elevated PowerShell session
scripts\install-latest-win.ps1 -AllUsers
```

#### macOS

1. Download the matching `.dmg`:
   - Apple Silicon (M1/M2/M3): `Sales-Claw-2.0.37-arm64.dmg`
   - Intel: `Sales-Claw-2.0.37-x64.dmg`
2. Double-click the DMG and drag **Sales Claw.app** into `/Applications`.
3. First launch: macOS Gatekeeper will block the unsigned app. Open
   System Settings → Privacy & Security → scroll to "Sales Claw was blocked"
   → click **Open Anyway**.
4. Confirm the second prompt with **Open**.

#### Linux

1. Download `Sales-Claw-2.0.37-x86_64.AppImage`.
2. Make it executable and run:

```bash
chmod +x Sales-Claw-2.0.37-x86_64.AppImage
./Sales-Claw-2.0.37-x86_64.AppImage
```

3. Optional desktop integration: install
   [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) and
   double-click the AppImage.

### Option B: Build from source

For contributors, security auditors, or users on unsupported platforms.

```bash
git clone https://github.com/joseikininsight-hue/sales-claw-ts.git
cd sales-claw-ts

# Install dependencies (~5 minutes)
npm install

# Compile TypeScript
npm run build

# Launch the dashboard in dev mode
npm start
```

The dashboard opens at `http://127.0.0.1:3765` (falls back to 3766, 3767, …
if the port is in use). The exact URL is exported as
`$SALES_CLAW_DASHBOARD_URL` to managed CLI sessions.

To build a native installer locally:

```bash
# Windows (run from PowerShell on Windows)
npm run dist:win -- --publish never

# macOS (run on macOS)
npm run dist:mac -- --publish never

# Linux (run on Linux)
npm run dist:linux -- --publish never
```

Output lands in `dist/`.

> **Never** run `npm run dist:*` without `-- --publish never` unless you
> intend to push the artifact to GitHub Releases.

Need help? See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) /
[FAQ.md](./FAQ.md) / [SUPPORT.md](./SUPPORT.md).

---

## 3. First Launch

### 3.1 Onboarding wizard

On first launch (when `settings.json` is missing or in sample state), Sales
Claw redirects you to the 5-step onboarding wizard at
`http://127.0.0.1:3765/onboarding`.

To re-open the wizard later:

```
http://127.0.0.1:3765/onboarding           # resume from current progress
http://127.0.0.1:3765/onboarding?fresh=1   # restart from step 1
```

#### Step 1: Language and terms

- Choose UI language: 🇯🇵 日本語 / 🇺🇸 English.
- Tick the OSS / self-responsibility consent.
- The Disclaimer (anti-spam laws, opt-out duty, factual accuracy) appears
  in your chosen language.

#### Step 2: Company profile

This is what gets typed into every contact form. Be accurate.

| Field | Required | Notes |
|-------|----------|-------|
| `companyName` | ✅ | Your company's legal name |
| `contactName` | ✅ | The human sender's name |
| `email` | ✅ | Reply-to address (must be reachable) |
| `phone` | ✅ | Office phone (used when forms require it) |
| `address` | ✅ | Postal address (CAN-SPAM and 特定商取引法 require it) |
| `department` | optional | Filled only when the form has a matching field |
| `contactTitle` | optional | e.g. "Sales Director" |
| `mobile` | optional | Used only when the form distinguishes mobile |
| `website` | optional | Your company URL |

> Sales Claw will **never** invent values that are missing from settings.
> Optional fields stay blank if you skip them.

#### Step 3: Strengths

8 presets are offered (e.g. "Cost reduction", "DX support", "Marketing
acceleration"). Pick the ones that apply, or write 1-3 custom strengths in
your own words. These are the hooks the AI uses when crafting messages.

#### Step 4: Target list

Either:

- Drop in a `.xlsx` or `.csv` (the schema mirrors `data/sample-targets.csv`
  in the repo), or
- Skip and add companies manually later from the dashboard.

#### Step 5: AI provider

Pick **one** of Claude / Codex / Gemini. The wizard checks whether the CLI
is installed and logged in, and prints a fix-it command if it isn't.
See [Section 4](#4-ai-provider-setup) for the provider-specific details.

When all five steps are complete, `data/settings.json` gets an
`_onboardedAt: "<ISO timestamp>"` field and you land on the normal
dashboard.

### 3.2 Settings file location

| OS | Path |
|----|------|
| Windows | `%APPDATA%\sales-claw-ts\runtime\data\settings.json` |
| macOS | `~/Library/Application Support/sales-claw-ts/runtime/data/settings.json` |
| Linux | `~/.config/sales-claw-ts/runtime/data/settings.json` |

The Settings tab in the dashboard is the supported way to edit these
values; manual JSON edits are at your own risk (they will be re-validated
on next launch).

Need help? See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) /
[FAQ.md](./FAQ.md) / [SUPPORT.md](./SUPPORT.md).

---

## 4. AI Provider Setup

You only need to set up the provider you selected in Onboarding Step 5.
You can switch providers later from **Settings → AI provider**.

### 4.1 Claude Code CLI (recommended)

#### Install

```bash
# Global install via npm
npm install -g @anthropic-ai/claude-code

# Verify
claude --version
# → claude-code 2.0.x
```

Minimum supported version: **2.0.0** (older versions had a Windows
`cmd.exe` quoting bug; see CLAUDE.md → Known traps).

#### Login

Two options:

**Option A — Anthropic subscription (recommended for Sales Claw):**

```bash
claude
# Opens a browser window for OAuth login
# Choose your Pro / Team / Max workspace
```

No `ANTHROPIC_API_KEY` is needed; usage is billed against your
subscription.

**Option B — Pay-as-you-go API key:**

```bash
# Linux / macOS
export ANTHROPIC_API_KEY=sk-ant-...

# Windows (PowerShell)
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# Windows (persistent)
setx ANTHROPIC_API_KEY "sk-ant-..."
```

> For Sales Claw the **subscription** path is recommended because the
> per-company cost stays bounded and predictable. API-key mode is fine for
> low-volume / experimental use.

Verify login:

```bash
claude auth status --json
# → { "loggedIn": true, "account": "your@email", ... }
```

#### MCP Playwright

Sales Claw needs the Playwright MCP server so the CLI can drive a real
browser. **Sales Claw auto-registers it on first launch** by running:

```bash
claude mcp add --scope user playwright -- node /path/to/playwright-mcp-wrapper.cjs
```

Manual registration (only needed if auto-setup fails):

```bash
# Find the wrapper path
node -e "console.log(require.resolve('@playwright/mcp/lib/server.js'))"

# Register
claude mcp add --scope user playwright -- node <wrapper-path>
```

Verify:

```bash
claude mcp list
# → playwright: ✓ Connected
```

If you see `playwright: ✗ Failed to connect`, the most common cause is a
stale Node version. See
[TROUBLESHOOTING.md → Category 1](./TROUBLESHOOTING.md).

#### Troubleshooting Claude Code

| Symptom | Fix |
|---------|-----|
| MCP registration timeout | Restart MCP: `claude mcp remove playwright && claude mcp add ...`. See TROUBLESHOOTING.md → Category 1 |
| `claude: command not found` (after npm i -g) | Add npm global bin to `$PATH`: `npm config get prefix` |
| Login browser never opens | Run `claude --print-login-url` and open the URL manually |
| `auto mode unavailable for this model` | Launch via `bypassPermissions` (see CLAUDE.md → Workflow Step 0) |

### 4.2 Codex CLI

#### Install

```bash
npm install -g @openai/codex

# Verify
codex --version
# → codex 0.128.x or newer
```

Minimum supported version: **0.128.0** (gpt-5.5 model support is required
for Sales Claw's Phase A.5 message generation).

#### Login

Codex authenticates via API key only (there is no OAuth subscription mode
yet):

```bash
# Linux / macOS
export OPENAI_API_KEY=sk-...

# Windows (PowerShell, persistent)
setx OPENAI_API_KEY "sk-..."
```

You can also enter the key from the Sales Claw dashboard:
**Settings → AI provider → Codex → API key**. The value is stored in your
OS keyring (Windows Credential Manager / macOS Keychain / libsecret on
Linux), not in `settings.json`.

#### MCP Playwright

Sales Claw auto-registers Playwright at first launch:

```bash
codex mcp add playwright -- node /path/to/playwright-mcp-wrapper.cjs
```

Verify:

```bash
codex mcp list
# → playwright: connected
```

#### Run from Sales Claw

```bash
# Verify Codex is wired up
codex exec -m gpt-5.5 -s workspace-write "echo hello"
```

If that prints `hello`, Sales Claw can drive Codex.

### 4.3 Gemini CLI

#### Install

```bash
npm install -g @google/gemini-cli

# Verify
gemini --version
# → gemini-cli 0.5.x
```

#### Login

Two options:

**Option A — Google account OAuth (recommended):**

```bash
gemini auth login
# Opens a browser window for Google login
```

**Option B — API key:**

```bash
# Linux / macOS
export GEMINI_API_KEY=...

# Windows (PowerShell, persistent)
setx GEMINI_API_KEY "..."
```

Verify:

```bash
gemini auth status
# → Authenticated as your@gmail.com
```

#### MCP Playwright

Sales Claw auto-registers Playwright:

```bash
gemini mcp add playwright -- node /path/to/playwright-mcp-wrapper.cjs
```

Verify with `gemini mcp list`.

> Gemini's MCP support is newer than Claude/Codex; if you hit issues, fall
> back to Claude Code for now.

Need help? See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) /
[FAQ.md](./FAQ.md) / [SUPPORT.md](./SUPPORT.md).

---

## 5. First Outreach (5 minutes)

You're set up. Let's send a test outreach to make sure the loop works
end-to-end.

1. **Open Sales Claw.** The dashboard loads at
   `http://127.0.0.1:3765` (or the port shown in the title bar).
2. **Verify your settings** — Settings tab → confirm Company profile +
   Strengths look right.
3. **Import the sample list** — the repo ships with
   `data/sample-targets.csv` (5 fictitious companies). Import it via
   List Builder → Import file, or just drag-and-drop.
4. **Pick 1-3 companies** and click the **AI Form Fill** button. Don't run
   100 at once on your first try.
5. **Watch progress** in the Live Monitor panel:
   - Phase A (analysis) takes ~1 minute per company (parallel).
   - Phase A.5 (message generation) takes ~30 seconds.
   - Phase B (form filling) takes ~5 minutes per company (sequential).
6. **Review** the **Awaiting** tab when each company finishes. You should
   see:
   - The screenshot at `screenshots/ss-{No}-input.png` (filled form).
   - The exact `sentMessage` that was typed into the form body.
   - The final form tab URL.
7. **Decide:**
   - "Looks good" → click **Mark Sent** (the message is already in the
     form; you'll then submit it on the actual site, or solve the CAPTCHA
     and submit).
   - "Not good" → click **Skip** with a reason.

That's the full loop. Once you trust it, scale to batches of 10-20.

> **Reminder:** Sales Claw never auto-submits. The "send" decision always
> happens on the website itself, after you eyeball the screenshot.

Need help? See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) /
[FAQ.md](./FAQ.md) / [SUPPORT.md](./SUPPORT.md).

---

## 6. Bilingual Setup (v2.0.37+)

As of v2.0.37, the entire UI plus the message generation pipeline is
bilingual.

### 6.1 Switch the UI to English

- Click the **🌐 EN** button in the top-right of the dashboard header.
- The page reloads. Settings, Awaiting, Sent, List Builder, Stats, and the
  onboarding wizard all switch language.
- The choice is persisted in `localStorage` and
  `settings.preferences.locale`.

To switch back: click **🌐 JA**.

### 6.2 Send English messages to non-Japanese companies

**Settings → Message Templates → language**:

| Value | Behavior |
|-------|----------|
| `auto` (default) | Sales Claw detects the company website's primary language and matches it (Japanese site → Japanese message; English site → English message) |
| `en` | Force English regardless of site language |
| `ja` | Force Japanese regardless of site language |

The same message templates exist in both languages. Strengths,
`approachObjective`, and `approachGuardrails` are translated automatically
on first use.

### 6.3 Compliance per jurisdiction

**Settings → Company Profile → country**:

| Value | Compliance applied |
|-------|--------------------|
| `ja-jp` | 特定電子メール法 — sender name, sender company, contact email, opt-out instructions |
| `en-us` | CAN-SPAM Act — postal address required, working unsubscribe link auto-added |
| `en-eu` | GDPR / ePrivacy — lawful basis statement, "withdraw consent" option |
| `other` | No automatic footer; you handle compliance manually |

The compliance footer is appended only if `preferences.complianceFooter` is
`true` (the default). The compliance scanner runs both before and after the
footer is appended; warnings show up in the Awaiting tab as a yellow chip.

> The compliance scanner is a best-effort safety rail, **not** a substitute
> for legal review. See the Disclaimer in [README.md](./README.md).

Need help? See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) /
[FAQ.md](./FAQ.md) / [SUPPORT.md](./SUPPORT.md).

---

## 7. Auto-Update

Installed Sales Claw apps check for updates automatically:

- **5 seconds after launch** — first check.
- **Every 6 hours afterwards** — periodic check.
- **Manual** — header **Update** button (packaged Electron only; the dev
  preview disables this because `app.isPackaged === false`).

When a new version is found:

1. Sales Claw silently downloads it in the background.
2. A toast appears at the top of the dashboard: "Update available. Restart
   to install."
3. Click **Restart to update**. Sales Claw closes, swaps the binary, and
   relaunches at the new version.

The update channel is **GitHub Releases** (`latest.yml` + the per-OS
artifact). No central update server is involved — if you can reach
`github.com`, you can update.

To audit the update flow yourself:

```bash
npm run verify:github   # confirms latest.yml is reachable from your network
```

Need help? See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) /
[FAQ.md](./FAQ.md) / [SUPPORT.md](./SUPPORT.md).

---

## 8. Update from older versions

### From v1.2.x (legacy CJS `sales-claw`) to v2.0.x (this repo, `sales-claw-ts`)

The two products have **different application data namespaces**:

- v1.2.x: `%APPDATA%\sales-claw\`
- v2.0.x: `%APPDATA%\sales-claw-ts\`

Because of this, **no automatic data migration is performed**. Treat the
v2.0.x install as a fresh setup:

1. Install v2.0.x using the steps in [Section 2](#2-installation).
2. Re-run the onboarding wizard.
3. (Optional) Copy your old target list (`.xlsx` / `.csv`) into the new
   List Builder.
4. (Optional) Manually port custom strengths and message templates by
   opening v1.2.x's `data/settings.json` side-by-side with v2.0.x's
   Settings tab.
5. Once v2.0.x is verified, uninstall v1.2.x.

### From v2.0.0–v2.0.36 to v2.0.37

This is a normal point release:

- Auto-update handles it; just click **Restart to update** when prompted.
- No settings migration is required; the bilingual additions are additive
  (existing `settings.json` is still valid).

Need help? See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) /
[FAQ.md](./FAQ.md) / [SUPPORT.md](./SUPPORT.md).

---

## 9. Uninstall

### Windows

1. **Settings → Apps → Installed apps** → search "Sales Claw" → click
   **Uninstall**.
2. App binaries are removed from
   `%LOCALAPPDATA%\Programs\Sales Claw\`.
3. **Your data is preserved** at `%APPDATA%\sales-claw-ts\`. To wipe it
   completely:

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\sales-claw-ts"
```

### macOS

1. Drag **Sales Claw.app** from `/Applications` to the Trash.
2. To wipe data:

```bash
rm -rf ~/Library/Application\ Support/sales-claw-ts
rm -rf ~/Library/Caches/sales-claw-ts
rm -rf ~/Library/Logs/sales-claw-ts
```

### Linux

1. Delete the AppImage file.
2. To wipe data:

```bash
rm -rf ~/.config/sales-claw-ts
rm -rf ~/.cache/sales-claw-ts
```

### Source build

```bash
# In the cloned directory
git clean -fdx        # Removes build output, node_modules, etc.
cd ..
rm -rf sales-claw-ts  # Removes the repo itself
```

CLI providers (Claude / Codex / Gemini) and their MCP registrations
**remain installed**, since they are independent of Sales Claw. Remove
them separately if desired:

```bash
npm uninstall -g @anthropic-ai/claude-code
npm uninstall -g @openai/codex
npm uninstall -g @google/gemini-cli
```

Need help? See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) /
[FAQ.md](./FAQ.md) / [SUPPORT.md](./SUPPORT.md).

---

**Setup complete.** You're ready to send your first batch.
For day-to-day operation, the **Awaiting** tab is your home base —
everything else is configured once and forgotten.
