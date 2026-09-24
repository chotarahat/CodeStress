import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { Stage0Confirm } from '../pipeline/stage0Confirm.js';
import { Stage1Understand } from '../pipeline/stage1Understand.js';
import { parseRepository } from '../repo/repositoryReader.js';

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
  if (currentRun) {
    if (data.type === 'stage_start') currentRun.started = data;
    if (data.type === 'authentication_result') currentRun.auth = data;
    if (data.type === 'repository_read') currentRun.repository = data;
    if (['reading_progress', 'understanding_progress'].includes(data.type)) currentRun.progress = data;
    if (['stage_complete', 'stage_error'].includes(data.type)) currentRun.finished = data;
  }
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

  const clientId = Symbol();
  const newClient = { id: clientId, res };
  activeClients.push(newClient);

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date().toISOString() })}\n\n`);

  if (currentRun?.active) {
    for (const event of [currentRun.started, currentRun.auth, currentRun.repository, currentRun.progress]) {
      if (event) res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } else if (currentRun?.finished) {
    if (currentRun.auth) res.write(`data: ${JSON.stringify(currentRun.auth)}\n\n`);
    res.write(`data: ${JSON.stringify(currentRun.finished)}\n\n`);
  }

  req.on('close', () => {
    activeClients = activeClients.filter(c => c.id !== clientId);
  });
});

// Status check endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    capabilities: ['source-understanding', 'evidence-based-auth', 'automatic-auth-discovery'],
    engine: `Ollama (${process.env.OLLAMA_MODEL || 'gpt-oss:120b'})`,
    model: process.env.OLLAMA_MODEL || 'gpt-oss:120b',
    running: Boolean(currentRun?.active),
    hasOllamaKey: Boolean(process.env.OLLAMA_API || process.env.OLLAMA_API_KEY),
    port: PORT
  });
});

// Run Stage 0 / Pipeline from GUI
app.post('/api/run', async (req, res) => {
  const { target, repo, authId, bearer, cookie, email, password, authLoginPath, authVerifyPath, authIdField } = req.body || {};

  if (currentRun?.active) return res.status(409).json({ error: 'An assessment is already running.' });
  if (!target) {
    return res.status(400).json({ error: 'Target URL is required' });
  }

  res.json({ success: true, message: 'Execution initiated' });

  // Start background run and stream logs
  const runId = Date.now();
  currentRun = { runId, aborted: false, active: true };

  broadcastLog({
    type: 'log',
    level: 'info',
    text: `🚀 Starting CodeStress run against ${target}`
  });

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
      authLoginPath,
      authVerifyPath,
      authIdField,
      onAuthResult: result => broadcastLog({ type: 'authentication_result', data: result }),
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
        authStatus: result.authResult?.status || 'UNVERIFIED',
        authVerified: result.authResult?.authenticated === true,
        authDetail: result.authResult?.detail || '',
        authEvidence: result.authResult?.evidence || [],
        confirmed: result.confirmed,
        sourceScanned: Boolean(result.codeAnalysis),
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
      level: result.confirmed ? 'success' : 'warn',
      text: result.confirmed ? 'Stage 0 completed.' : 'Stage 0 stopped: authentication was not verified. See the authentication evidence.'
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
  } finally {
    currentRun.active = false;
  }
});

// Stage 1 reads source independently of the target and authentication.
app.post('/api/understand', async (req, res) => {
  if (currentRun?.active) return res.status(409).json({ error: 'An assessment is already running.' });
  const { repo, readOnly = false } = req.body || {};
  try { parseRepository(repo); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (typeof readOnly !== 'boolean') return res.status(400).json({ error: 'readOnly must be a boolean.' });
  currentRun = { runId: Date.now(), active: true };
  res.json({ success: true, message: 'Source reading initiated' });
  broadcastLog({ type: 'stage_start', stage: 1, name: readOnly ? 'Read source' : 'Understand codebase' });
  try {
    const result = await new Stage1Understand({ repo, readOnly, onEvent: event => {
      if (event.type !== 'reading_progress' || event.filesRead === 1 || event.filesRead % 10 === 0) broadcastLog(event);
    } }).execute();
    broadcastLog({ type: 'stage_complete', stage: 1, data: result });
  } catch (error) {
    broadcastLog({ type: 'stage_error', stage: 1, error: error.message });
  } finally { currentRun.active = false; }
});

// API errors must remain JSON, including Express body-parser errors and 404s.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown CodeStress API endpoint. Restart the GUI server and refresh the page.' });
});
app.use((error, req, res, next) => {
  if (!req.path.startsWith('/api/')) return next(error);
  if (res.headersSent) return next(error);
  const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
  const message = status === 413 ? 'The request is too large.'
    : status === 400 ? 'Invalid JSON request body. Submit the repository path through the GUI form.'
    : 'CodeStress could not process the request. Check the server terminal.';
  res.status(status).json({ error: message });
});

export function startGuiServer(port = PORT) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log('');
      console.log(chalk.bold.green(`🖥️  CodeStress GUI Live Server running at:`));
      console.log(chalk.bold.cyan(`    👉 http://localhost:${port}`));
      console.log(chalk.gray(`    Engine: Ollama (${process.env.OLLAMA_MODEL || 'gpt-oss:120b'})`));
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
