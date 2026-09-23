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
