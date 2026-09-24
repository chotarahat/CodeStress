import axios from 'axios';
import { RepositoryReader, parseRepository } from '../repo/repositoryReader.js';
import { AIClient } from '../engine/aiClient.js';
import { Stage1Understand } from './stage1Understand.js';
import { RouteScanner } from '../repo/routeScanner.js';
import { ProjectMemory, projectKey, sourceFingerprint } from '../memory/projectMemory.js';
import { planAuthentication } from '../auth/authenticationPlanner.js';
import { verifyAuthentication } from '../auth/verifyAuthentication.js';

export class Assessment {
  constructor(options) {
    this.options = options;
    this.emit = options.onEvent || (() => {});
    this.http = options.http || axios;
    this.ai = options.ai || new AIClient();
    this.onUserPrompt = options.onUserPrompt || (() => Promise.resolve(true));
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
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      throw new Error('Use an HTTP(S) target without embedded credentials.');
    const source = parseRepository(options.repo);
    const key = projectKey(source, target.href);
    const memory = options.memory || new ProjectMemory(key, [
      options.cookie, options.bearer, options.password, options.authId, options.email,
      ...(options.cookie || '').split(';').map(pair => pair.slice(pair.indexOf('=') + 1).trim())
    ]);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 1 — REACHABILITY
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    this.phase('reachability', 'Checking target reachability');
    let reachResponse;
    try {
      reachResponse = await this.http.get(target.href, {
        timeout: 8000, maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024, validateStatus: () => true
      });
    } catch {
      throw new Error('The target could not be reached. No source analysis or login was attempted.');
    }
    this.emit({ type: 'target_reachable', status: reachResponse.status });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 2 — READ REPOSITORY (fast file I/O, no AI)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    this.phase('reading', 'Reading repository source');
    const previous = await memory.load();
    this.memory = memory;
    await memory.save({ status: 'reading', source, target: target.origin });
    this.emit({ type: 'memory_status', key, text: previous.updatedAt
      ? 'Project memory loaded; checking source changes.'
      : 'Created a private project memory workspace.' });

    const repository = options.repository || await new RepositoryReader({
      repo: options.repo, token: options.token,
      onProgress: progress => {
        if (progress.filesRead === 1 || progress.filesRead % 10 === 0)
          this.emit({ type: 'reading_progress', ...progress });
      }
    }).read();

    const fingerprint = sourceFingerprint(repository, this.ai.model || 'injected');
    const cachedNotes = previous.fingerprint === fingerprint ? previous.notes : [];
    await memory.save({
      fingerprint, status: 'read', notes: cachedNotes,
      sourceSnapshot: { source: repository.source, inventory: repository.inventory, coverage: repository.coverage },
      report: null, authPlan: null, authentication: null
    });

    // Quick heuristic route scan — no AI, just regex matching
    const analysis = new RouteScanner().analyze(repository);
    const routeSnapshot = {
      source: repository.source, coverage: repository.coverage, inventory: repository.inventory,
      routes: analysis.routes.map(({ rawContext, ...route }) => route),
      endpointsCount: analysis.endpoints, routeGroupsCount: analysis.routeGroups,
      aiStatus: 'pending', aiUnderstanding: '', chunkNotes: cachedNotes, analysisGaps: [],
      reportSections: [], testCommands: [],
      execution: { supported: false, status: 'not_run', requiresApproval: true },
      aiCoverage: { totalChunks: 0, analyzedChunks: 0, attemptedChunks: 0, filesAnalyzed: 0, complete: false }
    };
    this.emit({ type: 'repository_read', data: routeSnapshot });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 3 — AUTHENTICATION (AI-focused on auth code only)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const mode = options.cookie ? 'cookie' : options.bearer ? 'bearer'
      : options.authId ? 'login-id' : options.email || options.password ? 'credentials' : 'public';

    let authentication;
    let authPlan = null;

    if (mode === 'public') {
      authentication = {
        status: 'PUBLIC', authenticated: false, type: 'unauthenticated',
        detail: 'No credentials supplied. Source understanding is saved; authenticated access was not requested.',
        evidence: []
      };
      this.emit({ type: 'authentication_result', data: authentication });
    } else {
      // The auth planner reads auth-related source excerpts directly from the repository.
      // It does NOT need a full AI understanding report — a minimal report with cached
      // notes (if any) is enough. The planner's own regex filter picks up files matching
      // auth|session|middleware|login|app.|server. and sends them to the AI.
      const minimalReport = {
        chunkNotes: cachedNotes,
        aiCoverage: { totalChunks: 0, analyzedChunks: 0, complete: false }
      };

      let previousEvidence = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        this.phase('planning', attempt
          ? 'Reconsidering authentication using the observed responses'
          : 'Planning authentication from source');

        try {
          authPlan = await planAuthentication({
            ai: this.ai, repository, report: minimalReport, mode, previousEvidence
          });
        } catch (planError) {
          // AI-based planning failed — fall back to static code discovery.
          // verifyAuthentication handles the null authPlan by using discoverAuthentication.
          this.emit({ type: 'log', level: 'warn',
            text: `AI auth planning unavailable: ${planError.message}. Using static code discovery.` });
          authPlan = null;
        }

        if (authPlan) {
          await memory.save({ authPlan, status: 'authenticating' });
          this.emit({ type: 'log', level: 'info', text: `Authentication plan: ${authPlan.reason}` });
        }

        this.phase('authentication', 'Verifying authenticated access');
        const result = await verifyAuthentication({ ...options, authPlan }, this.http);
        const { session, ...safeResult } = result;
        authentication = safeResult;
        await memory.save({ authentication });
        this.emit({ type: 'authentication_result', data: authentication });

        // Never repeat a password/login attempt. Only adapt read-only session checks.
        if (authentication.status === 'SUCCESS'
          || !['cookie', 'bearer'].includes(mode)
          || !authentication.evidence.length
          || attempt === 1) break;
        previousEvidence = authentication.evidence;
      }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 4 — ASK USER: "Read full codebase?"
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const authComplete = ['SUCCESS', 'PUBLIC'].includes(authentication.status);
    this.phase('waiting', authComplete
      ? 'Authentication verified · waiting for confirmation'
      : 'Authentication incomplete · waiting for confirmation');

    const proceed = await this.onUserPrompt({
      type: 'user_prompt',
      prompt: 'Read full codebase?',
      detail: authComplete
        ? 'Authentication succeeded. Proceed with full AI codebase understanding?'
        : 'Authentication was not verified. You can still read and analyze the full codebase.',
      authStatus: authentication.status
    });

    if (!proceed) {
      const result = {
        reachable: true, report: routeSnapshot, authentication,
        memory: { key, updatedAt: new Date().toISOString(), reusedFindings: cachedNotes.length },
        status: authComplete ? 'auth_only' : 'needs_attention'
      };
      await memory.save({ status: result.status, authentication });
      this.emit({ type: 'memory_status', key, text: 'Authentication evidence saved. Full codebase analysis was skipped.' });
      return result;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // STEP 5 — FULL AI UNDERSTANDING
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    this.phase('understanding', `Understanding the full codebase${cachedNotes.length
      ? ` · ${cachedNotes.length} saved findings available` : ''}`);
    await memory.save({ status: 'understanding' });

    const report = await new Stage1Understand({
      repository, ai: this.ai, cachedNotes, onEvent: this.emit,
      onCheckpoint: result => memory.save({ notes: result.chunkNotes, report: result, status: 'understanding' })
    }).execute();

    await memory.save({ report, notes: report.chunkNotes, status: 'understood' });
    this.emit({ type: 'understanding_ready', data: report });

    if (report.aiStatus === 'unavailable' || !report.chunkNotes.length) {
      this.emit({ type: 'log', level: 'warn',
        text: 'AI understanding is unavailable. Source inventory and authentication evidence were saved.' });
    }

    const complete = authComplete && report.aiStatus !== 'unavailable' && report.chunkNotes.length > 0;
    const result = {
      reachable: true, report, authentication,
      memory: { key, updatedAt: new Date().toISOString(), reusedFindings: cachedNotes.length },
      status: complete ? 'complete' : 'needs_attention'
    };
    await memory.save({ status: result.status, authentication });
    this.emit({ type: 'memory_status', key, text: 'Source findings, coverage and authentication evidence saved for this project.' });
    return result;
  }
}
