import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATES = join(PKG_ROOT, 'templates');
export const PKG = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
export const MANIFEST = 'factory/.agent-factory.json';

/**
 * Every file the package installs, by its path in the target project.
 *
 * - `managed`: `update` replaces it when nobody edited it since install.
 *   Agents are managed too; once /factory-setup tailors one, `update` leaves it.
 * - `owned`: written once by `init`, then the project's. `update` never
 *   replaces it (config.json gets new keys merged in, nothing else).
 */
export const FILES = [
  { path: '.claude/skills/factory/SKILL.md', kind: 'managed' },
  { path: '.claude/skills/factory-setup/SKILL.md', kind: 'managed' },
  { path: '.claude/agents/intake.md', kind: 'managed' },
  { path: '.claude/agents/spec-writer.md', kind: 'managed' },
  { path: '.claude/agents/builder.md', kind: 'managed' },
  { path: '.claude/agents/reviewer-code.md', kind: 'managed' },
  { path: '.claude/agents/reviewer-security.md', kind: 'managed' },
  { path: '.claude/agents/reviewer-ux.md', kind: 'managed' },
  { path: '.claude/agents/reviewer-ui.md', kind: 'managed' },
  { path: '.claude/agents/approver.md', kind: 'managed' },
  { path: 'factory/bin/job', kind: 'managed', exec: true },
  { path: 'factory/bin/gate', kind: 'managed', exec: true },
  { path: 'factory/bin/route', kind: 'managed', exec: true },
  { path: 'factory/bin/dashboard', kind: 'managed', exec: true },
  { path: 'factory/dashboard.html', kind: 'managed' },
  { path: 'factory/checks.sh', kind: 'owned', exec: true },
  { path: 'factory/config.json', kind: 'owned' },
];

export const GITIGNORE_LINES = ['/factory/jobs/', '/.worktrees/'];

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const template = (path) => readFileSync(join(TEMPLATES, path));

export function hashFile(abs) {
  return existsSync(abs) ? sha256(readFileSync(abs)) : null;
}

export function writeFile(abs, content, exec = false) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (exec) chmodSync(abs, 0o755);
}

export function readManifest(dir) {
  const abs = join(dir, MANIFEST);
  return existsSync(abs) ? JSON.parse(readFileSync(abs, 'utf8')) : null;
}

export function writeManifest(dir, hashes) {
  const manifest = {
    package: PKG.name,
    version: PKG.version,
    upstream: PKG.agentFactory?.upstream,
    note: 'Written by agent-factory. `update` compares these hashes to tell which files you edited.',
    files: Object.fromEntries(Object.entries(hashes).sort()),
  };
  writeFile(join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
}

/** Add keys from `defaults` that `target` lacks, recursively. Never changes an existing value. */
export function mergeMissing(target, defaults) {
  const added = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in target)) {
      target[key] = value;
      added.push(key);
    } else if (isPlainObject(target[key]) && isPlainObject(value)) {
      added.push(...mergeMissing(target[key], value).map((k) => `${key}.${k}`));
    }
  }
  return added;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Top-level YAML keys in a markdown file's frontmatter. */
export function frontmatterKeys(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  return m[1].split('\n').filter((l) => /^[A-Za-z_][\w-]*:/.test(l)).map((l) => l.split(':')[0]);
}
