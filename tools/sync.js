#!/usr/bin/env node
'use strict';

/**
 * Pull the latest commits and bring the local environment back in step.
 *
 * Pulling alone is not always enough. If dependencies changed you need a fresh
 * install, and if the CDS model or the seed data changed the local SQLite
 * database is stale until it is redeployed. Doing those two steps
 * unconditionally is slow, and forgetting them produces confusing failures, so
 * this looks at what actually changed between the old and new commit and runs
 * only what is needed.
 *
 * Written in Node rather than shell so it behaves the same on Windows, macOS
 * and Linux.
 *
 * Usage:
 *   npm run sync              pull the current branch and catch up
 *   npm run sync -- --check   report what is pending without changing anything
 */

const { execFileSync, spawnSync } = require('child_process');

const CYAN = '[36m';
const GREEN = '[32m';
const YELLOW = '[33m';
const RED = '[31m';
const DIM = '[2m';
const RESET = '[0m';

const checkOnly = process.argv.includes('--check');

/** Run a git command and return trimmed stdout. */
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Run a command, streaming its output; returns true when it succeeded. */
function run(command, args) {
  const label = [command, ...args].join(' ');
  console.log(`${CYAN}> ${label}${RESET}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`${RED}  ${label} failed with exit code ${result.status}${RESET}`);
    return false;
  }
  return true;
}

function main() {
  let branch;
  try {
    branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  } catch {
    console.error(`${RED}Not a git repository.${RESET}`);
    process.exit(1);
  }

  // Refuse to pull over uncommitted work; a merge on top of a dirty tree is
  // how people lose changes they meant to keep.
  const dirty = git('status', '--porcelain');
  if (dirty) {
    console.error(`${YELLOW}You have uncommitted changes:${RESET}`);
    console.error(dirty.split('\n').map((line) => `  ${line}`).join('\n'));
    console.error(`\n${YELLOW}Commit or stash them first, then run sync again.${RESET}`);
    process.exit(1);
  }

  console.log(`${DIM}Branch: ${branch}${RESET}`);
  const before = git('rev-parse', 'HEAD');

  // An explicit refspec so the remote-tracking ref is definitely updated - the
  // ahead/behind comparison below reads origin/<branch>, and a bare
  // `git fetch origin <branch>` is only guaranteed to move FETCH_HEAD.
  // `run` already echoes the command it is about to execute.
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  if (!run('git', ['fetch', 'origin', refspec])) process.exit(1);

  let remote;
  try {
    remote = git('rev-parse', `origin/${branch}`);
  } catch {
    console.error(`${RED}No branch origin/${branch}. Push it first, or switch branch.${RESET}`);
    process.exit(1);
  }

  // Compare properly rather than testing the two SHAs for equality. A branch
  // that is *ahead* of the remote also has a different SHA, and treating that
  // as "there are changes to pull" would reinstall dependencies and rebuild the
  // database for commits that are already local.
  const [ahead, behind] = git('rev-list', '--left-right', '--count', `${before}...${remote}`)
    .split(/\s+/)
    .map(Number);

  if (behind === 0) {
    console.log(`${GREEN}Already up to date.${RESET}`);
    if (ahead > 0) {
      console.log(`${YELLOW}Local branch is ${ahead} commit(s) ahead of origin/${branch}`
        + ` - remember to push.${RESET}`);
    }
    return;
  }

  // Summarise what is coming before touching anything.
  const incoming = git('log', '--oneline', `${before}..${remote}`);
  console.log(`\n${GREEN}Incoming commits:${RESET}`);
  console.log(incoming.split('\n').map((line) => `  ${line}`).join('\n'));

  const changed = git('diff', '--name-only', before, remote).split('\n').filter(Boolean);
  console.log(`\n${DIM}${changed.length} file(s) changed${RESET}`);

  const needsInstall = changed.some((file) => file === 'package-lock.json' || file === 'package.json');

  // A redeploy is needed for more than just the data model. CAP generates a
  // database view for every entity a *service* exposes, so adding a projection
  // in srv/*.cds creates a table the running database does not have yet, and
  // queries against it fail with "no such table". Any CDS change counts.
  const needsDeploy = changed.some((file) =>
    file.startsWith('db/') || (file.startsWith('srv/') && file.endsWith('.cds')));

  const touchesUi = changed.some((file) => file.startsWith('app/'));
  const touchesServer = changed.some((file) =>
    file.startsWith('srv/') || file.startsWith('tools/'));

  if (checkOnly) {
    console.log(`\n${YELLOW}--check: nothing was changed.${RESET}`);
    console.log(`  npm ci needed:            ${needsInstall ? 'yes' : 'no'}`);
    console.log(`  deploy:local needed:      ${needsDeploy ? 'yes' : 'no'}`);
    console.log(`  UI files changed:         ${touchesUi ? 'yes (hard-refresh the browser)' : 'no'}`);
    console.log(`  server restart needed:    ${touchesServer ? 'yes' : 'no'}`);
    return;
  }

  if (!run('git', ['pull', '--ff-only', 'origin', branch])) {
    console.error(`\n${YELLOW}Fast-forward pull failed. Your branch has local commits that are not`
      + ` on the remote, so this needs a merge or rebase you should do yourself.${RESET}`);
    process.exit(1);
  }

  if (needsInstall) {
    console.log(`\n${DIM}Dependencies changed.${RESET}`);
    if (!run('npm', ['ci'])) process.exit(1);
  }

  if (needsDeploy) {
    console.log(`\n${DIM}A CDS model or the seed data changed - rebuilding the local database.${RESET}`);
    if (!run('npm', ['run', 'deploy:local'])) process.exit(1);
  }

  console.log(`\n${GREEN}In sync at ${git('rev-parse', '--short', 'HEAD')}.${RESET}`);
  if (!needsInstall && !needsDeploy) {
    console.log(`${DIM}No install or redeploy was needed.${RESET}`);
  }
  if (touchesUi) {
    console.log(`${YELLOW}UI files changed - hard-refresh the browser (Ctrl+Shift+R) to clear the cache.${RESET}`);
  }
  if (needsDeploy || touchesServer) {
    console.log(`${YELLOW}Restart the server so it picks this up (Ctrl+C, then npm start).${RESET}`);
  }
  console.log(`${DIM}If the server is running under "npm run watch" it has already reloaded.${RESET}`);
}

main();
