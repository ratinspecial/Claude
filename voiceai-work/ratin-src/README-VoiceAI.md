# Ratin AI Voice — integration guide

A new **Voice AI** tab inside Ratin Special. It uses **VoiceStudio**
(https://github.com/debpalash/VoiceStudio, AGPL-3.0) as a *local* AI voice
engine that runs as a **separate background app**. Ratin Special provides the
UI and drives VoiceStudio's documented, loopback-only local HTTP API.

Nothing in your existing plugin was rewritten. Only two files were added and
two one-line references were inserted into `index.html`.

---

## 1. Files created / modified

**New files (drop into the panel folder, next to `main.js`):**
- `voiceai.js`  — the whole feature (backend bridge, installer/detection,
  UI, model manager, After Effects import). ~62 KB.
- `voiceai.css` — styling, built only from your existing design tokens
  (`--bg-card`, `--accent`, …) so it matches the panel. ~12 KB.

**Modified file:**
- `index.html` — two surgical additions only:
  1. after `onboarding.css`:  `<link rel="stylesheet" href="voiceai.css?v=1">`
  2. right after the `main.js` `<script>`:  `<script src="voiceai.js?v=1"></script>`

**Not touched:** `main.js` (obfuscated — never edited), `rs-crypt.js`
(licensing), `autoupdate.js` (updates), `hostscript.jsxbin`, all themes, all
other features. The tab adds itself to the existing `.cat-row` navigation at
runtime and shows/hides itself purely through a `body.cat-voiceai` class, so no
other tab is affected.

---

## 2. How it works (install workflow)

When the user opens **Voice AI**:
1. Read VoiceStudio's published `backend.json` (in `%APPDATA%\VoiceStudio\`)
   to find the real backend URL — the port is **never** hard-coded (default is
   `127.0.0.1:3900`, but it is read from discovery).
2. `GET /health`. If it answers → **connected**, show the workspace.
3. If no backend but `VoiceStudio.exe` is installed → launch it headless with
   the official `--voicestudio-background` flag (its supervisor starts the
   Python backend), then poll `/health`.
4. If not installed → show the **Set up Voice AI** screen (one button).

**Setup button** (consent screen, Windows):
1. `GET api.github.com/repos/debpalash/VoiceStudio/releases/latest` → find the
   official `VoiceStudio-<ver>-win-x64.exe` (arm64 respected) + `SHA256SUMS.txt`.
2. Download the installer (progress bar, HTTP-Range resume, retry).
3. **Verify SHA-256** against the release's `SHA256SUMS.txt`. Mismatch = abort.
4. Silent install: `VoiceStudio-...exe /S` — electron-builder NSIS with
   `perMachine:false`, so it installs **per-user with no admin / no UAC**.
5. Launch headless, poll `/health`, connect.

Progress for every step is shown in the tab. There is a clear consent screen
before anything downloads (not a silent background install).

---

## 3. Interface

- **Speech (TTS):** text, model, voice, language, speed, format (WAV/MP3),
  Generate → in-panel audio preview → **Import to comp / Project only / Save**.
- **Clone:** name + voice-sample picker + language + a **required consent
  checkbox**, Create profile → saved-voices list (Use / Delete). Cloned voices
  appear in the Speech voice dropdown.
- **Transcribe (STT):** audio picker, model, language → transcript box →
  Copy / Export .txt.
- **Settings:** engine + connection status, hardware (from `/system/info`),
  model manager (install/select engines), install path, data folder, Restart
  engine, Repair, Uninstall.

---

## 4. API integration (verified against VoiceStudio source — nothing assumed)

| Feature | Endpoint |
|---|---|
| Health | `GET /health` |
| Text to Speech | `POST /v1/audio/speech` (OpenAI-compatible) |
| Speech to Text | `POST /v1/audio/transcriptions` (multipart, OpenAI-compatible) |
| Voices | `GET /v1/audio/voices` |
| Models | `GET /v1/models` |
| Voice clone (create) | `POST /profiles` (multipart: `name`, `ref_audio`, `kind=clone`) |
| Profiles list / delete | `GET /profiles`, `DELETE /profiles/{id}` |
| Generate with clone | `POST /v1/audio/speech` with `voice = <profile id>` |
| TTS / ASR engines | `GET /engines/tts`, `GET /engines/asr` |
| Install engine | `POST /engines/sidecar/{id}/install` + `.../install/status` |
| Select engine | `POST /engines/select` |
| Hardware / disk | `GET /system/info`, `GET /setup/preflight` |
| Setup state | `GET /setup/status` |

All requests are **pinned to loopback** (127.0.0.1 / ::1 / localhost); any
non-loopback host is refused. VoiceStudio's local API is unauthenticated on
loopback by design, so no key is sent.

---

## 5. Dependencies

- **No new bundled dependencies.** Uses only Node core modules already
  available because the manifest enables Node (`--enable-nodejs
  --mixed-context`): `fs, os, path, http, https, child_process, crypto, net`.
- VoiceStudio itself bootstraps its own Python, FFmpeg and model weights on
  first run — we do not ship any of them.

---

## 6. Build / install instructions

1. Copy `voiceai.js` and `voiceai.css` into the panel folder (the one with
   `index.html`, `main.js`).
2. Apply the two `index.html` additions above (or use the included modified
   `index.html`).
3. Bump the extension and reload in After Effects (CEP). The **Voice AI** tab
   appears in the top category row.

No change to the signing/ZXP packaging is required beyond including the two new
files.

---

## 7. Testing results (what was verified here vs. what needs your PC)

Verified in this environment (Linux):
- `voiceai.js` passes `node --check` (syntax clean).
- Unit-tested pure logic: SHA256SUMS parser (both `hash  file` and `hash *file`
  forms), multipart/form-data builder, engine/voice/profile response
  normalizers, loopback guard.
- API paths, ports, installer artifact names, silent-install flag, headless
  flag and clone workflow were all confirmed against the actual VoiceStudio
  source — not assumed.

Must be tested on your Windows PC (not possible from here — no Windows / AE /
VoiceStudio runtime):
- End-to-end download → verify → silent install → backend start.
- Real TTS / clone / STT generation and the After Effects import.
- Model install/select from Settings.

---

## 8. Known limitations

- **Windows-first.** Auto-setup targets Windows (your platform). On macOS/Linux
  the tab detects/connects to an existing VoiceStudio but does not auto-install
  (it tells the user to install from voicestudio.sh).
- First-ever VoiceStudio launch may run its own one-time first-run setup; if the
  backend doesn't come up headless, opening VoiceStudio once completes it.
- MP3 export relies on VoiceStudio's bundled FFmpeg; WAV always works.
- Model download pause is handled inside VoiceStudio's own resumable downloader;
  our UI exposes progress + retry.

---

## 9. Licensing / distribution

- VoiceStudio is **AGPL-3.0**. We keep it a **separate app/process** and do
  **not** bundle, modify or redistribute it — we download the **official signed
  installer** from the project's GitHub releases on user consent. This is the
  safe way to combine with AGPL software.
- Individual AI model licenses are handled by VoiceStudio's own model-license
  flow; we surface its engine/model lists rather than fetching weights
  ourselves.
- Voice samples stay local; a consent checkbox is required before cloning.
- The local API is loopback-only and never exposed to the network.
