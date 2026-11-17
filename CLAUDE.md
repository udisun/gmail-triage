# gmail-triage

- Node 22 runs `.ts` directly (type stripping): no build. `npm test` = `node --test 'tests/**/*.test.ts'`, `npm run typecheck` = tsc noEmit. TS strict, no semicolons, `.ts` import extensions, no enum.
- **This checkout is LIVE** once installed: the launchd job (`scripts/install-launchd.sh`) runs `src/main.ts run` from here at 07:30. Change code in a worktree (`git worktree add -b <b> .claude/worktrees/<name> main`), fast-forward main only after review + green suite.
- All Gmail writes go through `src/gmailWrite.ts` (allowlisted body shapes: triage, dedupe, archiveOld, undo). `tests/noForbiddenCalls.test.ts` scans `src/` — never write `settings.`, `drafts`, `.filters`, or `threads.modify`/`labels.create` outside gmailWrite.ts.
- Tests never touch real Gmail/Keychain/launchd/settings: set `GMAIL_TRIAGE_HOME` to a tmp dir, fake the APIs. Live state lives in `~/Library/Application Support/gmail-triage/` (state.json, runs/, reports/, unsub/).
- Review each change with Codex: `node "<codex plugin>/scripts/codex-companion.mjs" adversarial-review --wait --cwd <worktree> --base <sha> "<focus>"`; fix Critical/Important before merging.
- Gmail quirks: `resultSizeEstimate` is wrong (said 201 for 422) — count by paging ids; thread search matches if ANY message matches; per-user quota ≈ 6,000 units/min (get 40, modify 10) — pace by units (`GMAIL_TRIAGE_UNITS_PER_MINUTE`).
- Undo: `node src/main.ts undo <YYYY-MM-DD>` reverses every logged Gmail change for that day (not unsubscribes).
