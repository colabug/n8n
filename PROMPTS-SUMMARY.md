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

## Post-Submission Session — Cold Build Failure, Type Fixes, and Quality Audit

10 prompts. Discovered after submission that a cold `pnpm build` failed with 4 TypeScript errors that had been masked by three compounding factors: a stale `dist/` directory, turbo cache serving pre-built artifacts, and Jest running in transpile-only mode (skipping type-checking entirely). This session diagnosed the root cause, fixed the errors, audited the quality process, and committed everything cleanly.

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
