# 0047 vault-merge-alias — context

## Feature Boundary

In: operator-managed aliases so multiple `projectId`s resolve to one canonical vault project; status Vaults tab and `memo vault` CLI; optional copy of records into the canonical folder.

Out: rewriting git remote normalization; MCP tools; merging two different `SPEC_MEMO_ROOT` trees; auto-guessing aliases from similar names.

## Implementation Decisions

1. **Redirect is the merge.** Writes always hit the canonical folder after alias follow. Optional `copyRecords` imports history from source folders once; it is not required for new upserts after aliasing.
2. **Canonical id is chosen by the operator** (create `marchanterp` then alias both names onto it). Do not auto-create a hashed third id.
3. **Do not delete source folders on merge.** Delete is a separate confirmed action. Aliases stop new knowledge from landing in the empty/wrong folder.
4. **`config.json` `projectAliases` is the SoT.** Resolution happens in `resolveProjectIdentity` (or a helper it calls) so every tool path follows the map.

## Deferred Ideas

- Suggest likely duplicates by displayName / remote string similarity.
- Junction/symlink of `projects/{alias}` to the canonical directory on filesystems that support it.
- Hybrid daemon push of alias maps as their own changeset type (v1: aliases live in vault config and sync with config like other settings).
