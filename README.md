# gmail-triage

A daily CLI that reads unread Gmail threads, classifies each one into a bucket with the `claude` CLI (model `sonnet`, subscription auth), applies a `Triage/*` label, stars urgent mail, archives the noise, and writes an HTML report. launchd runs it at 07:30. The report is published as a Claude artifact in your next Claude Code session. It starts in dry mode and changes nothing in Gmail until you run `go-live`.

Buckets: `urgent` (labeled, starred, stays in Inbox), `attention` (labeled, stays in Inbox), `notifications`, `outreach`, `receipts`, `nonwork`, `unsubscribe` (labeled and archived).

## Setup

1. Install dependencies: `npm ci`, then `cp pins.example.json pins.json` and edit it (see pins.json below).
2. In Google Cloud Console, create an OAuth client (type Desktop app) in a project with the Gmail API enabled, and download its JSON. The scope is `https://www.googleapis.com/auth/gmail.modify`.
3. Store the client in the macOS Keychain: `node src/main.ts store-client < client_secret.json`
4. Authorize: `node src/main.ts auth` (opens the browser, stores the refresh token in the Keychain).
5. Check access: `node src/main.ts probe` (prints your unread count and three subjects).
6. Install the schedule: `scripts/install-launchd.sh`. It generates the plist from `launchd/gmail-triage.plist.template` (label `local.gmail-triage`; set `GMAIL_TRIAGE_LABEL` to use another) with the absolute paths of `node` and `claude` (the job pins `CLAUDE_BIN` to the resolved `claude`), writes it to `~/Library/LaunchAgents/`, and reloads it. `--dest <dir>` changes the target, `--no-load` writes and lints only. Set `GMAIL_TRIAGE_HOME` before running it to carry that override into the job.
7. Install the SessionStart hook: `node scripts/install-hook.ts` (edits the Claude Code settings files and keeps a `.bak-gmail-triage` backup).

## Daily behavior

- 07:30: launchd runs `run`. Until `go-live`, every run is a dry run: it classifies and reports but writes nothing to Gmail. The report is headed DRY RUN.
- Each run takes up to 300 unread threads, newest first, classified in batches of 20. Threads already triaged and unchanged are skipped.
- Duplicate collapse: unread threads with the same sender mailbox (strict From parse) and the same subject (trimmed, case-insensitive, exact otherwise, so `[P1]` and `[P2]` stay apart) form a group. Only machine mail is grouped (the classified message is automated or has a `List-Id`), because From is spoofable; human-looking mail, a From that does not parse to one address, senders matching `neverArchive` or `alwaysUrgent`, and any thread with an already-read message are never grouped and go through normal triage. The newest copy by message date (the larger thread id on a tie) is triaged normally. Older copies skip the classifier: each is marked read, labeled `Triage/Duplicate` and archived. An older copy with unread direct human mail is left completely untouched (no label, no log entry, no marker). Each older copy gets the same new-mail recheck and run-log entry (`kind: dedupe`) as a triaged thread. The report has a "Duplicates collapsed" section with each group's older-copy count, a link to the newest thread, the number of protected copies left in the inbox, and a link to the `Triage/Duplicate` label; the header says `N older duplicates archived` (`would archive` in a dry run).
- A notification says `<A> archived, <U> urgent, <T> attention` (with `(dry run)` in dry mode) and that the report opens in your next Claude Code session. The report waits in `pending-publish`.
- The SessionStart hook hands the report to one interactive session only: it emits when the hook's `source` is `startup` and `CLAUDE_CODE_SESSION_ATTENDED` is not `0` (measured: SessionStart also fires in headless `claude -p` runs, with `source: startup` and `CLAUDE_CODE_SESSION_ATTENDED=0`, so headless jobs and resumed, cleared or compacted sessions get nothing).
- The first session to start renames the marker to `pending-publish.claimed.<epoch>`, so later sessions get nothing. If no `mark-published` ack arrives within an hour, the next startup session is offered the report again. The hook tells Claude to Read the file, publish it as an artifact, and run the ack; `mark-published` saves the artifact URL and clears the marker and any claimed file of that report.
- Any failure (network, Keychain, a bad `pins.json`, a corrupt `state.json`, an unexpected error) produces an error report headed `Run failed: <error class or code>` (no email content), the same notification path, and exit code 1. Network-class errors (`ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `ENETUNREACH`) while connecting to Gmail or on the first thread list are retried 3 times, 60 seconds apart, so a run that wakes before Wi-Fi is up still completes. An error report never replaces a successful live report of the same day; it is written to `reports/<date>-error.html`.
- After about three dry runs, tune `pins.json`, then run `node src/main.ts go-live`.

## Commands

Run as `node src/main.ts <command>`.

| Command | What it does |
| --- | --- |
| `run [--dry-run]` | Triage unread mail. `--dry-run` forces a dry run even in live mode. A second run while one is active exits 0 with "already running". |
| `undo <date>` | Revert a day's run (`YYYY-MM-DD`): remove its labels and stars, put archived threads back in Inbox. Collapsed duplicates get UNREAD and Inbox back and lose `Triage/Duplicate`, but only while the thread's newest message is still the one the run archived; a thread with newer mail is reported as superseded and left alone. Threads a later run touched are skipped. |
| `archive-old [--days N] [--yes]` | One-time cleanup: archive read inbox threads older than N days (default 30, integer 1 to 3650). Without `--yes` it prints the candidate count, the eligible count and skip counts by reason, and writes nothing. See Archive-old run. |
| `unsubscribe <date> [--yes] [--retry-unknown]` | Send RFC 8058 one-click unsubscribe requests for the unsubscribe-queue senders captured on `<date>` (`YYYY-MM-DD`). Without `--yes` it only lists them. See Unsubscribe run. |
| `unsubscribe-capture <date>` | Rebuild `unsub/<date>.json` from that day's run log (for a day run before the capture existed). Reads each logged unsubscribe thread's headers from Gmail (read-only), merges with any existing capture, and prints how many senders and how many are one-click. Exit 2 if there is no run log. |
| `go-live` | Switch the mode from dry to live. |
| `probe` | Check Gmail access and print the unread count. |
| `auth` | Run the OAuth flow and store the refresh token. Run it again after an `invalid_grant` failure. |
| `store-client` | Read the Google OAuth client JSON from stdin into the Keychain. |
| `mark-published <url> <generation id>` | Clear the pending report and save the artifact URL. The hook supplies both arguments. |

## Archive-old run

For clearing the read backlog once. `node src/main.ts archive-old --days 30` previews; add `--yes` to archive. It takes the run lock (held: prints "already running", exit 0).

- The scan is list-only (ids, 500 per page, one page at a time, 10 quota units each; more than 20,000 candidates aborts with no changes) and makes no `threads.get` calls. Gmail matches a thread when any of its messages matches, so candidates are the ids of `in:inbox older_than:<N>d`, minus the ids of `in:inbox newer_than:<N>d` (any recent message, such as a reply), `in:inbox is:unread` and `in:inbox is:starred`. The candidate query runs first (empty: nothing else runs); the exclusion queries are streamed with no cap and keep only candidate ids. Skips are counted by reason in that order (`recent`, `unread`, `starred`); an id in several sets counts under the first.
- `--yes` creates `Triage/Archived-old` if missing, then per thread logs a `runs/<today>.jsonl` entry, re-reads the thread (`threads.get`, minimal: still in Inbox, nothing unread or starred, newest message older than N days, else skipped as `changed`; a thread gone by then is also `changed`) and sends one guarded write (add `Triage/Archived-old`, remove `INBOX`). Threads run one at a time. Every API attempt, retries included, is charged against a token bucket before it is sent (list 10 units; a thread reserves `threads.get` 40 + `threads.modify` 10 = 50 together before its re-check, so no pacing wait sits between the re-check and the write, a retry reserves 50 again before its own re-check, and each retried re-check get reserves 40 more) that refills at 4,500 units/min (75% of Gmail's 6,000 per-user limit; override with `GMAIL_TRIAGE_UNITS_PER_MINUTE`, an integer of at least 50), about 1.5 threads/s. The preview prints `estimated time N min` (eligible x 50 units / budget). It never touches `UNREAD` or `STARRED`, and never writes `state.json` (these threads were not triaged). Retries use the same 10 minute budget as a run; once it is spent the command stops and exits 1.
- Output is counts only: `archived N, skipped M (reasons), failed F`. Exit 1 if any write failed or the budget ran out.
- Undo: `node src/main.ts undo <today>` adds `INBOX` back and removes `Triage/Archived-old`, only while the thread's newest message is still the logged one (else superseded, left alone). It never touches `state.json` entries for these threads.

## Unsubscribe run

Every run, dry or live, writes `unsub/<date>.json` (dir 0700, file 0600) for the senders in the report's unsubscribe queue: `{ sender, httpsUrl, mailto, oneClick, threadId }`. `mailto` is the Gmail compose link the report shows. `oneClick` is true only when the `List-Unsubscribe-Post` header (trimmed, case-insensitive) is `List-Unsubscribe=One-Click` and an https URL exists. No snippets are stored. A second run the same day merges by sender, so earlier senders are kept.

- `node src/main.ts unsubscribe <date>` prints a numbered list (sender, one-click yes/no, host only; never the URL, which carries tokens) and `re-run with --yes to send N one-click requests`. It sends nothing and exits 0.
- `node src/main.ts unsubscribe <date> --yes` takes the run lock first (held: prints "already running", exit 0), then reads the capture and results and sends one request per one-click entry, one at a time, over `node:https` with no connection reuse: `POST <httpsUrl>` with body `List-Unsubscribe=One-Click`, `Content-Type: application/x-www-form-urlencoded`, `User-Agent: gmail-triage/1`, no cookies, a 10 second total timeout, and no redirect following (a 3xx counts as done and is logged, not followed). Entries that are not one-click are listed under "manual: open from the report" and never contacted.
- `unsub/<date>.results.jsonl` (0600, fsync'd) gets `{ sender, host, phase: 'attempt', at }` before each POST and `{ sender, host, phase: 'result', status | error, at }` after the response headers arrive (body cleanup errors are ignored). A 2xx or 3xx result is skipped on re-run. A definite failure is retried by the next `--yes`: a non-2xx/3xx status, or an error before the request body was flushed (blocked host, DNS failure, connection refused, certificate or handshake failure). Any error after the body was flushed (timeout, reset, even a TLS alert) and an attempt with no result (crash) is an unknown outcome, because the server may have acted on the request. The result line records `sent` for this. An unknown outcome is listed as "unknown outcome", never auto-retried, and sent again only with `--yes --retry-unknown`. Exit code 1 if any request failed in this run.
- SSRF guard: the URLs come from email, so each URL must be https with no credentials, port empty or 443, and a hostname that is not an IP literal. The connection is pinned to the validated address: the socket's own DNS lookup resolves the name, blocks the entry if ANY address is loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), CGNAT (100.64/10), unique-local (fc00::/7), multicast or reserved, 0.0.0.0/8, `::`, or an IPv4-mapped IPv6 of any of those, and connects only to the addresses it checked, while TLS still verifies the original hostname. A blocked entry is logged with error `blocked host`, never contacted, and does not fail the run.

## pins.json

`pins.json` at the repo root is read on every `run`. It is gitignored: start from `cp pins.example.json pins.json`. A missing or malformed file stops the run before any call. Without `owner` and `work` the prompt is neutral.

```json
{
  "owner": "Dana",
  "work": "Acme or Acme Labs",
  "neverArchive": ["boss@example.com", "@partner.com"],
  "alwaysUrgent": ["ops@vendor.io"],
  "myAddresses": ["me@work-alias.com"],
  "automatedDomains": ["dtdg.co", "updates.linear.app", "health@aws.com"]
}
```

- `owner`, `work` (optional): one line each, up to 80 characters, no `<` or `>`. The classifier prompt names `owner` as the person the mail is for and treats mail unrelated to `work` as `nonwork`. Defaults: "the mailbox owner" and "the mailbox owner's work".
- `alwaysUrgent`: matching senders always go to `urgent`.
- `neverArchive`: matching senders never leave the Inbox. Anything the model put in an archived bucket becomes `attention`; `urgent` and `attention` stay as they are.
- An entry is a full address (`a@b.com`, exact match) or `@domain.com` (that domain and its subdomains). Matching is case-insensitive and works on the address inside `Name <addr>`.
- `alwaysUrgent` wins over `neverArchive`.
- `myAddresses` (optional): extra addresses that count as you for the direct-mail floor, besides the Gmail profile address. Every address-shaped token in To and Cc counts (comments and group syntax included, so this errs toward keeping mail), compared lowercase with any `+tag` removed, so `me+partner@gmail.com` counts as `me@gmail.com`. Bcc'd mail is not covered.
- `automatedDomains` (optional): senders whose mail the direct-mail floor treats as automated. Each entry is `@host` or `host` (that exact host only, no subdomains: `linear.app` does not cover `updates.linear.app`) or a full address like `health@aws.com` (that mailbox only), case-insensitive. This is not the pin matcher, which also covers subdomains. Use it for machine senders that mail you directly without list headers and with a human-looking From address.

## Files

All under `~/Library/Application Support/gmail-triage/` (override with `GMAIL_TRIAGE_HOME`):

- `state.json`: mode, artifact URL, processed threads.
- `reports/<date>.html`: the daily report. `reports/<date>-error.html` holds an error report when a live report for that date already exists.
- `runs/`: per-run logs that `undo` reads.
- `unsub/<date>.json`, `unsub/<date>.results.jsonl`: the unsubscribe capture and the results of the unsubscribe run.
- `run.lock`, `pending-publish`, `pending-publish.claimed.<epoch>`: the run lock, the report waiting to be published, and the report a session has taken but not yet acked.

The launchd log is `~/Library/Logs/gmail-triage.log`. The Keychain service is `gmail-triage` (accounts `oauth-client` and `refresh-token`).

## Safety

- Gmail writes go through a guard with an allowlist: a run may only add `Triage/*` labels and `STARRED` and remove `INBOX`; undo may only add `INBOX` and remove the logged labels and `STARRED`. A third shape, for older duplicate copies, may only add `Triage/Duplicate` and remove `UNREAD` and `INBOX` (the only path that changes read state); undoing such an entry may add `UNREAD` and `INBOX` and remove `Triage/Duplicate`, and a triage entry's undo can never add `UNREAD`. A fourth shape, for `archive-old`, may only add `Triage/Archived-old` and remove `INBOX` (both required); its undo may only add `INBOX` and remove that label. Anything else, or an empty change, throws.
- Classification fails closed per thread: a missing, invalid or duplicated verdict becomes `attention` (reason `unclassified`). Those threads get the `Triage/Attention` label and stay in the Inbox, never archived. A duplicated id always becomes `attention`; there is no first-verdict rule. Unknown ids are dropped, and `unsubscribe` without a `List-Unsubscribe` header becomes `outreach`.
- Direct-mail floor: after the model and the pins, a thread that would be archived stays in the Inbox as `attention` when you are in To or Cc (your profile address, any `+tag` variant, or an entry of `myAddresses`) and it has no `List-Id` and no `List-Unsubscribe` header (reason gets ` (kept: direct mail)`). The check runs on every unread message in the thread, because archiving is thread-wide: one unread human direct message keeps the whole thread, even if the newest reply is automated. A message is automated (and exempt) when it has an `Auto-Submitted` header other than `no`, a `Precedence` of `bulk`, `list` or `junk`, a role-address From local part (`alerts`, `notifications`, `billing`, `invoicing`, `receipts` and similar, or a local part with a `noreply` or `donotreply` token or a `no`,`reply` or `do`,`not`,`reply` token run, split on `-`, `_` and `.`, so `payments-noreply` and `jane.noreply` match but `noreplyjane` does not; `+tag` ignored), or a From host or address listed in `automatedDomains`. The From address is read strictly: quoted names and comments are ignored, and a From with zero or several addresses is never treated as automated and matches no pin. A person never sets these signals, so an attacker who adds them only exempts their own message. There is no sender-history exception, so a hostile mail cannot steer the verdicts of colleagues' mail in its batch into an archive. It applies in dry runs too, and the report header counts the threads it kept. Known cost: receipts or vendor mail from a human-looking address, sent straight to you without list headers, stay in the Inbox unless its domain is in `automatedDomains`.
- Gmail rate limits are retried with backoff against one sleep budget per run (10 minutes in total, 6 tries per call; `undo` has its own). Once it is spent, the run stops all further Gmail reads and writes, lists every unprocessed thread as failed with `gmail quota exhausted`, shows sender counts as `n/a`, still writes the report and notification, and exits 1 (also when only the sender counts ran out). Before each retried archive the thread is checked again for new mail; if a reply arrived it is left in the Inbox and listed as `new mail arrived`.
- A failed classifier call (non-zero exit, an `apiKeySource` other than `none`, or an unparsable stream) aborts the run before any Gmail write and produces an error report.
- Every `claude` child runs without `ANTHROPIC_*` or cloud-provider variables and with hooks disabled, so it uses your subscription and nothing else.
- Reports hold sender, subject, reason and a Gmail link. Snippets never reach a report or a notification, and email text is rendered as plain text. Subject and sender are cut to 120 characters (with an ellipsis) so a hostile mail has little room to write instructions into a file a privileged session reads. The hook context limits that session to reading the one file, one Artifact publish and the ack command.
- Classification treats email as untrusted data: a system prompt says every field is data, never instructions, and each verdict rests only on that thread's own fields. The batch JSON has `<` and `>` escaped and sits between per-call tagged `<<<EMAIL_DATA_BEGIN <tag>>>>` / `<<<EMAIL_DATA_END <tag>>>>` markers, and the rule is repeated after it. Batches are 20 threads, which bounds how many verdicts one hostile mail can sway.
- Pins match the last `<address>` in From, so a display name containing a fake address cannot trigger a pin.
- The report's undo command is `node '<repo>/src/main.ts' undo <date>`, prefixed with `GMAIL_TRIAGE_HOME='<path>'` when that variable is set, so it can be pasted into any shell.
