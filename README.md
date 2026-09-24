# CodeStress
Be the first to break your own code.

## One assessment workflow

In the GUI (`npm run gui`, port 9999), supply a target URL, a local repository
folder or public GitHub root link, and any test credentials. Click **Start assessment**.
There is no stage selector or separate read-source button in the GUI.

The workflow checks target reachability, reads source, builds AI understanding,
saves its findings, then plans and verifies authentication from the source.
The AI can request additional file/line ranges from the in-memory source snapshot
to trace routes, imports, middleware and templates before producing its plan.
Cookie/token checks can be reconsidered once using observed HTTP evidence;
password logins are never repeated automatically. Source instructions are untrusted
and are not executed. Authentication uses bounded HTTP operations, not arbitrary
AI-generated commands.

**Files** shows read/excluded/skipped/failed entries, hashes and AI coverage.
**AI summary** shows architecture, business rules and findings with source references.
The downloadable report includes the completed authentication evidence.
Incomplete understanding remains clearly marked and is not proof of correctness.

### Project memory workspace

Each repository and target origin has a local workspace under
`.codestress/memory/<project-key>/memory.json`. Findings are checkpointed after each
completed excerpt, then the report, source fingerprint, authentication plan and
HTTP evidence are saved. The next assessment rereads source and reuses completed
findings only when the source fingerprint and AI model match. Changed source is
reanalyzed; old authentication success is never reused as proof of current access.
The GUI displays saved-memory status when a project is selected.

Supplied credentials are not part of the saved report or model prompt; known supplied
secret values are redacted from persisted string values. Ordinary source may still
contain embedded secrets; source filename exclusions are not a secret scanner.
The memory directory is excluded from source reading and Git. This is a persistent
knowledge workspace, **not an OS/container sandbox or command runner**. No tests or
repository commands run automatically. Raw source is reread on each assessment;
it is not copied into memory files, though AI notes may quote excerpts.

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
PIN authentication has been removed. Cookie, bearer, Login ID and email/password inputs remain.

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
Unified GUI assessments checkpoint these findings into project memory. Standalone
CLI source-analysis runs retain their existing downloadable/printed report behavior.

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

The unified GUI uses an AI plan grounded in exact source lines, rather than a fixed
list of guessed `/api/me` endpoints. The planner can reread up to six file ranges
per round for three rounds. Only same-origin HTTP paths and supported operations
are admitted. Source citations must match the actual snapshot. Login path and
request fields are discovered automatically; ambiguous or unsupported plans stop
without submitting credentials. No AI-generated shell commands are executed.

For JSON session routes, verification requires anonymous and invalid credentials
to be rejected, then a successful JSON response identifying the signed-in user.
For source-backed protected HTML pages, anonymous and invalid sessions must receive
401/403 or a redirect to the identified same-origin login path; the real session
must return HTTP 200 HTML with a source-backed authenticated-content marker.
HTML verification proves protected access, not independently verified account identity.
Public SPA shells do not pass this check. Redirects are observed, never followed.
Credentials are not sent to another origin or automatically guessed backend port.

OAuth uses the application's existing session cookie/token. Repository access cannot
complete Google consent, MFA or CAPTCHA. Fresh OAuth sign-in, client-side browser
flows, CSRF-dependent form submissions and separate API origins may require additional
integration; the current runner reports these limits rather than inventing success.
A repo and credentials enable discovery but do not guarantee every app can be logged in.

For cookies, paste request `name=value; other=value` pairs or the full `Cookie:`
header. Do not paste a Set-Cookie response or browser cookie table. Encoded values
and embedded equals signs are preserved. Real cookies are sent to discovered
candidates only after anonymous and invalid-cookie controls reject access.
HTTP 200 alone, onboarding responses and public account lookups never prove login.

Legacy CLI Stage 0 retains its heuristic discovery and optional overrides
`--auth-login-path`, `--auth-id-field`, and `--auth-verify-path`.
Source-only CLI commands remain available. The GUI always uses the unified workflow.
Regression cases are in `test/unified-assessment.test.js` and
`test/auth-verification.test.js`; they use mocks and must not run without permission.
