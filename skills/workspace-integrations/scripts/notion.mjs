#!/usr/bin/env node
const token = process.env.NOTION_TOKEN;
if (!token) die('Missing NOTION_TOKEN');
const [cmd, a, b] = process.argv.slice(2);
const version = process.env.NOTION_VERSION || '2022-06-28';
function die(msg) { console.error(msg); process.exit(1); }
async function notion(path, opts = {}) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': version,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) die(JSON.stringify({ status: res.status, error: data }, null, 2));
  return data;
}
const out = (x) => console.log(JSON.stringify(x, null, 2));

switch (cmd) {
  case 'search': {
    if (!a) die('Usage: notion.mjs search "query" [page|database]');
    const body = { query: a, page_size: 50 };
    if (b) body.filter = { value: b, property: 'object' };
    out(await notion('/search', { method: 'POST', body: JSON.stringify(body) }));
    break;
  }
  case 'page':
    if (!a) die('Usage: notion.mjs page PAGE_ID');
    out(await notion(`/pages/${encodeURIComponent(a)}`));
    break;
  case 'blocks':
    if (!a) die('Usage: notion.mjs blocks PAGE_ID');
    out(await notion(`/blocks/${encodeURIComponent(a)}/children?page_size=100`));
    break;
  case 'database': {
    if (!a) die('Usage: notion.mjs database DATABASE_ID [limit]');
    const page_size = Math.min(Number(b || 50), 100);
    out(await notion(`/databases/${encodeURIComponent(a)}/query`, { method: 'POST', body: JSON.stringify({ page_size }) }));
    break;
  }
  default:
    die('Commands: search "query" [page|database], page PAGE_ID, blocks PAGE_ID, database DATABASE_ID [limit]');
}
