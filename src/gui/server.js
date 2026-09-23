import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { Stage0Confirm } from '../pipeline/stage0Confirm.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.GUI_PORT || 9999;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active SSE clients
let activeClients = [];
let currentRun = null;

function broadcastLog(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  activeClients.forEach(client => {
    try {
      client.res.write(payload);
    } catch (e) {
      // client disconnected
    }
  });
}

// SSE endpoint for live logs
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  activeClients.push(newClient);

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date().toISOString() })}\n\n`);

  req.on('close', () => {
    activeClients = activeClients.filter(c => c.id !== clientId);
  });
});

// Status check endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    engine: `IBM Bob 2.0 (${process.env.OLLAMA_MODEL || 'gpt-oss:120b'})`,
    hasOllamaKey: Boolean(process.env.OLLAMA_API || process.env.OLLAMA_API_KEY),
    port: PORT
  });
});

// Run Stage 0 / Pipeline from GUI
app.post('/api/run', async (req, res) => {
  const { target, repo, authId, pin, pinLoginPath, bearer, cookie, email, password } = req.body || {};

  if (!target) {
    return res.status(400).json({ error: 'Target URL is required' });
  }

  res.json({ success: true, message: 'Execution initiated' });

  // Start background run and stream logs
  const runId = Date.now();
  currentRun = { runId, aborted: false };

  broadcastLog({
    type: 'log',
    level: 'info',
    text: `🚀 Starting CodeStress run against ${target}`
  });

  // Intercept console.log and process.stdout to stream to browser
  const origLog = console.log;
  const origWrite = process.stdout.write;

  const logHook = (text) => {
    // Strip ANSI colors for browser readability
    const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
    broadcastLog({ type: 'log', text: clean });
  };

  try {
    broadcastLog({
      type: 'stage_start',
      stage: 0,
      name: 'Confirm Target'
    });

    const stage0 = new Stage0Confirm({
      target,
      repo: repo || process.cwd(),
      authId,
      pin,
      pinLoginPath,
      bearer,
      cookie,
      email,
      password,
      yes: true // auto-confirm in GUI
    });

    const result = await stage0.execute();

    broadcastLog({
      type: 'stage_complete',
      stage: 0,
      data: {
        reachable: true,
        authStatus: result.authResult?.status || (result.authResult?.valid ? 'SUCCESS' : 'FAILED'),
        authMode: result.authResult?.type || 'unauthenticated',
        authUser: result.authResult?.user || null,
        authError: result.authResult?.error || null,
        endpointsCount: result.codeAnalysis?.endpoints || 0,
        routeGroupsCount: result.codeAnalysis?.routeGroups || 0,
        middlewares: result.codeAnalysis?.middlewares || [],
        dbTouchpoints: result.codeAnalysis?.dbQueries?.length || 0,
        aiUnderstanding: result.summary,
        routes: result.codeAnalysis?.routes || []
      }
    });

    broadcastLog({
      type: 'log',
      level: 'success',
      text: '✓ Stage 0 completed successfully!'
    });
  } catch (err) {
    broadcastLog({
      type: 'log',
      level: 'error',
      text: `✗ Error: ${err.message}`
    });
    broadcastLog({
      type: 'stage_error',
      stage: 0,
      error: err.message
    });
  }
});

// Stop endpoint
app.post('/api/stop', (req, res) => {
  if (currentRun) {
    currentRun.aborted = true;
    broadcastLog({ type: 'log', level: 'warn', text: '⚠️ Execution stopped by user' });
  }
  res.json({ success: true });
});

export function startGuiServer(port = PORT) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log('');
      console.log(chalk.bold.green(`🖥️  CodeStress GUI Live Server running at:`));
      console.log(chalk.bold.cyan(`    👉 http://localhost:${port}`));
      console.log(chalk.gray(`    Engine: IBM Bob 2.0 (${process.env.OLLAMA_MODEL || 'gpt-oss:120b'})`));
      console.log('');
      resolve(server);
    });
  });
}

// If run directly
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  startGuiServer();
}

export default app;
