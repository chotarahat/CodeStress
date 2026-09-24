const $ = id => document.getElementById(id);
let routes = [], eventCount = 0, running = false, streamReady = false, toastTimer;
let sourceReport = null;
let lastAuthResult = null;
const tabs = ['Activity', 'Routes', 'Summary', 'Files'];

async function apiRequest(endpoint, options = {}) {
  let response;
  try { response = await fetch(endpoint, { cache: 'no-store', ...options }); }
  catch { throw new Error('Cannot reach the CodeStress server. Start it with npm run gui, then refresh this page.'); }
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const hint = response.status === 404
      ? 'This server does not support the requested action. Restart CodeStress with npm run gui and refresh the page.'
      : 'The server returned a page instead of an API response. Open the CodeStress GUI on its configured port and restart it if needed.';
    throw new Error(`${hint} (${endpoint}, HTTP ${response.status})`);
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`The CodeStress server returned invalid JSON (${endpoint}, HTTP ${response.status}). Check the server terminal for errors.`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Unexpected response from ${endpoint}. Restart CodeStress and refresh the page.`);
  if (!response.ok) throw new Error(data.error || `Request failed (${endpoint}, HTTP ${response.status}).`);
  return data;
}
function selectTab(name) {
  tabs.forEach(tab => {
    const active = tab === name;
    $('tab' + tab).classList.toggle('active', active);
    $('tab' + tab).setAttribute('aria-selected', String(active));
    $('tab' + tab).tabIndex = active ? 0 : -1;
    $(tab.toLowerCase() + 'Panel').hidden = !active;
  });
}
tabs.forEach((name, index) => {
  $('tab' + name).addEventListener('click', () => selectTab(name));
  $('tab' + name).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next]); $('tab' + tabs[next]).focus();
  });
});
$('navRoutes').addEventListener('click', () => selectTab('Routes'));
$('navActivity').addEventListener('click', () => selectTab('Activity'));
const authGroups = { authId: 'groupAuthId', bearer: 'groupBearer', cookie: 'groupCookie', credentials: 'groupCredentials' };
$('authType').addEventListener('change', () => {
  Object.entries(authGroups).forEach(([mode, id]) => {
    $(id).hidden = mode !== $('authType').value;
    $(id).querySelectorAll('input').forEach(input => { input.required = !$(id).hidden; input.disabled = $(id).hidden; });
  });
  $('authHint').textContent = $('authType').value === 'none' ? 'Assess publicly accessible routes.' : 'Use a test account for authenticated access.';
});
$('authType').dispatchEvent(new Event('change'));
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800); }
function appendLog(text, level = 'info') {
  $('termBody').querySelector('.console-welcome')?.remove();
  const row = document.createElement('div'); row.className = 'log-line log-' + (['info','success','error','warn'].includes(level) ? level : 'info');
  const time = document.createElement('span'); time.className = 'log-time'; time.textContent = new Date().toLocaleTimeString([], {hour12:false});
  const content = document.createElement('span'); content.textContent = text; row.append(time, content); $('termBody').append(row);
  eventCount++; $('logCount').textContent = `${eventCount} event${eventCount === 1 ? '' : 's'}`;
  $('termBody').scrollTop = $('termBody').scrollHeight;
}
function setRunning(value, state = 'Idle') {
  running = value; $('configFields').disabled = value; $('btnRun').disabled = value || !streamReady;
  $('btnRun').firstElementChild.textContent = value ? 'Working…' : 'Start assessment';
  $('runState').textContent = state;
}
function renderRoutes() {
  const query = $('routeSearch').value.toLowerCase(); $('routesList').replaceChildren();
  const filtered = routes.filter(route => `${route.method} ${route.path}`.toLowerCase().includes(query));
  if (!filtered.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = query ? 'No routes match your search.' : 'No routes discovered yet. Run an assessment to map your application.'; $('routesList').append(empty); }
  filtered.forEach(route => {
    const row = document.createElement('div'); row.className = 'route-item';
    const method = document.createElement('span'); const name = String(route.method || 'GET').toUpperCase(); method.className = 'method-badge method-' + name.toLowerCase().replace(/[^a-z]/g,''); method.textContent = name;
    const path = document.createElement('span'); path.textContent = route.path || '/'; row.append(method, path); $('routesList').append(row);
  });
}
$('routeSearch').addEventListener('input', renderRoutes);
function resetResults() {
  lastAuthResult = null; $('authEvidence').hidden = true;
  sourceReport = null; $('aiFindings').replaceChildren(); $('testCommands').replaceChildren(); $('fileInventory').replaceChildren(); $('coverageText').textContent = 'Waiting for source reading…'; $('btnDownload').disabled = true;
  $('phaseStatus').textContent = 'Starting assessment';
  routes = []; $('routeSearch').value = ''; $('fileSearch').value = ''; renderRoutes(); $('routeCountLabel').textContent = $('navCount').textContent = '0';
  $('statStatus').textContent = 'Checking…'; $('statStatus').className = ''; $('statStatusDetails').textContent = 'Confirming your target';
  $('statAuth').textContent = 'Pending'; $('statAuth').className = ''; $('statAuthDetails').textContent = 'Waiting for verification';
  $('statEndpoints').textContent = '—'; $('statGroups').textContent = 'Discovering routes';
  $('aiText').textContent = 'The AI summary will appear when the assessment completes.'; $('aiText').className = 'summary-text empty-state'; $('formError').hidden = true;
}
function fail(message) {
  setRunning(false, 'Failed'); $('statStatus').textContent = 'Incomplete'; $('statStatus').className = 'error-text'; $('statStatusDetails').textContent = 'See activity for details';
  if (!lastAuthResult) { $('statAuth').textContent = 'Unverified'; $('statAuthDetails').textContent = 'Assessment did not complete'; }
  $('phaseStatus').textContent = 'Assessment incomplete · completed findings retained';
  $('formError').textContent = message; $('formError').hidden = false; appendLog(message, 'error');
}
function handleStreamEvent(event) {
  if (event.type === 'authentication_result') renderAuthentication(event.data);
  if (event.type === 'target_reachable') { $('statStatus').textContent = 'Reachable'; $('statStatus').className = 'success'; $('statStatusDetails').textContent = `HTTP ${event.status}`; }
  if (event.type === 'memory_status') $('memoryStatus').textContent = event.text;
  if (event.type === 'assessment_phase') { $('phaseStatus').textContent = event.text; setRunning(true, event.text); appendLog(event.text); }
  if (event.type === 'understanding_coverage' && sourceReport) { sourceReport.aiCoverage = event.data; updateCoverageText(sourceReport); }
  if (event.type === 'understanding_note' && sourceReport) {
    sourceReport.chunkNotes.push(event.data); appendSourceFinding(event.data);
    $('aiText').textContent = 'Reading source. Completed findings appear below; the report will follow.';
  }
  if (event.type === 'repository_read' || event.type === 'understanding_ready') renderSourceReport(event.data, true);
  if (event.type === 'reading_progress') appendLog(`Read ${event.filesRead} source files · ${event.path}`);
  if (event.type === 'understanding_progress') appendLog(`AI reading chunk ${event.current}/${event.total} · ${event.path}`);
  if (event.type === 'log') appendLog(event.text, event.level);
  if (event.type === 'stage_start') { if (!running) resetResults(); setRunning(true, 'Starting'); appendLog(event.name); }
  if (event.type === 'stage_error') fail(event.error || 'Assessment failed.');
  if (event.type === 'assessment_complete') {
    const data = event.data;
    renderSourceReport(data.report, true);
    renderAuthentication(data.authentication);
    $('statStatus').textContent = 'Reachable'; $('statStatus').className = 'success';
    $('statStatusDetails').textContent = `AI understanding: ${data.report.aiStatus}`;
    const complete = data.status === 'complete';
    setRunning(false, complete ? 'Complete' : 'Needs attention');
    $('phaseStatus').textContent = complete ? 'Assessment finished' : 'Understanding saved · authentication needs attention';
    $('memoryStatus').textContent = `Saved locally · ${data.memory.reusedFindings} previous findings available this run`;
    sourceReport.authentication = data.authentication; sourceReport.memory = data.memory;
    selectTab(complete ? 'Summary' : 'Activity');
  }
}
$('attackForm').addEventListener('submit', async event => {
  event.preventDefault(); if (running || !streamReady) return;
  const target = $('targetUrl').value.trim();
  try { if (!['http:', 'https:'].includes(new URL(target).protocol)) throw new Error(); } catch { $('formError').textContent = 'Enter a valid HTTP or HTTPS target URL.'; $('formError').hidden = false; return; }
  const payload = { target, repo: $('repoPath').value.trim() }; const mode = $('authType').value;
  if (mode === 'authId') { payload.authId = $('authIdInput').value.trim(); }
  if (mode === 'bearer') payload.bearer = $('bearerInput').value.trim();
  if (mode === 'cookie') payload.cookie = $('cookieInput').value.trim();
  if (mode === 'credentials') { payload.email = $('emailInput').value.trim(); payload.password = $('passwordInput').value; }
  resetResults(); setRunning(true, 'Starting'); selectTab('Activity'); appendLog(`Starting assessment · ${target}`);
  try {
    const serverStatus = await apiRequest('/api/status');
    const capability = 'unified-assessment';
    if (!serverStatus.capabilities?.includes(capability)) {
      throw new Error('An older CodeStress server is running. Stop it, run npm run gui again, and refresh this page to use the updated checks.');
    }
    const data = await apiRequest('/api/run', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if (!data.success) throw new Error(data.error || 'Could not start assessment.');
  } catch (error) { fail(error.message); }
});
$('btnClearLogs').addEventListener('click', () => { $('termBody').replaceChildren(); eventCount = 0; $('logCount').textContent = '0 events'; });
$('btnCopyLogs').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('termBody').innerText); toast('Activity copied to clipboard'); } catch { toast('Clipboard unavailable. Select and copy the activity text.'); } });
const stream = new EventSource('/api/stream');
stream.onopen = () => { streamReady = true; $('btnRun').disabled = running; $('connection').classList.remove('offline'); $('connectionText').textContent = 'Connected'; $('streamLabel').textContent = 'Live stream connected'; $('streamDot').style.background = ''; };
stream.onmessage = event => { try { handleStreamEvent(JSON.parse(event.data)); } catch { appendLog('Unable to read a stream event.', 'warn'); } };
stream.onerror = () => { streamReady = false; $('btnRun').disabled = true; $('connection').classList.add('offline'); $('connectionText').textContent = 'Reconnecting'; $('streamLabel').textContent = 'Connection lost · reconnecting'; $('streamDot').style.background = '#daae72'; };
$('btnRun').disabled = true;
apiRequest('/api/status').then(data => {
  $('engineModel').textContent = data.model || String(data.engine || 'Configured model').replace(/^.*\((.*)\)$/, '$1'); $('portLabel').textContent = `PORT ${data.port || 9999}`;
}).catch(() => { $('engineModel').textContent = 'Model status unavailable'; });

let memoryTimer;
function inspectMemory() {
  clearTimeout(memoryTimer);
  memoryTimer = setTimeout(async () => {
    if (running || !$('repoPath').value.trim() || !$('targetUrl').value.trim()) return;
    const query = new URLSearchParams({ repo: $('repoPath').value.trim(), target: $('targetUrl').value.trim() });
    try {
      const data = await apiRequest('/api/memory?' + query);
      if (!running) $('memoryStatus').textContent = data.exists ? `${data.findings} saved findings · ${new Date(data.updatedAt).toLocaleString()}. Source changes will be checked before reuse.` : 'New project · findings will be saved locally.';
    } catch { if (!running) $('memoryStatus').textContent = 'Memory will be checked when the assessment starts.'; }
  }, 400);
}
$('repoPath').addEventListener('input', inspectMemory);
$('targetUrl').addEventListener('input', inspectMemory);
function renderInventory() {
  const query = $('fileSearch').value.toLowerCase(); $('fileInventory').replaceChildren();
  for (const file of (sourceReport?.inventory || []).filter(file => `${file.path} ${file.status}`.toLowerCase().includes(query))) {
    const row = document.createElement('details'); row.className = 'file-entry';
    const title = document.createElement('summary'); title.textContent = `${file.status.toUpperCase()} · ${file.path}`;
    const detail = document.createElement('p'); detail.textContent = [file.reason, `${file.bytes} bytes`, file.lines ? `${file.lines} lines` : '', file.sha256 ? `SHA-256: ${file.sha256}` : '', file.aiAnalyzed ? 'All source chunks analyzed by AI' : 'Not fully analyzed by AI'].filter(Boolean).join(' · ');
    row.append(title, detail); $('fileInventory').append(row);
  }
}
$('fileSearch').addEventListener('input', renderInventory);
function renderSourceReport(data, reading = false) {
  sourceReport = data; const coverage = data.coverage;
  $('statEndpoints').textContent = data.endpointsCount; $('statGroups').textContent = 'Heuristic route matches';
  routes = data.routes || []; $('routeCountLabel').textContent = $('navCount').textContent = routes.length; renderRoutes();
  const ai = data.aiCoverage;
  updateCoverageText(data);
  $('aiText').textContent = [data.error, data.aiUnderstanding || (data.aiStatus === 'not_requested' ? 'Source reading completed. AI analysis has not been requested. Review Files, then choose Understand codebase.' : reading ? 'Source reading completed. AI analysis is pending…' : data.chunkNotes?.length ? 'The overall report is incomplete. Source findings collected so far are available below.' : 'No AI findings have been completed yet. Source inventory remains available.')].filter(Boolean).join('\n\n');
  $('aiText').className = 'summary-text'; $('btnDownload').disabled = false; renderInventory(); renderFindings(data);
  if (!reading) {
    const state = data.aiStatus === 'not_requested' ? (coverage.complete && coverage.filesRead ? 'Source read' : 'Partial read') : data.aiStatus === 'complete' ? 'Complete' : data.aiStatus === 'partial' ? 'Partial' : 'AI unavailable';
    setRunning(false, state); appendLog(`${state} · ${coverage.filesRead} files read, ${ai.analyzedChunks}/${ai.totalChunks} AI chunks`, data.error ? 'warn' : 'success');
    if (data.error) appendLog(data.error, 'warn');
    selectTab(data.aiStatus === 'not_requested' ? 'Files' : 'Summary');
  }
}
$('btnDownload').addEventListener('click', () => {
  if (!sourceReport) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(sourceReport, null, 2)], {type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'codestress-understanding.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function updateCoverageText(data) {
  const { coverage, aiCoverage: ai } = data;
  $('coverageText').textContent = `${coverage.filesRead} files read · ${coverage.bytesRead.toLocaleString()} bytes · ${coverage.excludedEntries} excluded entries · ${coverage.skippedFiles} skipped · ${coverage.failedEntries} failed. AI: ${ai.filesAnalyzed} files, ${ai.analyzedChunks}/${ai.totalChunks} source chunks. ${data.source.commit ? `Commit: ${data.source.commit}` : 'Local snapshot: file hashes recorded at read time.'}`;
}
function appendSourceFinding(finding) {
  const item = document.createElement('details'); item.className = 'file-entry';
  const title = document.createElement('summary');
  title.textContent = `${finding.complete === false ? 'INCOMPLETE · ' : ''}${finding.path}:${finding.startLine}-${finding.endLine}`;
  const body = document.createElement('div'); body.className = 'summary-text'; body.textContent = finding.note;
  item.append(title, body); $('aiFindings').append(item);
}
function renderFindings(data) {
  $('aiFindings').replaceChildren(); $('testCommands').replaceChildren();
  for (const finding of data.chunkNotes || []) appendSourceFinding(finding);
  for (const gap of data.analysisGaps || []) {
    const message = document.createElement('p'); message.className = 'error-text';
    message.textContent = `Incomplete: ${gap.path}:${gap.startLine}-${gap.endLine} · ${gap.reason}`;
    $('aiFindings').append(message);
  }
  if (data.testCommands?.length) {
    const title = document.createElement('h3'); title.textContent = 'Declared checks · not run';
    const note = document.createElement('p'); note.textContent = 'These scripts were found in the repository. Execution is not implemented; review the scripts and approve a separate run before testing.';
    $('testCommands').append(title, note);
    for (const command of data.testCommands) {
      const item = document.createElement('details'); item.className = 'file-entry';
      const label = document.createElement('summary'); label.textContent = `${command.executable} ${command.args.join(' ')} · ${command.directory}`;
      const body = document.createElement('pre'); body.textContent = `${command.manifest}\nScript: ${command.script}\nPre-script: ${command.before || '(none)'}\nPost-script: ${command.after || '(none)'}`;
      item.append(label, body); $('testCommands').append(item);
    }
  }
}

function renderAuthentication(result) {
  lastAuthResult = result;
  const verified = result.status === 'SUCCESS' && result.authenticated === true;
  const publicMode = result.status === 'PUBLIC' && result.type === 'unauthenticated';
  $('statAuth').textContent = publicMode ? 'Public' : verified ? 'Verified' : result.status === 'FAILED' ? 'Rejected' : 'Unverified';
  $('statAuth').className = verified ? 'success' : result.status === 'FAILED' ? 'error-text' : '';
  const detail = result.detail || (publicMode ? 'No authentication requested.' : 'No session verification evidence was supplied.');
  $('statAuthDetails').textContent = publicMode ? detail : 'See authentication evidence below';
  $('authEvidence').hidden = publicMode;
  $('authEvidenceDetail').textContent = detail;
  $('authEvidenceList').replaceChildren();
  for (const check of result.evidence || []) {
    const row = document.createElement('li'); row.textContent = `${check.step}: ${check.endpoint} → HTTP ${check.httpStatus}`; $('authEvidenceList').append(row);
  }
}
