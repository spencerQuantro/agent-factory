#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createLabels, doctor, init, update } from '../src/commands.mjs';
import { PKG } from '../src/files.mjs';

const HELP = `agent-factory ${PKG.version}: a Claude Code software factory for GitHub issues

Usage: agent-factory <command> [options]

Commands:
  init      copy the factory into this repo, detect config, generate checks.sh
  update    upgrade factory files you haven't edited to this package's version
  doctor    check the toolchain and the install (--full also runs checks.sh)
  labels    create the factory's GitHub labels (idempotent)

Options:
  -C, --dir <path>   project directory (default: current directory)
  -f, --force        init: overwrite existing files; update: replace edited files
  -n, --dry-run      show what would change without writing
      --labels       init: also create the GitHub labels
      --no-detect    init: don't ask git/gh for the base branch and merge method
      --full         doctor: also run factory/checks.sh and factory/bin/job queue
  -h, --help
  -v, --version

After init, open Claude Code in the project and run /factory-setup.`;

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string', short: 'C' },
      force: { type: 'boolean', short: 'f' },
      'dry-run': { type: 'boolean', short: 'n' },
      labels: { type: 'boolean' },
      'no-detect': { type: 'boolean' },
      full: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) return console.log(PKG.version);
  const [cmd] = positionals;
  if (values.help || !cmd) return console.log(HELP);

  const dir = resolve(values.dir ?? process.cwd());
  const opts = { dir, force: values.force, dryRun: values['dry-run'] };

  switch (cmd) {
    case 'init': {
      init({ ...opts, labels: values.labels, detect: !values['no-detect'] });
      if (!opts.dryRun) {
        console.log(`
Next:
  1. Open Claude Code in this project and run /factory-setup.
     It tailors checks.sh, the reviewers and AGENTS.md, creates the labels and verifies.
  2. Commit the install and push it to the base branch.
  3. Label a small issue \`factory\` and run /factory run.`);
      }
      break;
    }
    case 'update':
      update(opts);
      break;
    case 'doctor':
      process.exitCode = doctor({ dir, full: values.full }) ? 0 : 1;
      break;
    case 'labels':
      process.exitCode = createLabels({ dir }) ? 0 : 1;
      break;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

try {
  main();
} catch (e) {
  console.error(`agent-factory: ${e.message}`);
  process.exitCode = 1;
}
