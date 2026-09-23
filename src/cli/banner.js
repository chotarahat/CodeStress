import chalk from 'chalk';

export function printBanner(options = {}) {
  const { target = '', repo = '', engine = 'IBM Bob 2.0 (gpt-oss:120b)' } = options;

  console.log('');
  console.log(chalk.bold.cyan('🔍 CodeStress v1.0 — Adversarial App Tester'));
  console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`🌐 ${chalk.bold('Target')} : ${chalk.green(target || 'Not specified')}`);
  console.log(`📦 ${chalk.bold('Repo')}   : ${chalk.yellow(repo || 'Local directory')}`);
  console.log(`🤖 ${chalk.bold('Engine')} : ${chalk.magenta(engine)}`);
  console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
}
