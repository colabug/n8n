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

### 3.5 Get — focused flow (show this for "walk me through Get")

The single-Pokémon path. Each box has a **plain-English line** (what's happening) and the
**real function / detail** beneath it. `[!]` marks the things worth calling out.

> **This diagram reflects the SUBMITTED node: NO CACHING.** Every run is a cold fetch. (The
> caching work is in progress on a separate fork branch and is *not* shown here — see §11.4.)

**The input:** the node receives a list of items from whatever is wired into it
(`getInputData()`). For "type pikachu and hit Execute," a **Manual Trigger** hands it
**exactly one item** — so the path below runs once. (More on why there's a `for` at all, below
the diagram.)

```mermaid
flowchart TD
    A["<b>n8n starts the node</b><br/>passes in the items from upstream<br/><i>execute() — getInputData() returns the item list</i>"] --> B["<b>handle each incoming item</b><br/>manual Get = 1 item, so 1 pass<br/><i>for over items[] — batch-handling, NOT a real loop</i>"]
    B --> C["<b>read the field values for this item</b><br/>the Pokémon name/ID and the Simplify toggle<br/><i>getNodeParameter('nameOrId', i) / ('simplify', i)</i>"]
    C --> D{"<b>is the name safe and well-formed?</b><br/>[!] LAYER 1: check BEFORE any network call<br/><i>validateNameOrId() — trim, allowlist regex, lowercase</i>"}
    D -->|"empty or illegal chars<br/>(e.g. ../ path, ?query)"| DE["<b>reject it, no request sent</b><br/><i>throw NodeOperationError</i>"]
    D -->|"clean"| E["<b>build the request URL</b><br/>just the base URL + the name<br/><i>`${POKEAPI_BASE_URL}/pokemon/${nameOrId}`</i>"]
    E --> F["<b>call PokeAPI (cold — no cache)</b><br/>[!] redirects disabled = SSRF defense<br/>always returns the FULL ~200KB blob<br/><i>pokemonApiRequest() -> helpers.httpRequest()</i>"]
    F -->|"404 not found"| F4["<b>friendly 'check the spelling' error</b><br/>[!] LAYER 2<br/><i>NodeApiError, httpCode 404</i>"]
    F -->|"timeout / 5xx / network"| FE["<b>clean wrapped error</b><br/>[!] LAYER 2<br/><i>NodeApiError</i>"]
    F -->|"success"| G{"<b>does the user want the tidy version?</b><br/>[!] this is an OUTPUT filter, applied AFTER the fetch<br/><i>simplify flag</i>"}
    G -->|"yes (default)"| H["<b>trim to the dozen useful fields</b><br/>see field list below<br/><i>simplifyPokemonData() -> toDataObject()</i>"]
    G -->|"no"| I["<b>pass the full raw blob through</b><br/>untouched<br/><i>spread as IDataObject</i>"]
    H --> J["<b>package the result for n8n</b><br/>[!] tag it back to the input it came from<br/><i>returnJsonArray() + constructExecutionMetaData() — pairedItem</i>"]
    I --> J
    J --> K["<b>the raw blob is now discarded</b><br/>[!] transient — nothing keeps it (no cache)<br/><i>out of scope -> garbage-collected</i>"]
    K --> B
    B --> RET["<b>hand the output to the next node</b><br/><i>return [returnData] — one output branch</i>"]

    DE -.error is caught per-item.-> CF{"<b>was 'Continue on Fail' turned on?</b><br/>[!] LAYER 3: one bad item shouldn't kill the batch<br/><i>continueOnFail()</i>"}
    F4 -.-> CF
    FE -.-> CF
    CF -->|"yes"| CFY["<b>emit an error row, keep going</b><br/>tagged to its input<br/><i>error item + pairedItem</i>"]
    CF -->|"no"| CFN["<b>stop the run</b><br/><i>rethrow</i>"]
```

**What I simplified the fields to (human-readable):** Simplify keeps **id, name, height,
weight, base experience, types, abilities, stats, sprite (image URL), and species** — about a
dozen fields. It *flattens* nested values (a type buried as `types[0].type.name` becomes just
`"electric"`), *reshapes* the stats from a list-you-search into a direct lookup (so
`stats.speed` → `90`), and *drops* the bulky stuff like the full moves list (most of the
200KB). Turn Simplify off and you get the entire raw response instead.

**The `for` loop — what's real vs. what's automatic.** There IS a real `for` loop in
`execute()` (`Pokemon.node.ts:48`) and it iterates over the input items — that part is
genuine, you wrote it. What the **user** doesn't configure is **how many times it runs**: the
iteration count is simply **the number of items the upstream node handed in**. A Manual Trigger
sends **one** item → the loop runs **once** (the manual "Get pikachu" case). A Google Sheet with
50 rows sends **50** items → the *same* loop runs **50** times, no extra config. So the loop is
yours; the count comes from upstream. (Separately, the *workflow-level* looping in "enrich all
Pokémon" — Get Many → **Loop Over Items** → Get — is a distinct control-flow node the user adds
on the canvas; it feeds items into your node one batch at a time, but it's not the `for` inside
`execute`.) **One-line version: "Real for loop over the input items; I don't set the count, the
input size does."**

### 3.6 Get Many — focused flow (limit vs. Return All + the cost split)

Get Many lists Pokémon. Two modes: a **single page** (give me up to N) or **Return All** (walk
every page). Each box: plain-English line on top, the real detail beneath.

```mermaid
flowchart TD
    A["<b>list Pokémon for this item</b><br/><i>execute() — for loop over input items, 1 for a manual run</i>"] --> B{"<b>did the user turn on 'Return All'?</b><br/><i>returnAll flag</i>"}
    B -->|"no (default)"| C["<b>keep the limit sane</b><br/>clamp to 1–100 even if an expression sent something wild<br/><i>clampLimit()</i>"]
    C --> D["<b>ONE quick call — give me up to N names</b><br/>[!] CHEAP: 1 request, ~100ms<br/><i>GET /pokemon?limit=N&offset=0</i>"]
    B -->|"yes"| E["<b>walk every page until there are no more</b><br/>[!] ~14 pages, ~1.4s — cost grows with PAGES (~14), not Pokémon (~1300)<br/><i>pokemonApiRequestAllPages() — see 3.6a</i>"]
    D --> F["<b>keep just the list, throw away the envelope</b><br/>each entry is a STUB: name + URL only, no stats<br/><i>response.results — drop count/next/previous</i>"]
    E --> F
    F --> G["<b>package + tag to input -> next node</b><br/><i>constructExecutionMetaData (pairedItem)</i>"]

    G -.the user can chain this into.-> N["<b>Get Many -> Loop Over Items -> Get</b><br/>[!] THE EXPENSIVE PATH: enrich every stub = N+1, ~1300 calls, ~2 min<br/>unsimplified ~780MB — this is a USER-built workflow, NOT the node doing it"]
```

**The one thing to say here:** Return All *itself* is cheap (~14 calls). The expensive thing is
when the **user** chains it into per-item enrichment (the N+1 path on the right). Keeping list
and detail as separate operations is what makes that cost a visible, deliberate choice instead
of a hidden one.

#### 3.6a — How Return All knows when to stop (the pagination walk)

This is the "when do you stop?" detail. PokeAPI's list response is an envelope —
`{ count, next, previous, results }` — where **`next` is the URL of the following page, or
`null` once you're on the last page.** So the walk follows `next` until the API says "no more."

```mermaid
flowchart TD
    S["<b>start at page 1</b><br/><i>url = /pokemon?limit=100&offset=0</i>"] --> Q{"<b>did the last response give a 'next' link?</b><br/>(null means the API says we're done)<br/><i>while url !== null</i>"}
    Q -->|"no more (next is null)"| DONE["<b>done — return everything collected</b><br/>[!] the LAST page still has real results AND next=null"]
    Q -->|"yes, here's the next page"| GUARD{"<b>have we somehow gone past ~14 pages?</b><br/>[!] safety net — real run is ~14, cap is 50<br/><i>pageCount >= 50</i>"}
    GUARD -->|"way too many (>= 50)"| STOP["<b>abort with a clear error</b><br/>a 'next' that never ends = bug or bad actor<br/><i>throw NodeOperationError</i>"]
    GUARD -->|"normal"| FETCH["<b>fetch this page, add its results</b><br/><i>pokemonApiRequest(url); append results; url = response.next</i>"]
    FETCH --> Q
```

**Why follow `next` instead of 'loop until a page comes back empty'?** Because PokeAPI's **last
page has real results *and* `next: null`.** If you stopped on "empty page," you'd process the
last page, then make **one extra wasted request** to discover the page *after* it is empty.
Following `next` stops exactly on time — the server tells you you're done.

**Is 'wait for null' best practice, or a PokeAPI quirk?** Best practice. Here's the spectrum of
how APIs signal "you're done," strongest to weakest:

| Pattern | How you stop | Robustness | Who uses it |
|---|---|---|---|
| **Cursor / token** | follow an opaque `next_cursor` until null/absent | **Best** — server owns position; safe if data shifts mid-walk | Stripe, Slack, Twitter/X |
| **`next`-link (PokeAPI's)** | follow the `next` **URL** until null | **Best** — same as cursor, link-shaped | PokeAPI, GitHub (`Link` header) |
| **Offset / limit** | `offset += limit`; stop on a short page or past `count` | **OK** — simple, but can skip/duplicate if data changes; you compute offsets | Many older REST APIs |
| **Loop until empty** | keep going until a page is empty | **Weakest** — always one wasted trailing request; can't parallelize | Last resort when no cursor/count given |

> **SAY THIS:** "Following `next` until it's null is cursor/link-based pagination — the modern
> standard Stripe, Slack, and GitHub all use. It's not a PokeAPI quirk; it's the robust pattern
> because the *server* owns 'where am I,' so I can't skip or double-count if records shift. The
> simpler alternative — offset-and-stop-when-short — is more fragile, and 'loop until empty' is
> a last resort when the API gives you no cursor. PokeAPI hands me a `next` URL, so I follow it —
> using the API the way it's meant to be paged. The 50-page cap is just a safety net: a real run
> is ~14 pages, so 50 is generous headroom that turns a runaway 'next' that never ends — a bug
> or bad actor — into a clean error instead of an infinite loop."

### 3.7 Code-level function-call sequence (point here to show the call chain)

This is the "function calls and such" view — who calls whom across the three files, for a
single `Get`. Use it to narrate the layering: the node orchestrates; `GenericFunctions`
holds the reusable, typed helpers. **No caching in this version — every call hits PokeAPI.**

> **Reading the frames (they're not all the same thing):**
> - `loop` = the **real `for` loop** in `execute()` over the input items (`Pokemon.node.ts:48`).
>   It runs **once per input item** — one item for a manual Get, N for an N-item upstream node.
>   The loop is real; what's *not* user-configured is the count (it's the input size).
> - `alt` on **validation / simplify** = an actual **if/else** branch in the code.
> - `break` on **the fetch** = the **try/catch** error path (`Pokemon.node.ts:49,68`) — not a
>   branch you choose, but a failure being caught. Mermaid renders if/else and try/catch
>   similarly, so this is labeled to keep them distinct.

```mermaid
sequenceDiagram
    participant n8n as n8n engine
    participant Node as Pokemon.node.ts<br/>execute()
    participant GF as GenericFunctions.ts
    participant API as PokeAPI

    n8n->>Node: execute() — hands in the input items
    Note over Node: read which operation + the item list<br/>getInputData() / getNodeParameter('operation', 0)
    loop for each input item i — real for loop (1 item for a manual Get)
        Node->>Node: read this item's fields<br/>getNodeParameter('nameOrId', i), ('simplify', i)
        Note over Node,API: try { ... } — the whole fetch is wrapped in error handling
        Node->>GF: validate the name BEFORE any request<br/>validateNameOrId(ctx, raw, i)
        alt IF empty or illegal chars (if/else)
            GF-->>Node: throw NodeOperationError (no HTTP sent)
        else ELSE clean
            GF-->>Node: trimmed + lowercased nameOrId
        end
        Node->>GF: fetch it (cold — no cache)<br/>pokemonApiRequest(url, nameOrId)
        GF->>API: GET /pokemon/{nameOrId}<br/>(Accept json, redirects disabled)
        break CATCH 404 (try/catch, not a branch)
            API-->>GF: 404
            GF-->>Node: throw NodeApiError ("check the spelling")
        end
        API-->>GF: success: full ~200KB JSON blob
        GF-->>Node: responseData (typed as IPokemonDetailResponse)
        alt IF Simplify on (default) (if/else)
            Node->>GF: trim to ~12 useful fields<br/>simplifyPokemonData(responseData)
            GF-->>Node: tidy IPokemonSimplified
            Node->>GF: toDataObject(simplified)
            GF-->>Node: IDataObject ready for n8n
        else ELSE Simplify off
            Node->>Node: pass the full raw blob through
        end
        Node->>n8n: package + tag to input<br/>returnJsonArray + constructExecutionMetaData (pairedItem)
    end
    Node-->>n8n: [returnData] — hand to the next node
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

**Caching — the "for real I'd cache" answer (and the right design).** As submitted there is
**no cache** — every fetch is cold, and the node even ignores PokeAPI's 24-hour `Cache-Control`
header, so repeated lookups in a loop redo identical calls. For a take-home that was a deliberate
scope cut; for production it's a genuine gap. The *correct* design (worth stating precisely):
- **Cache the RAW blob, keyed on `nameOrId` ONLY** — not the simplified output, and not keyed on
  the simplify flag. The cached thing is the full response; the simplify/raw fork runs *after*
  the cache lookup, as a pure transform.
- **Why that ordering matters:** because the cache holds the *full* data and shaping happens
  after, a cache hit can serve **either** simplified or raw per request — toggling simplify never
  forces a re-fetch and never returns incomplete data. (If you cached the *simplified* output
  instead, a later raw request would find the dropped fields already gone — the bug to avoid.)
- **Two layers if you went further:** an **execution-scoped LRU** to collapse duplicate lookups
  inside one Return-All-then-Loop run, and a **persistent cache with a 24h TTL** matching the
  header for cross-run reuse. The cleanest home is actually an **HTTP-caching layer** that honors
  `Cache-Control`, so every node benefits — not hand-rolled inside `execute`.
- **Why deferred:** a correct cache is real complexity — keys, invalidation, memory bounds,
  staleness — not worth the risk in a 1–2h window for a dataset that changes a few times a year.

> **Interview tense rule:** submitted = no cache (cold); fork = caching WIP. Never narrate the
> cache while pointing at the submitted artifact. See §13, Pitfall 2.

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

**If they push: "how do you know the data is stable enough to parallelize?"** Separate two kinds
of stability:
- **Schema stability (does the response *shape* change?)** — you know this from the **contract**,
  not at runtime: PokeAPI is pinned to `/api/v2/`, so the shape is a versioned promise, and your
  code only reads known fields anyway (an added field is ignored harmlessly).
- **Data stability (does the *list* shift between my paginated calls?)** — the whole walk is
  ~1.4s and Pokémon are added a few times a *year*, so within that window it's safe to treat
  `count`/offsets as fixed. The key move is stating it as an **explicit assumption** ("safe in
  this short window, for this slow-moving dataset"), not a silent one. For a fast-moving dataset
  you'd keep cursor pagination, which is immune to mid-walk drift. Note your *shipped* code
  (cursor) already sidesteps this entirely; the stability question only arises in the
  *hypothetical* offset-parallel optimization.

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

---

## 12. Story Bank — "Did anything not go to plan?" (Q5)

The honest-maturity answer. Lead with the positive surprise, tell the failure plainly, name
the **process gap** (not just the bug), and close with the systemic fix.

### The full answer (read it aloud to rehearse)

> "A few things surprised me — mostly in a good way. I built my multi-agent harness mainly for
> Kotlin and JVM work, and this was the first time I'd pointed it at a **Node/TypeScript** stack
> I'd never personally coded in — and it produced quality work. The adversarial-review step in
> particular helped me land the right spec before writing code, rather than discovering the
> design halfway through.
>
> The thing that genuinely *didn't* go to plan: when I came back to the project the next morning
> and ran a clean build, **it didn't compile** — my heart skipped a beat. Four TypeScript errors.
> The fix itself took seconds, but the interesting part is **why I never saw them while I was
> building.**
>
> On my machine, everything was green — the editor was happy, all 68 tests passed. But three
> things were quietly hiding the problem: a **stale build output** directory from earlier,
> the **build cache** serving up already-compiled artifacts instead of recompiling, and — the
> big one — the **test runner transpiles the code without fully type-checking it.** So 'tests
> pass' was telling me the code *ran*, not that it *compiled cleanly from scratch.* Those are two
> different guarantees, and I'd been treating one as proof of the other.
>
> Honestly, that's a process failure on my part: I didn't know those tooling internals deeply —
> how the cache and the transpile-only test path interact — and I **never ran a cold build from a
> clean checkout to verify.** I should have. The submitted patch may not build from scratch for
> exactly that reason — dependency and build-state drift on my machine that a clean environment
> wouldn't have.
>
> So the fix wasn't just patching four type errors — it was closing the **class** of problem:
> add a clean-build step that clears the cache and type-checks from scratch, so 'it compiles
> cold' becomes its own gate that can't be skipped. The lesson I took: green tests and a green
> cold build are different promises, and for anything I ship I now verify the cold build
> explicitly — not just that the tests pass on a warm machine."

### Why it works / how to deliver it

- **Lead with the flex** (harness built for Kotlin, worked in unfamiliar Node) — reframes the
  whole answer from "I hit a bug" to "I built something general and it held up."
- **Don't rush the root cause.** The valuable part isn't "I fixed it fast" — it's *why it was
  hidden*: green tests proved the code **ran**, not that it **compiled cold**. Three masking
  layers: stale build dir + build cache + transpile-only tests.
- **Own the process gap explicitly** (your framing): "I didn't know those tooling internals
  deeply, and I never did a cold build to verify — I should have." Naming it as *your* gap,
  without flagellating, is the maturity signal.
- **Always attach the fix to the disclosure.** Saying "the patch may not build cold" is honest
  *only if* immediately followed by "…which is exactly the gap, and the fix is a cold-build
  gate." Never leave the defect hanging.
- **End on the transferable lesson:** "tests pass" ≠ "it builds cold" — different guarantees;
  verify the cold build as its own step.

### One-line version (if they want it short)

> "It looked done — green tests, happy editor — but a clean build the next morning failed with
> type errors. They were hidden because the tests transpile without full type-checking and the
> build cache was serving stale artifacts, and I never ran a cold build to catch it. Quick fix,
> but the real lesson was that 'tests pass' and 'compiles from scratch' are different promises —
> so I added a clean-build gate."

### Alternate stories (use if the question is framed differently)

- **"A judgment call / disagreement?"** → I overruled my own review team. QA/PM/Architect
  reached consensus to cut Return All; I pushed back, their case rested on "stubs are useless,"
  which the dropdown/reference use cases disprove, so I kept it — with documented reasoning.
  *(Shows independent judgment, not just recovery.)*
- **"A surprise *while building*?"** → The reference node I planned to copy (CoinGecko) turned
  out to use a **deprecated API** and a pagination pattern that **doesn't fit PokeAPI's
  envelope** — the obvious path was a trap, and my adversarial-review process caught it before it
  shipped. *(Shows process catching a problem early.)*

---

## 13. Delivery Technique & Pitfalls (how to perform in the room)

Content is only half of it — these are the *delivery* lessons from the live drill.

### How to drive a diagram (the 3-move technique)

When they ask "walk me through X" and you have a diagram up:
1. **Name the shape first** — "this is the single-Get path, top to bottom." Orient them.
2. **Sweep the happy path in one pass** — item in → validate → fetch → simplify → wrap → out.
   Don't go deep yet; just trace the spine.
3. **Then point at ONE callout and go deep** — pick the juiciest (validation-before-the-wire,
   or simplify-after-fetch) and let *them* pull the next thread.

The diagram carries completeness so you don't have to recite. You're driving the eye and
editorializing — exactly what a staff engineer does in a design review. (Works even on a
verbal-only call: you've internalized the *shape*, "there are basically five steps; the two
interesting ones are…".)

### Pitfall 1 — Answer the operation they actually asked about

In the drill, a "walk me through **Get**" question twice got a **Get Many / Return All**
answer (carryover from a prior tangent). It's a real failure mode: you have a great answer
loaded and fire it at the wrong question. **Fix:** before answering, say which operation/path
you're tracing ("this is the single Get…"), so you commit to the right one and they can
redirect you early if you misheard.

### Pitfall 2 — Keep caching in the right tense

The **submitted** node has **no caching** (every fetch cold). The cache is **WIP on your fork**,
not in what they're evaluating. If you narrate caching while pointing at the submitted artifact
or diagram, a sharp interviewer asks "show me" and you're explaining a post-submission
divergence mid-answer. **Fix — separate the tenses every time:** *"As submitted, every fetch is
cold — deliberately, for the time budget. Since then, on my fork, I've been adding an
execution-scoped cache so toggling simplify doesn't re-fetch — the natural next step."* Submitted
= cold; fork = in progress. (The §3 diagrams are labeled "no cache" to match the submission;
update them only when the cache lands.)

### Pitfall 3 — Don't undersell with "fixed it in seconds"

On the cold-build story (§12), speed is not the point — *why it was hidden* is. Spend the
sentence on the root cause (green tests prove it **ran**, not that it **compiled cold**), then
the systemic fix. "Fixed fast" makes a deep lesson sound trivial.

### Pitfall 4 — Concede before you defend

On challenged design decisions (Return All, simplify dropping data), lead by **agreeing with
the kernel of truth** ("you're right the stubs are thin…"), *then* dismantle it. Jumping
straight to defense reads as defensive. The strongest card on Return All is that you **overruled
your own review team** — independent judgment, not just convention.

### The meta-pattern from the drill

Your instinct pulls toward the **conceptual/product** beats (simplify, caching, data lifecycle,
GraphQL) — which you own cold — and away from the **mechanical** beats (the loop, validation,
error handling, wrapping). For "walk me through it," **traverse the whole machine briefly** and
go deep only when they pull a thread. The diagrams in §3 exist precisely so the mechanical beats
are *on the page* and you don't have to hold them in your head.
