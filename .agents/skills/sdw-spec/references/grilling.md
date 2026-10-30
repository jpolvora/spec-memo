# Spec Grilling — Round-Based Gap Interview

Grilling is the optional interview that turns a first draft into a specification the maintainer can defend. It is inspired by the `/grill-me` philosophy: ask in rounds, never ahead of settled prerequisites, and stop when nothing is left unstated.

It is not a plan-writing session and not a questionnaire. The maintainer owns the scope; the agent owns the questions.

## When to grill

- After the first canonical draft exists and before the header status becomes `awaiting-approval`.
- Run it when any of these is true: ACs are ambiguous, the spec mixes areas, an assumption is still `Confirmed: No`, or a DoR row has no verification method.
- Skip it when the draft is already precise, every assumption is confirmed, and the spec touches one feature. A spec that needs no grilling moves straight to `awaiting-approval`.

## The frontier rule

A question belongs in the current round only when its prerequisites are already settled. The round asks the whole frontier at once; never ask something that depends on an answer not yet given.

- Round 1 usually settles scope and boundaries.
- Round 2 settles behaviour that depended on scope.
- Round 3 settles evidence, verification, and failure handling.
- Round 4 closes leftovers and confirms the split decision.

Count rounds, not questions. Four rounds and a few dozen questions is an ordinary session. Do not drip one question per turn.

## Gap taxonomy

Walk every branch; a branch with no gap produces no question.

| Branch | Question to force | Lands in |
|---|---|---|
| Domain boundary | Does this spec describe one independently deliverable area, or several? | Split decision |
| Scope | What must this spec never do? | `## Out of Scope` |
| Behaviour | What exactly happens on the happy path, and on each failure? | ACs |
| Inputs | What are the bounds, defaults, and invalid values? | ACs, Notes |
| Persistence | What is stored, where, and for how long? | Notes, ACs |
| Dependencies | What must exist before this spec can run? | DoR |
| Observability | Which command proves the behaviour, and what does it print? | Validation notes |
| Evidence | What artifact proves each acceptance criterion? | DoR, ACs |
| Assumption | Is any chosen default still marked unconfirmed? | Assumptions |

## Focus and splitting

Default unit is **one feature per spec**.

- If the draft spans multiple domains, areas, or groups of modifications, stop and propose a split **by feature** before asking behaviour questions.
- One spec per area, each independently implementable. Name the split explicitly and create only the specs the maintainer approves.
- Do not use one spec as an umbrella for unrelated changes; cross-reference sibling specs in `## Notes` instead.
- A spec that needs more than roughly 15 ACs is a split signal, not a grilling signal.

## Rules of the interview

1. Ask in rounds, several questions per round, each with a recommended default and the tradeoff.
2. Never re-ask what the spec already answers; quote the line when the answer is already there.
3. Challenge a vague answer once, with a concrete alternative. Passivity ("agreed") is the failure mode.
4. "I don't know" is a valid answer. Mark it as an open question and stop; do not invent.
5. Some questions are ungrillable by conversation: they need a prototype, a measurement, or an inspection of the code. Stop grilling that branch, observe, then return with one question.
6. If the round count grows because the scope is too large, split first. Long sessions are a scope symptom.
7. Do not write implementation files, code, or plans during grilling. The only writes are to the spec being grilled, after the round's answers are settled.

## Recording the answers

- Confirmed assumption: update the `## Assumptions & Open Questions` row and set `Confirmed` to `Yes`.
- Changed requirement: edit the AC, keep it atomic and in EARS form.
- New decision: add one assumption row and one rationale, never a hidden default.
- Unanswerable: keep `Confirmed` as `No` and park it as an explicit open question.

## Done when

- Every assumption row is `Confirmed: Yes`, or an explicit open question is accepted by the maintainer.
- Every DoR row names a verification method.
- The focus check passed, or the split was approved and the sibling specs were named.
- `validate_spec.cjs --mode=authoring` exits `0`.
- Only then move the header status to `awaiting-approval`.
