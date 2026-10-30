# SDW Directory Structure & Guidelines

Baseline directory layout for consumer projects adopting Spec-Driven Workflow:

```text
{projectRoot}/
└── .sdw/
    ├── config.json              # Main project workflow configuration
    ├── config.schema.json       # JSON Schema definition for config.json validation
    ├── directory-structure.md   # Structural guidelines and layout rules
    ├── specs/                   # Target directory for canonical specifications
    ├── state/                   # Ephemeral execution run state files (*.state.json)
    │   └── {slug}/{runId}/      # Step artifacts ({slug}-step-{N}.md), dispatch prompts
    │                            # (task-{taskId}.prompt.md), task evidence (task-{taskId}.evidence.json),
    │                            # and Step 5 judge files (step-5-judge.prompt.md, .verdict.json)
    ├── memory/                   # Product knowledge entries (versioned)
    │   └── traps.md              # Central anti-regression trap log
    └── worktrees/               # Ephemeral per-task git worktrees (command mode only)
```

## Skills Installation Topologies

SDW supports three installation topologies with automatic `{skillsRoot}` token resolution in `.sdw/config.json`:

1. **Canonical Development Repository:** `{projectRoot}/skills/`
2. **Consumer Project-Local Vendoring:** `{projectRoot}/.agents/skills/`
3. **User-Wide Shared Installation (Hybrid Mode):** `$HOME/.agents/skills/`

In **Hybrid Mode**, skills are installed once globally under `$HOME/.agents/skills/` and shared across all projects on the workstation, while each consumer project strictly maintains its own isolated `.sdw/` directory. All configuration (`.sdw/config.json`), specs (`.sdw/specs/`), and run states (`.sdw/state/`) remain local to the consumer repository and never leak into global storage.
