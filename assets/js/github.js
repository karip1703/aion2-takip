// GitHub REST API yardımcıları.
// Token ve repo bilgisi giriş yapınca çözülen oturumdan gelir (bkz. auth.js).
// Hesap kurulumu ekranı kendi token/repo bilgisini `ctx` ile verir.

import { getSession } from './auth.js';

const API = 'https://api.github.com';
export const DATA_PATH = 'data/data.json';
export const WORKFLOW_FILE = 'update.yml';

// Oturum varsa ondan, yoksa GitHub Pages adresinden tahmin.
export function getRepo() {
  const s = getSession();
  if (s?.owner && s?.repo) return { owner: s.owner, repo: s.repo, branch: s.branch || 'main' };
  return { ...guessRepoFromLocation(), branch: 'main' };
}
export const getToken = () => getSession()?.token || '';

export function guessRepoFromLocation() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return { owner: '', repo: '' };
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: seg || `${m[1]}.github.io` };
}

export class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body, token = getToken() } = {}) {
  const res = await fetch(API + path, {
    method,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.message || res.statusText;
    throw new GitHubError(res.status, `GitHub ${res.status}: ${msg}`);
  }
  return json;
}

const repoPath = ({ owner, repo }) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

// ---- UTF-8 güvenli base64 ----
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ctx: { token, owner, repo, branch } — verilmezse oturum kullanılır.
const ctxOf = (ctx) => (ctx ? { token: ctx.token, r: { owner: ctx.owner, repo: ctx.repo, branch: ctx.branch || 'main' } }
  : { token: getToken(), r: getRepo() });

// ---- Dosya oku / yaz ----
export async function getFile(path = DATA_PATH, ctx) {
  const { token, r } = ctxOf(ctx);
  const j = await api(`${repoPath(r)}/contents/${path}?ref=${encodeURIComponent(r.branch)}`, { token });
  return { text: b64decode(j.content), sha: j.sha };
}

export async function putFile(text, sha, message, path = DATA_PATH, ctx) {
  const { token, r } = ctxOf(ctx);
  const j = await api(`${repoPath(r)}/contents/${path}`, {
    method: 'PUT',
    token,
    body: { message, content: b64encode(text), sha, branch: r.branch },
  });
  return { sha: j.content.sha, commit: j.commit?.sha };
}

// ---- Token testi (hesap kurulumu) ----
export async function testToken(ctx) {
  if (!ctx.owner || !ctx.repo) throw new Error('Repo sahibi ve adı gerekli');
  const repo = await api(repoPath(ctx), { token: ctx.token });
  if (!repo.permissions?.push) throw new Error('Bu token\'ın repoya yazma yetkisi yok (Contents: Read and write gerekli)');
  return { private: repo.private, defaultBranch: repo.default_branch };
}

// ---- Workflow tetikleme ve durum ----
export async function dispatchWorkflow() {
  const r = getRepo();
  await api(`${repoPath(r)}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: 'POST',
    body: { ref: r.branch },
  });
}

export async function latestDispatchRun(sinceMs) {
  const r = getRepo();
  const j = await api(`${repoPath(r)}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=5`);
  const runs = (j.workflow_runs || []).filter((x) => Date.parse(x.created_at) >= sinceMs - 10_000);
  return runs[0] || null;
}

export function stringifyData(data) {
  // Actions script'iyle aynı biçim: 2 boşluk girinti + sondaki satır sonu → temiz diff.
  return JSON.stringify(data, null, 2) + '\n';
}
