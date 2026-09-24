# CodeStress
Be the first to break your own code.

## Stage 1: understand source

In the GUI (`npm run gui`, port 9999), choose **Stage 1 · Understand codebase**.
Paste either a local folder address (including Windows paths with spaces) or a
public repository root such as `https://github.com/owner/repo`.

- **Read source only** opens source files and shows the inventory. It does not call
  the AI, contact the target website, authenticate, execute repository code, or run tests.
- **Understand codebase** reads eligible source and sends it to the configured
  Ollama engine in numbered file excerpts. It produces architecture, data flow,
  business-rule, authentication and validation findings with file/line references,
  plus hypotheses for future tests. It does not execute those tests.
- **Files** shows read/excluded/skipped/failed entries, byte counts, line counts,
  SHA-256 hashes, AI coverage and the GitHub commit. Download the JSON report to
  retain this evidence and the per-chunk AI notes. Raw source is not in that download.

CLI alternatives (do not require a running GUI or target):

```text
node bin/cstress.js --read-source --repo "C:/projects/my-app"
node bin/cstress.js --understand --repo https://github.com/owner/repo
```

Local relative paths resolve against the CodeStress server's working folder.
GitHub reads the default branch at one fixed commit, supports `.git` suffixes,
reads all eligible files within the documented limits, and handles truncated
recursive trees. Use a root repository link; branch/file links are rejected.
Public repos do not require a token, but anonymous GitHub API rate limits can
interrupt larger reads. Configure `GITHUB_TOKEN` to raise the available limit;
failed reads remain visible and the result is marked partial.

### AI configuration and coverage

Set `OLLAMA_BASE_URL` (for example `http://localhost:11434`) and `OLLAMA_MODEL`
for local Ollama. For Ollama Cloud, set `OLLAMA_API_KEY` (or `OLLAMA_API`) and
use `https://ollama.com`. Localhost Ollama does not require an API key.
AI errors are reported explicitly; Stage 1 never replaces them with a heuristic
report. Read-only inventory remains useful even when the AI is unavailable.

Defaults: 2,000 files, 512 KiB per file, 20 MiB total source, and 256 source chunks
for AI analysis. Limit hits and unreadable files are reported, not silently dropped.
Every admitted source file is split into line-numbered chunks. Findings are reduced
in groups for the final synthesis; original chunk notes remain in the JSON report.
An AI-coverage count means source was submitted and a response received, not proof
of perfect comprehension or a security assessment. Final synthesis uses summaries,
not every source byte at once. Review cited findings before planning tests.

The reader includes supported UTF-8 source languages, tests, manifests, schemas,
configuration and documentation. Dependency/build directories, binaries, lockfiles,
minified files, symlinks, submodules, environment files and known credential filenames
are excluded. Directory exclusions represent whole subtrees. Local `.gitignore`
patterns are not applied; inspect the inventory. Filename exclusions cannot detect
secrets embedded in ordinary source files. AI analysis transmits eligible source to
the configured provider. Local files are read sequentially; unlike GitHub's commit
snapshot, a local folder can change during reading. File hashes identify what was read.

Route counts are heuristic matches, currently oriented toward Express-style routes;
they do not measure the AI's support for other languages. A partial or unavailable
report should not be treated as readiness to run adversarial tests.

## Validation

Repository-reader and Stage 1 tests are in `test/repository-understanding.test.js`.
They use temporary local folders, a mocked GitHub API and a mocked AI; no public
repository or external AI is contacted. Run `npm test` only when authorized.
PIN authentication has been removed. Stage 0's other authentication methods remain.

### Recovering from AI output limits

Source excerpts are approximately 6,000 characters. Each request starts with a
4,096-token output allowance and retries once at 8,192 tokens if Ollama explicitly
reports truncation. Set `OLLAMA_ANALYSIS_OUTPUT_TOKENS` to an integer from 1,024 to
8,192 to override the starting budget; the retry doubles it. Context is configured
at 32,768 tokens, subject to the model/provider's supported context size. GPT-OSS
models use `think: low`; other model families keep their default reasoning settings.
A finished answer is no longer rejected just for exceeding 12,000 characters.

Source chunks that still truncate are split into smaller line-numbered excerpts,
up to two subdivision levels. Completed findings are kept; irrecoverable excerpts
are labeled incomplete and other source chunks continue. Provider/configuration
failures stop further requests. Only completed findings feed the synthesis. The
final report is generated in four separate sections, retaining any earlier sections
if a later one fails. Individual source findings, including clearly marked partial
answer text, appear in the GUI and downloadable JSON. Reasoning traces are not saved.
These findings live in server memory for the current run; download the report before
restarting the server or beginning a new run.

### From understanding to execution

Stage 1 discovers test/lint/check scripts declared in `package.json`, including
pre/post lifecycle hooks and each package's directory. These are proposals to review,
not trusted or executed commands. `execution.supported` is currently `false` and
all proposals remain `not_run`. A command runner is a separate future component:
review and approve the command and directory, run with resource/time limits in an
isolated checkout, collect exit status and output, and connect findings to actual
results. Static analysis alone never proves a test has passed.

Recovery checks are in `test/ai-analysis-recovery.test.js` and
`test/repository-understanding.test.js`; all AI responses are mocked. These checks
must not be run without the user's permission.

## Authentication evidence

Stage 0 does not infer authenticated access from HTTP 200, a login response's
`success` flag, a user lookup, or a `firstLogin`/onboarding response. It never invents
a user and never silently switches from the configured target to another port.

For Login ID or email/password, configure the login endpoint. CodeStress reads
local or GitHub source to infer the login ID field from supported Express routes
and their direct router mounts. Ambiguous fields stop the login attempt.
The GUI no longer requires a login field name or protected session endpoint.
Current-user routes discovered in source are checked first, followed by a bounded
list of common session paths on the target origin. Unsupported routing patterns
may not be discovered. If the API lives on a different port, set the target to
that API origin; credentials are never forwarded to another origin or redirects.

For cookie authentication, paste request cookie pairs (`session=…; other=…`),
optionally with the `Cookie:` prefix. Values retain their encoding and embedded
`=` characters. Copy the request header, not a Set-Cookie response or cookie table.
Anonymous and invalid-cookie checks happen before the real cookie is sent to an
automatically discovered candidate. Cookie values are excluded from UI evidence.

**Verified** requires a reusable token/cookie, HTTP 401/403 without credentials,
HTTP 401/403 with deliberately invalid credentials, and a successful JSON response
identifying the account with the supplied session. For Login ID or credentials,
that identity must match the submitted account field. Redirects are not followed.
The GUI displays endpoint/status evidence without tokens or passwords.

**Rejected** means the login or verification API rejected the request.
**Unverified** means evidence was missing, ambiguous or unavailable. A valid account
can still be unverified if the app does not expose a suitable session-check endpoint.
This verifies only the configured access check, not overall authentication security.
ID syntax is app-specific; a scanner must not mistake frontend validation for backend
validation. Source analysis can reveal a mismatch independently of session proof.

Unverified/rejected authentication stops Stage 0 before AI analysis or further
testing. Source reading for authentication discovery happens before verification. Source-only Stage 1 remains available separately.
CLI supports `--auth-login-path` and optional discovery overrides `--auth-id-field`
and `--auth-verify-path`.
Regression cases are in `test/auth-verification.test.js`; they use mocked requests
and must not be run without permission.
