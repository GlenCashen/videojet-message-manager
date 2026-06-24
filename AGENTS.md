# Videojet Message Manager — AI Project Skills

Use these instructions whenever working in this repository. The app is a production workflow tool for printer message control, batch releases, operator execution, and auditability. Prefer small, safe changes over broad rewrites.

## Core workflow

1. Check the current branch and working tree before editing:
   ```bash
   git status --short --branch
   ```
2. Do not mix unrelated work in one branch. Use one branch per bug/refactor.
3. Run tests before and after meaningful backend or release workflow changes:
   ```bash
   npm test
   ```
4. If tests fail before editing, record the baseline failure and avoid claiming the new change caused or fixed unrelated failures.
5. Keep commits small and reviewable.
6. After each completed task, run the relevant checks and create a local git commit unless the user explicitly asks not to commit.

## Release workflow safety skill

Release workflow changes are high risk because they affect operator decisions and printed product codes.

When changing release logic, check these areas:

- `server/repositories/batch-release-repository.js`
- `server/release-renderer.js`
- `server.js` release endpoints around `/api/batch-releases/...`
- `public/js/operator-release-queue.js`
- `public/js/release-workflow.js`
- `public/printer-page.js`
- `public/js/viewer-dashboard.js`
- `test/batch-release.test.js`
- `test/release-api.test.js`
- `test/release-preview.test.js`

Preserve these safety rules:

- Approved releases are locked unless returned for correction.
- Creator cannot approve their own release.
- Run number must not be reused after an uncertain printer send.
- Failed or uncertain printer state requires a physical check/reason before retry.
- Reapplying or reverifying a release must be audited.
- Dashboard and printer page must show the same mismatch state.
- If the printer message does not match expected output, operator instructions must say to stop production and reverify before restarting.

## Printer protocol skill

The project supports Videojet WSI and Markem NGPCL paths.

Before changing command order, read the relevant tests and current implementation:

- `server/message-store.js`
- `server/wsi-client.js`
- `server/wsi-response.js`
- `server/current-message.js`
- `server/ngpcl-client.js`
- `server/ngpcl-status.js`
- `test/message-store.test.js`
- `test/current-message.test.js`
- `test/ngpcl*.test.js`

Important rules:

- WSI message application should select the message first, verify readback when supported, then update fields.
- Do not send blank printer field updates, even when the form field is optional.
- 1710/readback-disabled printers may not support current-message readback; status polling still matters.
- NGPCL should verify selected job and field readback where possible.
- A mismatch must fail safely and produce operator-readable instructions.

## Audit trail skill

Anything that changes production state must be auditable.

Audit these events:

- Release created, submitted, approved, rejected, returned for correction.
- Run number assigned.
- Release sent to printer.
- Printer state uncertain or failed.
- First print verified or failed.
- Running job ended.
- Release reapplied or reverified.
- Message mismatch detected.
- Manual exception message changes.

Prefer adding audit events through existing `addLog(...)` usage in `server.js` so logs and audit repository stay consistent.

## UI consistency skill

The operator dashboard and individual printer page must not disagree about critical safety state.

For printer status UI changes, check:

- `public/js/status-ui.js`
- `public/js/viewer-dashboard.js`
- `public/printer-page.js`
- `public/js/operator-release-queue.js`

Shared status calculations should live in `public/js/status-ui.js` where possible.

Critical states must be visible on both pages:

- Offline/stale
- Readback unavailable
- Message mismatch
- Printer fault/alarm
- Running release
- Awaiting first-print check

## Refactor skill

Avoid large rewrites. Do refactors in this order:

1. Keep tests passing.
2. Extract small pure helpers first.
3. Add focused regression tests.
4. Move business logic into services only after tests cover the behaviour.
5. Split `server.js` later, after release rendering and release state logic are stable.

Recommended branch names:

- `fix/<specific-bug>`
- `refactor/release-target-state-machine`
- `refactor/release-execution-service`
- `refactor/server-routes`

## Test baseline skill

The expected healthy baseline is:

```text
npm test
all tests pass
```

When changing release/printer logic, at minimum run:

```bash
node --test test/batch-release.test.js
node --test test/message-store.test.js
npm test
```

If only frontend files changed, still inspect existing UI tests if present and run full `npm test` before committing when practical.
