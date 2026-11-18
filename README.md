# agent-factory

Spec → agents → PR → CI. A software factory for Claude Code, packaged so any
repo can install it with one command.

Label a GitHub issue `factory`, run `/factory run` in Claude Code, and agents
decide whether it's worth building, write a spec, build it, gate it on your own
checks, review it, and open a PR that closes the issue. The approver merges
what it's sure of and hands you the rest.

<p align="center">
  <img src="docs/pipeline.svg" width="100%" alt="Factory pipeline: a factory-labeled GitHub issue goes through intake (Fable), route (script), spec-writer, builder, gate (checks.sh), routed reviewers, approver and job merge. Gate failures and review changes loop back to the builder as new rounds, up to max_rounds. Intake can park a job for the author or reject it; a blocked builder, an exhausted last round, an approver escalation or a failed pre-merge gate hands the PR to a human, whose /factory feedback starts new rounds.">
</p>

This package distributes the
[ZazenCodes software factory v2](https://github.com/zazencodes/zazencodes-season-3/tree/main/src/software-factory-claude-code-v2)
(GPLv3). The skill, agents, scripts and dashboard in `templates/` are the
upstream files, unchanged apart from a few changes kept in
[scripts/patches/](scripts/patches/): `/factory dashboard`, an Opus code
reviewer, and the `skills` config; the package adds an installer, an updater, a doctor,
and a `/factory-setup` skill for the per-project tailoring.

## Use it in a project

```bash
npm i -D @spencerquantro/agent-factory      # or: npm i -D github:spencerQuantro/agent-factory
npx agent-factory init
```

`init` copies the factory into the repo, detects `base_branch` and
`merge_method` from GitHub, generates `factory/checks.sh` from your
`package.json` scripts (skipping anything with `--fix`, `--write` or watch
mode), and appends `/factory/jobs/` and `/.worktrees/` to `.gitignore`.

Then open Claude Code in the project and run:

```
/factory-setup
```

It tailors `checks.sh`, the reviewer agents and `AGENTS.md` to your stack,
creates the GitHub labels, runs `agent-factory doctor --full`, and commits.
Push the install to the base branch, label a small issue `factory`, and run
`/factory run`.

The factory files are committed to the project, not run from
`node_modules`: Claude Code loads agents and skills from the project's
`.claude/`, and the gate deliberately runs the main checkout's `checks.sh` so
a branch can't change the checks it's judged by. The npm dependency is only
the installer, so `-D` is right, and you can drop it after install if you
don't want `update`.

### Requirements

- Claude Code **2.1.257+** (intake runs on Fable)
- `python3` 3.10+ (the factory scripts use only the standard library)
- An authenticated [`gh`](https://cli.github.com/) that can push to the repo
  and manage labels, and an `origin` on GitHub
- Node 18.17+ for the installer

## Commands

```
agent-factory init      copy the factory in, detect config, generate checks.sh
agent-factory update    upgrade factory files you haven't edited to this version
agent-factory doctor    check toolchain + install; --full also runs checks.sh and job queue
agent-factory labels    create factory, factory:needs-info, factory:needs-human (idempotent)
agent-factory skills    install the Claude skills in config.json that apply here (--all: every one)

  -C, --dir <path>   project directory      -n, --dry-run   show, don't write
  -f, --force        init: overwrite clashes; update: replace locally edited files
  --labels           init: also create labels
  --skills           init: also install the skills that apply to this project
  --no-detect        init: skip git/gh detection
```

### Claude skills the factory follows

`factory/config.json` has a `skills` section. The builder reads every skill
whose `applies_to` covers the code it's writing and follows it; the code
reviewer checks the diff against the same skills and asks for changes when a
high-impact rule is broken. Both read the skill from the main checkout's
`.claude/skills/<name>/`, so a job branch can't change the rules it's judged by.

The default config ships Vercel's React and Next.js rules:

```json
"skills": {
  "vercel-react-best-practices": {
    "applies_to": "React and Next.js code: components, hooks, pages, routes, server actions and data fetching",
    "detect": ["react", "next"],
    "install": "npx -y skills add vercel-labs/agent-skills --skill vercel-react-best-practices --agent claude-code -y"
  }
}
```

`agent-factory skills` runs `install` for each skill that isn't installed yet
and whose `detect` packages are in `package.json` (`--all` ignores `detect`).
`doctor` fails when one that applies is missing. To add another skill, install
it into `.claude/skills/` and add an entry; `detect` and `install` are optional.

### How `update` stays safe

`init` writes `factory/.agent-factory.json` with a hash of every file it
installed (commit it). `update` replaces a file only when its hash still
matches, which means nobody edited it. Agents that `/factory-setup` tailored
are reported and left alone (`--force` replaces them). `factory/checks.sh` is
never replaced. `factory/config.json` keeps every value you set and only gains
keys a newer version added.

### From code

```js
import { init, update, doctor } from '@spencerquantro/agent-factory';

init({ dir: '/path/to/repo', labels: true });
doctor({ dir: '/path/to/repo', full: true });
```

## In the project after install

```
.claude/skills/factory/SKILL.md        /factory: the orchestrator
.claude/skills/factory-setup/SKILL.md  /factory-setup: tailor and verify the install
.claude/agents/                        intake, spec-writer, builder, 4 reviewers, approver
factory/config.json                    concurrency, rounds, labels, routing, protected paths, prices
factory/checks.sh                      your repo's checks; the gate runs it
factory/bin/{job,gate,route}           the deterministic spine
factory/bin/dashboard                  serves the dashboard on localhost and opens it
factory/dashboard.html                 the board: jobs, rounds, gate and review chips, cost
factory/.agent-factory.json            install manifest for `update`
```

```
/factory run          drain the queue: every open `factory` issue, `concurrency` at a time; also resumes
/factory run <n>      one issue now
/factory dashboard    open the live dashboard (factory/bin/dashboard --stop to stop it)
/factory <anything>   ask about jobs, give feedback, reject, file a feature
```

How the pipeline works and why: [docs/upstream/DESIGN.md](docs/upstream/DESIGN.md).

## Cost and safety

- It opens and merges real PRs on your Claude plan. Start with
  `"concurrency": 1` in `factory/config.json` and read every PR until you
  trust it.
- Intake runs on Fable once per issue; depending on your plan that can bill
  to usage credits.
- Only `factory`-labeled issues run (labels need triage/write access). Issue
  text reaches agents as quoted data, never as instructions. The factory
  pushes only `factory/*` branches, merges only via `gh pr merge`, and never
  deploys.

## Maintaining this package

```bash
npm run sync-upstream [ref]   # pull the latest reference files into templates/, re-apply scripts/patches/
npm test
npm version minor && npm publish
```

After a sync, read `git diff docs/upstream/INSTALL.md`. If the install steps
changed, update `templates/.claude/skills/factory-setup/SKILL.md` and
`src/` to match.

## License

[GPL-3.0](LICENSE), inherited from the upstream factory. You can use, modify
and share it; anything you distribute that includes it must also be GPLv3.
Running it inside a private project isn't distribution. For commercial
licensing of the factory itself, contact [ZazenCodes](https://zazencodes.com/).
