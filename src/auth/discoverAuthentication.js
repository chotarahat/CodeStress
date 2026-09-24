import path from 'node:path';
import { RepositoryReader } from '../repo/repositoryReader.js';

// Source is data: discovery never imports or executes repository code.
export async function discoverAuthentication(options) {
  const verificationPaths = [];
  const idFields = new Set();
  let files = [];
  if (options.repo) {
    try { files = (await new RepositoryReader({ repo: options.repo, token: options.token }).read()).files; }
    catch { /* Common same-origin session routes remain available. */ }
  }
  const mounts = new Map();
  for (const file of files) {
    const imports = new Map();
    for (const match of file.content.matchAll(/(?:import\s+(\w+)\s+from\s*|(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*)['"]([^'"]+)['"]/g)) {
      if (match[3].startsWith('.')) imports.set(match[1] || match[2], path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match[3])).replace(/\.[cm]?[jt]s$/, ''));
    }
    for (const match of file.content.matchAll(/\bapp\.use\s*\(\s*['"]([^'"]+)['"]\s*,\s*([\w\s,]+)\)/g)) {
      for (const handler of match[2].split(',')) {
        const module = imports.get(handler.trim());
        if (module) mounts.set(module, match[1].replace(/\/$/, ''));
      }
    }
  }
  for (const file of files) {
    const routes = [...file.content.matchAll(/\b(app|router)\.(get|post)\s*\(\s*['"]([^'"]+)['"]/g)];
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const prefix = route[1] === 'app' ? '' : mounts.get(file.path.replace(/\.[cm]?[jt]s$/, ''));
      if (prefix === undefined) continue;
      const routePath = prefix + route[3];
      if (route[2] === 'get' && /\/(?:me|whoami|profile|session|current-user|current_user)$/i.test(routePath)) verificationPaths.push(routePath);
      if (route[2] !== 'post' || routePath !== (options.authLoginPath || '/api/auth/login')) continue;
      const body = file.content.slice(route.index, routes[i + 1]?.index ?? file.content.length);
      for (const match of body.matchAll(/\breq\.body\.([\w]+)|\breq\.body\[['"](\w+)['"]\]/g)) idFields.add(match[1] || match[2]);
      for (const match of body.matchAll(/\{([^{}]+)\}\s*=\s*req\.body/g)) {
        for (const field of match[1].split(',')) {
          const name = field.trim().split(/[:=]/)[0].trim();
          if (/^[a-zA-Z]\w*$/.test(name)) idFields.add(name);
        }
      }
    }
  }
  const candidates = [...idFields].filter(field => /^(?:studentId|loginId|userId|username|email|identifier|id)$/i.test(field));
  return {
    authIdField: candidates.length === 1 ? candidates[0] : idFields.size === 1 ? [...idFields][0] : undefined,
    verificationPaths: [...new Set([...verificationPaths, '/api/auth/me', '/api/auth/session', '/api/users/me', '/api/me', '/auth/me', '/api/session', '/api/user', '/me'])].slice(0, 16)
  };
}
