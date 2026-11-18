import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, update } from '../src/commands.mjs';
import { FILES, MANIFEST, frontmatterKeys, mergeMissing, sha256, template } from '../src/files.mjs';
import { generateChecks, parseVersion, versionAtLeast } from '../src/detect.mjs';

const quiet = () => {};

function repo(files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-factory-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  return dir;
}

test('init copies every file, sets exec bits, writes manifest and .gitignore', () => {
  const dir = repo({ '.gitignore': 'node_modules' });
  init({ dir, detect: false, log: quiet });
  for (const f of FILES) {
    assert.ok(existsSync(join(dir, f.path)), f.path);
    if (f.exec) assert.ok(statSync(join(dir, f.path)).mode & 0o100, `${f.path} executable`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
  assert.equal(Object.keys(manifest.files).length, FILES.length);
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.match(gi, /^node_modules\n/);
  assert.match(gi, /\/factory\/jobs\/\n\/\.worktrees\/\n$/);
  const ignored = spawnSync('git', ['check-ignore', 'factory/jobs/x', '.worktrees/x'], { cwd: dir, encoding: 'utf8' });
  assert.equal(ignored.stdout.trim().split('\n').length, 2);
});

test('init refuses clashes and reinstalls, unless forced', () => {
  const dir = repo();
  init({ dir, detect: false, log: quiet });
  assert.throws(() => init({ dir, detect: false, log: quiet }), /already installed/);
  init({ dir, detect: false, force: true, log: quiet });
  const fresh = repo();
  execFileSync('mkdir', ['-p', join(fresh, 'factory')]);
  writeFileSync(join(fresh, 'factory/checks.sh'), 'mine');
  assert.throws(() => init({ dir: fresh, detect: false, log: quiet }), /already exist/);
});

test('init is idempotent on .gitignore and dry-run writes nothing', () => {
  const dir = repo({ '.gitignore': '/factory/jobs/\n/.worktrees/\n' });
  init({ dir, detect: false, dryRun: true, log: quiet });
  assert.ok(!existsSync(join(dir, 'factory')));
  init({ dir, detect: false, log: quiet });
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '/factory/jobs/\n/.worktrees/\n');
});

test('init generates checks.sh from package.json scripts', () => {
  const dir = repo({
    'package.json': JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest', build: 'vite build' } }),
    'pnpm-lock.yaml': '',
  });
  init({ dir, detect: false, log: quiet });
  const checks = readFileSync(join(dir, 'factory/checks.sh'), 'utf8');
  assert.match(checks, /set -euo pipefail/);
  assert.match(checks, /pnpm install --frozen-lockfile\npnpm run lint\npnpm run typecheck\npnpm run test\npnpm run build\n$/);
});

test('generateChecks skips unsafe scripts and returns null when nothing is safe', () => {
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint . --fix', test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.equal(generateChecks(dir), null);
  const dir2 = repo({ 'package.json': JSON.stringify({ scripts: { lint: 'prettier --write .', test: 'jest' } }), 'package-lock.json': '{}' });
  const g = generateChecks(dir2);
  assert.deepEqual(g.commands, ['npm ci --prefer-offline --no-audit --no-fund', 'npm run test']);
  assert.deepEqual(g.skipped, ['lint: prettier --write .']);
});

test('init without package.json keeps the placeholder checks.sh', () => {
  const dir = repo();
  init({ dir, detect: false, log: quiet });
  assert.match(readFileSync(join(dir, 'factory/checks.sh'), 'utf8'), /has no checks yet/);
});

test('update replaces untouched files, keeps edited ones, never touches checks.sh', () => {
  const dir = repo();
  init({ dir, detect: false, log: quiet });
  const manifestPath = join(dir, MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // Simulate an older install of bin/job (untouched since then)...
  writeFileSync(join(dir, 'factory/bin/job'), 'old job');
  manifest.files['factory/bin/job'] = sha256('old job');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  // ...a tailored agent, and an edited checks.sh.
  writeFileSync(join(dir, '.claude/agents/reviewer-ui.md'), 'tailored');
  writeFileSync(join(dir, 'factory/checks.sh'), 'my checks');

  const r = update({ dir, log: quiet });
  assert.deepEqual(r.updated, ['factory/bin/job']);
  assert.deepEqual(r.kept, ['.claude/agents/reviewer-ui.md']);
  assert.equal(readFileSync(join(dir, 'factory/bin/job'), 'utf8'), template('factory/bin/job').toString());
  assert.equal(readFileSync(join(dir, '.claude/agents/reviewer-ui.md'), 'utf8'), 'tailored');
  assert.equal(readFileSync(join(dir, 'factory/checks.sh'), 'utf8'), 'my checks');

  update({ dir, force: true, log: quiet });
  assert.equal(readFileSync(join(dir, '.claude/agents/reviewer-ui.md'), 'utf8'), template('.claude/agents/reviewer-ui.md').toString());
  assert.equal(readFileSync(join(dir, 'factory/checks.sh'), 'utf8'), 'my checks');
});

test('update merges new config keys without changing existing values', () => {
  const dir = repo();
  init({ dir, detect: false, log: quiet });
  const path = join(dir, 'factory/config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  cfg.concurrency = 1;
  delete cfg.ports;
  delete cfg.labels.needs_human;
  writeFileSync(path, JSON.stringify(cfg));
  const r = update({ dir, log: quiet });
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.concurrency, 1);
  assert.deepEqual(after.ports, { base: 5100, step: 10 });
  assert.equal(after.labels.needs_human, 'factory:needs-human');
  assert.match(r.updated[0], /labels\.needs_human, ports/);
});

test('mergeMissing leaves arrays and scalars alone', () => {
  const t = { a: [1], b: { c: 1 } };
  assert.deepEqual(mergeMissing(t, { a: [2, 3], b: { c: 2, d: 4 }, e: 5 }), ['b.d', 'e']);
  assert.deepEqual(t, { a: [1], b: { c: 1, d: 4 }, e: 5 });
});

test('shipped agents only use frontmatter keys Claude Code knows', () => {
  for (const f of FILES.filter((x) => x.path.startsWith('.claude/agents/'))) {
    const keys = frontmatterKeys(template(f.path).toString());
    const allowed = ['name', 'description', 'tools', 'model', ...(f.path.endsWith('builder.md') ? ['hooks'] : [])];
    assert.deepEqual(keys.filter((k) => !allowed.includes(k)), [], f.path);
  }
});

test('version parsing', () => {
  assert.deepEqual(parseVersion('2.1.257 (Claude Code)'), [2, 1, 257]);
  assert.deepEqual(parseVersion('Python 3.10'), [3, 10, 0]);
  assert.ok(versionAtLeast([2, 1, 300], [2, 1, 257]));
  assert.ok(!versionAtLeast([2, 0, 42], [2, 1, 257]));
});

test('CLI prints help and version', () => {
  const bin = new URL('../bin/agent-factory.mjs', import.meta.url).pathname;
  assert.match(execFileSync('node', [bin, '--help'], { encoding: 'utf8' }), /Commands:/);
  assert.match(execFileSync('node', [bin, '-v'], { encoding: 'utf8' }), /^\d+\.\d+\.\d+/);
});

test('factory/bin/dashboard serves the board on localhost, reuses it, and stops', async () => {
  const dir = repo();
  init({ dir, detect: false, log: quiet });
  const bin = join(dir, 'factory/bin/dashboard');
  const port = String(18000 + Math.floor(Math.random() * 1000));
  const run = (...args) => spawnSync(bin, args, { cwd: dir, encoding: 'utf8' });
  try {
    const first = run('--no-open', '--port', port);
    assert.equal(first.status, 0, first.stderr);
    const url = first.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/dashboard\.html/)[0];
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /factory\/bin\/job/);
    const again = run('--no-open');
    assert.match(again.stdout, /already running/);
    assert.equal(run('--status').stdout.trim(), url);
  } finally {
    assert.match(run('--stop').stdout, /stopped/);
  }
  assert.equal(run('--status').status, 1);
});

test('every patch in scripts/patches is already applied to templates/', () => {
  const root = new URL('..', import.meta.url).pathname;
  const dir = join(root, 'scripts/patches');
  const patches = readdirSync(dir).filter((f) => f.endsWith('.patch'));
  assert.ok(patches.length > 0);
  for (const p of patches) {
    const r = spawnSync('git', ['apply', '--check', '--reverse', join(dir, p)], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `${p}: ${r.stderr}`);
  }
});

test('the code reviewer runs on Opus at every risk level', () => {
  const cfg = JSON.parse(template('factory/config.json'));
  for (const risk of ['low', 'medium', 'high']) assert.equal(cfg.routing[risk].code, 'opus', risk);
  assert.match(template('.claude/agents/reviewer-code.md').toString(), /^model: opus$/m);
});
