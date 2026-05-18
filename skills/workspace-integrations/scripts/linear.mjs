#!/usr/bin/env node
const token = process.env.LINEAR_API_KEY;
if (!token) die('Missing LINEAR_API_KEY');
const [cmd, a, b] = process.argv.slice(2);
function die(msg) { console.error(msg); process.exit(1); }
async function linear(query, variables = {}) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) die(JSON.stringify(data, null, 2));
  return data.data;
}
const out = (x) => console.log(JSON.stringify(x, null, 2));

switch (cmd) {
  case 'viewer':
    out(await linear(`query { viewer { id name email } organization { id name urlKey } }`));
    break;
  case 'teams':
    out(await linear(`query { teams(first: 100) { nodes { id key name description } } }`));
    break;
  case 'issues': {
    const limit = Math.min(Number(b || 50), 100);
    const filter = a ? `filter: { team: { key: { eq: $team } } },` : '';
    out(await linear(`query($team: String, $limit: Int!) { issues(${filter} first: $limit, orderBy: updatedAt) { nodes { id identifier title priority estimate url updatedAt state { name type } assignee { name email } team { key name } project { name } } } }`, { team: a, limit }));
    break;
  }
  case 'issue':
    if (!a) die('Usage: linear.mjs issue ABC-123');
    out(await linear(`query($id: String!) { issue(id: $id) { id identifier title description priority estimate url createdAt updatedAt state { name type } assignee { name email } creator { name email } team { key name } project { name } comments { nodes { body createdAt user { name } } } } }`, { id: a }));
    break;
  case 'search': {
    if (!a) die('Usage: linear.mjs search "text" [limit]');
    const limit = Math.min(Number(b || 25), 100);
    out(await linear(`query($term: String!, $limit: Int!) { issueSearch(term: $term, first: $limit) { nodes { id identifier title url updatedAt state { name type } team { key name } assignee { name } } } }`, { term: a, limit }));
    break;
  }
  default:
    die('Commands: viewer, teams, issues [TEAMKEY] [limit], issue ABC-123, search "text" [limit]');
}
