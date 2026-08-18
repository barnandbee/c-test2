#!/bin/bash
#
# SessionStart guard for Claude Code on the web.
#
# This project has no dependencies to install — Three.js is vendored and there
# is no build step. The hook exists for a different reason.
#
# The remote container is ephemeral, and when it is reclaimed and reprovisioned
# it has come back from a stale filesystem snapshot: the checkout, and even
# .git itself, silently rewind to an older commit. Work that was committed and
# pushed is safe on the remote, but the local tree looks like it never
# happened — and editing on top of that produces a commit whose parent is the
# stale one, which on push would delete everything in between.
#
# So on every session start: compare the checkout against the remote and say
# plainly what it finds.
#
# Safety rules, in order:
#   1. NEVER touch a dirty working tree. Uncommitted work is unrecoverable;
#      a stale checkout is not. If there are local changes, warn and stop.
#   2. NEVER act on diverged history. Only a strict fast-forward is automatic.
#   3. NEVER fail the session. Every path exits 0 — no network, no upstream
#      and no git at all are all just "carry on".
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo '')
if [ -z "$branch" ]; then
  echo "session-start: detached HEAD — skipping the remote check."
  exit 0
fi

# Prefer the branch's own upstream; fall back to a same-named remote branch,
# then to main (this repo mirrors its work branch onto main for Pages).
upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo '')
if [ -n "$upstream" ]; then
  remote_ref="${upstream#*/}"
elif git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  remote_ref="$branch"
else
  remote_ref="main"
fi

if ! git fetch --quiet origin "$remote_ref" 2>/dev/null; then
  echo "session-start: couldn't reach origin — skipping the remote check."
  exit 0
fi

local_head=$(git rev-parse HEAD)
remote_head=$(git rev-parse FETCH_HEAD)

if [ "$local_head" = "$remote_head" ]; then
  echo "session-start: checkout matches origin/$remote_ref ($(git rev-parse --short HEAD))."
  exit 0
fi

behind=$(git merge-base --is-ancestor "$local_head" "$remote_head" && echo yes || echo no)
ahead=$(git merge-base --is-ancestor "$remote_head" "$local_head" && echo yes || echo no)

if [ "$behind" = "no" ] && [ "$ahead" = "no" ]; then
  echo "‼️  session-start: local history has DIVERGED from origin/$remote_ref."
  echo "    local  $(git rev-parse --short "$local_head")"
  echo "    origin $(git rev-parse --short "$remote_head")"
  echo "    Rebase onto origin — do NOT force-push, it would drop the remote's commits."
  exit 0
fi

if [ "$ahead" = "yes" ]; then
  echo "session-start: $(git rev-list --count "$remote_head..$local_head") unpushed commit(s) ahead of origin/$remote_ref. Push them before this container is reclaimed."
  exit 0
fi

# Behind. This is the rollback signature.
count=$(git rev-list --count "$local_head..$remote_head")
echo "‼️  session-start: checkout is $count commit(s) BEHIND origin/$remote_ref."
echo "    local  $(git rev-parse --short "$local_head")"
echo "    origin $(git rev-parse --short "$remote_head")"

# Only MODIFIED TRACKED files block the fast-forward. Untracked files are not
# at risk: `git reset --hard` leaves them exactly where they are, and after a
# rollback they are often the only surviving work.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "    Tracked files have uncommitted changes — changing nothing. Save the diff,"
  echo "    then reset to origin and reapply it. Do not commit on top of this stale base."
  exit 0
fi

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  echo "    Working tree is clean. Run: git reset --hard origin/$remote_ref"
  exit 0
fi

git reset --hard "$remote_head" --quiet 2>/dev/null || git reset --hard "$remote_head" >/dev/null
echo "    Working tree was clean — fast-forwarded to $(git rev-parse --short HEAD). Nothing was lost."
exit 0
