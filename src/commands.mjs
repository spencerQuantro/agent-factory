import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  FILES, GITIGNORE_LINES, MANIFEST, PKG, frontmatterKeys, hashFile, mergeMissing,
  readManifest, sha256, template, writeFile, writeManifest,
} from './files.mjs';
import {
  detectBaseBranch, detectMergeMethod, generateChecks, gitRoot, parseVersion, sh, versionAtLeast,
} from './detect.mjs';

const MIN_CLAUDE = [2, 1, 257];
const MIN_PYTHON = [3, 10, 0];
const AGENT_KEYS = new Set(['name', 'description', 'tools', 'model']);
const LABELS = [
  ['factory', '5319E7', 'Build this with the software factory'],
  ['factory:needs-info', 'FBCA04', 'The factory asked the author a question'],
  ['factory:needs-human', 'D93F0B', 'The factory needs a human decision on the PR'],
];

function resolveDir(dir, log) {
  const root = gitRoot(dir);
  if (!root) throw new Error(`${dir} is not inside a git repository. Run \`git init\` first.`);
  if (root !== dir && log) log(`Using the repository root: ${root}`);
  return root;
}

// ---- init ------------------------------------------------------------------

/**
 * Copy the factory into a project and do the mechanical half of INSTALL.md.
 * Options: dir, force (overwrite clashes), dryRun, labels (create GitHub labels),
 * skills (install the configured Claude skills that apply to this project),
 * detect (query git/gh for base branch and merge method; default true), log.
 */
export function init({ dir = process.cwd(), force = false, dryRun = false, labels = false, skills = false, detect = true, log = console.log } = {}) {
  dir = resolveDir(dir, log);
  if (readManifest(dir) && !force) {
    throw new Error(`The factory is already installed here (${MANIFEST}). Use \`agent-factory update\`, or \`init --force\` to reinstall.`);
  }
  const clashes = FILES.filter((f) => existsSync(join(dir, f.path))).map((f) => f.path);
  if (clashes.length && !force) {
    throw new Error(`These files already exist:\n  ${clashes.join('\n  ')}\nRe-run with --force to overwrite them.`);
  }

  // Adapt config.json and checks.sh before writing.
  const config = JSON.parse(template('factory/config.json'));
  if (detect) {
    const base = detectBaseBranch(dir);
    config.base_branch = base.branch;
    log(`base_branch: ${base.branch} (from ${base.source})`);
    const method = detectMergeMethod(dir);
    if (method) config.merge_method = method;
    log(`merge_method: ${config.merge_method}${method ? ' (allowed by the repo)' : ' (default; could not ask GitHub)'}`);
  }
  const checks = generateChecks(dir);
  if (checks) log(`checks.sh: ${checks.commands.join(' && ')}`);
  else log('checks.sh: nothing detected; /factory-setup will fill it in');

  const content = {
    'factory/config.json': Buffer.from(JSON.stringify(config, null, 2) + '\n'),
    ...(checks && { 'factory/checks.sh': Buffer.from(checks.content) }),
  };

  const hashes = {};
  for (const f of FILES) {
    const buf = content[f.path] ?? template(f.path);
    hashes[f.path] = sha256(buf);
    if (!dryRun) writeFile(join(dir, f.path), buf, f.exec);
    log(`${dryRun ? 'would write' : 'wrote'} ${f.path}${clashes.includes(f.path) ? ' (overwritten)' : ''}`);
  }
  if (!dryRun) writeManifest(dir, hashes);

  const added = ensureGitignore(dir, dryRun);
  if (added.length) log(`${dryRun ? 'would add' : 'added'} to .gitignore: ${added.join(' ')}`);

  if (labels && !dryRun) createLabels({ dir, log });

  const wanted = configuredSkills(dir).filter((s) => s.relevant && !s.installed);
  if (wanted.length && !dryRun) {
    if (skills) installSkills({ dir, log });
    else log(`skills: ${wanted.map((s) => s.name).join(', ')} apply to this project; run \`agent-factory skills\` to install`);
  }

  return { dir, checksGenerated: Boolean(checks), config };
}

function ensureGitignore(dir, dryRun) {
  const path = join(dir, '.gitignore');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length && !dryRun) {
    const prefix = text && !text.endsWith('\n') ? '\n' : '';
    appendFileSync(path, `${prefix}\n# software factory runtime state\n${missing.join('\n')}\n`);
  }
  return missing;
}

// ---- update ----------------------------------------------------------------

/**
 * Bring installed files up to this package version. A managed file is replaced
 * only if its hash still matches what was installed (nobody edited it); edited
 * files are reported and left alone unless `force`. Owned files are never
 * replaced; config.json gains any keys the new template added.
 */
export function update({ dir = process.cwd(), force = false, dryRun = false, log = console.log } = {}) {
  dir = resolveDir(dir, log);
  const manifest = readManifest(dir);
  if (!manifest) throw new Error(`No ${MANIFEST} here. Run \`agent-factory init\` first.`);
  const hashes = { ...manifest.files };
  const result = { updated: [], added: [], kept: [], unchanged: [] };

  for (const f of FILES) {
    const abs = join(dir, f.path);
    const current = hashFile(abs);
    const recorded = manifest.files[f.path];

    if (f.kind === 'owned') {
      if (!current) {
        const buf = template(f.path);
        if (!dryRun) writeFile(abs, buf, f.exec);
        hashes[f.path] = sha256(buf);
        result.added.push(f.path);
      } else if (f.path === 'factory/config.json') {
        const cfg = JSON.parse(readFileSync(abs, 'utf8'));
        const newKeys = mergeMissing(cfg, JSON.parse(template(f.path)));
        if (newKeys.length) {
          const buf = Buffer.from(JSON.stringify(cfg, null, 2) + '\n');
          if (!dryRun) writeFile(abs, buf);
          hashes[f.path] = sha256(buf);
          result.updated.push(`${f.path} (new keys: ${newKeys.join(', ')})`);
        } else result.unchanged.push(f.path);
      } else result.unchanged.push(f.path);
      continue;
    }

    const next = template(f.path);
    const nextHash = sha256(next);
    if (current === nextHash) {
      hashes[f.path] = nextHash;
      result.unchanged.push(f.path);
    } else if (!current || current === recorded || force) {
      if (!dryRun) writeFile(abs, next, f.exec);
      hashes[f.path] = nextHash;
      (current ? result.updated : result.added).push(f.path);
    } else {
      result.kept.push(f.path);
    }
  }
  if (!dryRun) writeManifest(dir, hashes);
  ensureGitignore(dir, dryRun);

  const verb = dryRun ? 'would ' : '';
  for (const p of result.added) log(`${verb}add     ${p}`);
  for (const p of result.updated) log(`${verb}update  ${p}`);
  for (const p of result.kept) log(`kept    ${p} (edited locally; --force to replace)`);
  log(`${result.unchanged.length} file(s) already current. Now at ${PKG.name}@${PKG.version}.`);
  return result;
}

// ---- skills ----------------------------------------------------------------

/** Claude skills the builder and code reviewer apply, from config.json `skills`. */
export function configuredSkills(dir) {
  const path = join(dir, 'factory/config.json');
  if (!existsSync(path)) return [];
  const skills = JSON.parse(readFileSync(path, 'utf8')).skills || {};
  const deps = projectDependencies(dir);
  return Object.entries(skills).map(([name, spec]) => ({
    name,
    ...spec,
    // A skill with `detect` applies only when package.json depends on one of those packages.
    relevant: !spec.detect?.length || spec.detect.some((d) => deps.has(d)),
    installed: SKILL_NAME.test(name) && existsSync(join(dir, '.claude/skills', name, 'SKILL.md')),
  }));
}

function projectDependencies(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }));
  } catch {
    return new Set();
  }
}

const SKILL_NAME = /^[A-Za-z0-9][\w.-]*$/;
// Plain words only: no quotes, globs, pipes, redirects, substitutions or separators.
const SAFE_ARG = /^[\w@%+=:,./-]+$/;

/**
 * Split a config.json `install` command into argv, or explain why it can't be
 * run. Commands run without a shell, so anything that needs one is refused
 * rather than handed to `sh -c`: a config.json from an untrusted clone or PR
 * can't chain extra commands onto an install.
 */
export function parseInstall(command) {
  if (typeof command !== 'string' || !command.trim()) return { error: 'empty install command' };
  const argv = command.trim().split(/\s+/);
  const bad = argv.find((a) => !SAFE_ARG.test(a));
  if (bad) return { error: `refusing to run: ${JSON.stringify(bad)} needs a shell (only plain arguments are allowed)` };
  return { argv };
}

/**
 * Install every relevant configured skill that isn't installed yet, by running
 * its `install` command (without a shell) in the project root. `all` ignores `detect`.
 */
export function installSkills({ dir = process.cwd(), dryRun = false, all = false, log = console.log } = {}) {
  dir = resolveDir(dir);
  let ok = true;
  const skills = configuredSkills(dir);
  if (!skills.length) log('No skills in factory/config.json.');
  for (const s of skills) {
    if (!SKILL_NAME.test(s.name)) { log(`skill ${JSON.stringify(s.name)}: invalid name, skipped`); ok = false; continue; }
    if (s.installed) { log(`skill ${s.name}: installed`); continue; }
    if (!s.relevant && !all) { log(`skill ${s.name}: skipped (package.json has none of ${s.detect.join(', ')}; --all installs it anyway)`); continue; }
    if (!s.install) { log(`skill ${s.name}: missing, and config.json gives no install command`); ok = false; continue; }
    const { argv, error } = parseInstall(s.install);
    if (error) { log(`skill ${s.name}: ${error}`); ok = false; continue; }
    if (dryRun) { log(`skill ${s.name}: would run ${argv.join(' ')}`); continue; }
    log(`skill ${s.name}: ${argv.join(' ')}`);
    const r = sh(argv[0], argv.slice(1), dir, { stdio: ['ignore', 'pipe', 'pipe'] });
    const installed = existsSync(join(dir, '.claude/skills', s.name, 'SKILL.md'));
    log(installed ? `skill ${s.name}: installed` : `skill ${s.name}: FAILED (exit ${r.status}) ${r.err.split('\n').slice(-3).join(' ')}`);
    ok &&= installed;
  }
  return ok;
}

// ---- labels ----------------------------------------------------------------

export function createLabels({ dir = process.cwd(), log = console.log } = {}) {
  dir = resolveDir(dir);
  let ok = true;
  for (const [name, color, description] of LABELS) {
    const r = sh('gh', ['label', 'create', name, '--color', color, '--description', description, '--force'], dir);
    if (r.missing) throw new Error('gh is not installed. Install it from https://cli.github.com/');
    log(r.ok ? `label ${name}: ok` : `label ${name}: FAILED ${r.err}`);
    ok &&= r.ok;
  }
  return ok;
}

// ---- doctor ----------------------------------------------------------------

/**
 * INSTALL.md's preflight (step 0) and verification (step 3). `full` also runs
 * factory/checks.sh in the project root and `factory/bin/job queue`.
 * Returns true when nothing failed.
 */
export function doctor({ dir = process.cwd(), full = false, log = console.log } = {}) {
  dir = resolveDir(dir);
  const results = [];
  const check = (level, name, detail = '') => results.push({ level, name, detail });
  const pass = (n, d) => check('ok', n, d);
  const fail = (n, d) => check('fail', n, d);
  const warn = (n, d) => check('warn', n, d);

  // Toolchain
  const origin = sh('git', ['remote', 'get-url', 'origin'], dir);
  if (!origin.ok) fail('git origin', 'no `origin` remote');
  else if (!/github\.com[:/]/.test(origin.out)) fail('git origin', `${origin.out} is not on GitHub`);
  else pass('git origin', origin.out);

  const auth = sh('gh', ['auth', 'status'], dir);
  if (auth.missing) fail('gh', 'not installed: https://cli.github.com/');
  else if (!auth.ok) fail('gh auth', 'run `gh auth login`');
  else pass('gh auth');

  const claude = sh('claude', ['--version'], dir);
  const cv = parseVersion(claude.out);
  if (claude.missing || !cv) fail('claude', 'Claude Code is not installed');
  else if (!versionAtLeast(cv, MIN_CLAUDE)) fail('claude', `${cv.join('.')} < ${MIN_CLAUDE.join('.')} (intake runs on Fable): run \`claude update\``);
  else pass('claude', cv.join('.'));

  const py = sh('python3', ['--version'], dir);
  const pv = parseVersion(py.out || py.err);
  if (py.missing || !pv) fail('python3', 'not installed');
  else if (!versionAtLeast(pv, MIN_PYTHON)) fail('python3', `${pv.join('.')} < 3.10`);
  else pass('python3', pv.join('.'));

  // Files
  const manifest = readManifest(dir);
  if (!manifest) fail('manifest', `no ${MANIFEST}: run \`agent-factory init\``);
  else pass('manifest', `installed from ${manifest.package}@${manifest.version}`);

  const missing = FILES.filter((f) => !existsSync(join(dir, f.path))).map((f) => f.path);
  if (missing.length) fail('files', `missing: ${missing.join(', ')}`);
  else pass('files', `${FILES.length} present`);

  const notExec = FILES.filter((f) => f.exec && existsSync(join(dir, f.path))
    && !(statSync(join(dir, f.path)).mode & 0o111)).map((f) => f.path);
  if (notExec.length) fail('executable bits', `chmod +x ${notExec.join(' ')}`);

  for (const f of FILES.filter((x) => x.path.startsWith('.claude/agents/'))) {
    const abs = join(dir, f.path);
    if (!existsSync(abs)) continue;
    const keys = frontmatterKeys(readFileSync(abs, 'utf8'));
    const allowed = f.path.endsWith('builder.md') ? new Set([...AGENT_KEYS, 'hooks']) : AGENT_KEYS;
    const bad = keys ? keys.filter((k) => !allowed.has(k)) : ['(no frontmatter)'];
    if (bad.length) fail(`frontmatter ${f.path}`, `unexpected keys: ${bad.join(', ')}`);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(join(dir, 'factory/config.json'), 'utf8'));
    pass('config.json', `base ${config.base_branch}, merge ${config.merge_method}, concurrency ${config.concurrency}`);
  } catch (e) {
    fail('config.json', e.message);
  }

  if (config?.base_branch && origin.ok) {
    const ls = sh('git', ['ls-remote', '--heads', 'origin', config.base_branch], dir);
    if (!ls.ok) warn('base branch', `couldn't reach origin: ${ls.err.split('\n')[0]}`);
    else if (!ls.out) fail('base branch', `${config.base_branch} doesn't exist on origin`);
    else pass('base branch', `origin/${config.base_branch}`);
  }

  const checksPath = join(dir, 'factory/checks.sh');
  if (existsSync(checksPath) && readFileSync(checksPath, 'utf8').includes('has no checks yet')) {
    fail('checks.sh', 'still the placeholder: run /factory-setup in Claude Code');
  }

  if (config) {
    for (const s of configuredSkills(dir)) {
      if (s.installed) pass(`skill ${s.name}`);
      else if (s.relevant) fail(`skill ${s.name}`, 'not installed: run `agent-factory skills`');
    }
  }

  const ignored = sh('git', ['check-ignore', 'factory/jobs/x', '.worktrees/x'], dir);
  if (ignored.out.split('\n').length === 2) pass('.gitignore', 'factory/jobs/ and .worktrees/ ignored');
  else fail('.gitignore', `add ${GITIGNORE_LINES.join(' and ')}`);

  const overIgnored = FILES.filter((f) => sh('git', ['check-ignore', '-q', f.path], dir).ok).map((f) => f.path);
  if (overIgnored.length) fail('.gitignore', `these must be committed but are ignored: ${overIgnored.join(', ')}`);

  if (auth.ok) {
    const ls = sh('gh', ['label', 'list', '--limit', '200', '--json', 'name', '--jq', '.[].name'], dir);
    const have = new Set(ls.out.split('\n'));
    const absent = LABELS.map(([n]) => n).filter((n) => !have.has(n));
    if (!ls.ok) warn('labels', ls.err.split('\n')[0]);
    else if (absent.length) fail('labels', `missing ${absent.join(', ')}: run \`agent-factory labels\``);
    else pass('labels');
  }

  if (full) {
    if (existsSync(checksPath)) {
      log('Running factory/checks.sh in the project root...');
      const r = sh('bash', ['factory/checks.sh'], dir, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
      if (r.ok) pass('checks.sh run', 'exit 0');
      else fail('checks.sh run', `exit ${r.status}:\n${(r.out + '\n' + r.err).trim().split('\n').slice(-20).join('\n')}`);
    }
    if (existsSync(join(dir, 'factory/bin/job'))) {
      const q = sh(join(dir, 'factory/bin/job'), ['queue'], dir);
      if (q.ok) pass('job queue', q.out ? `${q.out.split('\n').length} issue(s) labeled factory` : 'queue is empty');
      else fail('job queue', q.err);
    }
  }

  const icon = { ok: '✔', warn: '!', fail: '✘' };
  for (const r of results) log(`${icon[r.level]} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  const failures = results.filter((r) => r.level === 'fail').length;
  log(failures ? `\n${failures} problem(s).` : '\nAll checks passed.');
  return failures === 0;
}
