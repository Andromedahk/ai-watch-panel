<!-- agent-spec/1 · tgt=ai-watch-panel@0.19.1 · ref=main · enc=utf8 · lang=en+zh-tokens -->
# AGENT-README

```
§0 SIGIL
  ⊢ must   ⊬ must-not   ⇒ yields/then   ⟂ unsupported|unverified   ≔ default
  ⟦…⟧ enum   ⟨…⟩ placeholder   ∈ member-of   ↦ maps-to   ⌁ optional   ✓ verified   ~ prepared≠verified
  [M]=electron main  [P]=preload  [R]=renderer(sandboxed)  [N]=native  [S]=script  [T]=test
  ~/ = $HOME of runtime user   UD = app.getPath('userData')   PO = PROVIDER_ORDER
```

```
§1 ID
  pkg: ai-watch-panel  ver: 0.19.1  prod: "AI Watch"  appId: app.aiwatch.panel
  kind: desktop-panel(vertical) · aggregates {activity, wait-attention, quota|credit|balance} of local AI clients
  stack: electron@44.5.1 + react@19 + ts@5.9 + vite@8 (+ swift/WidgetKit ⌁)
  module: type=module; main=electron/main.cjs (CJS in electron/, ESM in scripts/)
  plat: darwin=✓acceptance · win32=CI-build+NSIS-install+fixture-smoke ✓, live-providers ⟂ · linux=~ (AppImage target, no release)
  repo: https://github.com/Andromedahk/ai-watch-panel
```

```
§2 TREE  (path : role)
  electron/main.cjs              [M] lifecycle, BrowserWindow, Tray, ipcMain handlers, prefs IO, status loop
  electron/preload.cjs           [P] contextBridge → window.panel.* (sole R↔M surface)
  electron/window-policy.cjs     [M] validPreferences(), PO, bounds math, enum guards
  electron/window-layout.cjs     [M] single|double|fullscreen transitions
  electron/local-status.cjs      [M] LocalStatusReader: fan-out to per-provider readers ⇒ LocalStatus
  electron/{claude,codex,deepseek,zcode,kimi,kimi-work,qwen,workbuddy}-*.cjs  [M] provider adapters
  electron/claude-hooks.cjs + claude-hook-logger.cjs   [M] ⌁ Claude Code user-settings hook install/remove
  electron/codex-attention*.cjs + json-*frame-decoder.cjs  [M] Codex IPC stream (unix sock) wait-state parse
  electron/lan-sync.cjs + lan-sync-controller.cjs      [M] LAN host/client sync
  electron/panel-tray.cjs, tray-summary.cjs            [M] menubar/tray + quota glance
  electron/widget-{publisher,snapshot}.cjs             [M] ⌁ WidgetKit snapshot bridge
  electron/i18n.cjs + locales/*.json                   [M+R] 17 langs (incl RTL ar/he)
  electron/native/*.c            [N] darwin helpers ⇒ electron/native/bin/ (gitignored, built by build-native)
  native/macos/*.swift           [N] ⌁ WidgetKit ext + Node-API bridge (macOS14+)
  src/main.tsx, App.tsx          [R] root
  src/view/{insights,parts,model,skins}.tsx|.ts|.css   [R] shared view ×3 skins
  src/view/quips.json            [R] mascot lines 8×150 (zh+en)
  src/journal.ts                 [R] local timeline/trend store (≤300 ev / 24h)
  src/SyncSettings.tsx, TestControls.tsx, test-mode.ts [R]
  images/                        vite publicDir (logos, images/anime/*.png)
  scripts/dev.mjs                [S] vite(127.0.0.1:5173) + electron, env AI_WATCH_DEV_URL
  scripts/build-native.mjs       [S] darwin: clang -arch arm64 -arch x86_64 → native/bin/*; else no-op
  scripts/verify-*.mjs           [S] playwright-electron acceptance, isolated profile
  tests/*.test.cjs               [T] node --test unit; tests/fixtures/local-status.json = synthetic status
  .github/workflows/release.yml  CI: workflow_dispatch{publish:bool≔false}
  docs/*.md                      per-provider integration notes, QA, releases/vX.md
  AGENTS.md, CLAUDE.md, Agent Log.md  repo rules + change journal
```

```
§3 FLOW
  boot[M]: readPreferences(UD/preferences.json) → validPreferences ⇒ prefs
         → cacheCleanupPending? clearStartupDiskCaches
         → LanSyncController.apply(syncRole, syncPort)
         → claudeHooksEnabled? applyClaudeHooks(true)
         → BrowserWindow(panelBounds(workArea, side, layout)) load (AI_WATCH_DEV_URL ?? dist/index.html)
  loop[M]: LocalStatusReader.read() ⇒ statusSnapshot ⇒ send 'panel:status-changed' → [R]
         syncRole=host ⇒ lanSync.publish(status) ; syncRole=client ⇒ local readers off, accept remote
  [R]→[M]: invoke 'panel:<verb>' via window.panel.<fn> ; [M]→[R]: 'panel:changed' | 'panel:status-changed' | 'panel:journal-changed'
  sec: webPreferences{contextIsolation:1,nodeIntegration:0,sandbox:1}; creds ⊬ leave M; CSP(index.html): default-src 'self'; connect-src 'self' ws://127.0.0.1:*
```

```
§4 IPC  window.panel.* ↦ channel 'panel:*'
  read  : getState→state · getStatus→status · refreshStatus→refresh · store · widgetBackground · getRemoteJournal→remote-journal
  sub   : onState(changed) · onStatus(status-changed) · onRemoteJournal(journal-changed)
  win   : setLocked→lock · setCollapsed→collapse · setLayout→layout · dock · quit
  look  : setTheme→theme · setSkin→skin · setLanguage→language · setAnimeMode→anime-mode · configure
  mods  : setOrder→order · setEnabled→enabled · setInsights→insights · setInsightOrder→insight-order · setMascotInterval→mascot-interval
  src   : setKimiSource→kimi-source · setClaudeSource→claude-source · setClaudeNetworkAccess→claude-network-access
          setClaudeHooks→claude-hooks · requestClaudeActivityAccess→claude-activity-access · setQwenAccess→qwen-access
  app   : openProvider→open-provider · chooseProviderApp→choose-provider-app · chooseImage→image · openRepository→open-repository
  sync  : setSyncRole→sync-role · setSyncPort→sync-port · pairSync(addr,code)→sync-pair · forgetSync→sync-forget
          regenerateSync→sync-regenerate · discoverSync→sync-discover · shareJournal→journal
  misc  : setWidgetsEnabled→widgets-enabled · clearCache→clear-cache
  ⊢ new channel ⇒ add in preload.cjs + ipcMain.handle in main.cjs + validator in window-policy.cjs
```

```
§5 PREFS  UD/preferences.json  (validPreferences; invalid ⇒ ≔)
  side⟦left,right⟧≔right  locked:bool≔0  animate:bool≔1  language≔zh-CN  theme⟦system,light,dark⟧≔system
  skin⟦watch,dial,party⟧≔watch  layout⟦single,double,fullscreen⟧≔single  windowLayout⟦single,double⟧≔single
  animeMode≔0  insights{timeline,resets,trend,mascot:bool}  insightOrder≔[resets,trend,timeline,mascot]
  mascotInterval: 0(off)|5..300 s ≔15
  kimiSource⟦code,work⟧≔code  claudeSource⟦desktop,code⟧≔desktop
  claudeNetworkAllowed≔0  claudeHooksEnabled≔0  qwenKeychainAllowed≔0  widgetsEnabled≔0
  syncRole⟦off,host,client⟧≔off  syncPort: 1024..65535 ≔47321
  providerOrder ⊆ PO, enabledProviders ⊆ PO ; PO=[claude,codex,antigravity,deepseek,zcode,kimi,qwen,workbuddy]
  providerApps{id:path}, kimiWorkApp  ⇒ private: stripped from R state & LAN sync
  other UD files: claude-desktop-plan.json, claude-config/ (test profile only), lan-sync.json, user-selected images
  ⊬ commit UD content
```

```
§6 PROVIDERS  id : local-source → data  (all read-only; ⊬ login/renew/approve on user's behalf)
  claude      : ~/.claude (sessions/<pid>.json, settings), ~/.config, Claude desktop AppSupport
                ⌁net(claudeNetworkAllowed, reuse existing login, may prompt keychain) ⌁hooks ⌁AX(darwin accessibility for desktop chat)
  codex       : ~/.codex (CODEX_HOME), ipc/ipc.sock stream(v11, ≤32 sessions, frame≤256MiB) ; quota via official client acct API ; win32 attention ⟂
  antigravity : ~/.gemini/antigravity + running local language_server (127.0.0.1) ; client-internal API, version-fragile
  deepseek    : ~/.dsh (v4 session events, procs, locks) ; balance via platform.deepseek.com w/ existing login ; CNY/USD split
  zcode       : ~/.zcode ; BigModel personal Coding Plan only
  kimi        : code ⇒ ~/.kimi | ~/.kimi-code (file OAuth) + api.kimi.{ai,com}/coding/v1 ; work ⇒ kimi-desktop AppSupport (running client)
  qwen        : Qianwen AppSupport + keychain (gate: qwenKeychainAllowed) ; qianwen.com member API
  workbuddy   : ~/.workbuddy + WBIPC local channel
  unknown≠free ; quota units never summed ; stale ⇒ flagged ; missing ⇒ "unknown"
  per-provider detail: docs/{ZCODE,KIMI,KIMI-WORK,QWEN,WORKBUDDY,PLAN}-INTEGRATION.md
```

```
§7 LAN-SYNC
  host: HTTP 0.0.0.0:<syncPort≔47321> base=/ai-watch/v1 PROTOCOL=1 ; discovery UDP 47322 broadcast
    GET  /hello   ⇒ {protocol,name}
    POST /pair    {code(6-digit), client} ⇒ long random token (host stores digest only; rate-limited)
    GET  /events  Authorization: Bearer <token> ⇒ text/event-stream (status, journal)
  accept: private LAN + loopback only ; reject requests w/ browser Origin ; payload sanitized (no creds/keys/paths/images/hook cfg)
  client: stops local readers, renders host data, auto-reconnect ; plaintext HTTP ⇒ trusted net only
  darwin first host enable ⇒ OS incoming-connection prompt ⇒ allow
```

```
§8 DEPLOY.local
  req: node ≥22.16 (CI pins 22.22.2) + npm ; git
       darwin: Xcode CLT (clang; swift ⌁ for widgets) ; win: none extra ; linux ~
  net: npm registry + electron binary download (or reuse §8.alt)

  S1 git clone https://github.com/Andromedahk/ai-watch-panel && cd ai-watch-panel
  S2 npm ci                              # postinstall fetches electron dist
  S3 dev   : npm run dev                 # vite 127.0.0.1:5173 strictPort + electron
     web   : npm run dev:web             # browser preview only, no OS caps
  S4 build : npm run build               # build-native(darwin) && tsc --noEmit && vite build ⇒ dist/
     run   : npm start                   # electron . (loads dist/)
  S5 pack  : npm run pack:mac            # ⇒ release/mac*/AI Watch.app (ad-hoc sign, identity "-")
             npm run dist:mac            # ⇒ release/AI-Watch-<v>-mac-{arm64,x64}.{dmg,zip}
             npm run dist:win            # ⇒ release/AI-Watch-<v>-win-x64.exe (NSIS, runAfterFinish=0)
             npm run dist:linux          # ⇒ AppImage ~
  S6 smoke : npm run test:release -- "<packaged executable>"   # fixture status + temp profile, no real acct
  §8.alt electron dl blocked ⇒ npx --no-install electron-builder --mac --dir --config.electronDist=node_modules/electron/dist
  install(darwin): quit running app fully (menu quit|⌘Q; close ≠ quit) → backup old .app + UD → replace .app → launch ; UD kept
    ⊬ overwrite running app ; re-sign ⇒ may need re-grant Accessibility on final copy
  post: user installs+logs in target AI clients first ; opt-ins in 配置→数据来源 (claude net/hooks/AX, qwen keychain)
  gatekeeper/smartscreen: unsigned/un-notarized ⇒ OS prompt ; ⊬ advise disabling OS protection globally
  release(CI): Actions "Release installers" on main ; publish≔false ⇒ artifacts only ; publish=true ⇒ draft→verify sha256→public ; notes=docs/releases/v<ver>.md
```

```
§9 VERIFY
  unit   : npm test                      # node --test tests/*.test.cjs ; runs on linux w/o electron GUI
  types  : npx tsc --noEmit
  core   : npm run build · test:skins · test:layouts · test:insights · test:codex-attention · test:corners · test:i18n · test:lan-sync
  extra  : test:{desktop,tray,motion,sort,theme,modules,ui,anime,credits,plans,quotas,kimi-work,resources}
  widgets: build:widgets -- --check · test:widgets:bundle · test:widgets · preview:widgets (darwin)
  ⊢ electron UI checks sequential (native window focus contention)
  ⊢ node_modules arch-specific ⇒ reinstall per OS/arch (@rolldown/binding-*, electron dist)
  live-acct QA ⇒ AI_WATCH_LIVE_QA=1 ; screenshots from live QA ⊬ commit
```

```
§10 ENV
  AI_WATCH_DEV_URL        renderer URL (dev.mjs sets)
  AI_WATCH_TEST_PROFILE   override UD (isolated profile)
  AI_WATCH_TEST_STATUS    ⟦fixture,glow-running,glow-attention⟧ + TEST_PROFILE ⇒ synthetic status, net/keychain off
  AI_WATCH_TEST_WIDGETS=1 mock widget bridge (needs TEST_PROFILE+TEST_STATUS)
  AI_WATCH_LIVE_QA=1      enable real-account verify scripts
  AI_WATCH_KEEP_OPEN, AI_WATCH_INSIGHTS_OUTPUT, AI_WATCH_MOTION_OUTPUT, AI_WATCH_QA_PROXY   verify-script knobs
  AI_WATCH_SIGN_WIDGETS, AI_WATCH_APPLE_TEAM_ID, AI_WATCH_APP_GROUP, AI_WATCH_BUILD_NUMBER, AI_WATCH_WIDGET_ARCH,
  AI_WATCH_NODE_HEADERS, AI_WATCH_ELECTRON_DIST, CSC_NAME, DEVELOPER_DIR   widget build/sign (docs/MACOS-WIDGETS.md)
  CODEX_HOME              Codex data root ≔ ~/.codex
```

```
§11 INVARIANTS (from AGENTS.md; ⊢ on every change)
  I1 change ⇒ prepend signed entry in "Agent Log.md" + README.md 更新记录 entry (signature: agent/model/env)
  I2 docs ⊬ {abs local path, username, email, token, device info}
  I3 provider data demonstrative unless real integration requested ; sample data labeled in UI
  I4 panel always collapsible to rail ; col width = screenH/3.4 clamp[300,420] px ; collapsed=64
  I5 skins×variants = {watch,dial,party}×{light,dark,anime} all must work when touching src/view/
  I6 OS caps in [M] only ; [P] narrow+validated ; [R] sandboxed
  I7 darwin = acceptance plat ; win/linux claims = prepared until verified
  I8 ⊬ commit {dist/, release/, electron/native/bin/, .local/, UD, auth material, user images}
  I9 read top of "Agent Log.md" before work
```

```
§12 FAIL→FIX
  vite port 5173 busy          ⇒ strictPort ⇒ free port | kill stale dev
  clang missing (darwin)       ⇒ xcode-select --install
  electron dl 403/timeout      ⇒ §8.alt | ELECTRON_MIRROR
  AX activity "denied"         ⇒ grant Accessibility to the installed copy (not dev electron) ; re-grant after re-sign
  provider "unknown/offline"   ⇒ client not running|not logged in|version drift ; not a panel crash
  tsc ok but test:* fail on linux ⇒ expected for darwin-only electron/native paths
```
