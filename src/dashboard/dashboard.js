const $ = id => document.getElementById(id);
const statuses = { backlog: '待安排', ready: '待调度', running: '进行中', retrying: '等待重试', review: '待审查', blocked: '需处理' };
const eventNames = { worker_started: 'Agent 开始处理任务', repository_prepared: '工作分支已准备', checks_started: '开始执行验证', branch_pushed: '分支已推送', pull_request_handoff: 'Pull Request 已交接', worker_completed: '本轮任务完成', worker_failed: '任务失败，等待重试', issue_blocked: '任务需要人工处理', post_handoff_agent_error: '交接已完成，模型会话随后报错' };
let snapshot, filter = 'all', view = 'board', page = 'board', selectedId, loading = false, lastFocus;
const number = value => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; }
function safeURL(value) { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } }
function duration(value) { const n = Math.max(0, Math.floor(value || 0)); return n >= 3600 ? `${Math.floor(n / 3600)} 小时 ${Math.floor(n % 3600 / 60)} 分` : `${Math.floor(n / 60)} 分 ${n % 60} 秒`; }
function notify(message, error = false) { $('notice').hidden = !message; $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function badge(status) { const el = node('span', 'badge'); el.append(node('i', `status-dot ${status}`), node('span', '', statuses[status] || status)); return el; }
function runtime(issue) { return snapshot.running.find(r => r.issue_id === issue.id); }
function retry(issue) { return snapshot.retrying.find(r => r.issue_id === issue.id); }
function task(issue) {
  const button = node('button', 'task'); button.type = 'button'; button.dataset.issue = issue.id;
  button.setAttribute('aria-label', `${issue.identifier} ${issue.title}，${statuses[issue.status]}`);
  const id = node('div', 'task-id'); id.append(node('span', '', issue.identifier), node('span', '', '↗'));
  button.append(id, node('h3', '', issue.title));
  const tags = node('div', 'task-labels'); for (const label of issue.labels.slice(0, 3)) tags.append(node('span', 'tag', label));
  if (!issue.labels.length) tags.append(node('span', 'tag', issue.state)); button.append(tags);
  const run = runtime(issue), waiting = retry(issue), foot = node('div', 'task-foot');
  foot.append(node('span', '', run ? `${run.turn_count} 轮 · ${number(run.tokens.total_tokens)} tokens` : waiting ? `第 ${waiting.attempt} 次重试` : issue.status === 'review' ? '等待人工审查' : issue.status === 'backlog' ? '尚未满足调度条件' : issue.state), node('span', '', run ? '● LIVE' : waiting ? time(waiting.due_at) : issue.updated_at ? new Date(issue.updated_at).toLocaleDateString('zh-CN') : '—'));
  button.append(foot); button.addEventListener('click', () => openDetail(issue.id)); return button;
}
function empty(message) { const el = node('div', 'empty'); el.append(node('span', 'empty-symbol', '◇'), node('span', '', message)); return el; }
function renderBoard() {
  const query = $('search').value.trim().toLowerCase();
  const all = snapshot.dashboard?.issues || [];
  const issues = all.filter(i => (filter === 'all' || filter === 'attention' && ['retrying', 'blocked'].includes(i.status) || i.status === filter) && `${i.title} ${i.identifier} ${i.labels.join(' ')}`.toLowerCase().includes(query));
  const focused = document.activeElement?.dataset?.issue;
  $('board').replaceChildren(); $('list').replaceChildren();
  for (const [status, title] of Object.entries(statuses)) {
    if (filter !== 'all' && !(filter === 'attention' ? ['retrying', 'blocked'].includes(status) : filter === status)) continue;
    const matches = issues.filter(i => i.status === status), column = node('section', 'column'), heading = node('div', 'column-head');
    heading.append(node('i', `status-dot ${status}`), node('b', '', title), node('span', 'count', matches.length), node('span', 'symbol', '···')); column.append(heading);
    matches.forEach(issue => column.append(task(issue))); if (!matches.length) column.append(empty(query ? '没有匹配的任务' : '暂无任务')); $('board').append(column);
  }
  for (const issue of issues) { const row = node('button', 'list-row'); row.dataset.issue = issue.id; row.append(node('span', '', issue.identifier), node('strong', '', issue.title), badge(issue.status), node('span', '', issue.state)); row.addEventListener('click', () => openDetail(issue.id)); $('list').append(row); }
  if (!issues.length) $('list').append(empty(query ? '没有找到匹配的任务，试试其他关键词。' : '当前没有任务。请在任务源中创建 Issue 并添加调度标签。'));
  $('board').hidden = view !== 'board'; $('list').hidden = view !== 'list';
  $('total-count').textContent = all.length; $('nav-count').textContent = all.length;
  $('match-count').textContent = `显示 ${issues.length} / ${all.length} 个任务`;
  if (focused) Array.from(document.querySelectorAll('[data-issue]')).find(el => el.dataset.issue === focused && !el.closest('[hidden]'))?.focus({ preventScroll: true });
}
function field(container, title, value) { const row = node('div'); row.append(node('dt', '', title), node('dd', '', value ?? '—')); container.append(row); }
function detailContent() {
  const issue = snapshot.dashboard.issues.find(i => i.id === selectedId); if (!issue) { $('detail-description').textContent = '该任务已离开当前调度快照。请到任务源查看最新状态。'; return; }
  $('detail-id').textContent = issue.identifier; $('detail-title').textContent = issue.title;
  $('detail-status').replaceChildren(badge(issue.status)); $('detail-description').textContent = issue.description || '暂无任务描述。';
  const fields = $('detail-fields'); fields.replaceChildren(); const run = runtime(issue), waiting = retry(issue);
  field(fields, '任务源状态', issue.state); field(fields, '标签', issue.labels.join(' · ') || '无');
  if (run) { field(fields, '运行时长', duration((Date.now() - Date.parse(run.started_at)) / 1000)); field(fields, '当前轮次', run.turn_count); field(fields, '最近事件', eventNames[run.last_event] || run.last_event || '正在启动'); field(fields, 'Token', number(run.tokens.total_tokens)); field(fields, '会话', run.session_id || '等待会话启动'); }
  if (waiting) { field(fields, '重试次数', waiting.attempt); field(fields, '下次尝试', time(waiting.due_at)); field(fields, '失败原因', waiting.error || '等待继续'); }
  const url = safeURL(issue.url); $('issue-link').hidden = !url; if (url) $('issue-link').href = url; else $('issue-link').removeAttribute('href');
}
function openDetail(id) { selectedId = id; lastFocus = document.activeElement; detailContent(); if (!$('detail').open) $('detail').showModal(); }
function renderActivity() {
  const target = $('activities'); target.replaceChildren(); const rows = snapshot.dashboard?.activities || [];
  if (!rows.length) { target.append(empty('暂无运行事件。任务开始处理后，进展会显示在这里。')); return; }
  for (const item of rows) { const el = node('article', 'activity'), body = node('div'); body.append(node('strong', '', eventNames[item.event] || item.event), node('p', '', item.issue_identifier || 'Symphony')); if (item.error) body.append(node('p', '', item.error)); const url = safeURL(item.pull_request_url); if (url) { const a = node('a', '', '查看 Pull Request ↗'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; body.append(a); } el.append(node('i', 'dot'), body, node('time', '', time(item.timestamp))); target.append(el); }
}
function render() {
  const d = snapshot.dashboard || { issues: [], activities: [] };
  $('sidebar-project').textContent = d.project; $('project-label').textContent = `${d.project} · ${String(d.tracker).toUpperCase()}`;
  $('running').textContent = snapshot.counts.running; $('capacity').textContent = `/ ${d.max_concurrent_agents}`;
  $('retrying').textContent = snapshot.counts.retrying; $('review').textContent = d.issues.filter(i => i.status === 'review').length;
  $('tokens').textContent = number(snapshot.codex_totals.total_tokens); $('runtime').textContent = `累计运行 ${duration(snapshot.codex_totals.seconds_running)}`;
  $('updated').textContent = d.tracker_updated_at ? `任务源同步于 ${time(d.tracker_updated_at)}` : '等待任务源同步';
  const healthy = snapshot.health.dispatch_enabled && !d.tracker_error;
  $('connection').textContent = healthy ? '服务在线' : '服务需关注'; $('connection-dot').classList.toggle('offline', !healthy);
  if (d.tracker_error || snapshot.health.last_error) notify(`任务同步异常：${d.tracker_error || snapshot.health.last_error}。当前显示上次获取的数据。`, true);
  renderBoard(); renderActivity();
  const service = $('service-details'); service.replaceChildren();
  field(service, '任务源', `${d.tracker} · ${d.project}`); field(service, '调度状态', snapshot.health.dispatch_enabled ? '已启用' : '已暂停');
  field(service, '并发上限', d.max_concurrent_agents); field(service, '任务轮询间隔', `${d.polling_interval_ms / 1000} 秒`); field(service, '调度标签', d.required_labels?.join(' · ') || '未限定'); field(service, '最近同步', d.tracker_updated_at ? new Date(d.tracker_updated_at).toLocaleString('zh-CN') : '尚未同步');
  const rate = snapshot.rate_limits; if (rate?.primary) field(service, '当前额度已使用', `${rate.primary.usedPercent}%`);
  if ($('detail').open) detailContent();
}
async function load() {
  if (loading) return; loading = true;
  try { const response = await fetch('/api/v1/state', { signal: AbortSignal.timeout(10000) }); if (!response.ok) throw Error(`HTTP ${response.status}`); snapshot = await response.json(); notify(''); render(); }
  catch { $('connection').textContent = '连接已断开'; $('connection-dot').classList.add('offline'); notify('无法连接本地 Symphony 服务，将自动重连。已有数据可能过期。', true); if (!snapshot) $('board').replaceChildren(empty('连接失败，请确认后台服务正在运行。')); }
  finally { loading = false; }
}
$('refresh').addEventListener('click', async () => {
  $('refresh').disabled = true;
  try { const response = await fetch('/api/v1/refresh', { method: 'POST', signal: AbortSignal.timeout(10000) }); if (!response.ok) throw Error(); await load(); notify('调度刷新已排队，任务源数据将在轮询完成后更新。'); }
  catch { notify('刷新调度失败，请检查本地服务连接。', true); }
  finally { $('refresh').disabled = false; }
});
$('search').addEventListener('input', () => { if (snapshot) renderBoard(); });
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(el => { el.classList.toggle('selected', el === button); el.setAttribute('aria-pressed', String(el === button)); }); if (snapshot) renderBoard(); }));
for (const name of ['board', 'list']) $(name + '-view').addEventListener('click', () => { view = name; for (const v of ['board', 'list']) { $(v + '-view').classList.toggle('selected', v === view); $(v + '-view').setAttribute('aria-pressed', String(v === view)); } if (snapshot) renderBoard(); });
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => { page = button.dataset.page; for (const name of ['board', 'activity', 'service']) $(name + '-page').hidden = name !== page; document.querySelectorAll('[data-page]').forEach(el => { el.classList.toggle('active', el === button); if (el === button) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); }); $('crumb').textContent = { board: '任务看板', activity: '运行活动', service: '服务概览' }[page]; }));
$('close-detail').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('close', () => { if (lastFocus?.isConnected) lastFocus.focus(); else $('search').focus(); });
$('detail').addEventListener('click', event => { if (event.target === $('detail')) { const r = $('detail').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('detail').close(); } });
document.addEventListener('keydown', event => { if (event.key === '/' && !$('detail').open && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); if (page !== 'board') document.querySelector('[data-page="board"]').click(); $('search').focus(); } });
await load(); setInterval(() => { if (!document.hidden) void load(); }, 5000); document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
