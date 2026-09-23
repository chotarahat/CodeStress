const $ = id => document.getElementById(id);
let routes = [], eventCount = 0, running = false, streamReady = false, toastTimer;
let sourceReport = null;
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
  $('btnRead').disabled = value || !streamReady;
  $('btnRun').firstElementChild.textContent = value ? 'Working…' : $('assessmentMode').value === 'understand' ? 'Understand codebase' : 'Confirm target';
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
  sourceReport = null; $('fileInventory').replaceChildren(); $('coverageText').textContent = 'Waiting for source reading…'; $('btnDownload').disabled = true;
  routes = []; $('routeSearch').value = ''; $('fileSearch').value = ''; renderRoutes(); $('routeCountLabel').textContent = $('navCount').textContent = '0';
  $('statStatus').textContent = 'Checking…'; $('statStatus').className = ''; $('statStatusDetails').textContent = 'Confirming your target';
  $('statAuth').textContent = 'Pending'; $('statAuth').className = ''; $('statAuthDetails').textContent = 'Waiting for verification';
  $('statEndpoints').textContent = '—'; $('statGroups').textContent = 'Discovering routes';
  $('aiText').textContent = 'The AI summary will appear when the assessment completes.'; $('aiText').className = 'summary-text empty-state'; $('formError').hidden = true;
}
function fail(message) {
  setRunning(false, 'Failed'); $('statStatus').textContent = 'Incomplete'; $('statStatus').className = 'error-text'; $('statStatusDetails').textContent = 'See activity for details';
  $('statAuth').textContent = $('assessmentMode').value === 'understand' ? '—' : 'Unverified'; $('statAuthDetails').textContent = 'Assessment did not complete'; $('statGroups').textContent = 'No results available';
  $('formError').textContent = message; $('formError').hidden = false; appendLog(message, 'error');
}
function handleStreamEvent(event) {
  if (event.type === 'repository_read') renderSourceReport(event.data, true);
  if (event.type === 'reading_progress') appendLog(`Read ${event.filesRead} source files · ${event.path}`);
  if (event.type === 'understanding_progress') appendLog(`AI reading chunk ${event.current}/${event.total} · ${event.path}`);
  if (event.type === 'stage_complete' && event.stage === 1) { renderSourceReport(event.data); return; }
  if (event.type === 'log') appendLog(event.text, event.level);
  if (event.type === 'stage_start') { if (!running) resetResults(); $('assessmentMode').value = event.stage === 1 ? 'understand' : 'confirm'; syncMode(); setRunning(true, 'Running'); appendLog(`Stage ${event.stage} · ${event.name}`); }
  if (event.type === 'stage_error') fail(event.error || 'Assessment failed.');
  if (event.type === 'stage_complete') {
    $('assessmentMode').value = 'confirm'; syncMode();
    const data = event.data || {}; setRunning(false, 'Complete');
    $('statStatus').textContent = data.reachable ? 'Reachable' : 'Unreachable'; $('statStatus').className = data.reachable ? 'success' : 'error-text'; $('statStatusDetails').textContent = 'Target confirmation complete';
    const status = String(data.authStatus || '').toUpperCase(); const mode = String(data.authMode || '').toLowerCase(); const publicMode = !mode || mode === 'none' || mode === 'unauthenticated';
    $('statAuth').textContent = publicMode ? 'Public' : status === 'SUCCESS' ? 'Verified' : 'Failed'; $('statAuth').className = !publicMode && status === 'FAILED' ? 'error-text' : '';
    $('statAuthDetails').textContent = publicMode ? 'Unauthenticated assessment' : data.authError || data.authMode || 'Session verified';
    $('statEndpoints').textContent = data.endpointsCount ?? 0; $('statGroups').textContent = `${data.routeGroupsCount || 0} route groups discovered`;
    routes = Array.isArray(data.routes) ? data.routes : []; $('routeCountLabel').textContent = $('navCount').textContent = routes.length; renderRoutes();
    $('aiText').textContent = data.aiUnderstanding || 'No AI summary was returned for this assessment.'; $('aiText').className = 'summary-text';
  }
}
$('attackForm').addEventListener('submit', async event => {
  event.preventDefault(); if (running || !streamReady) return;
  const understand = $('assessmentMode').value === 'understand';
  const target = $('targetUrl').value.trim();
  try { if (!understand && !['http:', 'https:'].includes(new URL(target).protocol)) throw new Error(); } catch { $('formError').textContent = 'Enter a valid HTTP or HTTPS target URL.'; $('formError').hidden = false; return; }
  const payload = understand ? { repo: $('repoPath').value.trim(), readOnly: event.submitter?.value === 'read' } : {target, repo: $('repoPath').value.trim()}; const mode = understand ? 'none' : $('authType').value;
  if (mode === 'authId') payload.authId = $('authIdInput').value.trim();
  if (mode === 'bearer') payload.bearer = $('bearerInput').value.trim();
  if (mode === 'cookie') payload.cookie = $('cookieInput').value.trim();
  if (mode === 'credentials') { payload.email = $('emailInput').value.trim(); payload.password = $('passwordInput').value; }
  resetResults(); setRunning(true, 'Starting'); selectTab('Activity'); appendLog(understand ? 'Reading repository source…' : `Starting assessment · ${target}`);
  if (understand) { $('statAuth').textContent = '—'; $('statAuthDetails').textContent = 'Reading source files'; $('statStatusDetails').textContent = 'Opening repository'; }
  try {
    if (understand) {
      const status = await apiRequest('/api/status');
      if (!status.capabilities?.includes('source-understanding')) {
        throw new Error('An older CodeStress server is running without Stage 1 support. Stop that process, run npm run gui again, and refresh this page.');
      }
    }
    const data = await apiRequest(understand ? '/api/understand' : '/api/run', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if (!data.success) throw new Error(data.error || 'Could not start assessment.');
  } catch (error) { fail(error.message); }
});
$('btnClearLogs').addEventListener('click', () => { $('termBody').replaceChildren(); eventCount = 0; $('logCount').textContent = '0 events'; });
$('btnCopyLogs').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('termBody').innerText); toast('Activity copied to clipboard'); } catch { toast('Clipboard unavailable. Select and copy the activity text.'); } });
const stream = new EventSource('/api/stream');
stream.onopen = () => { streamReady = true; $('btnRun').disabled = running; $('btnRead').disabled = running; $('connection').classList.remove('offline'); $('connectionText').textContent = 'Connected'; $('streamLabel').textContent = 'Live stream connected'; $('streamDot').style.background = ''; };
stream.onmessage = event => { try { handleStreamEvent(JSON.parse(event.data)); } catch { appendLog('Unable to read a stream event.', 'warn'); } };
stream.onerror = () => { streamReady = false; $('btnRun').disabled = true; $('btnRead').disabled = true; $('connection').classList.add('offline'); $('connectionText').textContent = 'Reconnecting'; $('streamLabel').textContent = 'Connection lost · reconnecting'; $('streamDot').style.background = '#daae72'; };
$('btnRun').disabled = true; $('btnRead').disabled = true;
apiRequest('/api/status').then(data => {
  $('engineModel').textContent = data.model || String(data.engine || 'Configured model').replace(/^.*\((.*)\)$/, '$1'); $('portLabel').textContent = `PORT ${data.port || 9999}`;
}).catch(() => { $('engineModel').textContent = 'Model status unavailable'; });

function syncMode() {
  const understand = $('assessmentMode').value === 'understand';
  $('targetField').hidden = understand; $('targetUrl').disabled = understand; $('targetUrl').required = !understand;
  $('authFields').hidden = understand;
  $('authFields').querySelectorAll('input, select').forEach(input => { input.disabled = understand || Boolean(input.closest('.auth-field')?.hidden); });
  $('repoPath').required = understand; $('btnRead').hidden = !understand;
  $('statusLabel').textContent = understand ? 'SOURCE STATUS' : 'TARGET STATUS';
  $('authLabel').textContent = understand ? 'FILES READ' : 'AUTHENTICATION';
  $('runNote').textContent = understand ? 'Read source first, or send eligible source files to the configured Ollama engine for analysis. Environment and credential files are excluded; review the inventory before AI analysis.' : 'Stage 0 · Reachability, authentication & route discovery';
  if (!running) $('btnRun').firstElementChild.textContent = understand ? 'Understand codebase' : 'Confirm target';
}
$('assessmentMode').addEventListener('change', () => { syncMode(); resetResults(); $('statStatus').textContent = 'Not checked'; $('statStatusDetails').textContent = 'Ready'; $('statAuth').textContent = '—'; $('statAuthDetails').textContent = 'Waiting for assessment'; });
syncMode();
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
  $('assessmentMode').value = 'understand'; syncMode();
  sourceReport = data; const coverage = data.coverage;
  $('statStatus').textContent = coverage.filesRead ? coverage.complete ? 'Read' : 'Partial read' : 'No source';
  $('statStatus').className = coverage.complete && coverage.filesRead ? 'success' : '';
  $('statStatusDetails').textContent = data.source.type === 'github' ? `GitHub · commit ${data.source.commit?.slice(0, 8) || 'unknown'}` : 'Local folder';
  $('statAuth').textContent = coverage.filesRead; $('statAuth').className = '';
  $('statAuthDetails').textContent = `${coverage.skippedFiles} skipped · ${coverage.failedEntries} failed`;
  $('statEndpoints').textContent = data.endpointsCount; $('statGroups').textContent = 'Heuristic route matches';
  routes = data.routes || []; $('routeCountLabel').textContent = $('navCount').textContent = routes.length; renderRoutes();
  const ai = data.aiCoverage;
  $('coverageText').textContent = `${coverage.filesRead} files read · ${coverage.bytesRead.toLocaleString()} bytes · ${coverage.excludedEntries} excluded entries · ${coverage.skippedFiles} skipped · ${coverage.failedEntries} failed. AI: ${ai.filesAnalyzed} files, ${ai.analyzedChunks}/${ai.totalChunks} source chunks. ${data.source.commit ? `Commit: ${data.source.commit}` : 'Local snapshot: file hashes recorded at read time.'}`;
  $('aiText').textContent = [data.error, data.aiUnderstanding || (data.aiStatus === 'not_requested' ? 'Source reading completed. AI analysis has not been requested. Review Files, then choose Understand codebase.' : reading ? 'Source reading completed. AI analysis is pending…' : 'AI understanding is unavailable. Source inventory remains available.')].filter(Boolean).join('\n\n');
  $('aiText').className = 'summary-text'; $('btnDownload').disabled = false; renderInventory();
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
