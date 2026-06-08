# Interview Prep — Pokemon Node Take-Home Debrief

A study guide for the live debrief. The interviewer will probe *how* you built it,
*what* you learned, and *how deeply* you understand your own submission. Every claim
below is grounded in the actual code, not the docs. File references are clickable.

**Code under discussion:**
- `packages/nodes-base/nodes/Pokemon/Pokemon.node.ts` — the `INodeType`, `execute()`
- `packages/nodes-base/nodes/Pokemon/GenericFunctions.ts` — request helpers, interfaces, validation, pagination, simplify
- `packages/nodes-base/nodes/Pokemon/PokemonDescription.ts` — UI / parameter definitions
- `packages/nodes-base/nodes/Pokemon/test/` — unit + workflow tests

---

## 1. The 60-Second Pitch (say this out loud)

> "It's a custom n8n node that wraps PokeAPI with two operations. **Get** fetches one
> Pokémon by name or numeric ID and, by default, *simplifies* the ~200KB raw response
> into a clean flat object — id, name, height, weight, base_experience, types,
> abilities, stats, sprite, species. **Get Many** lists Pokémon stubs (name + URL),
> with an optional Return All that paginates through every page.
>
> The design is deliberately *composable*: Get Many gives you an index, you Loop over
> it, and Get enriches each entry. They're separate operations because the list
> endpoint only returns stubs — enriching inline would be an N+1 call pattern that hides
> latency and abuses PokeAPI's fair-use policy.
>
> Under the hood it's a **programmatic** node — I needed real transform logic for
> simplify that you can't express readably in declarative routing. It's typed
> end-to-end with no `any`, validates input against an allowlist regex before building
> the URL, disables redirects, wraps every API call in `NodeApiError`, and has a
> pagination circuit breaker. 68 unit tests plus two workflow tests through
> n8n's `NodeTestHarness`."

Three things to emphasize because they're the differentiators:
1. **Composability** — separate Get/Get Many is a product decision, not a limitation.
2. **Typed, no `any`** — most candidates clone CoinGecko which uses `any` everywhere.
3. **Security hygiene on a read-only API** — validation, no redirects, circuit breaker.

---

## 2. How an n8n Programmatic Node Works (then how *this* node uses each piece)

An n8n node is a class implementing `INodeType`. Two members matter here:

| Piece | What it is | How this node uses it |
|---|---|---|
| `description: INodeTypeDescription` | Static metadata: name, icon, version, inputs/outputs, and the parameter UI | `Pokemon.node.ts:24-40`. Sets `usableAsTool: true`, `group: ['input']`, and pulls `properties` from `PokemonDescription.ts` |
| `execute()` | Runs per node execution. Returns `INodeExecutionData[][]` (array of output branches) | `Pokemon.node.ts:42-119` |
| `getInputData()` | The items flowing in from upstream nodes | `Pokemon.node.ts:43` |
| `getNodeParameter(name, i, fallback)` | Reads a UI parameter for input item `i` | e.g. `Pokemon.node.ts:50-51` |
| **items loop** | Nodes process N input items; you loop and process each | `for (let i = 0; i < items.length; i++)` in both branches |
| `continueOnFail()` | User toggle: on error, emit an error item instead of throwing | `Pokemon.node.ts:69, 104` |
| `helpers.returnJsonArray(data)` | Wraps plain objects into `{ json: ... }` items | `Pokemon.node.ts:64, 99` |
| `helpers.constructExecutionMetaData(items, { itemData })` | Attaches `pairedItem` linkage so downstream nodes can correlate output→input | `Pokemon.node.ts:64-66, 98-101` |
| `helpers.httpRequest(options)` | The modern axios-based HTTP helper (NOT deprecated `request()`) | `GenericFunctions.ts:117` |
| paired items | The `{ item: i }` tag that maps each output back to its source input | set via `constructExecutionMetaData` and in the `continueOnFail` error item |

**Key subtlety — the return shape is `[returnData]`** (`Pokemon.node.ts:118`). The outer array
is *output branches* (this node has one Main output), the inner array is the items.

**Key subtlety — why `push.apply`** (`Pokemon.node.ts:62-67, 102`). `constructExecutionMetaData`
returns an *array* of items (one per input item it produced). `returnData.push.apply(returnData, arr)`
spreads them in. This was deliberately switched away from `returnData.push(...arr)` to avoid a
TypeScript `TS2556` spread error on a cold typecheck — see §8 (the cold-build story).

---

## 3. Architecture & Data-Flow Diagrams

### 3.1 `execute()` control flow

```mermaid
flowchart TD
    A[execute called] --> B[getInputData]
    B --> C[read operation param at index 0]
    C --> D{operation?}

    D -->|get| E[loop input items i]
    E --> F[read nameOrId + simplify]
    F --> G[validateNameOrId<br/>trim, regex, lowercase]
    G -->|invalid| GE[throw NodeOperationError<br/>no HTTP call]
    G -->|valid| H[GET /pokemon/nameOrId<br/>pokemonApiRequest]
    H --> I{simplify?}
    I -->|true| J[simplifyPokemonData + toDataObject]
    I -->|false| K[spread raw response as IDataObject]
    J --> L[returnJsonArray + constructExecutionMetaData<br/>pairedItem item:i]
    K --> L
    L --> M[push.apply to returnData]
    M --> E

    D -->|getAll| N[loop input items i]
    N --> O{returnAll?}
    O -->|true| P[pokemonApiRequestAllPages<br/>paginate all pages]
    O -->|false| Q["clampLimit + GET /pokemon?limit=N&offset=0"]
    P --> R[map results to IDataObject]
    Q --> R
    R --> S[constructExecutionMetaData item:i]
    S --> T[push.apply to returnData]
    T --> N

    D -->|other| U[throw NodeOperationError<br/>Unknown operation]

    E -.error.-> X{continueOnFail?}
    N -.error.-> X
    X -->|yes| Y[push error item<br/>json.error + pairedItem item:i]
    X -->|no| Z[rethrow]

    M --> RET[return returnData wrapped in outer array]
    T --> RET
```

Note the error path is *per-item* inside each loop's `try/catch`, so one bad item in a
batch doesn't kill the others when `continueOnFail` is on.

### 3.2 Get-Many pagination loop with the circuit breaker

`pokemonApiRequestAllPages` — `GenericFunctions.ts:142-163`.

```mermaid
flowchart TD
    A["start: url = /pokemon?limit=100&offset=0<br/>allResults = empty, pageCount = 0"] --> B{"url is not null?"}
    B -->|no| F[return allResults]
    B -->|yes| C{"pageCount >= 50?"}
    C -->|yes| E[throw NodeOperationError<br/>Pagination exceeded 50 pages]
    C -->|no| D[pokemonApiRequest url]
    D --> G[append response.results to allResults]
    G --> H[url = response.next]
    H --> I[pageCount++]
    I --> B
```

Why `while (url !== null)` and not CoinGecko's `do...while(length !== 0)`: PokeAPI's
**last page has non-empty results with `next: null`**. The cursor (`next`) is the
correct termination signal; counting results would fire one wasted extra call. The
circuit breaker (`PAGINATION_CIRCUIT_BREAKER_LIMIT = 50`, `GenericFunctions.ts:70`) caps a
malicious or buggy `next` chain — PokeAPI is ~14 pages, so 50 is generous.

### 3.3 Data flow: PokeAPI response → output item

```mermaid
flowchart LR
    A[PokeAPI JSON<br/>~200KB raw] --> B{simplify?}
    B -->|true| C[simplifyPokemonData<br/>IPokemonDetailResponse to IPokemonSimplified]
    C --> C1[types: t.type.name array]
    C --> C2[abilities: a.ability.name array]
    C --> C3[stats: reduce to name to base_stat map]
    C --> C4[sprite: sprites.front_default nullable]
    C --> C5[species: species.name]
    C1 --> D[toDataObject<br/>spread to IDataObject]
    C2 --> D
    C3 --> D
    C4 --> D
    C5 --> D
    B -->|false| E[spread raw response<br/>as IDataObject]
    D --> F[returnJsonArray<br/>wrap in json key]
    E --> F
    F --> G[constructExecutionMetaData<br/>attach pairedItem]
    G --> H[n8n output panel]
```

### 3.4 Type / interface relationships (the typed-helper boundary)

```mermaid
classDiagram
    class IPokemonListItem {
        +string name
        +string url
    }
    class IPokemonListResponse {
        +number count
        +string|null next
        +string|null previous
        +IPokemonListItem[] results
    }
    class IPokemonDetailResponse {
        +number id
        +string name
        +number height
        +number weight
        +number base_experience
        +IPokemonType[] types
        +IPokemonAbility[] abilities
        +IPokemonStat[] stats
        +sprites front_default
        +species
        +IPokemonMove[] moves
    }
    class IPokemonSimplified {
        +number id
        +string name
        +string[] types
        +string[] abilities
        +Record~string,number~ stats
        +string|null sprite
        +string species
    }

    IPokemonListResponse "1" o-- "many" IPokemonListItem : results
    IPokemonDetailResponse ..> IPokemonSimplified : simplifyPokemonData()
    IPokemonListResponse ..> IPokemonListItem : pokemonApiRequestAllPages returns items
```

**The typed-helper boundary:** `pokemonApiRequest<T = unknown>` (`GenericFunctions.ts:111`)
is generic and returns `unknown` by default. The *caller* in `execute()` casts the result
to the concrete response interface (`as IPokemonDetailResponse`, `Pokemon.node.ts:54-58`).
So the untyped HTTP edge is contained: raw `unknown` comes back from the helper, and the
node asserts the shape exactly once at the call site. Everything downstream
(`simplifyPokemonData`, `toDataObject`) is fully typed.

---

### 3.5 Get — focused flow, with the complexity callouts (show this for "walk me through Get")

Split out from §3.1 so you can present *just* the single-Pokémon path and point at each
deliberate decision. Annotations marked **[!]** are the things worth calling out.

```mermaid
flowchart TD
    A["execute: getInputData = list of items<br/>[!] unit of work is the ITEM, not the call"] --> B["loop each item i<br/>[!] one fetch PER input item — 1 is the degenerate case"]
    B --> C["read nameOrId + simplify for item i<br/>[!] value is a literal OR a resolved expression"]
    C --> D{"validateNameOrId<br/>[!] LAYER 1: fail before the wire"}
    D -->|"empty / illegal chars<br/>(path traversal, injection)"| DE["throw NodeOperationError<br/>NO HTTP call made"]
    D -->|"valid: trim + lowercase"| E["build URL /pokemon/nameOrId<br/>[!] fetch is deliberately unremarkable"]
    E --> F["httpRequest<br/>[!] redirects disabled = SSRF defense<br/>ALWAYS returns the full ~200KB blob"]
    F -->|"404"| F4["LAYER 2: friendly 'not found' message"]
    F -->|"other error"| FE["LAYER 2: wrapped API error"]
    F -->|"ok"| G{"simplify?<br/>[!] output filter, applied AFTER fetch"}
    G -->|"true (default)"| H["simplifyPokemonData<br/>flatten + reshape + drop to ~12 fields"]
    G -->|"false"| I["pass raw blob through untouched"]
    H --> J["wrap: returnJsonArray + constructExecutionMetaData<br/>[!] pairedItem = provenance to input i"]
    I --> J
    J --> K["raw blob now out of scope -> garbage-collected<br/>[!] transient because nothing caches it"]
    K --> B
    B --> RET["return [returnData] — one output branch"]

    DE -.caught by per-item try/catch.-> CF{"continueOnFail?<br/>[!] LAYER 3: batch resilience"}
    F4 -.-> CF
    FE -.-> CF
    CF -->|"yes"| CFY["emit error ITEM with pairedItem,<br/>keep processing the rest"]
    CF -->|"no"| CFN["rethrow — fail the run"]
```

### 3.6 Get Many — focused flow (limit vs. Return All + the cost split)

```mermaid
flowchart TD
    A["execute: loop each item i"] --> B{"returnAll?"}
    B -->|"false (default)"| C["clampLimit 1..100<br/>[!] runtime guard — expression inputs bypass the UI min/max"]
    C --> D["ONE call: GET /pokemon?limit=N&offset=0<br/>[!] CHEAP — 1 request, ~100ms"]
    B -->|"true"| E["pokemonApiRequestAllPages<br/>[!] sequential cursor walk, ~14 pages, ~1.4s<br/>cost scales with PAGES (~14), not Pokémon (~1300)"]
    D --> F["extract results[] (drop count/next/previous envelope)<br/>[!] each item = name + URL STUB only"]
    E --> F
    F --> G["wrap with pairedItem -> output"]

    G -.composes into.-> N["Get Many -> Loop -> Get<br/>[!] THE EXPENSIVE PATH: N+1, ~1300 calls, ~2min<br/>unsimplified ~780MB — this is a USER workflow, not the node"]
```

The key thing to say at this diagram: **Return All itself is cheap (~14 calls); the expensive
thing is the user chaining it into per-item enrichment (N+1).** That separation is *why* list
and detail are two operations.

### 3.7 Code-level function-call sequence (point here to show the call chain)

This is the "function calls and such" view — who calls whom across the three files, for a
single `Get`. Use it to narrate the layering: the node orchestrates; `GenericFunctions`
holds the reusable, typed helpers.

```mermaid
sequenceDiagram
    participant n8n as n8n engine
    participant Node as Pokemon.node.ts<br/>execute()
    participant GF as GenericFunctions.ts
    participant API as PokeAPI

    n8n->>Node: execute() with input items
    Node->>Node: getInputData() / getNodeParameter('operation', 0)
    loop per input item i
        Node->>Node: getNodeParameter('nameOrId', i), ('simplify', i)
        Node->>GF: validateNameOrId(ctx, raw, i)
        alt invalid (empty / regex fail)
            GF-->>Node: throw NodeOperationError (no HTTP)
        else valid
            GF-->>Node: trimmed + lowercased nameOrId
        end
        Node->>GF: pokemonApiRequest(url, nameOrId)
        GF->>API: GET /pokemon/{nameOrId}<br/>(Accept json, disableFollowRedirect)
        alt 404
            API-->>GF: 404
            GF-->>Node: throw NodeApiError ("not found" message)
        else ok
            API-->>GF: full ~200KB JSON blob
            GF-->>Node: responseData (cast IPokemonDetailResponse)
        end
        alt simplify = true
            Node->>GF: simplifyPokemonData(responseData)
            GF-->>Node: ~12-field IPokemonSimplified
            Node->>GF: toDataObject(simplified)
            GF-->>Node: IDataObject
        else simplify = false
            Node->>Node: spread raw blob as IDataObject
        end
        Node->>n8n: returnJsonArray + constructExecutionMetaData (pairedItem)
    end
    Node-->>n8n: [returnData] (one output branch)
```

**Call out the layering:** `execute()` is the **orchestrator** — it owns the loop, the
operation branch, and the wrapping. Everything *reusable and testable* lives in
`GenericFunctions.ts`: validation, the HTTP helper (with the typed-`unknown` boundary),
pagination, and the simplify transform. That separation is why the helpers can be unit-tested
in isolation (and they are — 68 unit tests). For **Get Many**, swap `validateNameOrId` +
single `pokemonApiRequest` for either one `pokemonApiRequest` (limit path) or
`pokemonApiRequestAllPages` (the cursor loop) — same orchestration shape.

### 3.8 Error flow — the three-layer defense (the part under-shown elsewhere)

```mermaid
flowchart TD
    IN["input item i"] --> L1{"LAYER 1 — validation<br/>before any network call"}
    L1 -->|"empty / path traversal / injection"| L1X["NodeOperationError<br/>fail closed, early, cheap — no request sent"]
    L1 -->|"clean"| REQ["HTTP GET to PokeAPI"]

    REQ --> L2{"LAYER 2 — API boundary<br/>translate machine errors to human"}
    L2 -->|"404 not found"| L2A["friendly NodeApiError:<br/>'check spelling, use PokéAPI format'"]
    L2 -->|"timeout / 5xx / network"| L2B["wrapped NodeApiError<br/>surfaces cleanly in n8n UI"]
    L2 -->|"ok"| OK["success item"]

    L1X --> L3{"LAYER 3 — batch resilience<br/>continueOnFail?"}
    L2A --> L3
    L2B --> L3
    L3 -->|"off (default)"| L3A["fail the whole run<br/>safe + predictable"]
    L3 -->|"on"| L3B["emit error ITEM with pairedItem,<br/>keep processing items i+1..n<br/>failure becomes a data row, nothing dropped"]
```

Say it as: **reject bad input before the wire → humanize API errors at the boundary →
isolate per-item failures so one bad item doesn't sink the batch.** The 404-vs-everything
split and the continue-on-fail provenance are the two operability decisions an interviewer
rewards most.

---

## 4. Design-Decision Q&A (anticipate the interviewer)

These answers match your own documented rationale (ADR-001, PRD). If the interviewer
challenges a decision, the honest framing is: *"I made a scope call and documented why."*

**Q: Why keep Return All when the list endpoint only returns stubs?**
A: Three reasons (ADR D3). (1) Return All is a standard n8n convention — CoinGecko,
GitHub, most list ops have it; omitting it signals you couldn't implement pagination.
(2) Stub data *is* useful — building a dropdown, a reference list, or feeding a loop all
want all names at once; paging 20 at a time is worse UX. (3) It demonstrates real
cursor-based pagination against PokeAPI's envelope. **The UX concern (stubs only) is
solved by a field description warning, not a feature cut.** Notably, the adversarial
review *recommended cutting it* and I overruled them — that's a defensible product call,
not me missing their point.

**Q: Why no resource selector?**
A: Single resource (Pokemon) = a one-option dropdown is a required click with zero value
(ADR D2). OpenWeatherMap — same shape, read-only, single resource — omits it. YAGNI;
adding a resource selector later is trivial if a second resource appears. I documented
this as deliberate so it doesn't read as an oversight.

**Q: Why input validation on a read-only, no-auth API?**
A: The URL is built by string interpolation: `/pokemon/${nameOrId}` (`Pokemon.node.ts:53`).
Without validation, `../../`, `?callback=`, `#`, or `%00` could hit unintended endpoints
or leak internal detail through error messages. The allowlist regex `/^[a-zA-Z0-9-]+$/`
(`GenericFunctions.ts:69`) covers every valid Pokémon name including hyphenated ones like
`mr-mime`, plus numeric IDs, with zero false positives. It's baseline hygiene — cheap,
and the right habit even when the current API is benign (ADR D12).

**Q: Why `disableFollowRedirect`?**
A: PokeAPI never legitimately redirects. Disabling redirects (`GenericFunctions.ts:123`)
prevents an SSRF-via-redirect if the API were ever compromised or MITM'd — a 3xx pointing
at an internal address. Important nuance I can cite: `maxRedirects` is *not* a valid field
on `IHttpRequestOptions`; the correct option is `disableFollowRedirect` (ADR D12, finding 3).

**Q: Why a pagination circuit breaker, and why 50?**
A: A malicious or buggy `next` URL could loop forever (`GenericFunctions.ts:149-155`).
PokeAPI is ~14 pages at limit=100, so 50 is generous headroom while still bounding the
blast radius. It's defense-in-depth on top of the cursor-based termination.

**Q: Why default Simplify on?**
A: The raw response is ~200KB / 1000+ lines (`PokemonDescription.ts:53`). Most builders
want a clean flat object: id, name, types, abilities, stats, sprite. Defaulting to
simplify gives the common case a good experience; power users flip it off for the full
payload. The toggle is *hidden on Get Many* (ADR D6) because list stubs have nothing to
simplify — a no-op toggle would be a UX lie.

**Q: Why a programmatic node, not declarative?**
A: `simplifyPokemonData` (`GenericFunctions.ts:171`) flattens `types[].type.name`, reduces
`stats[]` into a keyed map, extracts `abilities[].ability.name`, handles a nullable sprite,
and drops the moves array. Declarative `postReceive` can only do simple `set` ops or raw
expressions — that logic would be unreadable and untestable as an expression (ADR D1). Get
operation *needs* programmatic. I kept Get Many programmatic too for consistency, since no
existing n8n node mixes both patterns — and noted "convert Get Many to declarative" as a
fast-follow.

**Q: How does error handling differ for 404 vs other failures?**
A: `pokemonApiRequest` catches the raw axios error and inspects the status
(`GenericFunctions.ts:125-137`). On **404**, it throws a `NodeApiError` with a *helpful*
message: `"Pokémon 'X' not found. Check the spelling..."` and `httpCode: '404'`. On **any
other failure** (network, 5xx), it wraps the raw error in a generic `NodeApiError`. Both are
`NodeApiError` (API-layer), distinct from `NodeOperationError` (used for *validation* and
unknown-operation — user/config errors that never make an HTTP call).

**Q: What's the memory risk of Return All + Loop + unsimplified Get?**
A: A user can chain Return All (~1302 stubs) → Loop → Get (simplify off). Simplified, the
whole run is ~650KB — safe. **Unsimplified**, it's ~780MB in-process and ~260MB stored
execution data, which freezes the browser UI and can OOM SQLite installs (PRD Performance,
ADR D11). I chose *not* to add caching/concurrency code for a 1–2h budget — the mitigation
is the Simplify field's description warning, and I documented an LRU cache / batch-enrich /
GraphQL as future work. It's a user-constructed pattern, not a node defect.

---

## 5. Rehearsal Trace: "Walk me through Get on 'pikachu'"

Narrate this end-to-end. Line refs are in `Pokemon.node.ts` / `GenericFunctions.ts`.

1. **Entry.** `execute()` runs. `getInputData()` returns the upstream items
   (`Pokemon.node.ts:43`); say there's one. `operation = getNodeParameter('operation', 0)`
   reads `'get'` (`:45`).
2. **Branch.** `operation === 'get'` → enter the get loop (`:47-48`).
3. **Read params** for item 0: `rawNameOrId = 'pikachu'` (`:50`), `simplify = true`
   (default, `:51`).
4. **Validate.** `validateNameOrId(this, 'pikachu', 0)` (`:52` → `GenericFunctions.ts:78`):
   trims (`'pikachu'`), checks non-empty, tests against `/^[a-zA-Z0-9-]+$/` (passes),
   returns `'pikachu'` lowercased. *If it were `'../x'` or `''`, it throws
   `NodeOperationError` here — before any HTTP call.*
5. **Build URL.** `https://pokeapi.co/api/v2/pokemon/pikachu` (`:53`).
6. **Request.** `pokemonApiRequest.call(this, url, 'pikachu')` (`:54`). Inside
   (`GenericFunctions.ts:117`): `httpRequest({ method: 'GET', url, headers: { Accept },
   disableFollowRedirect: true })`. On 404 it would throw the friendly NodeApiError; here
   it resolves to the raw Pokémon JSON, cast `as IPokemonDetailResponse` (`:54-58`).
7. **Transform.** `simplify` is true → `toDataObject(simplifyPokemonData(responseData))`
   (`:60`). `simplifyPokemonData` (`GenericFunctions.ts:171`) maps types→`['electric']`,
   abilities→`['static','lightning-rod']`, stats→`{hp:35,...,speed:90}`,
   sprite→`front_default` URL, species→`'pikachu'`; drops moves. `toDataObject` spreads it
   into an `IDataObject`.
8. **Wrap + meta.** `returnJsonArray([outputData])` → `[{ json: {...} }]`;
   `constructExecutionMetaData(..., { itemData: { item: 0 } })` attaches
   `pairedItem: { item: 0 }` (`:62-67`). `push.apply` adds it to `returnData`.
9. **Return.** Loop ends; `return [returnData]` (`:118`) — one output branch, one item.
   Output panel shows the flat simplified Pikachu.

**If the interviewer says "now make it ID 25"**: step 3 reads `'25'`, validation passes the
regex (digits allowed) and returns `'25'`, URL becomes `/pokemon/25`, PokeAPI resolves the
same Pikachu. Name vs ID is the same code path — the API treats both as the path segment.

---

## 6. What I Learned / What I'd Do Differently

From `APPROACH.md` (be specific, own the gaps):

1. **Update the harness first.** Some patterns drifted over the prior month (e.g. an
   advisor pattern for token efficiency). Refreshing it first would have saved time/tokens.
2. **PokeAPI GraphQL (v1beta2, June 2026).** GraphQL would let users request exactly the
   fields they need and **eliminate the simplify function entirely** — the cleanest future
   direction.
3. **Run the Playwright E2E tests.** The spec exists, modeled on `http-request-node.spec.ts`,
   but I didn't execute it against a dev server in-session. Honest gap.
4. **Convert Get Many to declarative routing.** It's a plain GET with envelope extraction —
   a natural declarative candidate; I kept it programmatic for consistency.
5. **In-memory LRU cache** scoped to one execution, to dedupe repeated lookups in loops.

**The strongest "what I learned" story — see §8.** Have it ready; it's a maturity signal.

---

## 7. Likely Weak Spots / Gotcha Questions (honest answers)

**"Your `simplify=false` path spreads the raw response — is that really typed?"**
Yes and no, honestly. `{ ...responseData } as IDataObject` (`Pokemon.node.ts:61`) spreads a
typed `IPokemonDetailResponse` but the cast to `IDataObject` is structural. The raw shape is
n8n's expected "pass-through whatever the API returned" behavior for full mode. I'd flag that
in full mode the user is trusting PokeAPI's shape directly — that's documented as an accepted
risk (ADR D12, finding 7).

**"Get Many's non-Return-All path requests `limit` but does it slice?"**
It doesn't slice client-side — it passes `limit` straight to PokeAPI:
`/pokemon?limit=${limit}&offset=0` (`Pokemon.node.ts:93`). PokeAPI honors the limit, so the
count is correct at the source. `clampLimit` (`GenericFunctions.ts:105`) bounds it to 1–100
at runtime *because expression inputs bypass the `typeOptions` min/max* — that's the subtle
part worth volunteering.

**"Return All ignores the `limit` field — intentional?"**
Yes. When `returnAll` is true (`Pokemon.node.ts:85-88`), the code calls
`pokemonApiRequestAllPages` which hardcodes `limit=100` per page and walks `next`. The UI
`limit` field is hidden via `displayOptions` when Return All is on (`PokemonDescription.ts:76-78`),
so there's no contradiction the user can see.

**"What if `getInputData()` returns zero items?"**
Both loops are `for (i < items.length)`, so with zero items the node returns `[[]]` — an
empty output branch, no HTTP calls. Standard n8n behavior; nothing to special-case.

**"Where's the 404 detection actually happening — status can be in two places?"**
`GenericFunctions.ts:126-128` checks both `error.statusCode` *and*
`error.response.status` because different HTTP layers surface the code differently. That
defensive double-read is intentional; a single check would miss some error shapes. (The
tests exercise both shapes — see the 404 and continueOnFail suites.)

**"Why `push.apply` instead of spread?"**
Volunteered honestly: a cold typecheck flagged `TS2556` on `returnData.push(...arr)` for
the `constructExecutionMetaData` return type. `push.apply(returnData, arr)` is equivalent
and types cleanly. Leads into §8.

**"Is the limit field description lint-clean?"**
There's an intentional `eslint-disable-next-line` on it (`PokemonDescription.ts:86`) for
`node-param-description-wrong-for-limit`, with an inline justification: the description
warns that the list endpoint returns stubs ("name and URL only — use Get for full details"),
which the canonical-limit-description rule would otherwise strip. That's a deliberate UX
decision from the adversarial review, *protected* with a justified suppression — not lint
debt. (This warning was silently stripped by an autofix once and restored — see §8.)

---

## 8. The Cold-Build Story (lead with this when asked "what did you learn")

This is the single best maturity signal you have. Tell it as a process lesson.

**What happened.** The submission's editor and tests were green. After submission, a *cold*
`pnpm build` (clean clone, no cache) surfaced **4 TypeScript errors** that had been masked
by three compounding factors:
1. a stale `dist/` directory serving already-compiled output,
2. turbo's build cache returning prior artifacts instead of recompiling,
3. **Jest transpiling rather than type-checking** — tests ran the code without ever asking
   the compiler "does this typecheck?"

So three different layers all said "green" while a from-clean compile was red.

**The 4 errors and the fixes:**
- **Instantiation-expression calls** like `(pokemonApiRequest<T>).call(...)` — illegal TS
  syntax. Removed the inline generic instantiation; the helper stays generic
  (`pokemonApiRequest<T = unknown>`) and callers cast the result.
- **Bare `as IDataObject` casts** that didn't structurally conform — replaced with a
  typed-`unknown` cast at the API boundary and **object-spread** for `IDataObject`
  conformance (`{ ...responseData } as IDataObject`, `{ ...item } as IDataObject`).
- **`TS2556` on `push(...arr)`** — switched to `push.apply(returnData, arr)`.
- **Inline `import('...').Type` annotations in tests** — replaced with **top-level
  `import type` blocks**.
- Plus a silent regression: a lint autofix had **stripped the intentional limit-field
  description warning**. Restored it and protected it with a justified
  `eslint-disable-next-line` (§7).

68 tests still pass after the fixes.

**The root cause, stated as an issue class:** *"CI that never exercises the cold path."*
Verification rode cached and compiled artifacts; nothing ever ran a cold typecheck of the
final source. The instance fix is the 4 errors; the **class fix** is a CI step that clears
turbo cache and runs a cold build/typecheck before merge.

**Why this is a strong answer, not an admission of failure:** it's the exact difference
between *"tests pass"* and *"it compiles cold."* Jest's transpile-only mode is a real,
common trap. I caught it, root-caused it past the symptom, and turned it into a process gate
rather than just patching four lines. That's the engineering-maturity story: fix the issue
*class*, not just the instance.

If they push: *"Why didn't TDD catch it?"* — Because TDD proves *behavior*, and Jest's
transpile path doesn't enforce *types*. Green tests and a green typecheck are different
guarantees; my mistake was treating one as proof of the other. The fix is making the cold
typecheck a non-skippable gate.

---

## 9. Process & "How I Built It" (for the harness questions)

- **Spec before code.** Filed the assignment as a real project: PRD with user stories, data
  shapes, workflow patterns, and a visual description of the node in the editor *before*
  touching TypeScript (`PRD-POKEMON-NODE.md`).
- **Adversarial trio.** QA, PM, and Architect agents reviewed the plan independently then
  debated live. They found real issues: CoinGecko's deprecated `helpers.request()`, its
  pagination pattern not matching PokeAPI's envelope, and a pointless resource dropdown
  (`ADR-001`, `REVIEW-DISCUSSION.md`). **I overruled their consensus to cut Return All** —
  a documented product-judgment override.
- **Incremental TDD.** Red → Green → Refactor per behavior, one commit per cycle, so git
  history *is* the evidence (ADR D10). I corrected the team's initial "all-red-then-all-green"
  plan to real incremental TDD.
- **Quality gates.** Reviewer agent per PR; a senior code review caught whitespace handling
  (`' pikachu '`) and raw-404 messages; a security audit produced the validation regex,
  redirect disable, and circuit breaker — *shipped, not just documented* (ADR D12).
- **Models.** Opus 4.7 for lead/coordination/judgment calls; Sonnet 4.6 for specialist
  agents. Built on Claude Code's agent-teams over 44+ sessions. I act as product owner.

The framing the assignment rewards: *not just the code, but the system that produces the
code* — and the judgment to override the system when it's wrong (Return All) and to fix the
system when it has a blind spot (the cold-build gate).

---

## 11. Deep Dives (from the live drill — architect altitude, plain language)

Written for a systems architect who reads code but doesn't live in node internals. The goal
is to *explain the behaviour and the trade-off*, not recite function signatures. Each ends
with a **SAY THIS** soundbite you can read aloud to rehearse.

### 11.1 Cheap vs. expensive — don't blur the two costs

There are two separate activities, and conflating them is the easiest way to get corrected:

- **Activity A — "Return All" (just get every name).** PokeAPI hands out names in **pages**,
  like a phone book: ~100 per page, each page pointing to the next. ~1,300 Pokémon = ~14
  pages = ~14 requests, ~1.4 seconds. **Cheap.** The cost scales with *pages* (~14), not
  Pokémon (~1,300).
- **Activity B — "get every name, then look up full detail for each."** The list only gave
  stubs, so each detail needs its own call: ~1,300 requests, ~2 minutes, hundreds of MB if
  unsimplified. **Expensive.** This is the classic **N+1 pattern** — 1 call for the list, N
  calls for the details.

The expensive thing is **B (enrichment)**, not **A (Return All)**. That's *why* list and
detail are separate operations — so the cheap thing stays cheap and the expensive thing is a
visible, deliberate user choice rather than a hidden cost behind one button.

> **SAY THIS:** "Two different costs. Listing all the names is cheap — ~14 calls in about a
> second, because it scales with pages, not Pokémon. What's expensive is *enriching* each of
> those ~1,300 names with its own detail call — that's the N+1 pattern, ~1,300 calls. So I
> kept list and detail separate: the cheap operation stays cheap, and the expensive
> enrichment is a deliberate, visible choice instead of a hidden cost behind one click."

### 11.2 Why Get loops — "one fetch per *input item*", not "one fetch per node"

An n8n node receives a **list of items**, sized by whatever feeds it. Get isn't "fetch one
Pokémon" — it's "**fetch one Pokémon per input item**", i.e. a **map over the input stream**.

- Manual trigger → Get "pikachu": 1 item in, 1 fetch (the common case, your assumption).
- Google Sheet (50 rows) → Get: 50 items in, the *same* node runs 50 times.
- Get Many → Loop → Get: the loop feeds names one at a time.

One-item-in is just the degenerate case. This is *why* batching, per-item error isolation,
and per-item provenance exist — they're properties of a node that processes a *stream*, not a
singleton. (You don't need to know how the loop is written — just that the unit of work is the
item, and the input can carry many.)

> **SAY THIS:** "It's one fetch per *input item*, not one per node. Usually that's a single
> item, but if an upstream node feeds 50 rows, Get runs 50 times — it's a map over the input
> stream. One item in is just the degenerate case. That's why error handling and provenance
> are per-item rather than per-call."

### 11.3 Simplify — flatten, reshape, drop (and why it's a *default*, not a deletion)

The API returns a giant ~1000-line blob; most of it (every learnable move, every image
variant) nobody wants. Simplify is a **cleanup step** that does three things:

1. **Flatten** — surface buried values (a deeply-nested type name becomes just `"electric"`).
2. **Reshape** — change structure so it's usable: the stats **list-you-search** becomes a
   **lookup** so you can say `stats.speed` directly. (List → dictionary.)
3. **Drop** — discard the bulky stuff (the moves list), which is most of the size.

Result: ~1000 lines → ~12 useful fields. It's the most product-minded part of the node.

**Crucial framing for the "isn't dropping data unwise?" challenge:** simplify is a **default,
not a deletion**. Flip the toggle off and you get the **complete raw response, untouched**. So
the drift from source names and the hidden fields are **reversible** — the power user is one
click from the original. You optimised the *default* for the 80% case without locking anyone
out. And a flat shape like `stats.speed` is actually *easier* to map in n8n expressions than
the nested raw blob — so for typical use the simplified shape is the *more* mappable one.

**Who chooses the fields:** the curated set is **hardcoded by the author** (you, via the ADRs
— D9 added `base_experience`/`species` after the PM flagged real use cases). The **user** only
chooses *simplified vs. raw* — a single boolean. Not field-by-field; that's deliberate
simplicity (n8n's downstream Edit Fields / Set node exists if someone wants finer control).

**REST vs. GraphQL (strong unprompted connection):** PokeAPI is REST, so each endpoint returns
a fixed, server-decided blob — you over-fetch and trim client-side. GraphQL inverts that: the
client asks for exactly the fields it needs and the server returns only those. **Simplify is
me hand-rolling on the client what GraphQL would do for free on the server.** If PokeAPI's
GraphQL beta were production-ready, most of simplify disappears — though a thin reshape might
remain, since GraphQL picks fields but returns them in the API's native shape. (This is the
#1 future direction in APPROACH.md.)

> **SAY THIS:** "The API returns a ~1000-line blob; simplify cleans it to ~12 useful fields —
> it flattens buried values, reshapes the stats from a list-you-search into a lookup so you can
> say `stats.speed`, and drops bulk like the moves list. It's a *default*, not a deletion:
> flip the toggle and you get the full raw response untouched, so the drift is reversible. I
> chose the curated fields via the ADRs; the user just picks simplified-versus-raw. And it's
> basically client-side GraphQL — if PokeAPI's GraphQL beta were ready, most of simplify would
> disappear."

### 11.4 Data lifecycle — where the blob lives, and why "no cache" means "discarded"

**The fetch is ALWAYS the full blob** — REST has no "fetch only some fields"; you always get
everything. Simplify is **not a fetch option**, it's an **output filter applied in memory after
the fetch.** The lifecycle:

1. Full response lands in a **temporary in-memory variable** for this one run — never written
   to disk, never persisted by itself.
2. Simplify reads the fields it wants (or passes the whole thing through if the toggle is off).
3. The chosen output is handed onward; the **raw blob then goes out of scope and is
   garbage-collected** — gone.

So the blob is **transient** — it lives just long enough to read from, then evaporates,
*precisely because nothing caches it*. The only thing that survives is the output shape you
chose; n8n may persist *that* as execution history, but never the raw blob.

(The toggle itself is a real, visible **Simplify** switch in the config panel, **on by
default**, and it **only appears for Get** — it hides on Get Many, because list stubs have
nothing to simplify. Showing a no-op toggle would be a UX lie — ADR D6.)

> **SAY THIS:** "Nothing's thrown away *on fetch* — every run pulls the full response, REST
> has no partial fetch. Simplify is an output filter applied in memory *after* the fetch. The
> blob lives in a temporary variable just long enough to read from, then it's
> garbage-collected — discarded precisely because nothing caches it. Only the output shape I
> chose survives. The Simplify toggle is a visible switch, on by default, and it only shows for
> Get — it hides on Get Many because list stubs have nothing to simplify."

### 11.5 Error flows — the three-layer defense (the richest part; under-shown on the diagram)

A good architect separates *three distinct failure layers*:

**Layer 1 — Validation failures (before any network call).** Empty input or illegal characters
(a path like `../../`, a query injection like `?callback=`) are **rejected immediately, before
any request goes out.** Input-shaped failure → fail **closed, early, and cheap**. A malformed
input can't even reach the network. (This is also the security gate — see §4.)

**Layer 2 — API failures (the call came back bad).** Two sub-cases, and the split is a real UX
decision:
- **404 (not found)** → translated into a **friendly, actionable message** ("Pokémon 'X' not
  found — check spelling; names use PokéAPI format like 'mr-mime'"), not a raw stack trace.
- **Everything else** (timeout, 500, network down) → wrapped as a clean API error that surfaces
  in n8n's UI instead of crashing the run.
The principle: **translate machine errors into human errors at the boundary** — same
philosophy as simplify (shape the raw thing into something usable).

**Layer 3 — Batch resilience (one item fails in a multi-item run).** When Get runs over 50
items and #37 fails, two policies:
- **Default:** fail the whole run — safe, predictable.
- **"Continue on fail" (user toggle):** isolate the failure — emit an **error item** for #37
  carrying **provenance** (which input row it came from) and keep processing 38–50. The failure
  becomes a *data row*, not a crash; nothing is silently dropped.

So: **reject bad input before the wire → translate API errors into human messages at the
boundary → isolate per-item failures so one bad item doesn't sink the batch.** The
404-vs-everything-else split and the continue-on-fail provenance are the two things an
interviewer rewards most — they show you thought about *operability*, not just the happy path.

> **SAY THIS:** "Three layers. First, validation rejects bad input — empty strings, path
> traversal, injection — before any request goes out; fail closed, early, cheap. Second, at the
> API boundary I translate machine errors into human ones: a 404 becomes a friendly 'not found,
> check the spelling' message, everything else is wrapped so it surfaces cleanly instead of
> crashing. Third, batch resilience: if I'm processing 50 items and one fails, 'continue on
> fail' turns that failure into an error row that records which input it came from and keeps
> going — nothing's silently dropped. So: reject before the wire, humanize errors at the
> boundary, isolate per-item failures."

### 11.6 The fetch + URL build — deliberately unremarkable (don't over-talk it)

Architecturally it's a plain GET to `…/pokemon/<name-or-id>`, no auth (PokeAPI is open). Only
two things are worth a sentence, and only if asked: **redirects are disabled** (a compromised
API shouldn't bounce the request to an internal address — SSRF-via-redirect defense), and the
identifier is **validated before** it's interpolated into the URL (Layer 1 above). The
interesting decisions are *around* the fetch — validation before, error translation after — not
the fetch itself.

> **SAY THIS:** "Nothing special about the fetch — it's a plain GET, no auth, PokeAPI is open.
> The interesting decisions are *around* it: I validate the identifier before it goes in the
> URL, and I disable redirects so a compromised API can't bounce me to an internal address.
> The fetch is the boring middle; the judgment is at the edges."

### 11.7 Pagination: could you parallelize? (the cursor-vs-offset trade)

Return All currently follows the API's `next` link page-by-page — **cursor-based**, therefore
**sequential** (you only learn page 2's address by reading page 1). You *could* parallelize:
PokeAPI returns the **total count** in the first response, so you could compute every page
offset up front and fire them all at once — collapsing ~1.4s into ~one round-trip. You didn't,
for three honest reasons: cursor-following is the **conventional, API-safe default** (works
even without a total, immune to the list shifting mid-walk); parallel adds **partial-failure
handling and concurrency** complexity; and firing 14 simultaneous requests at a **free public
API** is less polite. If Return All became a hot path, offset-based parallel fetch is the
obvious optimization — and the reason cursor pagination exists at all is that offset pagination
can **double-count or skip** if the underlying list changes between calls (a non-issue for a
slow-moving dataset, but the textbook caveat).

> **SAY THIS:** "I could parallelize — PokeAPI returns the total count up front, so I could
> compute all the page offsets and fetch them at once, turning ~1.4 seconds into roughly one
> round-trip. I chose cursor-based `next`-following: it's the conventional, API-safe default,
> it doesn't assume the list is stable across calls, and parallelizing adds partial-failure
> handling and is ruder to a free public API. If it became a hot path, offset-based parallel
> fetch is the obvious next step."

---

## 10. Fast-Reference Cheat Sheet

| Thing | Value / Location |
|---|---|
| Base URL | `https://pokeapi.co/api/v2` — `GenericFunctions.ts:68` |
| Validation regex | `/^[a-zA-Z0-9-]+$/` — `GenericFunctions.ts:69` |
| Circuit breaker | 50 pages — `GenericFunctions.ts:70` |
| Limit clamp | 1–100 runtime — `GenericFunctions.ts:105` |
| Operations | `get`, `getAll` (display "Get" / "Get Many") — `PokemonDescription.ts` |
| Simplify default | `true`, hidden on Get Many — `PokemonDescription.ts:53,48-50` |
| Return All page size | hardcoded `limit=100` — `GenericFunctions.ts:145` |
| Error types | `NodeApiError` = API/404; `NodeOperationError` = validation / unknown op |
| `usableAsTool` | `true` — `Pokemon.node.ts:36` |
| Tests | 68 unit (Pokemon.node.test.ts) + 2 workflow (NodeTestHarness) |
| Simplified fields | id, name, height, weight, base_experience, types, abilities, stats, sprite, species |
</content>
</invoke>
