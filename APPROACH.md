# Approach

Back in March, I built what I call my software-making factory — a multi-agent harness built on Claude Code's agent teams. I'm a systems builder by nature, and I wanted a way to accelerate testing my ideas outside of work without losing the hard-won knowledge from my tech career about how good software actually gets built. The harness has agents for different roles — builders, reviewers, QA, PM, architect, security — each experienced at their kind of task. I act as product owner, making the final calls.

I used this harness to tackle this assignment the same way I approach most problems: get really clear on what's needed, what's been said, what *hasn't* been said, and what's expected. In my harness, that takes the form of a PRD and ADRs. For this node, that meant defining user stories, data shapes, workflow patterns showing how the node composes with other n8n nodes, and thinking through the visual editor experience before writing any code.

Once the spec was clear, I ran an adversarial trio — QA, PM, and Architect agents — to validate the requirements, find gaps, and finalize the design. They debated live and found real issues: the CoinGecko reference node uses a deprecated API (`helpers.request`), its pagination pattern doesn't work with PokeAPI's response structure, and a resource selector dropdown would add a click with zero value for a single-resource node. I overruled one of their consensus recommendations — they wanted to cut the Return All toggle because the list endpoint only returns stubs. I pushed back because Return All is a standard n8n convention, and omitting it would raise questions.

Then the builders built. Each user story got its own builder agent working on a dedicated branch with TDD discipline — write one test, make it pass, refactor, commit. Reviewer agents checked each PR before merge. After implementation, I ran a senior code review that audited against n8n's coding standards and found real issues (a broken workflow test, a duplicate constant, unnecessary type casts). Fixed them all. Then a security auditor checked for input validation gaps, injection risks, and redirect vulnerabilities. Finally, I ran a submission auditor that assessed the complete node as if reviewing a take-home — checking every technical claim against the actual code.

I built it locally and made sure it worked in the n8n editor — Get, Get Many, Return All, error handling, the lot. It was built with quality in mind throughout. The BDD scenarios became acceptance criteria, the TDD cycles are visible in the commit history, and I wrote end-to-end Playwright tests following n8n's existing patterns.

I also had a documentation system running alongside the whole build that captured agent decisions (an audit trail), all the prompts used, and a build journal showing how everything came together. That's the approach — not just the code, but the system that produces the code.

## Assumptions

I assumed I could use AI in whatever way felt right — in this case, that meant using the harness I'd already built as the base. The requirements were deliberately thin, which gave me room to make scope calls: I included Return All (standard convention), left out a resource selector (single resource), and added input validation (baseline hygiene even for a read-only API). I assumed the assignment was less interested in deep n8n node knowledge and more interested in how I think about building software — systems thinking, quality process, and the ability to ship something that works.

## How I Tested

Started with a clear spec and turned it into BDD scenarios and acceptance criteria. Those became the test plan. Built the tests using TDD — red, green, refactor — with 66 unit tests covering the expected paths (Get by name, Get by ID, simplified vs full output, multi-type Pokemon, null sprites, pagination, error handling) and the edge cases (path traversal, query injection, empty strings, circuit breaker). Wrote workflow tests using n8n's NodeTestHarness to prove the node works in the actual execution pipeline, not just in isolation. Added Playwright E2E test specs following the existing `http-request-node.spec.ts` pattern. Then manual testing in the n8n visual editor to make sure it all looked and felt right.

## What I'd Do Differently With More Time

1. **Update the harness first.** A few things have changed over the last month and I'd adopt the Advisor pattern for better token efficiency once the spec has been created.
2. **PokeAPI GraphQL integration.** They're launching v1beta2 in June. GraphQL would let users query exactly the fields they need, eliminating the simplify function entirely.
3. **Run the Playwright E2E tests.** The spec file exists, but wasn't executed against a dev server in this session.
4. **Convert Get Many to declarative routing.** The list operation is a simple GET with envelope extraction — a natural candidate for n8n's declarative pattern.
5. **In-memory LRU cache** scoped to execution, to avoid redundant API calls in loop patterns.

## Model Used

**Claude Opus 4.7** for lead and coordination, **Sonnet 4.6** for specialist agents (builders, reviewers, QA). I have a Claude subscription and built the multi-agent harness on top of Claude Code's agent teams feature over 44+ sessions. Opus handles the judgment calls — what to build, in what order, when to override recommendations. Sonnet handles the well-scoped specialist work. The full prompt log is in `PROMPTS-SUMMARY.md`.
