# Feature Boundary

Status monitor **chrome** (left categorized nav), **Home dashboard** of counts from other pages, **error.logs viewer**, and **AI config editor**. Not a new MCP tool, not Canvas, not extra LLM providers.

# Implementation Decisions

1. **Keep `id="tab-*"` panels** and `data-tab` on sidebar leaves so existing JS (rules jump, vaults `?tab=`) stays valid.
2. **UI `noop` vs disk `enabled: false`** mapping so the select matches operator language without a new config enum.
3. **Host `tab-ai-ops` in the AI category** even if spec 0057 lands later; do not duplicate `/api/ai-ops`.
4. **Read error.logs from the tail (2 MiB)** instead of streaming the whole file into the browser.
5. **Home is the default `?tab=`** (`home`); Activity remains a full page under Overview, not deleted.
6. **Dashboard is counts/health cards** from `GET /api/dashboard`, not charts or a duplicate live SSE log.

# Deferred Ideas

- Implementing `opencode` / `freellmapi` providers (show disabled in the select)
- Truncate/rotate `error.logs` from the UI
- Editing `ttl` / ports / vaultGit from the same settings area
- Keyboard shortcut palette for pages
