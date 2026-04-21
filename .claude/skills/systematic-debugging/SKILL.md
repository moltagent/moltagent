---
name: systematic-debugging
description: Systemic-before-reductionist diagnosis. Apply whenever a bug is reported, a test fails, a log line looks wrong, or code is being added in response to something breaking. The first question is always what CLASS of problem this is, not how to make this specific instance work. Two instances of the same pattern = stop patching, find the generating function. Load PROACTIVELY at the start of any bug investigation, failure analysis, or debugging session.
---

# Systematic Debugging

## The first question is never "how do I fix this"

It is: **what class of problem is this, and what generates that class?**

When a failure appears, resist the immediate pull toward "change this line." The right fix at the right altitude replaces five fixes at the wrong altitude. "Less code, not more" is not an aesthetic preference — it is a signal that the fix is structural rather than incidental.

## The diagnostic sequence

1. **Gather evidence before hypothesis.** Read the actual log lines. Read the actual failing test. Read the actual file involved. Do not synthesize an explanation from partial reads — the pattern-matching instinct will fabricate a plausible story that is not what is happening.

2. **State the observed behavior as behavior, not judgment.** Not "the code is wrong" — "the function returns X when inputs are Y." Behavior is falsifiable. Judgment is not.

3. **Ask: is this an instance, or a generator?**
   - *Instance:* this specific call, this specific input, this specific edge case.
   - *Generator:* the structural reason this class of failure is possible at all.
   - If two bugs in different places turned out to share a root cause, the generator is that shared root.

4. **Is this regex for intelligence?** A failure often leads to "just add a check for X." If X is natural language, keyword detection, or post-classifier override, the fix is at the wrong altitude. Strengthen the LLM component instead — better prompt, better examples, better model. See moltagent-dev-rules skill.

5. **BUILT ≠ VERIFIED.** Green tests can mask silent runtime failures. After any fix, produce evidence from real production behavior — a log line showing the new path executed, a query against the live system, an observable state change. Tests confirm the fix doesn't regress. Production evidence confirms it actually runs. The Verification Gate in moltagent-dev-rules.md and the Stop hook that enforces it exist precisely to prevent green-test rationalization.

6. **Commit size is a signal.** If a fix adds more lines than it removes, question the altitude. Sometimes additive is correct. Often it is patching an instance while the generator continues to produce new instances.

## Generator-level fixes — examples from the issue tracker

- **Two independent PAUSED readers returning different results** → consolidate to one canonical reader. (Issue #23 closed the generator that produced #22.)
- **Stop-word list growing to handle German and Portuguese** → replace the stop-word approach with LLM-based keyword extraction.
- **Post-classify guard overriding the LLM** → fix the classifier prompt, remove the guard.
- **DEEP_READ Meta filter running before the observation generator** → reorder so the generator sees everything; the filter applies only to the user-facing response. (Issue #29.)
- **WikiSteward conflating "no retrieval traffic" with "not useful"** → disambiguate the signal, either by type-aware logic, explicit pinning, or an additional write site. (Issue #30 captures all three options in-situ.)

## The anti-pattern: instance patching

Symptoms:
- Each new language, edge case, or input class requires a new code change.
- The function grows branches instead of responsibility shrinking.
- The fix works on the reported case but you can list five others that would trigger the same class.

If any of these hold, stop. Write down what the generator is. Propose the generator-level fix. Compare scope. Decide explicitly whether to fix the generator now, fix the instance now with a generator-level follow-up issue filed, or revise scope.

## Zoom sequence: 50% analysis, 50% synthesis

- **Zoom in:** what exactly happens in this case? Get the evidence from logs, tests, live queries.
- **Zoom out:** what other cases would produce the same symptom? What is the shared structure?
- **Synthesize:** where does the fix belong — at the symptom site, or upstream at the generator?

Both modes matter. Neither alone is sufficient. Reductionist thinking produces instance patches; holistic thinking without evidence produces architectural astronautics. The target is the interplay, not either pole.

## When an instance patch is genuinely correct

Sometimes the generator-level fix is out of scope for the session, or the structural work is too large for the current window. That is fine. But in that case:

- Document the generator in the commit message or in a linked GitHub issue.
- Label the instance patch explicitly ("instance patch for #NN; generator-level fix tracked as #MM").
- Do not let the instance patch pretend to be a resolution. It closes the symptom, not the class.

## The final diagnostic gate

Before declaring a diagnostic done:

1. Is the evidence from real production, not just from tests?
2. Have I named the generating function, not just the instance?
3. If I fix only this instance, will three more instances appear from the same generator within the next week?
4. Is my fix at the altitude of the generator, or at the altitude of the instance? Was that choice explicit?
5. Is my `[VERIFIED: ...]` marker concrete — naming the command I ran and the observed result — rather than vague?

If any answer is uncertain, the diagnostic is not done.

## Cross-reference

- The eight-rule checklist in the moltagent-dev-rules skill is the final gate *before committing code*.
- The Verification Gate in the same skill is the final gate *before declaring a session done*.
- This skill is the diagnostic gate *before deciding what code to write*.
- All three apply, in that order.
