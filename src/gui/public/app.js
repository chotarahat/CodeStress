const $ = id => document.getElementById(id);
let routes = [], eventCount = 0, running = false, streamReady = false, toastTimer;
const tabs = ['Activity', 'Routes', 'Summary'];
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
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next]); $('tab' + tabs[next]).focus();
  });
});
$('navRoutes').addEventListener('click', () => selectTab('Routes'));
$('navActivity').addEventListener('click', () => selectTab('Activity'));
const authGroups = { pin: 'groupPin', authId: 'groupAuthId', bearer: 'groupBearer', cookie: 'groupCookie', credentials: 'groupCredentials' };
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
  $('btnRun').firstElementChild.textContent = value ? 'Assessment running…' : 'Run assessment';
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
  routes = []; renderRoutes(); $('routeCountLabel').textContent = $('navCount').textContent = '0'; $('routeSearch').value = '';
  $('statStatus').textContent = 'Checking…'; $('statStatus').className = ''; $('statStatusDetails').textContent = 'Confirming your target';
  $('statAuth').textContent = 'Pending'; $('statAuth').className = ''; $('statAuthDetails').textContent = 'Waiting for verification';
  $('statEndpoints').textContent = '—'; $('statGroups').textContent = 'Discovering routes';
  $('aiText').textContent = 'The AI summary will appear when the assessment completes.'; $('aiText').className = 'summary-text empty-state'; $('formError').hidden = true;
}
function fail(message) {
  setRunning(false, 'Failed'); $('statStatus').textContent = 'Incomplete'; $('statStatus').className = 'error-text'; $('statStatusDetails').textContent = 'See activity for details';
  $('statAuth').textContent = 'Unverified'; $('statAuthDetails').textContent = 'Assessment did not complete'; $('statGroups').textContent = 'No results available';
  $('formError').textContent = message; $('formError').hidden = false; appendLog(message, 'error');
}
function handleStreamEvent(event) {
  if (event.type === 'log') appendLog(event.text, event.level);
  if (event.type === 'stage_start') { if (!running) resetResults(); setRunning(true, 'Running'); appendLog(`Stage ${event.stage} · ${event.name}`); }
  if (event.type === 'stage_error') fail(event.error || 'Assessment failed.');
  if (event.type === 'stage_complete') {
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
  const target = $('targetUrl').value.trim();
  try { if (!['http:', 'https:'].includes(new URL(target).protocol)) throw new Error(); } catch { $('formError').textContent = 'Enter a valid HTTP or HTTPS target URL.'; $('formError').hidden = false; return; }
  const payload = {target, repo: $('repoPath').value.trim()}; const mode = $('authType').value;
  if (mode === 'pin') { payload.pin = $('pinInput').value.trim(); payload.pinLoginPath = $('pinLoginPath').value.trim(); }
  if (mode === 'authId') payload.authId = $('authIdInput').value.trim();
  if (mode === 'bearer') payload.bearer = $('bearerInput').value.trim();
  if (mode === 'cookie') payload.cookie = $('cookieInput').value.trim();
  if (mode === 'credentials') { payload.email = $('emailInput').value.trim(); payload.password = $('passwordInput').value; }
  resetResults(); setRunning(true, 'Starting'); selectTab('Activity'); appendLog(`Starting assessment · ${target}`);
  try {
    const response = await fetch('/api/run', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    const data = await response.json(); if (!response.ok || !data.success) throw new Error(data.error || 'Could not start assessment.');
  } catch (error) { fail(error.message); }
});
$('btnClearLogs').addEventListener('click', () => { $('termBody').replaceChildren(); eventCount = 0; $('logCount').textContent = '0 events'; });
$('btnCopyLogs').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('termBody').innerText); toast('Activity copied to clipboard'); } catch { toast('Clipboard unavailable. Select and copy the activity text.'); } });
const stream = new EventSource('/api/stream');
stream.onopen = () => { streamReady = true; $('btnRun').disabled = running; $('connection').classList.remove('offline'); $('connectionText').textContent = 'Connected'; $('streamLabel').textContent = 'Live stream connected'; $('streamDot').style.background = ''; };
stream.onmessage = event => { try { handleStreamEvent(JSON.parse(event.data)); } catch { appendLog('Unable to read a stream event.', 'warn'); } };
stream.onerror = () => { streamReady = false; $('btnRun').disabled = true; $('connection').classList.add('offline'); $('connectionText').textContent = 'Reconnecting'; $('streamLabel').textContent = 'Connection lost · reconnecting'; $('streamDot').style.background = '#daae72'; };
$('btnRun').disabled = true;
fetch('/api/status').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(data => {
  $('engineModel').textContent = data.model || String(data.engine || 'Configured model').replace(/^.*\((.*)\)$/, '$1'); $('portLabel').textContent = `PORT ${data.port || 9999}`;
}).catch(() => { $('engineModel').textContent = 'Model status unavailable'; });
