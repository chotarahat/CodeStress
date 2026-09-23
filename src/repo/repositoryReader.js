import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';

const excludedDirs = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', 'coverage', '.venv', 'venv', '__pycache__', '.cache', '.idea', '.vscode']);
const sourceExtensions = new Set('.js .mjs .cjs .ts .tsx .jsx .py .pyi .java .kt .kts .go .rs .rb .php .cs .fs .vb .c .h .cpp .hpp .cc .swift .scala .ex .exs .erl .clj .vue .svelte .html .htm .css .scss .sass .less .sql .graphql .gql .prisma .proto .json .yaml .yml .toml .xml .md .mdx .txt .sh .ps1 .bat .ini .cfg .conf .gradle .tf .hcl .r .dart .lua'.split(' '));
const excludedFiles = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'poetry.lock', 'cargo.lock', 'composer.lock']);
const specialFiles = new Set(['dockerfile', 'makefile', 'gemfile', 'procfile', '.gitignore', '.dockerignore']);

export function parseRepository(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Enter a local folder path or public GitHub repository URL.');
  const value = input.trim().replace(/^"(.*)"$/, '$1');
  if (/^(https?:\/\/|github\.com\/)/i.test(value)) {
    let url;
    try { url = new URL(value.startsWith('github.com/') ? `https://${value}` : value); } catch { throw new Error('Invalid repository URL.'); }
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname !== 'github.com' || url.username || url.password || parts.length !== 2) {
      throw new Error('Use a repository root URL: https://github.com/owner/repository (not a file or branch link).');
    }
    return { type: 'github', owner: parts[0], repo: parts[1].replace(/\.git$/i, ''), location: url.href };
  }
  return { type: 'local', location: path.resolve(value.replace(/^~(?=[/\\]|$)/, os.homedir())) };
}

export function exclusionReason(filePath, directory = false) {
  const segments = filePath.replace(/\\/g, '/').split('/');
  if (segments.some(segment => excludedDirs.has(segment.toLowerCase()))) return 'Dependency, generated output, or tool directory';
  const name = segments.at(-1).toLowerCase();
  if (/^\.env(?:\.|$)/.test(name) || /(?:^|[._-])(secret|secrets|credentials)(?:[._-]|$)/.test(name) || /\.(pem|key|p12|pfx|keystore)$/.test(name) || /^id_(rsa|ed25519)/.test(name) || ['.npmrc', '.pypirc', '.netrc'].includes(name)) return 'Credential or environment file';
  if (directory) return null;
  if (excludedFiles.has(name) || /\.(min\.(js|css)|map)$/.test(name)) return 'Generated or lock file';
  if (!sourceExtensions.has(path.posix.extname(name)) && !specialFiles.has(name)) return 'Unsupported or binary file type';
  return null;
}

export class RepositoryReader {
  constructor({ repo, token, github, onProgress = () => {}, limits = {} } = {}) {
    this.source = parseRepository(repo);
    this.github = github || new Octokit({ auth: token || process.env.GITHUB_TOKEN || undefined, request: { timeout: 20000 } });
    this.onProgress = onProgress;
    this.limits = { maxFiles: 2000, maxFileBytes: 512 * 1024, maxTotalBytes: 20 * 1024 * 1024, ...limits };
    this.files = [];
    this.inventory = [];
    this.bytesRead = 0;
  }

  record(filePath, status, reason, bytes = 0) {
    const entry = { path: filePath, status, reason, bytes };
    this.inventory.push(entry);
    return entry;
  }

  async consume(filePath, size, load) {
    const reason = exclusionReason(filePath);
    if (reason) { this.record(filePath, 'excluded', reason, size); return; }
    if (this.githubBlocked) { this.record(filePath, 'failed', 'GitHub access or rate limit prevented reading', size); return; }
    if (this.files.length >= this.limits.maxFiles || size > this.limits.maxFileBytes || this.bytesRead + size > this.limits.maxTotalBytes) {
      this.record(filePath, 'skipped', 'Repository read limit reached', size); return;
    }
    try {
      const buffer = await load();
      if (buffer.length > this.limits.maxFileBytes || this.bytesRead + buffer.length > this.limits.maxTotalBytes) {
        this.record(filePath, 'skipped', 'Repository read limit reached', buffer.length); return;
      }
      if (buffer.includes(0)) { this.record(filePath, 'excluded', 'Binary content', buffer.length); return; }
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { this.record(filePath, 'skipped', 'Unsupported text encoding (UTF-8 required)', buffer.length); return; }
      this.bytesRead += buffer.length;
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      this.files.push({ path: filePath, content, bytes: buffer.length, sha256 });
      Object.assign(this.record(filePath, 'read', null, buffer.length), { sha256, lines: content.split('\n').length });
      this.onProgress({ phase: 'reading', filesRead: this.files.length, path: filePath });
    } catch (error) {
      if (this.source.type === 'github' && [403, 429].includes(error.status)) this.githubBlocked = true;
      this.record(filePath, 'failed', `Read failed (${error.status || error.code || 'unavailable'})`, size);
    }
  }

  async readLocal() {
    const root = await fs.realpath(this.source.location).catch(() => { throw new Error('Local repository folder does not exist or cannot be accessed.'); });
    if (!(await fs.stat(root)).isDirectory()) throw new Error('The local repository path must point to a folder.');
    this.source.location = root;
    const queue = [''];
    while (queue.length) {
      const relativeDir = queue.shift();
      let entries;
      try { entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true }); }
      catch { this.record(relativeDir || '.', 'failed', 'Directory could not be read'); continue; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = path.posix.join(relativeDir, entry.name);
        if (entry.isSymbolicLink()) { this.record(relative, 'excluded', 'Symbolic link'); continue; }
        if (entry.isDirectory()) {
          const reason = exclusionReason(relative, true);
          if (reason) this.record(relative + '/', 'excluded', reason);
          else queue.push(relative);
        } else if (entry.isFile()) {
          const absolute = path.join(root, relative);
          try { const stat = await fs.stat(absolute); await this.consume(relative, stat.size, () => fs.readFile(absolute)); }
          catch { this.record(relative, 'failed', 'File could not be accessed'); }
        }
      }
    }
  }

  async readGitHub() {
    const { owner, repo } = this.source;
    try {
      const { data: commit } = await this.github.rest.repos.getCommit({ owner, repo, ref: 'HEAD' });
      this.source.commit = commit.sha;
      const { data: tree } = await this.github.rest.git.getTree({ owner, repo, tree_sha: commit.commit.tree.sha, recursive: 'true' });
      let entries = tree.tree;
      // GitHub may truncate recursive trees. Walk each tree explicitly in that case.
      if (tree.truncated) {
        entries = [];
        const queue = [{ sha: commit.commit.tree.sha, prefix: '' }];
        while (queue.length) {
          const current = queue.shift();
          const { data } = await this.github.rest.git.getTree({ owner, repo, tree_sha: current.sha });
          if (data.truncated) throw new Error('GitHub returned an incomplete directory tree.');
          for (const item of data.tree) {
            const filePath = current.prefix + item.path;
            if (item.type === 'tree') {
              const reason = exclusionReason(filePath, true);
              if (reason) this.record(filePath + '/', 'excluded', reason);
              else queue.push({ sha: item.sha, prefix: filePath + '/' });
            } else entries.push({ ...item, path: filePath });
          }
        }
      }
      for (const item of entries.sort((a, b) => a.path.localeCompare(b.path))) {
        if (item.type === 'tree') continue;
        if (item.mode === '120000' || item.type === 'commit') { this.record(item.path, 'excluded', 'Symbolic link or submodule'); continue; }
        if (item.type !== 'blob') continue;
        await this.consume(item.path, item.size || 0, async () => {
          const { data } = await this.github.rest.git.getBlob({ owner, repo, file_sha: item.sha });
          if (data.encoding !== 'base64') throw new Error('Unsupported GitHub file encoding');
          return Buffer.from(data.content, 'base64');
        });
      }
    } catch (error) {
      const hint = error.status === 404 ? 'Repository not found. Use a public GitHub repository root URL.'
        : [403, 429].includes(error.status) ? 'GitHub access or rate limit reached. Retry later or configure GITHUB_TOKEN.'
        : 'GitHub repository could not be read. Check the URL, network connection, and API availability.';
      throw new Error(hint);
    }
  }

  async read() {
    if (this.source.type === 'github') await this.readGitHub(); else await this.readLocal();
    const count = status => this.inventory.filter(file => file.status === status).length;
    return {
      source: this.source, files: this.files, inventory: this.inventory,
      coverage: { filesRead: this.files.length, bytesRead: this.bytesRead, excludedEntries: count('excluded'), skippedFiles: count('skipped'), failedEntries: count('failed'), complete: !count('skipped') && !count('failed'), limits: this.limits }
    };
  }
}
