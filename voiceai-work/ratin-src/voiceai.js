/* ============================================================================
 * voiceai.js — Ratin AI Voice ("Voice AI") for Ratin Special
 * ----------------------------------------------------------------------------
 * A clean, integrated tab that uses VoiceStudio (https://github.com/debpalash/
 * VoiceStudio, AGPL-3.0) as a LOCAL AI voice engine running as a SEPARATE
 * background process. Ratin Special provides the UI and drives VoiceStudio's
 * documented, loopback-only local HTTP API.
 *
 * Design rules honoured:
 *   • Non-invasive: adds its own tab/view; does NOT modify obfuscated main.js
 *     logic. All show/hide is scoped to body.cat-voiceai (see voiceai.css).
 *   • Localhost only: every API call is pinned to 127.0.0.1 / ::1 / localhost.
 *   • VoiceStudio stays a separate app/process (AGPL compliance). We never
 *     bundle or modify it; we download the official signed installer on consent.
 *   • Real work only — no dummy buttons. Requires CEP + Node (enabled in the
 *     manifest via --enable-nodejs). Degrades to a clear message otherwise.
 *
 * Verified against VoiceStudio source (backend/api, cli/voicestudio_cli,
 * docs/): default backend port 3900 (discovered from backend.json, never
 * assumed), GET /health, OpenAI-compatible /v1/audio/speech & /v1/audio/
 * transcriptions & /v1/audio/voices & /v1/models, voice-profile clone via
 * POST /profiles, engines via /engines/tts|/engines/asr, hardware via
 * /system/info and /setup/preflight. Headless launch = desktop app with the
 * --voicestudio-background flag (the app's supervisor starts the Python
 * backend and publishes backend.json).
 * ========================================================================== */
(function () {
  "use strict";

  /* ---- environment guards ------------------------------------------------ */
  var NODE = false, fs, os, path, https, http, child, crypto, net;
  try {
    if (typeof require === "function") {
      fs = require("fs"); os = require("os"); path = require("path");
      https = require("https"); http = require("http");
      child = require("child_process"); crypto = require("crypto"); net = require("net");
      NODE = true;
    }
  } catch (e) { NODE = false; }

  function hasCEP() {
    return !!(window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === "function");
  }
  var IS_WIN = NODE && process.platform === "win32";

  /* ---- constants (verified) --------------------------------------------- */
  var GH_REPO = "debpalash/VoiceStudio";
  var GH_LATEST = "https://api.github.com/repos/" + GH_REPO + "/releases/latest";
  var DEFAULT_BACKEND = "http://127.0.0.1:3900";          // config/app.json ports.backend
  var BACKGROUND_FLAG = "--voicestudio-background";        // electron/src/main/headless.ts
  var STOP_FLAG = "--voicestudio-stop";
  var UA = "RatinSpecial-VoiceAI";                         // generic client name, no PII
  var LOOPBACK = { "127.0.0.1": 1, "::1": 1, "localhost": 1 };

  // CPU-friendly engine hints (docs/install/windows.md CPU preset).
  var CPU_TTS_HINT = ["kittentts", "supertonic3", "pockettts", "moss-tts-nano"];

  /* ---- tiny helpers ------------------------------------------------------ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function fmtBytes(n) { if (!n && n !== 0) return "–"; var u = ["B", "KB", "MB", "GB"], i = 0; n = Number(n); while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + " " + u[i]; }
  function esStr(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n") + '"'; }

  function appData() {
    if (!NODE) return null;
    if (process.env.VOICESTUDIO_USER_DATA) return process.env.VOICESTUDIO_USER_DATA;
    if (IS_WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "VoiceStudio");
    if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "VoiceStudio");
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "VoiceStudio");
  }

  /* ========================================================================
   * Backend bridge — loopback-only HTTP client + VoiceStudio API wrappers
   * ====================================================================== */
  var VS = {
    baseUrl: DEFAULT_BACKEND,

    discovery: function () {
      // The running app publishes backend.json with the real URL + port.
      if (!NODE) return null;
      try {
        var p = path.join(appData(), "backend.json");
        var rec = JSON.parse(fs.readFileSync(p, "utf8"));
        if (!rec || rec.schema !== 1 || typeof rec.url !== "string") return null;
        var u = new URL(rec.url);
        // A LOCAL record must stay on loopback; never follow a remote redirect.
        if (!rec.remote && (u.protocol !== "http:" || !LOOPBACK[u.hostname])) return null;
        return rec;
      } catch (e) { return null; }
    },

    resolveBaseUrl: function () {
      var rec = VS.discovery();
      if (rec && !rec.remote && rec.url) { VS.baseUrl = rec.url.replace(/\/+$/, ""); }
      else { VS.baseUrl = DEFAULT_BACKEND; }
      return VS.baseUrl;
    },

    _guardLoopback: function (u) {
      if (!LOOPBACK[u.hostname]) throw new Error("Refusing non-loopback backend host: " + u.hostname);
    },

    // Core request. opts: {method, path, json, form, raw(Buffer resp), timeout, headers}
    request: function (opts, cb) {
      if (!NODE) return cb(new Error("Node runtime unavailable"));
      var u;
      try { u = new URL((opts.base || VS.baseUrl) + opts.path); VS._guardLoopback(u); }
      catch (e) { return cb(e); }
      var mod = u.protocol === "https:" ? https : http;
      var headers = Object.assign({ "Accept": "*/*", "User-Agent": UA }, opts.headers || {});
      var body = null;
      if (opts.json != null) { body = Buffer.from(JSON.stringify(opts.json)); headers["Content-Type"] = "application/json"; headers["Content-Length"] = body.length; }
      else if (opts.form) { body = opts.form.buffer; headers["Content-Type"] = "multipart/form-data; boundary=" + opts.form.boundary; headers["Content-Length"] = body.length; }
      var req = mod.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || "GET", headers: headers }, function (res) {
        var chunks = [];
        res.on("data", function (d) { chunks.push(d); });
        res.on("end", function () {
          var buf = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            var msg = buf.toString("utf8"); try { var j = JSON.parse(msg); msg = (j.error && (j.error.message || j.error)) || j.detail || msg; } catch (e2) {}
            return cb(new Error("HTTP " + res.statusCode + ": " + String(msg).slice(0, 300)));
          }
          if (opts.raw) return cb(null, buf, res);
          var txt = buf.toString("utf8");
          var ct = res.headers["content-type"] || "";
          if (ct.indexOf("json") >= 0) { try { return cb(null, JSON.parse(txt), res); } catch (e3) { return cb(null, txt, res); } }
          cb(null, txt, res);
        });
      });
      req.on("error", function (e) { cb(e); });
      req.setTimeout(opts.timeout || 600000, function () { req.destroy(new Error("Request timed out")); });
      if (body) req.write(body);
      req.end();
    },

    health: function (base, cb) {
      VS.request({ base: base, path: "/health", timeout: 2500 }, function (err, data, res) {
        if (err) return cb(false);
        cb(!!(res && (res.statusCode === 200 || res.headers["x-omnivoice-backend"])));
      });
    },

    // Is a backend answering at the resolved URL?
    probe: function (cb) { VS.resolveBaseUrl(); VS.health(VS.baseUrl, cb); },

    systemInfo: function (cb) { VS.request({ path: "/system/info", timeout: 8000 }, cb); },
    setupStatus: function (cb) { VS.request({ path: "/setup/status", timeout: 8000 }, cb); },
    preflight: function (cb) { VS.request({ path: "/setup/preflight", timeout: 15000 }, cb); },
    enginesTts: function (cb) { VS.request({ path: "/engines/tts", timeout: 8000 }, cb); },
    enginesAsr: function (cb) { VS.request({ path: "/engines/asr", timeout: 8000 }, cb); },
    listVoices: function (cb) { VS.request({ path: "/v1/audio/voices", timeout: 8000 }, cb); },
    listModels: function (cb) { VS.request({ path: "/v1/models", timeout: 8000 }, cb); },
    listProfiles: function (cb) { VS.request({ path: "/profiles", timeout: 8000 }, cb); },
    deleteProfile: function (id, cb) { VS.request({ method: "DELETE", path: "/profiles/" + encodeURIComponent(id), timeout: 8000 }, cb); },

    // TTS → audio bytes. body mirrors OpenAI CreateSpeechRequest (+ VS extras).
    speech: function (body, cb) {
      VS.request({ method: "POST", path: "/v1/audio/speech", json: body, raw: true, timeout: 600000 }, cb);
    },

    // STT. filePath → transcript. opts {model, language, response_format}
    transcribe: function (filePath, opts, cb) {
      var form;
      try {
        var fd = new MultipartForm();
        fd.file("file", filePath, fs.readFileSync(filePath));
        fd.field("model", opts.model || "whisper-1");
        if (opts.language) fd.field("language", opts.language);
        fd.field("response_format", opts.response_format || "json");
        form = fd.finish();
      } catch (e) { return cb(e); }
      VS.request({ method: "POST", path: "/v1/audio/transcriptions", form: form, timeout: 600000 }, cb);
    },

    // Voice clone: create a profile from a reference clip (single call).
    createClone: function (name, refAudioPath, opts, cb) {
      var form;
      try {
        var fd = new MultipartForm();
        fd.field("name", name);
        fd.field("kind", "clone");
        if (opts && opts.language) fd.field("language", opts.language);
        if (opts && opts.ref_text) fd.field("ref_text", opts.ref_text);
        fd.file("ref_audio", refAudioPath, fs.readFileSync(refAudioPath));
        form = fd.finish();
      } catch (e) { return cb(e); }
      VS.request({ method: "POST", path: "/profiles", form: form, timeout: 180000 }, cb);
    },

    // Engine (model) install for sidecar engines + status polling.
    installSidecar: function (engineId, cb) { VS.request({ method: "POST", path: "/engines/sidecar/" + encodeURIComponent(engineId) + "/install", timeout: 20000 }, cb); },
    sidecarStatus: function (engineId, cb) { VS.request({ path: "/engines/sidecar/" + encodeURIComponent(engineId) + "/install/status", timeout: 8000 }, cb); },
    selectEngine: function (engineId, family, cb) { VS.request({ method: "POST", path: "/engines/select", json: { engine: engineId, family: family || "tts" }, timeout: 15000 }, cb); }
  };

  /* ---- minimal multipart/form-data builder (Node Buffers) --------------- */
  function MultipartForm() {
    this.boundary = "----RatinVoiceAI" + crypto.randomBytes(12).toString("hex");
    this.parts = [];
  }
  MultipartForm.prototype.field = function (name, value) {
    this.parts.push(Buffer.from("--" + this.boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n"));
    return this;
  };
  MultipartForm.prototype.file = function (name, filePath, buf) {
    var fn = path.basename(filePath);
    this.parts.push(Buffer.from("--" + this.boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"; filename=\"" + fn + "\"\r\nContent-Type: application/octet-stream\r\n\r\n"));
    this.parts.push(buf);
    this.parts.push(Buffer.from("\r\n"));
    return this;
  };
  MultipartForm.prototype.finish = function () {
    this.parts.push(Buffer.from("--" + this.boundary + "--\r\n"));
    return { boundary: this.boundary, buffer: Buffer.concat(this.parts) };
  };

  /* ========================================================================
   * Install / detection manager
   * ====================================================================== */
  var Installer = {
    // Find an installed VoiceStudio.exe (Windows). Returns path or null.
    detect: function () {
      if (!IS_WIN) {
        // macOS/Linux candidates (secondary; primary target is Windows).
        try {
          if (process.platform === "darwin") {
            var macs = ["/Applications/VoiceStudio.app", path.join(os.homedir(), "Applications/VoiceStudio.app")];
            for (var i = 0; i < macs.length; i++) if (fs.existsSync(macs[i])) return macs[i];
          }
        } catch (e) {}
        return null;
      }
      var roots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
      var subs = ["Programs\\VoiceStudio", "VoiceStudio", "voicestudio-electron"];
      for (var r = 0; r < roots.length; r++) {
        for (var s = 0; s < subs.length; s++) {
          var p = path.join(roots[r], subs[s], "VoiceStudio.exe");
          try { if (fs.existsSync(p)) return p; } catch (e) {}
        }
      }
      return null;
    },

    // Launch the installed app headless; its supervisor starts the backend.
    startBackground: function (exePath) {
      if (!exePath) return false;
      try {
        if (process.platform === "darwin" && exePath.endsWith(".app")) {
          child.spawn("open", ["-a", exePath, "--args", BACKGROUND_FLAG], { detached: true, stdio: "ignore" }).unref();
        } else {
          child.spawn(exePath, [BACKGROUND_FLAG], { detached: true, stdio: "ignore", windowsHide: true }).unref();
        }
        return true;
      } catch (e) { return false; }
    },

    stopBackground: function () {
      var exe = Installer.detect(); if (!exe) return;
      try { child.spawn(exe, [STOP_FLAG], { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch (e) {}
    },

    // Ensure a backend is answering. cb(err, {status:'connected'|'need_install'})
    ensureBackend: function (onStep, cb) {
      VS.probe(function (up) {
        if (up) return cb(null, { status: "connected" });
        var exe = Installer.detect();
        if (!exe) return cb(null, { status: "need_install" });
        onStep && onStep("launch", "Starting VoiceStudio in the background…");
        Installer.startBackground(exe);
        Installer.pollHealth(180000, onStep, function (ok) {
          cb(null, { status: ok ? "connected" : "launch_failed" });
        });
      });
    },

    pollHealth: function (budgetMs, onStep, cb) {
      var start = Date.now();
      (function loop() {
        VS.probe(function (up) {
          if (up) return cb(true);
          if (Date.now() - start > budgetMs) return cb(false);
          setTimeout(loop, 2000);
        });
      })();
    },

    /* ---- HTTPS GET with redirect following (Buffer or stream) ---------- */
    httpsGet: function (url, opts, cb) {
      opts = opts || {};
      var u;
      try { u = new URL(url); } catch (e) { return cb(e); }
      var headers = Object.assign({ "User-Agent": UA, "Accept": "application/vnd.github+json" }, opts.headers || {});
      var req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers: headers }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return Installer.httpsGet(new URL(res.headers.location, url).toString(), opts, cb);
        }
        if (res.statusCode >= 400) { res.resume(); return cb(new Error("HTTP " + res.statusCode + " for " + u.hostname)); }
        cb(null, res);
      });
      req.on("error", cb);
      req.setTimeout(opts.timeout || 60000, function () { req.destroy(new Error("Download timed out")); });
      req.end();
    },

    getJson: function (url, cb) {
      Installer.httpsGet(url, {}, function (err, res) {
        if (err) return cb(err);
        var c = []; res.on("data", function (d) { c.push(d); }); res.on("end", function () {
          try { cb(null, JSON.parse(Buffer.concat(c).toString("utf8"))); } catch (e) { cb(e); }
        });
      });
    },

    // Resolve latest release → {version, exeUrl, exeName, sumsUrl}
    resolveRelease: function (cb) {
      Installer.getJson(GH_LATEST, function (err, rel) {
        if (err) return cb(err);
        var assets = rel.assets || [], exe = null, sums = null;
        var arch = (IS_WIN && process.arch === "arm64") ? "arm64" : "x64";
        for (var i = 0; i < assets.length; i++) {
          var n = assets[i].name || "";
          if (/win.*\.exe$/i.test(n) && n.indexOf(arch) >= 0) exe = assets[i];
          if (/SHA256SUMS/i.test(n)) sums = assets[i];
        }
        if (!exe) { // fall back to any win x64 exe
          for (var j = 0; j < assets.length; j++) if (/win.*x64.*\.exe$/i.test(assets[j].name || "")) { exe = assets[j]; break; }
        }
        if (!exe) return cb(new Error("No Windows installer found in the latest VoiceStudio release."));
        cb(null, {
          version: rel.tag_name || rel.name || "latest",
          exeUrl: exe.browser_download_url, exeName: exe.name, exeSize: exe.size,
          sumsUrl: sums ? sums.browser_download_url : null
        });
      });
    },

    // Download to dest with progress + resume (HTTP Range) + retry.
    download: function (url, dest, expectBytes, onProgress, cb) {
      var attempts = 0, MAX = 4;
      function attempt() {
        attempts++;
        var have = 0;
        try { if (fs.existsSync(dest)) have = fs.statSync(dest).size; } catch (e) {}
        if (expectBytes && have >= expectBytes) return cb(null, dest);
        var headers = {};
        if (have > 0) headers["Range"] = "bytes=" + have + "-";
        Installer.httpsGet(url, { headers: Object.assign({ "Accept": "application/octet-stream" }, headers), timeout: 120000 }, function (err, res) {
          if (err) { return retry(err); }
          var total = expectBytes || (parseInt(res.headers["content-length"], 10) + have) || 0;
          var append = res.statusCode === 206 && have > 0;
          var out = fs.createWriteStream(dest, { flags: append ? "a" : "w" });
          if (!append) have = 0;
          var got = have;
          res.on("data", function (d) { got += d.length; if (onProgress && total) onProgress(got, total); });
          res.pipe(out);
          out.on("finish", function () { out.close(function () { cb(null, dest); }); });
          out.on("error", retry);
          res.on("error", retry);
        });
      }
      function retry(err) {
        if (attempts >= MAX) return cb(err || new Error("Download failed after retries"));
        setTimeout(attempt, 1500 * attempts);
      }
      attempt();
    },

    sha256: function (file) {
      var h = crypto.createHash("sha256"); h.update(fs.readFileSync(file)); return h.digest("hex");
    },

    // Parse SHA256SUMS.txt → expected hash for a given filename.
    expectedHash: function (sumsText, fileName) {
      var lines = String(sumsText).split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var m = lines[i].trim().match(/^([0-9a-fA-F]{64})[\s*]+(.+)$/);
        if (m && path.basename(m[2].trim()) === fileName) return m[1].toLowerCase();
      }
      return null;
    },

    // Silent, per-user install (electron-builder NSIS: /S, perMachine:false →
    // no elevation / no UAC). cb(err).
    runSilent: function (exePath, cb) {
      try {
        var p = child.spawn(exePath, ["/S"], { windowsHide: true });
        p.on("error", cb);
        p.on("exit", function (code) { cb(code === 0 ? null : new Error("Installer exited with code " + code)); });
      } catch (e) { cb(e); }
    },

    // Full first-run setup pipeline. onStep(stage, text, pct?). cb(err).
    setup: function (onStep, cb) {
      if (!IS_WIN) return cb(new Error("Automatic setup is Windows-only. On this OS, install VoiceStudio from voicestudio.sh, then reopen this tab."));
      var tmp = path.join(os.tmpdir(), "RatinVoiceAI");
      try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) {}

      onStep("resolve", "Finding the latest VoiceStudio release…");
      Installer.resolveRelease(function (err, rel) {
        if (err) return cb(err);
        var exeDest = path.join(tmp, rel.exeName);
        onStep("download", "Downloading VoiceStudio " + rel.version + "…", 0);
        Installer.download(rel.exeUrl, exeDest, rel.exeSize, function (got, total) {
          onStep("download", "Downloading VoiceStudio " + rel.version + "…", Math.round(got / total * 100));
        }, function (err2) {
          if (err2) return cb(err2);
          // Verify integrity against the release's SHA256SUMS (authenticity).
          onStep("verify", "Verifying the installer…");
          function afterVerify(verifiedOk, note) {
            if (verifiedOk === false) return cb(new Error("Installer verification failed — download rejected. " + (note || "")));
            onStep("install", "Installing VoiceStudio (no admin needed)…");
            Installer.runSilent(exeDest, function (err3) {
              if (err3) return cb(err3);
              onStep("launch", "Starting the VoiceStudio engine…");
              var exe = Installer.detect();
              if (!exe) { // installer may add to PATH only; retry detect briefly
                return setTimeout(function () {
                  exe = Installer.detect();
                  if (!exe) return cb(new Error("Installed, but VoiceStudio.exe was not found. Open VoiceStudio once, then reopen this tab."));
                  Installer.startBackground(exe); waitHealth();
                }, 2500);
              }
              Installer.startBackground(exe); waitHealth();
            });
          }
          function waitHealth() {
            onStep("connect", "Connecting to the local engine…");
            Installer.pollHealth(240000, null, function (ok) {
              if (!ok) return cb(new Error("VoiceStudio installed but the backend did not come up. Open VoiceStudio once to finish first-run setup, then reopen this tab."));
              cb(null);
            });
          }
          if (!rel.sumsUrl) return afterVerify(null, "no checksums published");
          var sumsDest = path.join(tmp, "SHA256SUMS.txt");
          Installer.download(rel.sumsUrl, sumsDest, 0, null, function (e4) {
            if (e4) return afterVerify(null, "checksums unavailable");
            try {
              var want = Installer.expectedHash(fs.readFileSync(sumsDest, "utf8"), rel.exeName);
              if (!want) return afterVerify(null, "no matching checksum line");
              var got = Installer.sha256(exeDest);
              return afterVerify(got === want, "expected " + want.slice(0, 12) + "… got " + got.slice(0, 12) + "…");
            } catch (e5) { return afterVerify(null, "checksum read error"); }
          });
        });
      });
    }
  };

  /* ========================================================================
   * After Effects integration (inline ExtendScript via evalScript)
   * ====================================================================== */
  function importToAE(filePath, addToComp, cb) {
    if (!hasCEP()) return cb(new Error("After Effects connection unavailable (open this panel inside AE)."));
    var js =
      "(function(){try{" +
      "var f=new File(" + esStr(filePath) + ");" +
      "if(!f.exists)return 'ERR:File not found';" +
      "app.beginUndoGroup('Ratin AI Voice Import');" +
      "var io=new ImportOptions(f);var item=app.project.importFile(io);var added=false;" +
      (addToComp ?
        "var c=app.project.activeItem;if(c&&(c instanceof CompItem)){var L=c.layers.add(item);try{L.startTime=c.time;}catch(e){}added=true;}" : "") +
      "app.endUndoGroup();return 'OK:'+(added?'comp':'project');" +
      "}catch(err){try{app.endUndoGroup();}catch(e){}return 'ERR:'+err.toString();}})()";
    window.__adobe_cep__.evalScript(js, function (r) {
      r = String(r || "");
      if (r.indexOf("OK:") === 0) cb(null, r.slice(3));
      else cb(new Error(r.replace(/^ERR:/, "") || "Import failed"));
    });
  }

  /* ========================================================================
   * UI
   * ====================================================================== */
  var UI = {
    root: null, ready: false, built: false,
    state: { backend: "unknown", busy: false, lastAudio: null },

    toast: function (msg, isErr) {
      var t = el("div", "va-toast" + (isErr ? " err" : ""), msg);
      document.body.appendChild(t);
      requestAnimationFrame(function () { t.classList.add("on"); });
      setTimeout(function () { t.classList.remove("on"); setTimeout(function () { t.remove(); }, 250); }, isErr ? 4200 : 2600);
    },

    setStatus: function (kind, html) {
      var s = $("#vaStatus", UI.root); if (!s) return;
      s.className = "va-status " + (kind === "ok" ? "is-ok" : kind === "busy" ? "is-busy" : kind === "err" ? "is-err" : "");
      $(".va-status-text", s).innerHTML = html;
    },

    build: function () {
      if (UI.built) return;
      var v = UI.root; v.innerHTML = "";

      // status strip
      var st = el("div", "va-status"); st.id = "vaStatus";
      st.appendChild(el("span", "va-dot"));
      st.appendChild(el("span", "va-status-text", "Checking the local engine…"));
      v.appendChild(st);

      // gate (setup) screen
      v.appendChild(UI.buildGate());

      // workspace (sub-nav + panels), hidden until ready
      var ws = el("div"); ws.id = "vaWorkspace"; ws.className = "va-hidden";
      ws.appendChild(UI.buildSubnav());
      ws.appendChild(UI.buildTTS());
      ws.appendChild(UI.buildClone());
      ws.appendChild(UI.buildSTT());
      ws.appendChild(UI.buildSettings());
      v.appendChild(ws);

      UI.built = true;
    },

    buildGate: function () {
      var g = el("div", "va-gate"); g.id = "vaGate";
      g.appendChild(el("div", "va-gate-ico", icon("wave", 46)));
      g.appendChild(el("h2", null, "Ratin AI Voice"));
      g.appendChild(el("p", null, "Generate speech, clone voices and transcribe audio — all locally on your PC. This uses the open-source <b>VoiceStudio</b> engine (AGPL-3.0), installed on your computer as a separate background app. Nothing is uploaded; your voice stays on your device."));
      var btn = el("button", "va-btn", icon("download", 15) + "<span>Set up Voice AI</span>"); btn.id = "vaSetupBtn";
      btn.addEventListener("click", UI.onSetup);
      g.appendChild(btn);
      // progress steps
      var steps = el("div", "va-steps"); steps.id = "vaSteps";
      ["resolve:Find latest release", "download:Download engine", "verify:Verify integrity", "install:Install (no admin)", "launch:Start engine", "connect:Connect"].forEach(function (s) {
        var k = s.split(":")[0], label = s.split(":")[1];
        var row = el("div", "va-step"); row.setAttribute("data-step", k);
        row.appendChild(el("span", "va-step-ico", "○"));
        row.appendChild(el("span", null, label));
        steps.appendChild(row);
      });
      g.appendChild(steps);
      var prog = el("div", "va-progress"); prog.id = "vaSetupProgress";
      var bar = el("div", "va-bar"); bar.appendChild(el("div", "va-bar-fill"));
      prog.appendChild(bar);
      prog.appendChild(el("div", "va-progress-label", "<span class='t'></span><span class='p'></span>"));
      g.appendChild(prog);
      g.appendChild(el("div", "va-gate-note", "By continuing you agree to install VoiceStudio and its AI models locally. VoiceStudio is a separate program under the <a href='https://github.com/debpalash/VoiceStudio/blob/main/LICENSE' target='_blank'>AGPL-3.0 license</a>."));
      return g;
    },

    buildSubnav: function () {
      var nav = el("div", "va-subnav");
      [["tts", "Speech", "wave"], ["clone", "Clone", "user"], ["stt", "Transcribe", "text"], ["settings", "Settings", "gear"]].forEach(function (t, i) {
        var b = el("button", i === 0 ? "on" : "", icon(t[2], 14) + "<span>" + t[1] + "</span>");
        b.setAttribute("data-panel", t[0]);
        b.addEventListener("click", function () { UI.showPanel(t[0]); });
        nav.appendChild(b);
      });
      return nav;
    },

    showPanel: function (name) {
      Array.prototype.forEach.call(UI.root.querySelectorAll(".va-subnav button"), function (b) { b.classList.toggle("on", b.getAttribute("data-panel") === name); });
      Array.prototype.forEach.call(UI.root.querySelectorAll(".va-panel"), function (p) { p.classList.toggle("on", p.id === "vaPanel-" + name); });
      if (name === "settings") UI.refreshSettings();
      if (name === "clone") UI.refreshProfiles();
    },

    /* ---------- Text to Speech ---------- */
    buildTTS: function () {
      var p = el("div", "va-panel on"); p.id = "vaPanel-tts";
      var c = el("div", "va-card");
      c.appendChild(el("div", "va-card-title", "<span class='diamond'></span>Text to Speech"));
      c.appendChild(field("Text", "<textarea class='va-textarea' id='vaTtsText' placeholder='Type what you want spoken…' maxlength='4096'></textarea>"));
      var row = el("div", "va-row");
      row.appendChild(field("Model", "<select class='va-select' id='vaTtsModel'></select>"));
      row.appendChild(field("Voice", "<select class='va-select' id='vaTtsVoice'></select>"));
      c.appendChild(row);
      var row2 = el("div", "va-row");
      row2.appendChild(field("Language", "<input class='va-input' id='vaTtsLang' placeholder='auto (e.g. en, bn, hi)' />"));
      row2.appendChild(field("Format", "<select class='va-select' id='vaTtsFmt'><option value='wav'>WAV</option><option value='mp3'>MP3</option></select>"));
      c.appendChild(row2);
      c.appendChild(field("Speed", "<div class='va-range-row'><input type='range' class='va-range' id='vaTtsSpeed' min='0.25' max='4' step='0.05' value='1'><span class='va-range-val' id='vaTtsSpeedVal'>1.0×</span></div>"));
      var gen = el("button", "va-btn", icon("play", 15) + "<span>Generate</span>"); gen.id = "vaTtsGen";
      c.appendChild(gen);
      c.appendChild(progressBlock("vaTtsProg"));
      c.appendChild(resultBlock("vaTtsResult"));
      p.appendChild(c);

      $("#vaTtsSpeed", p) || 0;
      gen.addEventListener("click", UI.onGenerateTTS);
      return p;
    },

    /* ---------- Voice Cloning ---------- */
    buildClone: function () {
      var p = el("div", "va-panel"); p.id = "vaPanel-clone";
      var c = el("div", "va-card");
      c.appendChild(el("div", "va-card-title", "<span class='diamond'></span>Create a voice profile"));
      c.appendChild(field("Profile name", "<input class='va-input' id='vaCloneName' placeholder='e.g. My Narrator' maxlength='60' />"));
      var drop = el("div", "va-drop"); drop.id = "vaCloneDrop";
      drop.innerHTML = "<div class='va-drop-ico'>" + icon("mic", 26) + "</div><div class='va-drop-main'>Choose a voice sample</div><div class='va-drop-sub'>WAV, MP3, M4A, FLAC… 10–30s of clean speech</div><div class='va-file-chip va-hidden' id='vaCloneChip'></div>";
      c.appendChild(drop);
      c.appendChild(field("Language", "<input class='va-input' id='vaCloneLang' placeholder='auto (e.g. en, bn)' />"));
      // consent (required)
      var consent = el("label", "va-hint"); consent.style.display = "flex"; consent.style.gap = "7px"; consent.style.alignItems = "flex-start"; consent.style.cursor = "pointer";
      consent.innerHTML = "<input type='checkbox' id='vaCloneConsent' style='margin-top:1px'> <span>I confirm this is my own voice, or I have the speaker's permission to clone it. The sample stays on this computer.</span>";
      c.appendChild(consent);
      var btn = el("button", "va-btn", icon("user", 15) + "<span>Create profile</span>"); btn.id = "vaCloneCreate";
      btn.style.marginTop = "10px";
      c.appendChild(btn);
      c.appendChild(progressBlock("vaCloneProg"));
      p.appendChild(c);

      var c2 = el("div", "va-card");
      c2.appendChild(el("div", "va-card-title", "<span class='diamond'></span>Saved voices"));
      var list = el("div", "va-list"); list.id = "vaProfileList";
      list.appendChild(el("div", "va-empty", "No saved voices yet."));
      c2.appendChild(list);
      p.appendChild(c2);

      drop.addEventListener("click", function () { UI.pickFile(["wav", "mp3", "m4a", "flac", "ogg", "opus", "aac", "webm"], function (f) { UI.cloneFile = f; var chip = $("#vaCloneChip", p); chip.classList.remove("va-hidden"); chip.innerHTML = icon("check", 13) + "<span>" + f.split(/[\\/]/).pop() + "</span>"; }); });
      btn.addEventListener("click", UI.onCreateClone);
      return p;
    },

    /* ---------- Speech to Text ---------- */
    buildSTT: function () {
      var p = el("div", "va-panel"); p.id = "vaPanel-stt";
      var c = el("div", "va-card");
      c.appendChild(el("div", "va-card-title", "<span class='diamond'></span>Transcribe audio"));
      var drop = el("div", "va-drop"); drop.id = "vaSttDrop";
      drop.innerHTML = "<div class='va-drop-ico'>" + icon("audio", 26) + "</div><div class='va-drop-main'>Choose an audio file</div><div class='va-drop-sub'>WAV, MP3, M4A, FLAC, OGG…</div><div class='va-file-chip va-hidden' id='vaSttChip'></div>";
      c.appendChild(drop);
      var row = el("div", "va-row");
      row.appendChild(field("Model", "<select class='va-select' id='vaSttModel'></select>"));
      row.appendChild(field("Language", "<input class='va-input' id='vaSttLang' placeholder='auto' />"));
      c.appendChild(row);
      var btn = el("button", "va-btn", icon("text", 15) + "<span>Transcribe</span>"); btn.id = "vaSttGo";
      c.appendChild(btn);
      c.appendChild(progressBlock("vaSttProg"));
      var res = el("div", "va-result"); res.id = "vaSttResult";
      res.appendChild(el("div", "va-transcript", "")); res.querySelector(".va-transcript").id = "vaSttText";
      var brow = el("div", "va-btn-row");
      var copy = el("button", "va-btn ghost sm", icon("copy", 14) + "<span>Copy</span>");
      var exp = el("button", "va-btn ghost sm", icon("download", 14) + "<span>Export .txt</span>");
      brow.appendChild(copy); brow.appendChild(exp);
      res.appendChild(brow);
      c.appendChild(res);
      p.appendChild(c);

      drop.addEventListener("click", function () { UI.pickFile(["wav", "mp3", "m4a", "flac", "ogg", "opus", "aac", "webm", "mp4", "mov"], function (f) { UI.sttFile = f; var chip = $("#vaSttChip", p); chip.classList.remove("va-hidden"); chip.innerHTML = icon("check", 13) + "<span>" + f.split(/[\\/]/).pop() + "</span>"; }); });
      btn.addEventListener("click", UI.onTranscribe);
      copy.addEventListener("click", function () { var t = $("#vaSttText", p).textContent; try { require("electron"); } catch (e) {} try { navigator.clipboard.writeText(t); UI.toast("Copied."); } catch (e2) { UI.toast("Copy failed", true); } });
      exp.addEventListener("click", function () { UI.saveText($("#vaSttText", p).textContent, "transcript.txt"); });
      return p;
    },

    /* ---------- Settings ---------- */
    buildSettings: function () {
      var p = el("div", "va-panel"); p.id = "vaPanel-settings";

      var c1 = el("div", "va-card");
      c1.appendChild(el("div", "va-card-title", "<span class='diamond'></span>Engine status"));
      var kv = el("div"); kv.id = "vaSetKv";
      kv.innerHTML = "<div class='va-empty'>Loading…</div>";
      c1.appendChild(kv);
      var brow = el("div", "va-btn-row");
      var rb = el("button", "va-btn ghost sm", icon("refresh", 14) + "<span>Restart engine</span>"); rb.id = "vaRestart";
      var rp = el("button", "va-btn ghost sm", icon("wrench", 14) + "<span>Repair</span>"); rp.id = "vaRepair";
      brow.appendChild(rb); brow.appendChild(rp);
      c1.appendChild(brow);
      p.appendChild(c1);

      var c2 = el("div", "va-card");
      c2.appendChild(el("div", "va-card-title", "<span class='diamond'></span>Models"));
      c2.appendChild(el("div", "va-hint", "Download only what you need. Lightweight engines are recommended for your PC (CPU-only)."));
      var ml = el("div", "va-list"); ml.id = "vaModelList"; ml.style.marginTop = "10px";
      ml.appendChild(el("div", "va-empty", "Connect the engine to see models."));
      c2.appendChild(ml);
      p.appendChild(c2);

      var c3 = el("div", "va-card");
      c3.appendChild(el("div", "va-card-title", "<span class='diamond'></span>Advanced"));
      var kv3 = el("div"); kv3.id = "vaSetKv2"; c3.appendChild(kv3);
      var un = el("button", "va-btn danger sm", icon("trash", 14) + "<span>Uninstall VoiceStudio</span>"); un.id = "vaUninstall"; un.style.marginTop = "10px";
      c3.appendChild(un);
      c3.appendChild(el("div", "va-inline-note", "Uninstalling opens VoiceStudio's own uninstaller. Your saved voices and projects are kept unless you choose otherwise there."));
      p.appendChild(c3);

      rb.addEventListener("click", UI.onRestart);
      rp.addEventListener("click", UI.onRepair);
      un.addEventListener("click", UI.onUninstall);
      return p;
    },

    /* ================= actions ================= */
    onSetup: function () {
      if (!NODE) return UI.toast("Node runtime is required (open inside After Effects).", true);
      var btn = $("#vaSetupBtn", UI.root); btn.disabled = true;
      $("#vaSteps", UI.root).classList.add("on");
      var prog = $("#vaSetupProgress", UI.root); prog.classList.add("on");
      var fill = $(".va-bar-fill", prog), lbl = prog.querySelector(".va-progress-label");
      function stepUI(stage, text, pct) {
        var steps = UI.root.querySelectorAll(".va-step"), hit = false;
        Array.prototype.forEach.call(steps, function (s) {
          var k = s.getAttribute("data-step");
          if (k === stage) { s.className = "va-step active"; s.querySelector(".va-step-ico").innerHTML = "<span class='va-spin'></span>"; hit = true; }
          else if (!hit) { s.className = "va-step done"; s.querySelector(".va-step-ico").textContent = "✓"; }
        });
        lbl.querySelector(".t").textContent = text || "";
        if (typeof pct === "number") { prog.querySelector(".va-bar").classList.remove("indeterminate"); fill.style.width = pct + "%"; lbl.querySelector(".p").textContent = pct + "%"; }
        else { prog.querySelector(".va-bar").classList.add("indeterminate"); lbl.querySelector(".p").textContent = ""; }
        UI.setStatus("busy", "<b>Setting up</b> — " + (text || ""));
      }
      Installer.setup(stepUI, function (err) {
        if (err) {
          btn.disabled = false;
          UI.setStatus("err", "Setup failed");
          UI.toast(err.message || String(err), true);
          // mark current step failed
          var act = UI.root.querySelector(".va-step.active"); if (act) { act.querySelector(".va-step-ico").textContent = "✕"; act.style.color = "var(--danger)"; }
          return;
        }
        Array.prototype.forEach.call(UI.root.querySelectorAll(".va-step"), function (s) { s.className = "va-step done"; s.querySelector(".va-step-ico").textContent = "✓"; });
        UI.onConnected();
      });
    },

    onConnected: function () {
      $("#vaGate", UI.root).classList.add("va-hidden");
      $("#vaWorkspace", UI.root).classList.remove("va-hidden");
      UI.setStatus("ok", "<b>Connected</b> — local engine ready");
      UI.ready = true;
      UI.loadModelsAndVoices();
      UI.refreshProfiles();
    },

    loadModelsAndVoices: function () {
      // TTS model dropdown from /engines/tts (fallback to known ids)
      var mSel = $("#vaTtsModel", UI.root);
      VS.enginesTts(function (err, data) {
        var list = normalizeEngines(data);
        mSel.innerHTML = "";
        if (!list.length) { ["omnivoice", "kittentts", "voxcpm2", "cosyvoice", "moss-tts-nano"].forEach(function (id) { mSel.appendChild(new Option(id, id)); }); }
        else list.forEach(function (e) { var o = new Option((e.name || e.id) + (e.ready ? "" : " (not installed)"), e.id); mSel.appendChild(o); });
      });
      // voices
      var vSel = $("#vaTtsVoice", UI.root);
      VS.listVoices(function (err, data) {
        var voices = normalizeVoices(data);
        vSel.innerHTML = "";
        vSel.appendChild(new Option("Default voice", "default"));
        voices.forEach(function (v) { if (v.voice_id && v.voice_id !== "default") vSel.appendChild(new Option(v.name || v.voice_id, v.voice_id)); });
      });
      // STT models from /engines/asr
      var sSel = $("#vaSttModel", UI.root);
      VS.enginesAsr(function (err, data) {
        var list = normalizeEngines(data);
        sSel.innerHTML = "";
        sSel.appendChild(new Option("Default (whisper-1)", "whisper-1"));
        list.forEach(function (e) { sSel.appendChild(new Option((e.name || e.id) + (e.ready ? "" : " (not installed)"), e.id)); });
      });
      // speed label
      var sp = $("#vaTtsSpeed", UI.root), spv = $("#vaTtsSpeedVal", UI.root);
      if (sp) sp.addEventListener("input", function () { spv.textContent = parseFloat(sp.value).toFixed(2) + "×"; });
    },

    onGenerateTTS: function () {
      var text = $("#vaTtsText", UI.root).value.trim();
      if (!text) return UI.toast("Enter some text first.", true);
      var body = {
        model: $("#vaTtsModel", UI.root).value || "omnivoice",
        input: text,
        voice: $("#vaTtsVoice", UI.root).value || "default",
        response_format: $("#vaTtsFmt", UI.root).value || "wav",
        speed: parseFloat($("#vaTtsSpeed", UI.root).value) || 1.0
      };
      var lang = $("#vaTtsLang", UI.root).value.trim(); if (lang) body.language = lang;
      var prog = showProg("vaTtsProg", "Generating speech…");
      $("#vaTtsGen", UI.root).disabled = true;
      VS.speech(body, function (err, buf) {
        $("#vaTtsGen", UI.root).disabled = false; hideProg("vaTtsProg");
        if (err) return UI.toast(err.message, true);
        var ext = body.response_format === "mp3" ? "mp3" : "wav";
        var file = writeTemp(buf, "tts", ext);
        UI.state.lastAudio = file;
        UI.showAudioResult("vaTtsResult", file, ext);
      });
    },

    showAudioResult: function (resultId, file, ext) {
      var res = $("#" + resultId, UI.root); res.classList.add("on");
      res.innerHTML = "";
      var audio = el("audio", "va-audio"); audio.controls = true; audio.src = fileUrl(file);
      res.appendChild(audio);
      var row = el("div", "va-btn-row");
      var imp = el("button", "va-btn sm", icon("import", 14) + "<span>Import to comp</span>");
      var impP = el("button", "va-btn ghost sm", icon("import", 14) + "<span>Project only</span>");
      var save = el("button", "va-btn ghost sm", icon("download", 14) + "<span>Save " + ext.toUpperCase() + "</span>");
      row.appendChild(imp); row.appendChild(impP); row.appendChild(save);
      res.appendChild(row);
      imp.addEventListener("click", function () { importToAE(file, true, function (e, where) { e ? UI.toast(e.message, true) : UI.toast("Imported to " + where + "."); }); });
      impP.addEventListener("click", function () { importToAE(file, false, function (e) { e ? UI.toast(e.message, true) : UI.toast("Imported to project."); }); });
      save.addEventListener("click", function () { UI.saveBinary(file, "voiceai." + ext); });
    },

    onCreateClone: function () {
      var name = $("#vaCloneName", UI.root).value.trim();
      if (!name) return UI.toast("Give the profile a name.", true);
      if (!UI.cloneFile) return UI.toast("Choose a voice sample.", true);
      if (!$("#vaCloneConsent", UI.root).checked) return UI.toast("Please confirm consent to clone this voice.", true);
      var opts = {}; var lang = $("#vaCloneLang", UI.root).value.trim(); if (lang) opts.language = lang;
      var prog = showProg("vaCloneProg", "Creating voice profile…");
      $("#vaCloneCreate", UI.root).disabled = true;
      VS.createClone(name, UI.cloneFile, opts, function (err, data) {
        $("#vaCloneCreate", UI.root).disabled = false; hideProg("vaCloneProg");
        if (err) return UI.toast(err.message, true);
        UI.toast("Voice profile created.");
        $("#vaCloneName", UI.root).value = ""; UI.cloneFile = null;
        var chip = $("#vaCloneChip", UI.root); chip.classList.add("va-hidden");
        $("#vaCloneConsent", UI.root).checked = false;
        UI.refreshProfiles(); UI.loadModelsAndVoices();
      });
    },

    refreshProfiles: function () {
      var list = $("#vaProfileList", UI.root); if (!list) return;
      VS.listProfiles(function (err, data) {
        var profs = normalizeProfiles(data);
        list.innerHTML = "";
        if (err || !profs.length) { list.appendChild(el("div", "va-empty", err ? "Could not load voices." : "No saved voices yet.")); return; }
        profs.forEach(function (pr) {
          var row = el("div", "va-list-item");
          var main = el("div", "va-li-main");
          main.appendChild(el("div", "va-li-name", pr.name || pr.id));
          main.appendChild(el("div", "va-li-sub", (pr.language || "Auto") + " · " + (pr.kind || "clone")));
          row.appendChild(main);
          var use = el("button", "va-btn sm", "Use");
          var del = el("button", "va-btn ghost sm", icon("trash", 13));
          row.appendChild(use); row.appendChild(del);
          use.addEventListener("click", function () {
            UI.showPanel("tts");
            var vSel = $("#vaTtsVoice", UI.root);
            var found = false;
            Array.prototype.forEach.call(vSel.options, function (o) { if (o.value === pr.id) { vSel.value = pr.id; found = true; } });
            if (!found) { var o = new Option(pr.name || pr.id, pr.id); vSel.appendChild(o); vSel.value = pr.id; }
            UI.toast("Voice selected — type text and Generate.");
          });
          del.addEventListener("click", function () {
            if (!confirm("Delete voice profile \"" + (pr.name || pr.id) + "\"?")) return;
            VS.deleteProfile(pr.id, function (e) { if (e) return UI.toast(e.message, true); UI.toast("Deleted."); UI.refreshProfiles(); UI.loadModelsAndVoices(); });
          });
          list.appendChild(row);
        });
      });
    },

    onTranscribe: function () {
      if (!UI.sttFile) return UI.toast("Choose an audio file.", true);
      var opts = { model: $("#vaSttModel", UI.root).value || "whisper-1", response_format: "json" };
      var lang = $("#vaSttLang", UI.root).value.trim(); if (lang) opts.language = lang;
      showProg("vaSttProg", "Transcribing…");
      $("#vaSttGo", UI.root).disabled = true;
      VS.transcribe(UI.sttFile, opts, function (err, data) {
        $("#vaSttGo", UI.root).disabled = false; hideProg("vaSttProg");
        if (err) return UI.toast(err.message, true);
        var text = (data && (data.text != null ? data.text : (typeof data === "string" ? data : JSON.stringify(data)))) || "";
        $("#vaSttResult", UI.root).classList.add("on");
        $("#vaSttText", UI.root).textContent = text;
      });
    },

    refreshSettings: function () {
      if (!UI.ready) { $("#vaSetKv", UI.root).innerHTML = "<div class='va-empty'>Engine not connected.</div>"; return; }
      VS.systemInfo(function (err, info) {
        var kv = $("#vaSetKv", UI.root);
        if (err || !info) { kv.innerHTML = "<div class='va-empty'>Status unavailable.</div>"; }
        else {
          kv.innerHTML = "";
          kv.appendChild(kvRow("Backend", VS.baseUrl));
          kv.appendChild(kvRow("Device", (info.device || "cpu").toUpperCase()));
          if (info.cpu_model) kv.appendChild(kvRow("CPU", info.cpu_model));
          if (info.total_ram || info.ram_total_gb) kv.appendChild(kvRow("RAM", (info.total_ram || info.ram_total_gb).toFixed ? (info.total_ram || info.ram_total_gb).toFixed(1) + " GB" : (info.total_ram || info.ram_total_gb) + " GB"));
          if (info.gpu_name) kv.appendChild(kvRow("GPU", info.gpu_name));
          if (info.disk_free_gb != null) kv.appendChild(kvRow("Free disk", info.disk_free_gb.toFixed ? info.disk_free_gb.toFixed(1) + " GB" : info.disk_free_gb + " GB"));
        }
      });
      var kv2 = $("#vaSetKv2", UI.root);
      kv2.innerHTML = "";
      kv2.appendChild(kvRow("Install path", Installer.detect() || "not found"));
      kv2.appendChild(kvRow("Data folder", appData() || "–"));
      UI.refreshModels();
    },

    refreshModels: function () {
      var ml = $("#vaModelList", UI.root); if (!ml) return;
      VS.enginesTts(function (err, data) {
        var tts = normalizeEngines(data);
        VS.enginesAsr(function (err2, data2) {
          var asr = normalizeEngines(data2);
          ml.innerHTML = "";
          var all = tts.map(function (e) { e._fam = "tts"; return e; }).concat(asr.map(function (e) { e._fam = "asr"; return e; }));
          if (!all.length) { ml.appendChild(el("div", "va-empty", "No engines reported.")); return; }
          all.forEach(function (e) {
            var row = el("div", "va-list-item");
            var main = el("div", "va-li-main");
            var rec = CPU_TTS_HINT.indexOf((e.id || "").toLowerCase()) >= 0;
            main.appendChild(el("div", "va-li-name", (e.name || e.id) + (rec ? "  ·  light" : "")));
            main.appendChild(el("div", "va-li-sub", e._fam.toUpperCase() + (e.size ? " · " + fmtBytes(e.size) : "")));
            row.appendChild(main);
            if (e.ready) { row.appendChild(badge("Installed", "ok")); }
            else {
              var btn = el("button", "va-btn sm", "Install");
              btn.addEventListener("click", function () { UI.installEngine(e, btn, row); });
              row.appendChild(btn);
            }
            ml.appendChild(row);
          });
        });
      });
    },

    installEngine: function (e, btn, row) {
      btn.disabled = true; btn.textContent = "Installing…";
      VS.installSidecar(e.id, function (err) {
        if (err) { btn.disabled = false; btn.textContent = "Install"; return UI.toast(err.message, true); }
        var tries = 0;
        (function poll() {
          VS.sidecarStatus(e.id, function (er2, st) {
            tries++;
            var state = st && (st.state || st.status);
            if (state === "ready" || state === "installed" || (st && st.ready)) { UI.toast((e.name || e.id) + " installed."); UI.refreshModels(); return; }
            if (state === "failed" || state === "error") { btn.disabled = false; btn.textContent = "Retry"; return UI.toast("Install failed.", true); }
            if (st && (st.progress != null)) btn.textContent = Math.round(st.progress * (st.progress <= 1 ? 100 : 1)) + "%";
            if (tries > 900) { btn.disabled = false; btn.textContent = "Install"; return; }
            setTimeout(poll, 2000);
          });
        })();
      });
    },

    onRestart: function () {
      UI.setStatus("busy", "Restarting engine…");
      Installer.stopBackground();
      setTimeout(function () {
        var exe = Installer.detect(); if (exe) Installer.startBackground(exe);
        Installer.pollHealth(120000, null, function (ok) { ok ? (UI.setStatus("ok", "<b>Connected</b> — engine ready"), UI.toast("Engine restarted.")) : (UI.setStatus("err", "Restart failed"), UI.toast("Engine did not come back.", true)); });
      }, 2500);
    },

    onRepair: function () {
      // Re-run ensureBackend; if still down, re-run setup.
      UI.setStatus("busy", "Checking engine…");
      Installer.ensureBackend(null, function (err, r) {
        if (r && r.status === "connected") { UI.setStatus("ok", "<b>Connected</b> — engine ready"); return UI.toast("Engine is healthy."); }
        if (r && r.status === "need_install") { UI.toast("VoiceStudio not found — running setup.", true); $("#vaGate", UI.root).classList.remove("va-hidden"); $("#vaWorkspace", UI.root).classList.add("va-hidden"); return; }
        UI.toast("Could not reach the engine. Try Restart, or open VoiceStudio once.", true);
        UI.setStatus("err", "Engine not responding");
      });
    },

    onUninstall: function () {
      if (!IS_WIN) return UI.toast("Uninstall from your OS app settings.", true);
      if (!confirm("Open VoiceStudio's uninstaller? Your saved voices and projects are kept.")) return;
      // electron-builder NSIS uninstaller lives next to the app.
      try {
        var exe = Installer.detect();
        if (!exe) return UI.toast("VoiceStudio not found.", true);
        var dir = path.dirname(exe);
        var un = path.join(dir, "Uninstall VoiceStudio.exe");
        if (!fs.existsSync(un)) { // fallback: common name
          var alt = fs.readdirSync(dir).filter(function (f) { return /uninstall/i.test(f) && /\.exe$/i.test(f); });
          if (alt.length) un = path.join(dir, alt[0]);
        }
        if (fs.existsSync(un)) { child.spawn(un, [], { detached: true, stdio: "ignore" }).unref(); UI.toast("Uninstaller opened."); }
        else UI.toast("Uninstaller not found; remove VoiceStudio from Windows Settings.", true);
      } catch (e) { UI.toast(e.message, true); }
    },

    /* ---------- file dialogs via CEP ---------- */
    pickFile: function (exts, cb) {
      if (hasCEP() && window.cep && window.cep.fs && window.__adobe_cep__.showOpenDialogEx) {
        try {
          var r = window.__adobe_cep__.showOpenDialogEx(false, false, "Choose a file", null, exts, "Select");
          var data = typeof r === "string" ? JSON.parse(r) : r;
          var arr = data && (data.data || data);
          if (arr && arr.length) return cb(decodeURI(String(arr[0]).replace(/^file:\/\//, "")));
        } catch (e) {}
      }
      // Fallback: hidden <input type=file> (gives a path in CEP/Node).
      var inp = el("input"); inp.type = "file"; if (exts) inp.accept = exts.map(function (x) { return "." + x; }).join(",");
      inp.style.display = "none"; document.body.appendChild(inp);
      inp.addEventListener("change", function () { var f = inp.files[0]; if (f) cb(f.path || f.name); inp.remove(); });
      inp.click();
    },

    saveBinary: function (srcFile, suggested) {
      try {
        if (hasCEP() && window.__adobe_cep__.showSaveDialogEx) {
          var r = window.__adobe_cep__.showSaveDialogEx("Save audio", null, [suggested.split(".").pop()], suggested);
          var data = typeof r === "string" ? JSON.parse(r) : r;
          var dest = data && (data.data || data.path || data);
          if (dest) { dest = decodeURI(String(dest).replace(/^file:\/\//, "")); fs.copyFileSync(srcFile, dest); return UI.toast("Saved."); }
        }
      } catch (e) {}
      // fallback: copy to Desktop/Downloads
      try { var out = path.join(os.homedir(), "Downloads", suggested); fs.copyFileSync(srcFile, out); UI.toast("Saved to Downloads."); }
      catch (e2) { UI.toast("Save failed: " + e2.message, true); }
    },

    saveText: function (text, suggested) {
      try {
        if (hasCEP() && window.__adobe_cep__.showSaveDialogEx) {
          var r = window.__adobe_cep__.showSaveDialogEx("Save transcript", null, ["txt"], suggested);
          var data = typeof r === "string" ? JSON.parse(r) : r;
          var dest = data && (data.data || data.path || data);
          if (dest) { dest = decodeURI(String(dest).replace(/^file:\/\//, "")); fs.writeFileSync(dest, text, "utf8"); return UI.toast("Saved."); }
        }
      } catch (e) {}
      try { var out = path.join(os.homedir(), "Downloads", suggested); fs.writeFileSync(out, text, "utf8"); UI.toast("Saved to Downloads."); }
      catch (e2) { UI.toast("Save failed: " + e2.message, true); }
    },

    /* ---------- lifecycle ---------- */
    activate: function () {
      UI.build();
      if (UI.ready) return;
      UI.setStatus("busy", "Checking the local engine…");
      if (!NODE) { UI.setStatus("err", "Open this panel inside After Effects to use Voice AI."); return; }
      Installer.ensureBackend(function (stage, text) { UI.setStatus("busy", text); }, function (err, r) {
        if (r && r.status === "connected") return UI.onConnected();
        // not connected → show gate (Setup)
        $("#vaGate", UI.root).classList.remove("va-hidden");
        $("#vaWorkspace", UI.root).classList.add("va-hidden");
        if (r && r.status === "need_install") UI.setStatus("", "VoiceStudio is not installed yet. Tap <b>Set up Voice AI</b> below.");
        else UI.setStatus("err", "Engine found but not responding. Tap <b>Set up Voice AI</b> to repair.");
      });
    }
  };

  /* ---- small render helpers --------------------------------------------- */
  function field(label, inner) { var f = el("div", "va-field"); f.appendChild(el("label", "va-label", label)); var w = el("div"); w.innerHTML = inner; f.appendChild(w.firstChild); return f; }
  function kvRow(k, v) { var r = el("div", "va-kv"); r.appendChild(el("span", "k", k)); r.appendChild(el("span", "v", String(v))); return r; }
  function badge(text, kind) { return el("span", "va-badge " + kind, text); }
  function progressBlock(id) { var p = el("div", "va-progress"); p.id = id; var b = el("div", "va-bar indeterminate"); b.appendChild(el("div", "va-bar-fill")); p.appendChild(b); p.appendChild(el("div", "va-progress-label", "<span class='t'></span><span class='p'></span>")); return p; }
  function resultBlock(id) { var r = el("div", "va-result"); r.id = id; return r; }
  function showProg(id, text) { var p = $("#" + id, UI.root); p.classList.add("on"); p.querySelector(".t").textContent = text || ""; return p; }
  function hideProg(id) { var p = $("#" + id, UI.root); if (p) p.classList.remove("on"); }

  function writeTemp(buf, prefix, ext) {
    var dir = path.join(os.tmpdir(), "RatinVoiceAI", "out");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    var f = path.join(dir, prefix + "_" + Date.now() + "." + ext);
    fs.writeFileSync(f, buf); return f;
  }
  function fileUrl(f) { return "file:///" + String(f).replace(/\\/g, "/").replace(/^\//, ""); }

  /* ---- defensive response normalizers ----------------------------------- */
  function normalizeVoices(d) {
    if (!d) return []; if (Array.isArray(d)) return d;
    return d.voices || d.data || [];
  }
  function normalizeModels(d) {
    if (!d) return []; if (Array.isArray(d)) return d; return d.data || d.models || [];
  }
  function normalizeEngines(d) {
    if (!d) return []; var arr = Array.isArray(d) ? d : (d.engines || d.data || d.tts || d.asr || []);
    return arr.map(function (e) {
      var id = e.id || e.engine || e.name;
      return {
        id: id,
        name: e.name || e.title || e.display_name || id,
        ready: !!(e.ready || e.installed || e.ready_to_use || e.available || (e.status === "ready")),
        size: e.size || e.download_size || e.bytes || 0
      };
    }).filter(function (e) { return e.id; });
  }
  function normalizeProfiles(d) {
    if (!d) return []; var arr = Array.isArray(d) ? d : (d.profiles || d.data || []);
    return arr.map(function (p) { return { id: p.id, name: p.name, language: p.language, kind: p.kind }; }).filter(function (p) { return p.id; });
  }

  /* ---- inline icons (stroke=currentColor) -------------------------------- */
  function icon(name, size) {
    var s = size || 16, a = "width='" + s + "' height='" + s + "' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'";
    var P = {
      wave: "<path d='M3 12h2M7 7v10M11 4v16M15 8v8M19 11v2M21 12h0'/>",
      user: "<circle cx='12' cy='8' r='4'/><path d='M4 21c0-4 4-6 8-6s8 2 8 6'/>",
      text: "<path d='M4 6h16M4 12h16M4 18h10'/>",
      gear: "<circle cx='12' cy='12' r='3'/><path d='M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-5l-.3 2.5a7 7 0 0 0-1.7 1l-2.4-1-2 3.5 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 1.7 1l.3 2.5h5l.3-2.5a7 7 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5a7 7 0 0 0 .1-1z'/>",
      download: "<path d='M12 3v12M7 10l5 5 5-5M5 21h14'/>",
      play: "<path d='M6 4l14 8-14 8V4z'/>",
      import: "<path d='M12 3v12M8 11l4 4 4-4M4 21h16'/>",
      mic: "<rect x='9' y='3' width='6' height='11' rx='3'/><path d='M5 11a7 7 0 0 0 14 0M12 18v3'/>",
      audio: "<path d='M9 18V6l10-2v12'/><circle cx='6' cy='18' r='3'/><circle cx='16' cy='16' r='3'/>",
      copy: "<rect x='9' y='9' width='12' height='12' rx='2'/><path d='M5 15V5a2 2 0 0 1 2-2h10'/>",
      refresh: "<path d='M21 12a9 9 0 1 1-3-6.7L21 7M21 3v4h-4'/>",
      wrench: "<path d='M14 7a4 4 0 0 1-5 5l-6 6 3 3 6-6a4 4 0 0 1 5-5l-2-2 1.5-1.5z'/>",
      trash: "<path d='M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'/>",
      check: "<path d='M4 12l5 5L20 6'/>"
    };
    return "<svg " + a + ">" + (P[name] || "") + "</svg>";
  }

  /* ========================================================================
   * Wiring: add the view + hook the cat-row (non-invasive)
   * ====================================================================== */
  function ensureView() {
    var sr = document.getElementById("scrollRegion");
    if (!sr) return null;
    var v = document.getElementById("voiceaiView");
    if (!v) { v = el("div", "capturer-inline"); v.id = "voiceaiView"; v.style.display = "none"; sr.appendChild(v); }
    UI.root = v; return v;
  }

  function setActive(on) {
    document.body.classList.toggle("cat-voiceai", !!on);
    var v = document.getElementById("voiceaiView");
    if (v) v.style.display = on ? "block" : "none";
    if (on) UI.activate();
  }

  function init() {
    ensureView();
    var catRow = document.getElementById("catRow");
    if (!catRow) return;

    // Add our tab button if not present.
    if (!catRow.querySelector('[data-cat="voiceai"]')) {
      var b = el("button", "cat-btn voiceai-btn");
      b.setAttribute("data-cat", "voiceai");
      b.setAttribute("title", "Ratin AI Voice");
      b.setAttribute("aria-label", "Ratin AI Voice");
      b.innerHTML = "<span class='cat-ico' aria-hidden='true'>" + icon("wave", 24) + "</span><span class='cat-label'>Voice AI</span>";
      catRow.appendChild(b);
    }

    // Capture-phase listener so we react before/independently of main.js.
    catRow.addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest(".cat-btn") : null;
      if (!btn) return;
      var cat = btn.getAttribute("data-cat");
      if (cat === "voiceai") {
        // Let main.js clear other state, then assert ours.
        setTimeout(function () { setActive(true); }, 0);
      } else {
        if (document.body.classList.contains("cat-voiceai")) setActive(false);
      }
    }, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  // expose for debugging / other scripts
  window.RatinVoiceAI = { VS: VS, Installer: Installer, UI: UI };
})();
