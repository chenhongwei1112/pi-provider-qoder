# omp-provider-qoder

An [omp](https://github.com/badlogic/pi-mono) provider extension that connects omp to the **Qoder API**, exposing Qoder Global and Qoder China models through provider surfaces. This is an omp-only fork of [`pi-provider-qoder`](https://github.com/simonsmh/pi-provider-qoder) — see [Fork notes](#fork-notes).

## Features

- **Two provider entries**:
  - `qoder` — Global / international Qoder.
  - `qoder-cn` — Qoder China, forced to CN endpoints and independent of `QODER_REGION`.
- **Interactive Login**: Global Qoder supports browser device-code flow or Personal Access Token (PAT) login.
- **Qoder CN PAT Login**: China edition uses a separate PAT login entry (`/login qoder-cn`) and CN token exchange endpoints.
- **WAF Bypass**: Built-in WAF obfuscation and body encoding (`Encode=1`).
- **COSY Signing**: Full COSY signature header generation (RSA/AES-CBC/MD5).
- **Dynamic Model Catalog**: Dynamically fetches model limits, effort configurations, and options from the `/algo/api/v2/model/list` endpoint.
- **Reasoning/Thinking Support**: Real-time extraction of thinking process from API reasoning or HTML-like `<think>` tags.

## Quick start

Build the extension (`npm ci` runs the build through `prepare`):

```bash
npm ci
```

Point omp at the bundle in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - /path/to/omp-provider-qoder/dist/index.js
```

Extensions load at startup, so restart omp afterwards. Then log in.

Global / international edition:

```text
/login qoder
```

China edition:

```text
/login qoder-cn
```

### Personal Access Token (PAT)

A Qoder PAT (`pt-...`) cannot authenticate API calls directly — the provider
exchanges it for a short-lived job token (mirroring the official `qodercli` /
`qoderclicn` flow) and resolves your account identity automatically.

Global Qoder:

- Run `/login qoder` and choose **Use API Key (PAT)**, then paste the token.
- Or set `QODER_PERSONAL_ACCESS_TOKEN` (or `QODER_PAT`) before starting omp.
- `QODER_API_KEY` is also accepted; when set, the provider exchanges it and logs
  in during startup.

Qoder China:

- Run `/login qoder-cn`, then paste the CN PAT.
- Or set `QODERCN_PERSONAL_ACCESS_TOKEN` (or `QODERCN_PAT`) before starting omp.
- `QODERCN_API_KEY` is also accepted and triggers the same automatic startup login.

> The exchanged job token is short-lived; the provider transparently re-exchanges
> the stored PAT when it expires.

### Region environment variables

The provider also understands these optional variables:

```bash
export QODER_REGION=cn       # or QODER_BACKEND=cn / QODER_MODE=cn
```

Setting a CN PAT without a global PAT also auto-selects CN mode for the `qoder`
entry, but the recommended explicit China entry is still `/login qoder-cn` and
`--provider qoder-cn`.

## Endpoints

Global:

- PAT exchange: `https://openapi.qoder.sh/api/v1/jobToken/exchange`
- User info: `https://openapi.qoder.sh/api/v1/userinfo`
- Usage: `https://openapi.qoder.sh/api/v2/quota/usage`
- Model / chat gateway: `https://api3.qoder.sh/algo/api/v2/...`

China:

- PAT exchange: `https://openapi.qoder.com.cn/api/v1/jobToken/exchange`
- User info: `https://openapi.qoder.com.cn/api/v1/userinfo`
- Usage: `https://openapi.qoder.com.cn/api/v2/quota/usage`
- Model / chat gateway: `https://gateway.qoder.com.cn/algo/api/v2/...`

## Models

### Global `qoder`

Exposes the backing model keys returned by Qoder, including:

- **Tier Models**: `auto`, `ultimate`, `performance`, `efficient`, `lite`
- **Frontier Models**:
  - `qmodel` (Qwen3.7 Plus)
  - `cmodel` (Cantus)
  - `qmodel_preview` (Qwen3.8 Max Preview)
  - `qmodel_latest` (Qwen3.7 Max)
  - `dmodel` (DeepSeek V4 Pro)
  - `dfmodel` (DeepSeek V4 Flash)
  - `gm51model` (GLM 5.2)
  - `kmodel` (Kimi K2.7 Code)
  - `kmodel_latest` (Kimi K3)
  - `mmodel` (MiniMax M3)

### China `qoder-cn`

The China provider exposes friendly model IDs and maps them back to Qoder CN's
internal keys at request time:

| Friendly ID | Qoder CN key | Context | Images | Reasoning |
| --- | --- | ---: | :---: | :---: |
| `auto` | `auto` | 180K | ✅ | ✅ |
| `qwen3.7-max` | `qmodel_latest` | 1M | ✅ | ✅ |
| `qwen3.7-plus` | `qmodel` | 1M | ❌ | ✅ |
| `qwen3.6-flash` | `q36fmodel` | 1M | ❌ | ✅ |
| `deepseek-v4-pro` | `dmodel` | 1M | ❌ | ✅ |
| `deepseek-v4-flash` | `dfmodel` | 1M | ❌ | ❌ |
| `glm-5.2` | `gm51model` | 200K | ✅ | ✅ |
| `kimi-k2.6` | `kmodel` | 256K | ✅ | ✅ |
| `minimax-m2.7` | `mmodel` | 200K | ❌ | ❌ |

Compatibility aliases are also accepted for request mapping, such as
`qwen3.6-plus` → `qmodel`, `glm-5.1` → `gm51model`, and `minimax-m3` → `mmodel`.

## Usage

Once logged in, select any Qoder model in omp:

```text
/model qoder/auto
```

Or start directly:

```bash
omp --model qoder/auto
```

China example:

```bash
omp --model qoder-cn/qwen3.7-plus
```

## Architecture

```text
src/
├── index.ts            # Extension registration
├── stream.ts           # Orchestration only: build -> open -> translate -> emit
│
│                       # Streaming pipeline. Split so each part can be reasoned
│                       # about on its own; the boundaries below are enforced.
├── request.ts          # Chat request body, stable session and record ids
├── transport.ts        # HTTP, retries, Retry-After, idle watchdog
├── sse.ts              # SSE line framing, pure
├── events.ts           # SSE payloads -> pi events, usage mapping
├── thinking-parser.ts  # Fallback <think> tag parser
├── transform.ts        # Message conversions (OpenAI schema mapping)
├── qoder-encoding.ts   # WAF bypass body encoder
├── usage.ts            # Token accounting
│
│                       # Identity, credentials, signing
├── cosy.ts             # COSY signature, machine id, endpoints, identity defaults
├── oauth.ts            # PAT / OAuth orchestrator, identity resolution
├── identity-store.ts   # The identity omp's auth store drops, persisted beside it
├── login.ts            # OAuth device flow + PAT login sequence
├── pat.ts              # PAT -> job-token exchange
│
│                       # Model catalogue and paths
├── models.ts           # Dynamic config cache
├── models-static.ts    # Static model catalogue
└── paths.ts            # omp agent directory (honors PI_CODING_AGENT_DIR)
```

Three boundaries hold mechanically, and each is worth keeping:

- `sse.ts` has **zero imports**. It is byte framing and knows nothing about
  Qoder, so it needs no harness to test. It is also deliberately greedy and
  terminator-blind: it returns every complete `data:` line in the buffer, and
  the caller is responsible for stopping at `[DONE]` and for threading the
  unconsumed `rest` into the next chunk.
- `transport.ts` references **no pi types**. It moves bytes and retries; it has
  no opinion about what they mean.
- `events.ts` contains **no `fetch`**. SSE-to-event translation is decided
  entirely by its inputs, so stream semantics are testable without a network.

`stream.ts` owns the terminator and `rest` contract spanning those three, and
emits both terminal events (`done` and `error`) so that responsibility stays in
one place.

## Storage layout

Everything this provider persists lives under omp's agent directory — `~/.omp/agent`
by default, relocated by `PI_CODING_AGENT_DIR` and by `omp --profile <name>`:

| Path | Written by | Contents |
| --- | --- | --- |
| `agent.db` | omp | Credential record: `access`, `refresh`, `expires`, `email` |
| `qoder-identity.json` | this provider | `userID`, `name`, `email`, `machineID` |
| `qoder-models-cache.json` | this provider | Dynamic model catalogue and effort configs |
| `qoder-machine-id` | this provider | Fallback machine id, only when the Qoder IDE has none |

The identity file exists because omp's auth store keeps only the
`OAuthCredentials` fields it knows and drops the `userID`, `name`, and `machineID`
this provider attaches. COSY signing rejects an empty `userID`, so the identity
has to survive independently of the credential. `userID` and `machineID` are also
recoverable from the refresh string — `pat|<pat>|<jobRefresh>|<userID>|<machineID>`
for PAT credentials, `<refreshToken>|<userID>|<machineID>` for OAuth ones — and
the file covers `name`, which neither layout carries.

The machine id prefers `~/.qoder/.auth/machine_id`, the Qoder IDE's own copy:
reusing it keeps this client on the same device fingerprint as the official one.

## Fork notes

Differences from upstream `pi-provider-qoder`, each driven by omp rather than
preference:

- **`systemPrompt` arrives as an array.** omp hands it over as `string[]` while
  the `pi-ai` types it injects still declare `string`. Passing the array through
  as a system message's `content` makes Qoder reject the body with
  `set property error, ...MessagesInputDto#content`.
- **No `oauth.modifyModels`.** omp clones the provider config across its worker
  boundary, so a function member makes that clone throw and omp logs
  `extension model projection failed; serving unprojected catalog` — the hook is
  never invoked. `registerProvider` already supplies the correct catalogue.
- **Credentials come from omp's `AuthStorage`**, not from `~/.pi/agent/auth.json`.
- **Paths follow `PI_CODING_AGENT_DIR`** instead of resolving under `~/.pi`.
- **Manifest key is `omp.extensions`**; omp reads `pi.extensions` only as legacy.

Verified end to end against omp: startup registration, catalogue listing
(`omp models` lists all 16 models), streaming completions, and tool calls. The
interactive `/login` device-code flow is unchanged from upstream and was not
re-exercised here.

## License

MIT
