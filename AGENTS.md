# Project conventions

- Every update must also update README.md, including the change log and relevant usage or limitations.
- README.md and committed documentation must not contain absolute local paths, usernames, email addresses, tokens, or machine-specific information.
- Keep provider data demonstrative until a real integration is explicitly requested. Label sample quotas and activity in the UI.
- The panel must always be collapsible to a side rail. Single-column width follows `electron/window-policy.cjs` (screen height ÷ 3.4, 300–420 px); the old 4.5 : 1 and 0.5 : 1 : 1 : 1 : 1 ratios are retired.
- The renderer offers three skins (watch / dial / party), each with light, dark and anime variants. Keep all of them working when changing shared view code in `src/view/`.
- Use Electron's main process for OS capabilities and a narrow validated preload bridge. Keep the renderer sandboxed.
- macOS is the current acceptance platform. Describe Windows/Linux support as prepared until verified on those systems.
- Do not commit build outputs, local preferences, authentication material, or user-selected images.
