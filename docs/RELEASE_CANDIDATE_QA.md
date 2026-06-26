# Release Candidate QA Checklist

Use this checklist before deploying a new build or handing the system to operators after UI, release workflow, printer status, or configuration changes.

Record the app commit, date, tester, environment, and printer/emulator setup before starting.

```text
Commit:
Date:
Tester:
Environment:
Printers/emulators:
Notes:
```

## 1. Fresh Start

- [ ] Stop the app and any printer-agent process.
- [ ] Start the main app with the intended `.env` values.
- [ ] Confirm `/api/health` returns `ok: true`.
- [ ] Open the dashboard and confirm no browser console errors are visible.
- [ ] Confirm navigation loads Dashboard, Production Coding Releases, and Editor pages.
- [ ] Confirm the current branch/commit is the intended release candidate.

## 2. Status Timing

Check these settings before testing offline/stale behavior:

- `POLL_INTERVAL_MS`
- `STALE_AFTER_MS`
- `OFFLINE_AFTER_FAILURES`

Expected behavior:

- [ ] A healthy printer shows live/online status.
- [ ] Failed polls update the latest attempt time without pretending there was a successful update.
- [ ] Stale state appears after `STALE_AFTER_MS` from the last successful poll.
- [ ] Offline state appears only after `OFFLINE_AFTER_FAILURES` failed polls.
- [ ] Dashboard and printer page show the same stale/offline/mismatch state.

## 3. Dashboard

- [ ] All expected printer cards load.
- [ ] Current running job is visually dominant where a job is running.
- [ ] Printer status traffic-light widget is compact and vertical.
- [ ] Message, expected print, faults, and sync sections do not overlap.
- [ ] Expected message text preserves line breaks and does not wrap printed-code lines.
- [ ] Status labels are clear for online, stale, offline, mismatch, and mismatch/offline.
- [ ] “Open printer” opens the correct individual printer page.

## 4. Printer Page Live Status

- [ ] Live printer state card matches the dashboard card hierarchy.
- [ ] Current running job matches the dashboard running-job card.
- [ ] Mismatch is primary when expected and current messages differ.
- [ ] If the printer goes stale/offline during mismatch, the UI still shows mismatch and also indicates stale/offline.
- [ ] Redundant mismatch text is not repeated in multiple places.
- [ ] Data stale banner appears only when appropriate.
- [ ] Connection diagnostics can expand without breaking layout.

## 5. Happy Release Path

- [ ] Create or select an approved release assigned to the test printer.
- [ ] Open the printer page for that printer.
- [ ] Send the approved release.
- [ ] Confirm the modal moves to a stable sending state.
- [ ] Confirm it then moves to first-print verification without flashing the wrong confirmation text.
- [ ] Confirm expected print preserves exact formatting and no printed-code line wraps.
- [ ] Mark first print verified.
- [ ] Confirm the printer target becomes running.
- [ ] Confirm dashboard and printer page show the same running release.
- [ ] Confirm the release audit/history records send and first-print verification.

## 6. Mismatch And Reverify Path

- [ ] Force or simulate the printer reporting a different message.
- [ ] Confirm mismatch appears on the dashboard.
- [ ] Confirm mismatch appears on the printer page.
- [ ] Confirm the operator instruction says to stop production and reverify before restarting.
- [ ] Resend and reverify from the printer page.
- [ ] Confirm a reason/confirmation is required before resend.
- [ ] Confirm the modal uses the same sending and first-print verification phases as the happy path.
- [ ] Confirm first-print verification restores the target to running.
- [ ] Confirm the reverify event is recorded in audit/history.

## 7. Offline During Mismatch

- [ ] Create a mismatch.
- [ ] Disconnect or stop the printer/emulator.
- [ ] Confirm mismatch remains the primary safety state.
- [ ] Confirm offline/stale is still visible alongside mismatch.
- [ ] Confirm dashboard and printer page agree.
- [ ] Reconnect the printer/emulator.
- [ ] Confirm polling recovers without needing a page refresh.

## 8. Manual Exception Message

- [ ] Open the manual message modal from a printer page as a privileged user.
- [ ] Confirm the modal is centered in the viewport, not the page scroll position.
- [ ] Click outside the modal and confirm it closes when not busy.
- [ ] Reopen the modal and select a message.
- [ ] Enter all required fields and a reason.
- [ ] Confirm expected preview updates its time live/near-live.
- [ ] Confirm expected preview does not wrap printed-code lines.
- [ ] Click review.
- [ ] Confirm the edit form is hidden or visually de-emphasized while the audit confirmation card is visible.
- [ ] Confirm audit confirmation shows message, fields, expected print, and reason clearly.
- [ ] Confirm audited change succeeds or fails with an operator-readable notice.
- [ ] Confirm the audit log records the manual exception.

## 9. Production Coding Releases Page

- [ ] Release Register tab loads without horizontal page overflow.
- [ ] Search, status filter, and packaging filter work.
- [ ] Release rows show status, product, brew, run, printers, and actions clearly.
- [ ] Details open and close cleanly.
- [ ] History opens and shows relevant audit events.
- [ ] New release form previews expected print for each inherited printer.
- [ ] Expected time fields update live/near-live where the template includes a time token.
- [ ] Independent review claim behavior prevents a second reviewer from approving at the same time.
- [ ] Creator cannot approve their own release.

## 10. Product Masters

- [ ] Product Masters tab loads without horizontal page overflow.
- [ ] Search and packaging filter work.
- [ ] Master cards show product, batch/default product, version, next run, status, and printer summary clearly.
- [ ] Creating a new version preserves existing approved releases.
- [ ] Printer/message mapping previews preserve expected print format.
- [ ] Save requires a change reason when editing an existing master.

## 11. Messages Page

- [ ] Printer user field list is readable and aligned.
- [ ] Message list has no horizontal scrollbar.
- [ ] Selecting a message updates the editor panel.
- [ ] Message ID, printer, display name, stored printer message, enabled flag, and fields are clear.
- [ ] Expected print preview updates live/near-live when a time token is present.
- [ ] Expected print preview preserves exact line breaks and does not wrap printed-code lines.
- [ ] Creating, editing, archiving, and restoring messages work as expected.

## 12. Access Control

- [ ] Viewer can view dashboard but cannot use operator/editor actions.
- [ ] Operator can use assigned printer page release actions only for assigned printers.
- [ ] QA/Packaging Leader can perform allowed release review actions.
- [ ] Admin can access editor and user simulation.
- [ ] Simulate user and Return to admin work without losing the admin session.

## 13. Restart And Recovery

- [ ] Restart the main app while no printer operation is active; UI recovers cleanly.
- [ ] Restart during or after an uncertain local send; target becomes attention-required rather than silently resending.
- [ ] In agent mode, restart the agent during an in-flight job and confirm it reports success or uncertainty without duplicate sends.
- [ ] Sessions survive normal app restart.

## 14. Final Checks

- [ ] Run `npm test`.
- [ ] Run `npm run db:check`.
- [ ] Confirm `.env` values match [Configuration](CONFIGURATION.md).
- [ ] Confirm `.env` is not staged or committed.
- [ ] Confirm no browser console errors were observed during the pass.
- [ ] Confirm no unexpected files changed during the pass.

## Sign-Off

```text
Result: PASS / FAIL
Blocking issues:
Follow-up issues:
Approved by:
Date:
```
