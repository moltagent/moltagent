---
name: public-content-discipline
description: Privacy and sensitivity screening for any content bound for public surfaces — GitHub issues, PRs, README, docs, blog posts, external communications. Load PROACTIVELY whenever drafting content that will be published, indexed, or shared beyond the project team. The privacy pass catches identifiable people, client names, internal codenames, and traceable information before publication, not after.
---

# Public Content Discipline

## When this applies

Any time you are drafting content that will appear on a public or indexed surface:

- GitHub issue bodies, PR descriptions, public commit messages
- README amendments, public documentation
- Blog posts, release notes, social content
- External emails likely to be forwarded or archived publicly
- Code comments that will be published (inline in shipped code, in open-source files)

## The trigger

Before drafting a single word of content, ask:

**"Is this going to a public surface?"**

If yes — the privacy pass runs. Not as a final polish step. As the first filter on the source material. The pass shapes the draft; it is not an audit after the draft is written.

## The privacy pass

Screen the draft and any source material being quoted for:

1. **Named individuals.** Full names, unusual first names, names tied to identifying roles. Abstract to "a person," "a collaborator," "an external contact" unless the user has explicitly confirmed publication of that specific name is intended.

2. **Real organizations.** Company names, institutions, client names. If the org is publicly associated with the project (contributors in README, public partners named in public materials), naming is fine. If the org appears in the knowledge base as a client or private contact, abstract.

3. **Internal project codenames.** Features under NDA, client engagements not yet announced, partnerships in negotiation, internal product names that haven't shipped publicly.

4. **File names carrying identifying content.** A filename like `CV_Jane_Doe.pdf` leaks a name even with no surrounding context. Abstract to "a CV file" or "[person's CV]." Filenames with project codenames (`ClientX_Q3_proposal.docx`) same treatment.

5. **Quotes from the knowledge base.** Anything retrieved from wiki, Deck cards, email, Talk, files, activity logs. Source material is not public material. Treat it as private by default and only quote what has been explicitly cleared for publication.

6. **Log excerpts with user content.** Command outputs, journald lines, stack traces may contain usernames, paths with personal names, query text with private information. Redact or abstract before including. CostTracker lines are typically safe (cost numbers, model names) — user-facing response logs are not.

## Response hierarchy when something is caught

1. **Abstract.** Replace the specific with a placeholder that preserves the structural point. Prefer this — the diagnostic or narrative value usually survives abstraction.

2. **Remove.** If the specific is not necessary to the point being made, cut it. Fewer words, no leak.

3. **Confirm before publishing.** For genuine edge cases where the specific carries real diagnostic value and abstraction would materially weaken the content, explicitly ask the user: "This draft includes [specific]. OK to publish?"

Default to 1 or 2. Option 3 is for the rare edge case, not a convenience door around the discipline.

## Post-publication catch

If something identifiable slipped through and went public:

- Surface it immediately. Do not wait for review.
- Propose edit or deletion of the public artifact.
- Document the miss so the pattern is visible to future sessions (an issue, a note in the dev-rules, or at minimum a comment in the PR where the fix lands).

Mistakes happen. Hiding them is what makes them compound.

## The meta-rule

Public content is a one-way door. Abstraction costs nothing. Leakage costs forever.

The asymmetry dictates the default: when uncertain, abstract. The cost of abstracting one more piece of information that could have stayed specific is zero. The cost of publishing one piece of information that should have been abstracted is real, and indexed, and potentially permanent.

## Cross-reference

- Rule 7 in `moltagent-dev-rules.md` (Prompt Updates, Not Code Guards) — this skill applies that rule one layer up: when drafts leak information, the fix is better discipline at drafting time, not a post-publication filter. The privacy pass IS the prompt update for public-content generation.
- `moltagent-dev-rules.md` § Verification Gate — adjacent discipline. Both follow the pattern "before declaring X done, run check Y." One for code, one for public content.
- Issue #36 — the near-miss that prompted this skill. A full list of real names from the knowledge base almost went into the issue body; caught before publication by the human operator. This skill exists so the catch doesn't depend on the human every time.
