#!/usr/bin/env node
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) die('Missing GITHUB_TOKEN or GH_TOKEN');
const [cmd, a, b, c] = process.argv.slice(2);
const api = 'https://api.github.com';

function die(msg) { console.error(msg); process.exit(1); }
async function gh(path, opts = {}) {
  const res = await fetch(api + path, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) die(JSON.stringify({ status: res.status, error: data }, null, 2));
  return data;
}
const enc = encodeURIComponent;
const out = (x) => console.log(JSON.stringify(x, null, 2));

switch (cmd) {
  case 'me': out(await gh('/user')); break;
  case 'repos': {
    const path = a ? `/users/${enc(a)}/repos?per_page=100&sort=updated` : '/user/repos?per_page=100&sort=updated';
    out((await gh(path)).map(r => ({ name: r.full_name, private: r.private, updated_at: r.updated_at, url: r.html_url, description: r.description })));
    break;
  }
  case 'issues': {
    if (!a) die('Usage: github.mjs issues owner/repo [state]');
    const state = b || 'open';
    out(await gh(`/repos/${a}/issues?state=${enc(state)}&per_page=100`));
    break;
  }
  case 'prs': {
    if (!a) die('Usage: github.mjs prs owner/repo [state]');
    const state = b || 'open';
    out(await gh(`/repos/${a}/pulls?state=${enc(state)}&per_page=100`));
    break;
  }
  case 'issue': {
    if (!a || !b) die('Usage: github.mjs issue owner/repo number');
    out(await gh(`/repos/${a}/issues/${enc(b)}`));
    break;
  }
  case 'search-issues': {
    if (!a) die('Usage: github.mjs search-issues "query"');
    out(await gh(`/search/issues?q=${enc(a)}&per_page=${enc(b || '50')}`));
    break;
  }
  default:
    die('Commands: me, repos [owner], issues owner/repo [state], prs owner/repo [state], issue owner/repo number, search-issues "query" [limit]');
}
