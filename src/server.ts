import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Orchestrator } from './orchestrator.js';
import { SymphonyError } from './types.js';

export async function startServer(orchestrator: Orchestrator, port: number) {
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html'], ['/dashboard.css', 'dashboard.css', 'text/css'], ['/dashboard.js', 'dashboard.js', 'text/javascript']
  ].map(async ([route, file, type]) => [route, { type, body: await readFile(new URL(`./dashboard/${file}`, import.meta.url)) }] as const)));
  let refreshing = false;
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
    const error = (status: number, code: string) => send(status, { error: { code, message: code } });
    let route: string;
    try { route = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname); } catch { error(400, 'invalid_url'); return; }
    const asset = assets.get(route);
    if (asset) {
      if (req.method !== 'GET') { error(405, 'method_not_allowed'); return; }
      res.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8`, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
      res.end(asset.body); return;
    }
    if (route.startsWith('/api/v1/issues/') && route.endsWith('/restart')) {
      if (req.method !== 'POST') { error(405, 'method_not_allowed'); return; }
      const allowedHosts = new Set([`127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, `localhost:${(server.address() as import('node:net').AddressInfo).port}`]);
      if (!allowedHosts.has(req.headers.host ?? '') || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') { error(403, 'origin_not_allowed'); return; }
      const id = route.slice('/api/v1/issues/'.length, -'/restart'.length);
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(id)) { error(400, 'invalid_issue_id'); return; }
      void orchestrator.restartIssue(id).then(() => send(202, { queued: true, issue_id: id }), e => {
        const code = e instanceof SymphonyError ? e.category : 'restart_failed';
        error(code === 'issue_not_found' ? 404 : ['issue_running', 'issue_closed', 'issue_in_review', 'issue_has_pull_request', 'assignee_mismatch', 'restart_unsupported'].includes(code) ? 409 : 503, code);
      }); return;
    }
    if (route === '/api/v1/refresh') {
      if (req.method !== 'POST') { error(405, 'method_not_allowed'); return; }
      // Block cross-origin browser control; local CLI callers need no Origin header.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { error(403, 'origin_not_allowed'); return; }
      const coalesced = refreshing;
      if (!refreshing) { refreshing = true; void orchestrator.tick().catch(() => {}).finally(() => { refreshing = false; }); }
      send(202, { queued: true, coalesced, requested_at: new Date().toISOString(), operations: ['poll', 'reconcile'] }); return;
    }
    if (route.startsWith('/api/v1/')) {
      if (req.method !== 'GET') { error(405, 'method_not_allowed'); return; }
      const state = orchestrator.snapshot();
      if (route === '/api/v1/state') { send(200, state); return; }
      const identifier = route.slice('/api/v1/'.length);
      const running = state.running.find(r => r.issue_identifier === identifier), retry = state.retrying.find(r => r.issue_identifier === identifier);
      if (running || retry) { send(200, { issue_identifier: identifier, issue_id: (running ?? retry)!.issue_id, status: running ? 'running' : 'retrying', running: running ?? null, retry: retry ?? null }); return; }
      error(404, 'issue_not_found'); return;
    }
    error(404, 'not_found');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  return server;
}
