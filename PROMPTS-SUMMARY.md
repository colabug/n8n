# Prompt Summary — Pokemon Node Take-Home

47 prompts in the build session; a later post-submission session is logged below. This is the decision-making arc, not a chronological log. Full prompt-by-prompt log: `docs/prompts.md`.

## Setting the Stage

The session started with the full assignment spec and a deliberate choice: spec before code. I filed the assignment as a real project — PRD with user stories, data shapes, workflow patterns, and a visual description of what the node looks like in the n8n editor. The goal was to think through the user experience before touching TypeScript.

I also set expectations for the process: TDD/BDD discipline, an audit trail of agent decisions, and a running prompt log. The submission artifacts needed to show how the thing was built, not just that it works.

## Adversarial Review

Three specialist agents (QA, PM, Architect) reviewed the plan independently, then debated live via messaging. This wasn't a rubber stamp — they found real issues. QA caught that the reference node's pagination pattern wouldn't work with PokeAPI's envelope structure. The Architect flagged that the reference node uses a deprecated API (`helpers.request()`). The PM argued correctly that a single-resource node doesn't need a resource dropdown.

I overruled one consensus recommendation: the trio wanted to cut Return All because the list endpoint only returns stubs. I pushed back — cutting it would signal to reviewers that the candidate couldn't implement cursor-based pagination. The solution was a field description warning, not a feature cut.

A separate security audit found input validation gaps — the URL is constructed from user input, so without validation, path traversal and injection are possible. A trust audit verified that n8n's agent-readable documentation wasn't misleading us.

## Building with TDD

I corrected the team's initial TDD approach — they planned "all red tests, then all green." Real TDD is small increments: write one test, make it pass, refactor, commit. Each cycle is a separate commit so the git history shows the discipline.

Each user story got its own builder agent working on a dedicated branch. The scaffold (US-0) went first since everything depends on shared types. List and Get ran in parallel, then merged. I split "Get by name or ID" into separate stories — different edge cases for name vs ID lookup.

## Quality Gates

Every PR got a reviewer agent before merge. A senior code review pass caught two UX issues: whitespace in input (`" pikachu "` should work) and 404 error messages (should suggest correct name format, not show raw errors). Both were fixed.

The security audit produced concrete mitigations: allowlist regex validation on input, disabled HTTP redirects, and a pagination circuit breaker. These shipped, not just documented.

## Refinement

The PRD expanded from API-focused to UX-focused after I asked "what will the node look like in the visual editor? How would you plug it into flows?" This added workflow patterns and canvas appearance descriptions.

A final documentation audit compared all docs against the actual implementation and fixed inconsistencies. The performance assessment identified the Return All + Loop + Get (unsimplified) pattern as a memory risk (~780MB) and added field description warnings.

Throughout: corrections flowed both ways. I corrected agent behavior (TDD cadence, one builder per story, live debate not static reports). Agents caught things I hadn't considered (pagination pattern, deprecated API, performance risk).

---

## Post-Submission Session

~29 prompts across two arcs. **Part 1** (prompts 1–10) — the cold-build failure, type fixes, and quality audit. **Part 2** (prompts 11–29) — turning the audit into harness improvements, a disciplined backlog, and a trustworthy clean build. The throughline: a single stale-cache build failure became a systems-level review of how the whole agent harness enforces quality.

### Part 1 — Cold Build Failure, Type Fixes, and Quality Audit

Discovered after submission that a cold `pnpm build` failed with 4 TypeScript errors that had been masked by three compounding factors: a stale `dist/` directory, turbo cache serving pre-built artifacts, and Jest running in transpile-only mode (skipping type-checking entirely). This part diagnosed the root cause, fixed the errors, and audited the quality process.

### What Happened

Tried to run the node locally and needed a fresh build. The cold build exposed type errors that had never been caught: invalid instantiation-expression syntax on generic function calls (`(pokemonApiRequest<T>).call(...)` — illegal in TypeScript), bare `as IDataObject` casts that didn't structurally conform, and inline `import('...').Type` annotations in tests that TypeScript rejects. These compiled fine through turbo cache and passed Jest because Jest transpiles without checking types.

Once the stale `dist/` and generated node-definitions directory were cleared, the build error changed from ENOTEMPTY to the underlying TypeScript errors. Fixed all four: typed-unknown cast at the call boundary, object-spread for IDataObject conformance, push.apply to avoid TS2556, and top-level import type block in tests. 68 tests still pass.

The autofix that ran during the original build session also stripped the deliberate limit-field description — the UX warning ("Returns name and URL only — use Get for full details.") that was a PO product decision from the adversarial review. That was a silent regression. Restored it, added a targeted eslint-disable-next-line with inline justification for the canonical-description rule that enforces the shorter text.

The deeper question after fixes: why wasn't this caught before submission? The issue class is "CI that never exercises the cold path." I asked the team to fix the issue class, not just the instance — add a cold-build step to CI that clears turbo cache, verify it in the harness.

I also spun up an Opus auditor (Claude Teams agent, not a subagent) to investigate whether the harness expectations had gone stale as models evolved — whether I was working against the system or expecting too much. The auditor's findings pointed to language-agnostic process fixes that belong in the Snippets harness, not the n8n fork.

### Prompts, In Order

1. "How do I run my Pokemon node locally?"
2. "Seeing this error on build. I didn't run install because I assumed it had cached enough." *(build failed with 4 TypeScript errors)*
3. "Annoying we didn't catch these before submission — why's that?"
4. "Now I'm getting this one." *(a stale-dist ENOTEMPTY build error)*
5. "I deleted it." *(removed the stale generated node-definitions directory)*
6. "Fix issue class." *(add cold-build CI step that clears turbo cache)*
7. "Spin up an auditor Claude Teams agent (not a subagent) to investigate: how do you make sure Claude does what you want — good engineering practice — when it feels like it ignores it, takes the easy way out, does the bare minimum? Check the learnings. Am I working against the system? Expecting too much? Have my approaches gone stale as the model evolved?"
8. *(decision)* "Fix the things as suggested, but with a separate builder following the harness guidelines; focus on the Snippets repo not n8n (just a fork I don't control); I won't use TypeScript generally — Kotlin Multiplatform is more likely."
9. "You're the lead now. Make sensible commits with good messages to fix the issues we've seen this morning. Use separate builders, not the lead main thread."
10. "Add the prompts we've done this session to the running prompts file for the n8n project."

### Part 2 — Harness Improvement, Disciplined Backlog, and Clean Verification

The audit didn't stop at findings — it became action, then a lesson in restraint.

**The audit's verdict, briefly.** The model cuts corners by a precise mechanism: it optimizes for "make the visible check turn green" over "satisfy the unstated quality intent." The fixes that hold are *gates* (a machine refuses to proceed); the ones that don't are *prompts* ("act like a senior engineer," self-graded checklists). The standards were right; the enforcement was missing, so the PO had been personally absorbing the gap. A few rules had also gone stale as models grew (compaction thresholds, no-agent-reuse) and now *caused* corner-cutting by starving agents of context.

**Action — language-agnostic, in the harness, not the fork.** A separate builder implemented three process fixes in the Snippets harness (the PO's general stack is Kotlin Multiplatform, not TypeScript; n8n is a fork he doesn't control): the agent DONE report must now paste actual command output instead of self-attested checkboxes (killing the "a staff engineer would approve: yes" theater); a new rule that a *recurring behavioral correction needs a mechanical gate, not more prose*; and a re-baselining of stale model-era rules for a 1M-context model. These merged as harness-only PRs.

**Restraint.** Mid-cleanup, the lead over-orchestrated — spinning up a deep-dive investigation and staging implementation builders when the PO only wanted backlog tickets. The PO stopped it: clean slate, define the work as tickets, don't build. This is itself part of the story: the harness is only as good as the human keeping it pointed at the actual goal. The lead stood down to pure orchestration. The concrete code-level gates (auto-fail new `!!`, detekt-baseline-removal check, koverVerify smoke-test) were captured as a ticket, not built.

**Backlog, not scope creep.** The remaining ideas were filed as issues rather than chased: a token-efficiency audit, a model-migration eval framework with benchmarks, undoing stale 4.8 slowdowns, the advisor pattern (expensive models spec; cheap builders — even Haiku — implement once scope is crystal clear, with on-demand escalation), and a CI flake fix (a Gradle-distribution download timeout — infrastructure, not code).

**The trust check.** A full clean build with turbo's cache bypassed: 19 packages force-compiled from source, all 421 node definitions regenerated from an empty directory, zero errors. The cold compile that had been silently broken at session start now passes. Ran the node in the n8n editor and confirmed it works end to end.

### Prompts, In Order (continued)

11. "Sounds like we should update the gitignore." *(n8n build artifacts / strays)*
12. "Should this one be closed?" *(GitHub issue #1129 — verified it's still open work, tracked by an existing PR; don't close)*
13. *(decisions)* "Leave the stale PRs for now." / "Spawn 2 gate builders now."
14. "Let's get everything to a good state and then you stay as lead, not implementer."
15. "Add an issue for a deep token-efficiency audit; a separate issue for a model-migration eval framework with sensible benchmarks; a third for undoing things that slow down 4.8."
16. "Create a ticket for the advisor pattern — expensive models spec, cheap builders (e.g. Haiku) implement once scope is clear and they can ask for help as needed."
17. "No — do a full deep dive on this specifically." *(the gate-enforcement landscape)*
18. "Don't spawn builders, I wanted tickets only."
19. "What? Why? Not good process." *(re: launching an investigation unprompted)*
20. "I stopped the auditor. I want to define the work — a clean slate and good documentation for future work."
21. "Create a ticket for the 3 gates, don't build."
22. "n8n repo: pull latest from main, then rebuild the project (or tell me how)."
23. "Actually, no need to update — this is just a take-home, not real life."
24. "Did this do anything?" *(a no-op `pnpm install`; only a config-deprecation warning)*
25. "I want to do a clean build as I don't trust it — things were stale when I launched this session."
26. "Why is this failing?" *(a CI run — diagnosed as a Gradle-distribution download timeout, not code)*
27. "File a ticket for later." *(the CI flake)*
28. "I've rebuilt everything — how do I run it locally?"
29. "I ran it and saw the node working. Do a write-up of what we found this morning, log all the prompts, and spin up a separate auditor to prep me for the interview debrief — with diagrams that help me understand why my code works."
