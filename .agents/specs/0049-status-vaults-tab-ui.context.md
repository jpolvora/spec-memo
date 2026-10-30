# 0049 status-vaults-tab-ui — context

## Feature Boundary

In: status monitor Vaults tab (`:3124`) action UX (modals instead of `prompt`/`confirm`) and per-project **Push / Pull / Both** sync that reuses hybrid HTTP and vault-git engines already used by `memo sync`.

Out: other status tabs; MCP tools; changing `0047` alias/merge JSON contracts; treating backup zip export/import as sync; rewriting SSE `:3123` `/api/sync/*` prefer inversion.

## Implementation Decisions

1. **One parameterized overlay** (`modal-vault-action`) rather than six copy-pasted overlay blocks, still using existing `.modal-overlay` / `.modal-card` styles. Delete uses the destructive border treatment already on backup delete.
2. **Sync = `syncDual` / hybrid pull-push**, not download/upload of zip files. Pull (down) = remote → this vault; Push (up) = this vault → remote.
3. **Vault-git** participates on push and both (`flushVaultGit`). Pull-only is hybrid HTTP when hybrid is on; if only vault-git is enabled, pull-only still flushes git (pull then push is how `flushVaultGit` works) unless a later slice splits git pull vs push.
4. **In-process hybrid client:** status `:3124` calls `syncHybrid` in the same Node process. `prefer: local` means this host. Do not invert prefer/strategy here.
5. **Visible wrapping action buttons**, not a kebab menu, because the request asked for side-by-side controls that open forms.

## Deferred Ideas

- Native `<dialog>` element instead of `.modal-overlay` (works, but would fork from Backups CSS).
- Sync-all toolbar action (rejected for v1: `id: all` is 400, same as derive-rules refusing vault=all).
- Live sync progress SSE in the modal (banner + busy disable is enough).
- Suggest duplicate vaults by name similarity (belongs with `0047` deferred list).
