#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { printBanner } from '../src/cli/banner.js';
import { Stage0Confirm } from '../src/pipeline/stage0Confirm.js';

dotenv.config();

const program = new Command();

program
  .name('cstress')
  .description('AI-powered adversarial testing CLI tool — Stress test your logic, not just your server.')
  .version('1.0.0')
  .argument('[target]', 'Target application URL (e.g. http://localhost:3000 or https://myapp.com)')
  .option('-g, --gui', 'Launch interactive Web GUI dashboard on port 9999')
  .option('-p, --port <port>', 'Port for web GUI server', '9999')
  .option('-r, --repo <path_or_url>', 'Codebase path (local directory) or GitHub repo URL', process.cwd())
  .option('-t, --token <gh_token>', 'GitHub personal access token for private/rate-limited repos')
  .option('-c, --cookie <cookie>', 'Session cookie header (e.g. "session=abc123")')
  .option('-b, --bearer <jwt>', 'Bearer token / JWT')
  .option('--email <email>', 'Login email for credentialed testing')
  .option('--password <password>', 'Login password for credentialed testing')
  .option('--auth-id <code>', 'Single login ID, student ID, access code or username (e.g. 24101128)')
  .option('-o, --output <file>', 'Output report path', 'CODESTRESS.md')
  .option('-y, --yes', 'Automatically answer yes to confirmation prompts', false)
  .action(async (target, options) => {
    try {
      // If GUI flag is passed or no target provided, start web dashboard
      if (options.gui || !target) {
        const { startGuiServer } = await import('../src/gui/server.js');
        const port = parseInt(options.port || process.env.GUI_PORT || '9999', 10);
        await startGuiServer(port);
        // Try opening the browser automatically on Windows
        try {
          const { exec } = await import('child_process');
          exec(`start http://localhost:${port}`);
        } catch (e) {}
        return;
      }
      // Print visual banner
      printBanner({
        target,
        repo: options.repo,
        engine: `IBM Bob 2.0 (${process.env.OLLAMA_MODEL || 'gpt-oss:120b'})`
      });

      // Normalize target URL
      if (!/^https?:\/\//i.test(target)) {
        target = `http://${target}`;
      }

      // Execute Stage 0: Confirm Target
      const stage0 = new Stage0Confirm({
        target,
        repo: options.repo,
        token: options.token,
        cookie: options.cookie,
        bearer: options.bearer,
        email: options.email,
        password: options.password,
        authId: options.authId,
        yes: options.yes
      });

      const stage0Result = await stage0.execute();

      if (!stage0Result.confirmed) {
        process.exit(0);
      }

      // Next stages will hook in here as we build them out
      console.log(chalk.cyan('Stage 0 completed successfully.'));
    } catch (err) {
      console.error(chalk.bold.red('\n[FATAL ERROR]'), chalk.red(err.message));
      process.exit(1);
    }
  });

program.parse(process.argv);
