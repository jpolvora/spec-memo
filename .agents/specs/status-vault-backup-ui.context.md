# status-vault-backup-ui — design companion

## Feature Boundary

Status monitor gains **two** mutating HTTP endpoints and matching UI controls for vault snapshot export (download zip) and restore (upload zip). Everything else on `:3001` stays read-only. No MCP/CLI expansion.

## Implementation Decisions

### Optional encryption in UI

- **Export:** show a modal with optional password field (empty = plaintext JSON inside zip, same as CLI without `--password`).
- **Import:** if extracted JSON has `format: spec-memo-encrypted-vault-v1`, require password before POST; show inline error on decrypt failure.
- Password never sent to activity bus, logs, or localStorage.

### Import overwrite confirmation

- Before upload, confirm dialog: "Import will merge records from the archive into the local vault and overwrite existing records with the same paths. Continue?"
- Default `importVault({ overwrite: true })` — no silent import without confirmation click.

### Zip layout

```
spec-memo-vault-{projectId}-{timestamp}.zip
└── vault-backup.json   # UTF-8 JSON from exportVault payload
```

Import accepts zips where `vault-backup.json` exists **or** exactly one `.json` member (CLI-manual zip convenience).

## Deferred Ideas

- Export all projects in one zip from **All vaults** mode.
- Remember last export timestamp per project in `localStorage` reminder badge.
- Drag-and-drop import drop zone on the vault list panel.
