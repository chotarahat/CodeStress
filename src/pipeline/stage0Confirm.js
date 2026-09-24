import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import { RouteScanner } from '../repo/routeScanner.js';
import { AIClient } from '../engine/aiClient.js';
import { verifyAuthentication } from '../auth/verifyAuthentication.js';

export class Stage0Confirm {
  constructor(options = {}) {
    this.options = options;
    this.target = options.target;
    this.repo = options.repo || process.cwd();
    this.token = options.token;
    this.cookie = options.cookie;
    this.bearer = options.bearer;
    this.email = options.email;
    this.password = options.password;
    this.authId = options.authId;
    this.autoYes = Boolean(options.yes);
    this.aiClient = new AIClient();
  }

  /**
   * Ping target URL to verify it is live and reachable
   */
  async pingTarget() {
    process.stdout.write(chalk.gray('  → Pinging target URL... '));
    const startTime = Date.now();
    try {
      const response = await axios.get(this.target, {
        timeout: 8000,
        validateStatus: () => true, // Accept any status code, server is responding
        headers: {
          'User-Agent': 'CodeStress-Scanner/1.0'
        }
      });
      const duration = Date.now() - startTime;
      console.log(chalk.green(`Reachable [${response.status} ${response.statusText || 'OK'} (${duration}ms)] ✓`));
      return { reachable: true, status: response.status, duration };
    } catch (err) {
      console.log(chalk.red(`Unreachable ✗`));
      throw new Error(`Target ${this.target} is unreachable: ${err.message}. Ensure the server is running and accessible.`);
    }
  }

  /**
   * Test authentication credentials or tokens
   */
  async testAuth() {
    const result = await verifyAuthentication(this.options);
    if (result.authenticated) {
      this.bearer = result.session.bearer;
      this.cookie = result.session.cookie;
    }
    const { session, ...publicResult } = result;
    console.log(`Authentication: ${result.status} — ${result.detail}`);
    return publicResult;
  }

  /**
   * Scan repository and count discovered routes
   */
  async discoverRoutes() {
    process.stdout.write(chalk.gray('  → Scanning repository for routes & logic... '));
    const scanner = new RouteScanner({
      repo: this.repo,
      token: this.token
    });

    const analysis = await scanner.scan();

    console.log(chalk.cyan(`Discovered ${analysis.routeGroups} route groups, ${analysis.endpoints} endpoints ✓`));
    return analysis;
  }

  /**
   * Prompt user to confirm before proceeding
   */
  async askUserConfirmation() {
    if (this.autoYes) {
      console.log(chalk.gray('  → Auto-confirm flag (-y) passed. Proceeding to Stage 1.'));
      return true;
    }

    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.question(chalk.bold.cyan('\n? Ready to begin adversarial test? (y/n) '), (answer) => {
        rl.close();
        const trimmed = (answer || '').trim().toLowerCase();
        if (trimmed === 'y' || trimmed === 'yes' || trimmed === '') {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  /**
   * Run Stage 0 execution
   */
  async execute() {
    console.log(chalk.bold.blue('[STAGE 0] Confirm Target'));

    // 1. Ping target URL
    const pingResult = await this.pingTarget();

    // 2. Test authentication
    const authResult = await this.testAuth();
    this.options.onAuthResult?.(authResult);
    if (!['SUCCESS', 'PUBLIC'].includes(authResult.status)) {
      return { confirmed: false, target: this.target, pingResult, authResult, codeAnalysis: null, summary: 'Authentication was not verified. AI analysis and further testing were not started.' };
    }

    // 3. Count routes in repo
    const codeAnalysis = await this.discoverRoutes();

    // 4. Summarize AI understanding
    process.stdout.write(chalk.gray('  → Generating target understanding summary... '));
    const summary = await this.aiClient.summarizeCodebase(codeAnalysis);
    console.log(chalk.green('Done ✓'));

    console.log('');
    console.log(chalk.bold('Target Overview:'));
    const authBadge = authResult.status === 'SUCCESS'
      ? chalk.bold.green(`SUCCESS [${authResult.type}] ✓`)
      : (authResult.status === 'FAILED' ? chalk.bold.red(`FAILED [${authResult.type}] ✗`) : chalk.yellow(`${authResult.status}: ${authResult.detail}`));
    console.log(`  • Auth State       : ${authBadge}`);
    if (authResult.user?.studentId) {
      console.log(`  • Logged in User   : ${chalk.cyan(`ID: ${authResult.user.studentId} (${authResult.user.stream || 'Student'})`)}`);
    }
    console.log(`  • Endpoints Found  : ${chalk.green(codeAnalysis.endpoints)} across ${codeAnalysis.routeGroups} route groups`);
    console.log(`  • Middlewares      : ${chalk.yellow(codeAnalysis.middlewares.length > 0 ? codeAnalysis.middlewares.join(', ') : 'None detected')}`);
    console.log(`  • DB Touchpoints   : ${chalk.yellow(codeAnalysis.dbQueries.length)} raw queries detected`);
    console.log(`  • AI Understanding : ${chalk.italic.white(summary)}`);

    // 5. Ask user confirmation
    const confirmed = ['SUCCESS', 'PUBLIC'].includes(authResult.status) && await this.askUserConfirmation();
    if (!confirmed) {
      console.log(chalk.yellow('\nNot advancing: authentication is unverified/rejected, or confirmation was declined.'));
      return { confirmed: false, codeAnalysis, authResult, summary };
    }

    console.log(chalk.green('✓ Target confirmed. Advancing to Stage 1.\n'));
    return {
      confirmed: true,
      target: this.target,
      codeAnalysis,
      authResult,
      summary,
      session: {
        cookie: this.cookie,
        bearer: this.bearer,
        email: this.email,
        password: this.password
      }
    };
  }
}
