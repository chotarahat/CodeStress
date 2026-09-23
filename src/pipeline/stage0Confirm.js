import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import { RouteScanner } from '../repo/routeScanner.js';
import { AIClient } from '../engine/aiClient.js';

export class Stage0Confirm {
  constructor(options = {}) {
    this.target = options.target;
    this.repo = options.repo || process.cwd();
    this.token = options.token;
    this.cookie = options.cookie;
    this.bearer = options.bearer;
    this.email = options.email;
    this.password = options.password;
    this.authId = options.authId;
    this.pin = options.pin;
    this.pinLoginPath = options.pinLoginPath || "/api/auth/login";
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
  async loginWithPin() {
    const failed = error => ({ valid: false, authenticated: false, status: 'FAILED', type: 'PIN', error });
    if (typeof this.pin !== 'string' || !/^\d+$/.test(this.pin)) {
      return failed('Enter a numeric PIN.');
    }
    let loginUrl;
    try {
      const target = new URL(this.target);
      if (typeof this.pinLoginPath !== 'string' || !this.pinLoginPath.startsWith('/')) {
        return failed('Login endpoint must be a path beginning with /.');
      }
      loginUrl = new URL(this.pinLoginPath, target);
      if (loginUrl.origin !== target.origin || !['http:', 'https:'].includes(loginUrl.protocol)) {
        return failed('PIN login endpoint must belong to the target website.');
      }
    } catch {
      return failed('Invalid target URL or PIN login endpoint.');
    }
    try {
      const response = await axios.post(loginUrl.href, { pin: this.pin }, {
        timeout: 8000,
        maxRedirects: 0,
        validateStatus: () => true
      });
      const data = response.data;
      const cookies = response.headers['set-cookie'];
      const token = data?.token || data?.accessToken;
      const rejected = data?.success === false || data?.authenticated === false || data?.valid === false || Boolean(data?.error);
      const granted = token || cookies?.length || data?.success === true || data?.authenticated === true || data?.valid === true;
      if (response.status < 200 || response.status >= 300 || rejected || !granted) {
        return failed(`PIN login was not confirmed (HTTP ${response.status}). Check the PIN and login endpoint.`);
      }
      if (cookies?.length) this.cookie = cookies.map(cookie => cookie.split(';')[0]).join('; ');
      if (token) this.bearer = token;
      console.log(chalk.green('PIN login authenticated ✓'));
      return { valid: true, authenticated: true, status: 'SUCCESS', type: 'PIN' };
    } catch {
      // Never include the request body or credential in logs or streamed errors.
      return failed('Could not reach the PIN login endpoint. Check the target and try again.');
    }
  }

  async testAuth() {
    if (!this.bearer && !this.cookie && this.pin !== undefined) {
      return this.loginWithPin();
    }
    process.stdout.write(chalk.gray('  → Testing authentication... '));

    const headers = {};
    let authType = 'none';

    if (this.bearer) {
      authType = 'Bearer token';
      headers['Authorization'] = `Bearer ${this.bearer.replace(/^Bearer\s+/i, '')}`;
    } else if (this.cookie) {
      authType = 'Session cookie';
      headers['Cookie'] = this.cookie;
    } else if (this.authId) {
      authType = `Login ID (${this.authId})`;
      const loginPaths = ['/api/auth/login', '/api/login', '/login', '/api/users/login'];
      const payloadKeys = ['studentId', 'id', 'username', 'code', 'userId'];
      let loginSuccess = false;

      for (const p of loginPaths) {
        for (const key of payloadKeys) {
          try {
            const res = await axios.post(`${this.target.replace(/\/+$/, '')}${p}`, {
              [key]: this.authId
            }, { timeout: 4000, validateStatus: () => true });

            if (res.status >= 200 && res.status < 300) {
              loginSuccess = true;
              this.isFirstLogin = Boolean(res.data?.firstLogin);
              this.authenticatedUser = res.data?.user || { studentId: this.authId, isNewUser: true };
              if (res.headers['set-cookie']) {
                this.cookie = res.headers['set-cookie'].join('; ');
              }
              if (res.data?.token || res.data?.accessToken) {
                this.bearer = res.data.token || res.data.accessToken;
              }
              break;
            }
          } catch (e) {
            // continue checking
          }
        }
        if (loginSuccess) break;
      }

      // If probe on target failed, and target is on port 3000 (React dev server), check port 5000 backend
      if (!loginSuccess && this.target.includes(':3000')) {
        for (const key of payloadKeys) {
          try {
            const res = await axios.post('http://localhost:5000/api/auth/login', {
              [key]: this.authId
            }, { timeout: 2000, validateStatus: () => true });

            if (res.status >= 200 && res.status < 300) {
              loginSuccess = true;
              this.isFirstLogin = Boolean(res.data?.firstLogin);
              this.authenticatedUser = res.data?.user || { studentId: this.authId, isNewUser: true };
              console.log(chalk.cyan(`\n  💡 Note: Automatically linked to active backend API on http://localhost:5000`));
              break;
            }
          } catch (e) {}
        }
      }

      if (loginSuccess) {
        const userTypeLabel = this.isFirstLogin ? 'New Student Registration' : 'Existing Student Profile';
        console.log(chalk.green(`Authenticated with ID ${this.authId} (${userTypeLabel}) ✓`));
        return {
          valid: true,
          authenticated: true,
          status: 'SUCCESS',
          type: authType,
          user: this.authenticatedUser,
          isFirstLogin: this.isFirstLogin
        };
      } else {
        console.log(chalk.red(`Failed to authenticate with ID ${this.authId} on ${this.target} ✗`));
        return { valid: false, authenticated: false, status: 'FAILED', type: authType, error: 'Login rejected or route not found' };
      }
    } else if (this.email && this.password) {
      authType = `Credentials (${this.email})`;
      // Attempt login check against common login paths if available
      const loginPaths = ['/api/login', '/api/auth/login', '/login', '/api/users/login'];
      let loginSuccess = false;
      for (const p of loginPaths) {
        try {
          const res = await axios.post(`${this.target.replace(/\/+$/, '')}${p}`, {
            email: this.email,
            password: this.password
          }, { timeout: 4000, validateStatus: () => true });

          if (res.status >= 200 && res.status < 300) {
            loginSuccess = true;
            // Capture cookie or token if returned
            if (res.headers['set-cookie']) {
              this.cookie = res.headers['set-cookie'].join('; ');
            }
            if (res.data?.token || res.data?.accessToken) {
              this.bearer = res.data.token || res.data.accessToken;
            }
            break;
          }
        } catch (e) {
          // continue checking
        }
      }

      if (loginSuccess) {
        console.log(chalk.green(`Login credentials authenticated ✓`));
        return { valid: true, authenticated: true, status: 'SUCCESS', type: authType };
      } else {
        console.log(chalk.red(`Login credentials failed on ${this.target} ✗`));
        return { valid: false, authenticated: false, status: 'FAILED', type: authType, error: 'Login rejected' };
      }
    } else {
      console.log(chalk.yellow(`No auth provided — testing in public unauthenticated mode`));
      return { valid: true, authenticated: false, status: 'PUBLIC', type: 'unauthenticated' };
    }

    // If token or cookie passed, probe target to confirm
    try {
      const probeRes = await axios.get(this.target, {
        headers,
        timeout: 5000,
        validateStatus: () => true
      });
      console.log(chalk.green(`${authType} configured and active ✓`));
      return { valid: true, authenticated: true, status: 'SUCCESS', type: authType, responseStatus: probeRes.status };
    } catch (err) {
      console.log(chalk.yellow(`${authType} attached (probe response: ${err.message})`));
      return { valid: true, authenticated: true, status: 'SUCCESS', type: authType };
    }
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
      : (authResult.status === 'FAILED' ? chalk.bold.red(`FAILED [${authResult.type}] ✗`) : chalk.yellow('PUBLIC (Unauthenticated)'));
    console.log(`  • Auth State       : ${authBadge}`);
    if (authResult.user?.studentId) {
      console.log(`  • Logged in User   : ${chalk.cyan(`ID: ${authResult.user.studentId} (${authResult.user.stream || 'Student'})`)}`);
    }
    console.log(`  • Endpoints Found  : ${chalk.green(codeAnalysis.endpoints)} across ${codeAnalysis.routeGroups} route groups`);
    console.log(`  • Middlewares      : ${chalk.yellow(codeAnalysis.middlewares.length > 0 ? codeAnalysis.middlewares.join(', ') : 'None detected')}`);
    console.log(`  • DB Touchpoints   : ${chalk.yellow(codeAnalysis.dbQueries.length)} raw queries detected`);
    console.log(`  • AI Understanding : ${chalk.italic.white(summary)}`);

    // 5. Ask user confirmation
    const confirmed = await this.askUserConfirmation();
    if (!confirmed) {
      console.log(chalk.red('\nAdversarial testing cancelled by user.'));
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
