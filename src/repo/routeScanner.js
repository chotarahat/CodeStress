import fs from 'fs';
import path from 'path';
import { Octokit } from '@octokit/rest';

export class RouteScanner {
  constructor(options = {}) {
    this.repoPath = options.repo || process.cwd();
    this.token = options.token || process.env.GITHUB_TOKEN || '';
    this.isGitHub = this.isGitHubUrl(this.repoPath);
  }

  isGitHubUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    return urlStr.includes('github.com') || /^https?:\/\/github\.com\//i.test(urlStr);
  }

  parseGitHubUrl(urlStr) {
    const clean = urlStr.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
    const parts = clean.split('/');
    return { owner: parts[0], repo: parts[1] };
  }

  /**
   * Scan repository and extract routes, middlewares, db interactions
   */
  async scan() {
    if (this.isGitHub) {
      return this.scanGitHub();
    }
    return this.scanLocal();
  }

  /**
   * Scan local filesystem
   */
  async scanLocal(targetDir = this.repoPath) {
    const files = [];
    this.collectFiles(targetDir, files);

    const routes = [];
    const middlewares = new Set();
    const dbQueries = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const relativePath = path.relative(targetDir, file).replace(/\\/g, '/');
        const extracted = this.extractFromCode(content, relativePath);

        routes.push(...extracted.routes);
        extracted.middlewares.forEach(m => middlewares.add(m));
        dbQueries.push(...extracted.dbQueries);
      } catch (err) {
        // Skip unreadable files
      }
    }

    const routeGroups = this.groupRoutes(routes);

    return {
      repoType: 'local',
      repoPath: targetDir,
      totalFilesScanned: files.length,
      routeGroups: Object.keys(routeGroups).length,
      routeGroupsList: Object.keys(routeGroups),
      endpoints: routes.length,
      routes,
      middlewares: Array.from(middlewares),
      dbQueries
    };
  }

  /**
   * Scan remote GitHub repo via Octokit
   */
  async scanGitHub() {
    const { owner, repo } = this.parseGitHubUrl(this.repoPath);
    const octokit = new Octokit({ auth: this.token || undefined });

    const routes = [];
    const middlewares = new Set();
    const dbQueries = [];
    let totalFilesScanned = 0;

    try {
      // Get repository tree recursively
      const { data: commit } = await octokit.rest.repos.getCommit({
        owner,
        repo,
        ref: 'HEAD'
      });
      const treeSha = commit.commit.tree.sha;

      const { data: treeData } = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: treeSha,
        recursive: 'true'
      });

      const candidateFiles = (treeData.tree || []).filter(item => {
        if (item.type !== 'blob') return false;
        const p = item.path;
        if (p.includes('node_modules/') || p.includes('.git/') || p.includes('test/')) return false;
        return /\.(js|mjs|cjs|ts|jsx|tsx|py)$/i.test(p);
      });

      for (const item of candidateFiles.slice(0, 30)) { // limit to top 30 code files
        totalFilesScanned++;
        try {
          const { data: fileData } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: item.path
          });

          if (fileData.content) {
            const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
            const extracted = this.extractFromCode(content, item.path);
            routes.push(...extracted.routes);
            extracted.middlewares.forEach(m => middlewares.add(m));
            dbQueries.push(...extracted.dbQueries);
          }
        } catch (e) {
          // ignore individual file error
        }
      }
    } catch (err) {
      // GitHub API rate-limited or private repo error
      return {
        repoType: 'github',
        repoPath: this.repoPath,
        error: err.message,
        routeGroups: 0,
        routeGroupsList: [],
        endpoints: 0,
        routes: [],
        middlewares: [],
        dbQueries: []
      };
    }

    const routeGroups = this.groupRoutes(routes);

    return {
      repoType: 'github',
      repoPath: this.repoPath,
      totalFilesScanned,
      routeGroups: Object.keys(routeGroups).length,
      routeGroupsList: Object.keys(routeGroups),
      endpoints: routes.length,
      routes,
      middlewares: Array.from(middlewares),
      dbQueries
    };
  }

  /**
   * Recursively collect supported source files
   */
  collectFiles(dir, fileList, maxDepth = 6, currentDepth = 0) {
    if (currentDepth > maxDepth) return;
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build', '.next', '.vscode'].includes(entry.name)) {
          continue;
        }
        this.collectFiles(fullPath, fileList, maxDepth, currentDepth + 1);
      } else if (entry.isFile()) {
        if (/\.(js|mjs|cjs|ts|jsx|tsx|py)$/i.test(entry.name)) {
          fileList.push(fullPath);
        }
      }
    }
  }

  /**
   * Regex extraction of endpoints, parameters, middlewares, and db patterns
   */
  extractFromCode(content, relativePath) {
    const routes = [];
    const middlewares = [];
    const dbQueries = [];

    const lines = content.split('\n');

    // 1. Detect routes: app.get('/api/users', ...), router.post('/login', ...)
    const routeRegex = /(?:app|router)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const endpoint = match[2];

      // Find line number
      const upToMatch = content.substring(0, match.index);
      const lineNumber = upToMatch.split('\n').length;

      // Detect parameters
      const params = [];
      const paramMatches = endpoint.match(/:[a-zA-Z0-9_]+/g);
      if (paramMatches) {
        paramMatches.forEach(p => params.push({ name: p.replace(':', ''), in: 'path' }));
      }

      // Check nearby code block for req.body and req.query
      const blockEnd = Math.min(content.length, match.index + 1200);
      const surroundingCode = content.substring(match.index, blockEnd);

      const bodyMatches = surroundingCode.match(/req\.body(?:\.([a-zA-Z0-9_]+)|\[['"]([a-zA-Z0-9_]+)['"]\])/g);
      if (bodyMatches) {
        bodyMatches.forEach(b => {
          const name = b.replace(/^req\.body(\.|\[['"])/, '').replace(/['"]\]$/, '');
          if (name && !params.find(p => p.name === name)) {
            params.push({ name, in: 'body' });
          }
        });
      }

      const queryMatches = surroundingCode.match(/req\.query(?:\.([a-zA-Z0-9_]+)|\[['"]([a-zA-Z0-9_]+)['"]\])/g);
      if (queryMatches) {
        queryMatches.forEach(q => {
          const name = q.replace(/^req\.query(\.|\[['"])/, '').replace(/['"]\]$/, '');
          if (name && !params.find(p => p.name === name)) {
            params.push({ name, in: 'query' });
          }
        });
      }

      routes.push({
        method,
        path: endpoint,
        file: relativePath,
        line: lineNumber,
        parameters: params,
        rawContext: surroundingCode.slice(0, 300)
      });
    }

    // 2. Detect middleware usage: app.use(authMiddleware), verifyToken, etc.
    const mwRegex = /(?:verifyToken|authenticate|authMiddleware|requireAuth|checkAuth|isAdmin|rateLimit|limiter)/gi;
    let mwMatch;
    while ((mwMatch = mwRegex.exec(content)) !== null) {
      middlewares.push(mwMatch[0]);
    }

    // 3. Detect raw DB queries (SQL injection points)
    const sqlRegex = /(?:SELECT|INSERT|UPDATE|DELETE)\s+[^;]{4,100}/gi;
    let sqlMatch;
    while ((sqlMatch = sqlRegex.exec(content)) !== null) {
      const upToMatch = content.substring(0, sqlMatch.index);
      const lineNumber = upToMatch.split('\n').length;
      dbQueries.push({
        file: relativePath,
        line: lineNumber,
        snippet: sqlMatch[0].trim()
      });
    }

    return { routes, middlewares, dbQueries };
  }

  groupRoutes(routes) {
    const groups = {};
    for (const r of routes) {
      // Group by first path segment, e.g. /api/users -> /api/users or /api
      const parts = r.path.split('/').filter(Boolean);
      const groupKey = parts.length > 1 ? `/${parts[0]}/${parts[1]}` : `/${parts[0] || 'root'}`;
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(r);
    }
    return groups;
  }
}
