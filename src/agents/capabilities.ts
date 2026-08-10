import type { CommandPolicy } from '../tools/runCommand.ts';
import type { Tool } from '../tools/registry.ts';
import type { AgentRole, Capability } from './types.ts';

/**
 * Capability → tool grants (GRACE coordinator).
 *
 * The permission boundary is enforced HERE: an agent only ever receives the
 * tools its capabilities allow, so a read-only role physically cannot call
 * write_file/run_command no matter what the model asks for.
 */

const READ_TOOLS = ['read_file', 'search_files', 'list_directory'];
const WRITE_TOOLS = ['write_file', 'edit_file'];
const EXECUTE_TOOLS = ['run_command'];
const DIFF_TOOLS = ['git_diff'];
const WEB_TOOLS = ['web_fetch'];
// Browser capability has no local tool today — see browser.ts availability.

const CAPABILITY_TOOLS: Record<Capability, string[]> = {
  read: READ_TOOLS,
  write: WRITE_TOOLS,
  execute: EXECUTE_TOOLS,
  diff: DIFF_TOOLS,
  web: WEB_TOOLS,
  browser: [],
};

/** Filter a full tool set down to the agent's capability grant. */
export function toolsForCapabilities(all: Tool[], capabilities: Capability[]): Tool[] {
  const wanted = new Set<string>();
  for (const cap of capabilities) {
    for (const name of CAPABILITY_TOOLS[cap] ?? []) wanted.add(name);
  }
  return all.filter((t) => wanted.has(t.name));
}

/** True when a read-only role would leak a mutating tool through its grant. */
export function capabilitiesAreReadOnly(capabilities: Capability[]): boolean {
  return !capabilities.includes('write') && !capabilities.includes('execute');
}

/** Commands the test runner may run without asking the user. */
export const TEST_PREFIXES = [
  'npm test', 'npm run test', 'npm run typecheck', 'npm run build', 'npm run lint', 'npm run smoke',
  'pnpm test', 'pnpm run test', 'pnpm run typecheck', 'pnpm run build', 'pnpm run lint',
  'yarn test', 'yarn run test', 'yarn typecheck', 'yarn build', 'yarn lint',
  'go test', 'cargo test', 'mvn test', 'gradle test', 'pytest', 'python -m pytest', 'node --test',
];

/** Git mutations the curator must confirm even though they are not dangerous. */
const GIT_MUTATE_PREFIXES = [
  'git add', 'git commit', 'git rm', 'git mv', 'git restore', 'git stash', 'git tag', 'git clean',
];

/** Per-role command policy applied to run_command inside the agent's tools. */
export function commandPolicyForRole(role: AgentRole): CommandPolicy | undefined {
  switch (role) {
    case 'test-runner':
      return { allowPrefixes: TEST_PREFIXES };
    case 'git-curator':
      return { requireApprovalPrefixes: GIT_MUTATE_PREFIXES };
    default:
      return undefined; // default behavior: danger-flagged commands ask the user
  }
}
