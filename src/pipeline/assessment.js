import axios from 'axios';
import { RepositoryReader, parseRepository } from '../repo/repositoryReader.js';
import { AIClient } from '../engine/aiClient.js';
import { Stage1Understand } from './stage1Understand.js';
import { ProjectMemory, projectKey, sourceFingerprint } from '../memory/projectMemory.js';
import { planAuthentication } from '../auth/authenticationPlanner.js';
import { verifyAuthentication } from '../auth/verifyAuthentication.js';

export class Assessment {
  constructor(options) {
    this.options = options;
    this.emit = options.onEvent || (() => {});
    this.http = options.http || axios;
    this.ai = options.ai || new AIClient();
  }
  phase(name, text) { this.emit({ type: 'assessment_phase', phase: name, text }); }
  async execute() {
    try { return await this.run(); }
    catch (error) {
      if (this.memory) await this.memory.save({ status: 'incomplete' }).catch(() => {});
      throw error;
    }
  }
  async run() {
    const options = this.options;
    const target = new URL(options.target);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use an HTTP(S) target without embedded credentials.');
    const source = parseRepository(options.repo);
    const key = projectKey(source, target.href);
    const memory = options.memory || new ProjectMemory(key, [options.cookie, options.bearer, options.password, options.authId, options.email, ...(options.cookie || '').split(';').map(pair => pair.slice(pair.indexOf('=') + 1).trim())]);
    this.phase('reachability', 'Checking target reachability');
    let response;
    try { response = await this.http.get(target.href, { timeout: 8000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, validateStatus: () => true }); }
    catch { throw new Error('The target could not be reached. No source analysis or login was attempted.'); }
    this.emit({ type: 'target_reachable', status: response.status });
    const previous = await memory.load();
    this.memory = memory;
    await memory.save({ status: 'reading', source, target: target.origin });
    this.emit({ type: 'memory_status', key, text: previous.updatedAt ? 'Project memory loaded; checking source changes.' : 'Created a private project memory workspace.' });
    this.phase('reading', 'Reading repository source');
    const repository = options.repository || await new RepositoryReader({ repo: options.repo, token: options.token, onProgress: progress => {
      if (progress.filesRead === 1 || progress.filesRead % 10 === 0) this.emit({ type: 'reading_progress', ...progress });
    } }).read();
    const fingerprint = sourceFingerprint(repository, this.ai.model || 'injected');
    const cachedNotes = previous.fingerprint === fingerprint ? previous.notes : [];
    await memory.save({ fingerprint, status: 'understanding', notes: cachedNotes, sourceSnapshot: { source: repository.source, inventory: repository.inventory, coverage: repository.coverage }, report: null, authPlan: null, authentication: null });
    this.phase('understanding', `Understanding the codebase${cachedNotes.length ? ` · ${cachedNotes.length} saved findings available` : ''}`);
    const report = await new Stage1Understand({ repository, ai: this.ai, cachedNotes, onEvent: this.emit,
      onCheckpoint: result => memory.save({ notes: result.chunkNotes, report: result, status: 'understanding' })
    }).execute();
    await memory.save({ report, notes: report.chunkNotes, status: 'understood' });
    this.emit({ type: 'understanding_ready', data: report });
    if (report.aiStatus === 'unavailable' || !report.chunkNotes.length) throw new Error('AI understanding is unavailable. Source inventory and completed findings were saved; authentication has not started.');
    const mode = options.cookie ? 'cookie' : options.bearer ? 'bearer' : options.authId ? 'login-id' : options.email || options.password ? 'credentials' : 'public';
    let authentication;
    let authPlan = null;
    if (mode === 'public') {
      authentication = { status: 'PUBLIC', authenticated: false, type: 'unauthenticated', detail: 'No credentials supplied. Source understanding is saved; authenticated access was not requested.', evidence: [] };
    } else {
      let previousEvidence = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        this.phase('planning', attempt ? 'Reconsidering authentication using the observed responses' : 'Planning authentication from source and saved findings');
        authPlan = await planAuthentication({ ai: this.ai, repository, report, mode, previousEvidence });
        await memory.save({ authPlan, status: 'authenticating' });
        this.emit({ type: 'log', level: 'info', text: `Authentication plan: ${authPlan.reason}` });
        this.phase('authentication', 'Checking authenticated access');
        const result = await verifyAuthentication({ ...options, authPlan }, this.http);
        const { session, ...safeResult } = result;
        authentication = safeResult;
        await memory.save({ authentication });
        this.emit({ type: 'authentication_result', data: authentication });
        // Never repeat a password/login attempt. Only adapt read-only session checks.
        if (authentication.status === 'SUCCESS' || !['cookie', 'bearer'].includes(mode) || !authentication.evidence.length || attempt === 1) break;
        previousEvidence = authentication.evidence;
      }
    }
    const complete = ['SUCCESS', 'PUBLIC'].includes(authentication.status);
    const result = { reachable: true, report, authentication, memory: { key, updatedAt: new Date().toISOString(), reusedFindings: cachedNotes.length }, status: complete ? 'complete' : 'needs_attention' };
    await memory.save({ status: result.status, authentication });
    this.emit({ type: 'memory_status', key, text: 'Source findings, coverage and authentication evidence saved for this project.' });
    return result;
  }
}
