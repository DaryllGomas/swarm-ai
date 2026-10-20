// OAuth scope names, which MCP tool each one unlocks, and the MCP authorization challenge. Kept free of the OAuth library so
// mcp.js can use it. The scopes are checked on the server for every tool call (see handleMcp), whatever the client showed the user.
import { rpOrigin } from './accounts.js';

export const SCOPES = ['read', 'work', 'submit'];
// Tools with no entry (how_to_help, setup_guide, list_projects, list_tasks, get_task, pair) need no scope and no sign-in.
export const SCOPE_FOR_TOOL = {
  my_work: 'read', submission_status: 'read', my_week: 'read',
  next_task: 'work', claim_task: 'work', release_task: 'work', link_account: 'work',
  submit_work: 'submit',
};
export const SCOPE_TEXT = {
  read: 'See your handle, your claims, your submissions and your weekly recap.',
  work: 'Ask for tasks (next_task), claim and release them, and link your Swarm voter account.',
  submit: 'Hand in finished work under your handle (submit_work). A person reviews it; nothing is published automatically.',
};

// The OAuth provider is on unless OAUTH is set to "off" (a kill switch) or the KV namespace is not bound.
export const oauthEnabled = (env) => env.OAUTH !== 'off' && !!env.OAUTH_KV;

export const resourceUrl = (env) => `${rpOrigin(env)}/mcp`;
export const resourceMetadataUrl = (env) => `${rpOrigin(env)}/.well-known/oauth-protected-resource/mcp`;

// The WWW-Authenticate value from the MCP authorization spec (RFC 9728): where to find the protected resource metadata.
export function oauthChallenge(env, { error, scope } = {}) {
  const parts = ['Bearer realm="OAuth"', `resource_metadata="${resourceMetadataUrl(env)}"`];
  if (error) parts.push(`error="${error}"`);
  if (scope?.length) parts.push(`scope="${scope.join(' ')}"`);
  return parts.join(', ');
}
