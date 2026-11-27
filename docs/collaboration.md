# Working together on a game

Several people, and each person's agents (MCP clients, ACP agents in the Workbench), can build one game at once
without overwriting each other. The model is GitHub's, cut down to what a game on HearthCade needs: collaborators with
roles, a branch each, change requests that are reviewed, a protected main, and merges that combine everyone's work and
report conflicts the way git does.

Code: rules in `src/collab-core.ts` (pure, no imports, tested in `tests/collab.mjs`), the Worker side in
`src/collab.ts`, MCP tools in `src/mcp/collab-tools.ts`, the console API in `src/routes/collab.ts` (`/api/collab/*`),
the pages in `web/src/pages/Team.tsx` (`/team`, `/team/:id`, `/console/p/:id/team`). Schema
`migrations/0053_collaboration.sql`. The live test against a running Worker is `npm run test:collab`
(`tests/collab-live.mjs`).

## What it is modelled on

| GitHub | HearthCade | Reference |
| --- | --- | --- |
| Repository collaborators, invited by account, accepting the invitation | `project_members`, `project_invites`: invited by the email they sign in with, open 7 days | [Inviting collaborators](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-access-to-your-personal-repositories/inviting-collaborators-to-a-personal-repository) |
| Repository roles Read, Triage, Write, Maintain, Admin | read, write, maintain, admin, plus the owner (Triage folded into write: there are no issues) | [Repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization), [expanded permissions](https://github.blog/news-insights/product-news/delegate-responsibilities-with-expanded-repository-permissions) |
| Branches | `branches`: a working copy of the whole game, forked from a main version | |
| Protected branch: required reviews, required status checks, dismiss stale approvals, who can push, admin bypass | `projects.protection`: `required_approvals`, `require_verified`, `dismiss_stale`, `main_writers`, `allow_bypass` | [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [required approvals hardening](https://github.blog/changelog/2023-06-06-security-enhancements-to-required-approvals-on-pull-requests/) |
| Pull requests, reviews (approve, request changes, comment), dismissing a review | `change_requests`, `change_reviews` | [About pull request reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews) |
| Status checks | verification: a change request merges a version that passed it | |
| Merge commit, three-way merge, conflict markers | every merge makes a new main version, combined with a three-way tree and diff3 text merge | [git merge](https://git-scm.com/docs/git-merge), [diff3](https://www.cis.upenn.edu/~bcpierce/papers/diff3-short.pdf) |
| Update branch (bring the base in) | `branches {action: "update"}` | [Keeping your PR in sync](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/keeping-your-pull-request-in-sync-with-the-base-branch) |
| Optimistic concurrency on the contents API (sha of the file you change) | `deploy_preview {base_version}`; the version number is taken only while main's newest is still the base | [Repository contents](https://docs.github.com/en/rest/repos/contents) |

Where it differs, on purpose:

- **Money stays the owner's.** Prices, sales, trials, the build skill's price, earnings, deleting the game and the admin
  role are the owner's alone, whatever role anyone else holds. A console project page (it shows earnings) is the
  owner's; collaborators use `/team/:id`, which needs no creator license.
- **No access, no trace.** A project you have no role on answers exactly like one that does not exist (404), so being
  a collaborator never reveals other creators' games.
- **Approvals never exceed the people who can give them.** Required approvals are capped at the number of members other
  than the author who may review, so a two-person team with `required_approvals: 2` is not stuck.
- **A project nobody else works on is never protected for its owner.** The owner always writes main directly; protection
  applies to everyone else (`mayPushMain`).
- **Adjacent-line edits conflict**, as in git: two people changing neighbouring lines get a conflict to resolve, not a
  silent guess.

## Roles

| Role | Can |
| --- | --- |
| read | See the game, its versions, branches and change requests; download files; comment |
| write | Also work on branches (upload, deploy branch previews), open change requests, review them, use debug_preview |
| maintain | Also change main directly (when protection allows), merge change requests, manage branches, edit the store listing, game data and rooms |
| admin | Also invite and remove collaborators up to maintain, set main's protection, publish, roll back, unpublish |
| owner | Everything, including prices, earnings, admins and deleting the game. A platform admin counts as owner, except on a connection the person limited to selected projects |

Every MCP tool has a least role in `TOOL_ROLES` (`src/mcp/scope.ts`); a tool without one is the owner's (fail closed,
checked by `tests/collab.mjs`). Workspace tools enter at read and then check write on the branch, or main's protection
on main (`target()` in `src/collab.ts`).

## Workspaces and versions

- **Main** is the game itself: its workspace id is the project id, its versions have `branch = NULL`, and main's newest
  version is `MAX(n) WHERE branch IS NULL`. Publishing takes main versions only.
- **A branch** is a working copy with id `<project>~<branch id>`, kept in the same `files` table and R2 bucket
  (`ws/<workspace>/<path>`). Branch versions share the project's numbering and record `versions.branch`; a branch
  remembers its `base_version` (the merge base), `head_version` and `ws_base`.
- Every workspace tool (`upload_files`, `create_upload_url`, `list_files`, `deploy_preview`, `checkout_version`,
  `pull_version`, `diff_versions`, `game_metadata`, `compatibility`) takes `branch`.
- A branch deploy goes to the project's preview address like any deploy (one preview per game, serialized by the
  Pipeline Durable Object), and is verified the same way.

## A change, start to finish

1. The owner invites people: `collaborators {action: "invite", email, role}` or the Team tab. The invitee accepts at
   `/team` or with `collaborators {action: "accept"}`.
2. Each person or agent creates a branch: `branches {action: "create", name, from_version?}`.
3. They work on it (`upload_files {branch}`) and deploy it (`deploy_preview {branch}`).
4. They open a change request: `change_requests {action: "open", branch, title, body}`. Its head is the branch's newest
   version, so new deploys update the change request.
5. Others review: `change_requests {action: "review", number, verdict: "approve" | "request_changes" | "comment"}`.
   A request for changes blocks until that reviewer approves (or an admin dismisses it). With `dismiss_stale`, an
   approval counts only for the version it reviewed.
6. A maintainer merges: `change_requests {action: "merge", number, delete_branch?}`. An admin may bypass missing
   approvals or a failed verification when `allow_bypass` is on (recorded); never conflicts, an unfinished
   verification or a closed request.

`change_requests {action: "get"}` returns the files changed, a dry-run of the merge, every blocker with what to do, the
reviews (stale ones marked) and what the caller may do.

## Merging

`mergeChange` in `src/collab.ts`:

1. **Claim**: `UPDATE change_requests SET status = 'merging' WHERE status = 'open'`. Only one merge of a change request
   runs; a claim left by a crashed merge lapses after 5 minutes.
2. **Check** the rules (`mergeability`), or the bypass.
3. **Tree merge** (`mergeTrees`): for each path, main's newest version ("ours") and the branch head ("theirs") against
   their merge base. One side changed it: that side. Both the same way: either. Both differently: a text merge, or a
   conflict for binary and over-size files. Changed on one side and deleted on the other: a conflict.
4. **Text merge** (`merge3Text`): diff3 over Myers' O(ND) line diff. Changes to separate lines combine; overlapping or
   touching changes conflict unless identical. Conflicts are trimmed of lines both sides share (git's zealous merge).
5. Any conflict: the merge is refused with the list, and nothing is written. The author runs `branches {action:
   "update"}`, which brings main into the branch with git's `<<<<<<<`, `=======`, `>>>>>>>` markers and records the
   conflicts on the branch. `deploy_preview` refuses a workspace that still has markers. Uploading the fixed file clears
   it (`autoResolve`); `branches {action: "resolve", path, take}` settles a binary or deleted file.
6. **Build** the result in a scratch workspace and run the static checks on it.
7. **Snapshot** it as a new main version, based on main's newest, with the number taken only while that is still main's
   newest (see below). If main moved during the merge, the merge is refused ("main changed while…") and can simply be
   pressed again.
8. Mark the change request merged, queue verification, bring main's workspace and the branch up to the new version
   when they had no unsaved changes, and drop the scratch workspace.

## Concurrency

Every rule that two people or agents could race on is enforced in the database, not by reading first:

| Race | How it is stopped |
| --- | --- |
| Two deploys, or a deploy and a merge, taking the next version from the same base | `snapshot()` takes the number, writes the version row and moves the branch or main pointer in one D1 batch, guarded by an `alloc_token` and a compare-and-set on main's (or the branch's) newest version |
| Writes to one workspace at once (uploads, zips, checkout, update, merge follow-ups) | A lease per workspace (`ws_locks`, `withLock`): 60 seconds, renewed by long operations, lapses after a crash; a waiter gives up after 10 seconds with 409 `workspace_busy` |
| The same change request merged twice | The claim (open → merging) |
| Two branches with one name, two open change requests for one branch, two pending invitations to one email | Unique partial indexes |
| One invitation accepted twice, or the member limit passed by accepts at once | A conditional `UPDATE` claims the invitation; the member row is `INSERT … SELECT … WHERE (count) < limit` |
| A removed member's upload URL | The upload and download grants check the role again on every use |

`tests/collab-live.mjs` runs each of these against a real Worker: a double accept, 12 creates of one branch name at
once, three maintainers merging the same change request at once, two change requests merged at once (main's history
stays a chain), 36 concurrent writes across main and branches with hash checks afterwards, writes racing a deploy,
a removed member's upload URL, and deleting a branch closing its change request.

## Limits

`LIMITS` in `src/collab-core.ts`: 25 collaborators and 50 pending invitations per game, invitations open 7 days and
30 sent per hour per person, 30 open branches per game and 10 per person, 50 open change requests, titles 120
characters, bodies 8,000, review comments 4,000, 400 reviews per change request, text merges up to 2 MB per file
(bigger files conflict when both sides changed them). The console API allows 240 writes per 10 minutes per person.

## Known limits

- One preview address per game: branch deploys and main deploys take turns on it (the pipeline serializes them), so two
  people verifying at the same moment wait for each other. Each version keeps its own report and screenshot.
- Merges are line-based. Two changes to one long line conflict even when they touch different parts of it.
- Old versions are kept while anything still needs them: main's head, `ws_base`, and every open branch's base, head and
  `ws_base` are exempt from version cleanup (`src/cleanup.ts`).
