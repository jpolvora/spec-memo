# Anti-Patterns Catalog: Common LLM Overengineering Traps

This catalog details recurring pitfalls observed in LLM agent code and specifies concrete avoidance criteria.

---

## 1. Speculative Configurability
- **Symptom:** Adding 5 new options to `config.json` that were neither requested nor needed for the immediate acceptance criteria.
- **Why it hurts:** Inflates documentation, demands extra validation logic, increases testing matrix.
- **Directive:** Only add configuration properties explicitly requested in specifications. Default behaviors should be convention-based.

## 2. Inventing Unasked Subcommands / CLI Machinery
- **Symptom:** When asked to write a script that does X, creating an entire interactive CLI framework with 8 subcommands, colors, and spinners.
- **Why it hurts:** Unnecessary lines of code to maintain; breaks agnosticism.
- **Directive:** Implement only the subcommands defined in the specification. Use standard stdout/stderr and exit codes.

## 3. Class Hierarchies for Single-Use Logic
- **Symptom:** Creating `AbstractBaseHandler`, `DefaultHandlerFactory`, `HandlerRegistry` when only a single function is called.
- **Why it hurts:** Obscures data flow, burns tokens during context ingestion, complicates debugging.
- **Directive:** Prefer plain functions and standard CommonJS modules. Introduce abstractions only upon the third distinct concrete use case (Rule of Three).
- **Example:** a prefix transform implemented as a registry, an abstract base class, and one concrete transformer takes ~50 lines; the actual requirement is `function addPrefix(input, prefix = 'v1') { return \`${prefix}:${input}\`; }`. Write the two-line function.

## 4. Adjacent Code "Refactoring" / Formatting Drift
- **Symptom:** Modifying whitespace, sorting imports, or "modernizing" syntax in unrelated functions in the same file.
- **Why it hurts:** Pollutes `git diff`, makes code review painful, risks regressions in unrelated areas.
- **Directive:** Surgical diffs only. Touch strictly lines relevant to the current task.

## 5. Composite / Vague Acceptance Criteria
- **Symptom:** Authoring acceptance criteria like `The system shall do X, Y, and Z while handling errors gracefully.`
- **Why it hurts:** Hard to score deterministically (0–10); hides failure states.
- **Directive:** Atomic EARS criteria. One condition, one response, one verification method.

## 6. Acting Without Explicit Instruction
- **Symptom:** Treating a topic statement, observation, or design musing (e.g. "I am changing the way X handles Y") as authorization to implement, edit files, or commit, without the user ever issuing a command or approving a plan.
- **Why it hurts:** Produces unrequested work and irreversible side effects (commits, pushes, mutations); forces the user to review or revert actions they never asked for; erodes trust in agent autonomy boundaries.
- **Directive:** Act only on an explicit user command or an approved plan. When intent is ambiguous in any way, stop and ask for clarification first. Never infer authorization, and never decide on the user's behalf.
