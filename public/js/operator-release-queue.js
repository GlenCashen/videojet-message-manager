import { apiJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';
import { releaseExpectedOutput } from './release-preview.js';
import { messageMismatch } from './status-ui.js';

function createOperatorReleaseQueue({ elements, getPrinter, getStatus = () => null, printerId = null }) {
  const state = { releases: [], selected: null, busy: false, loading: false };

  function closeOnBackdrop(dialog, closeAction) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      closeAction();
    });
  }

  function targetStatusLabel(status) {
    return {
      pending: 'Approved / ready to send', applying: 'Sending to printer', awaiting_print_check: 'Sent / awaiting first-print check',
      running: 'Running on printer', ended: 'Completed', failed: 'Attention required — printer state uncertain'
    }[status] || status;
  }

  function targetTone(status) {
    if (['running', 'ended'].includes(status)) return 'good';
    if (status === 'failed') return 'bad';
    if (['applying', 'awaiting_print_check'].includes(status)) return 'stale';
    return 'neutral';
  }

  function isProductionRelease(release) {
    return ['released', 'applying', 'awaiting_print_check', 'running', 'failed', 'completed'].includes(release.status);
  }

  function rows() {
    return state.releases.filter(isProductionRelease).flatMap((release) => (release.executionTargets || [])
      .filter((target) => !printerId || target.printerId === printerId)
      .map((target) => ({ release, target })));
  }

  function plannedTime(row) {
    const value = new Date(row.release.plannedProductionAt).valueOf();
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  }

  function matchesSearch({ release }, query) {
    const search = query.trim().toLowerCase();
    if (!search) return true;
    return [release.brewSheetProduct, release.brewNumber, release.runCode]
      .some((value) => String(value || '').toLowerCase().includes(search));
  }

  function renderTarget(container, { release, target }, { spotlight = false } = {}) {
    const printer = getPrinter(target.printerId);
    const mismatch = target.status === 'running' ? messageMismatch(printer || {}, getStatus(target.printerId) || {}) : null;
    const currentSpotlight = spotlight && container === elements.current;
    const actionText = mismatch ? 'Resend and reverify' : {
      awaiting_print_check: 'Verify first print', failed: 'Resolve uncertain printer state', running: 'View running job', ended: 'Reapply job'
    }[target.status] || 'Review and send';
    const expected = releaseExpectedOutput(release, target.printerId);
    container.appendChild(el('article', { className: `operator-release-item target-${target.status}${spotlight ? ' release-spotlight-card' : ''}${currentSpotlight ? ' current-running-job-card' : ''}` }, [
      el('div', { className: 'operator-release-item-main' }, [
        el('div', {}, [
          currentSpotlight ? el('span', { className: 'current-job-eyebrow', text: 'Current running job' }) : null,
          el('span', { className: `badge ${targetTone(target.status)}`, text: targetStatusLabel(target.status) }),
          el('h3', { text: currentSpotlight ? `${release.brewSheetProduct} · ${release.runCode || 'Run pending'}` : release.brewSheetProduct }),
          el('p', { className: 'muted', text: `${printer?.name || target.printerId} · ${printer?.location || 'No line location'} · ${release.runCode || 'Tracked run pending'}` })
        ]),
        el('div', { className: 'operator-release-compact-facts' }, [
          el('span', { text: 'Brew' }), el('strong', { text: release.brewNumber || '-' }),
          el('span', { text: 'Planned' }), el('strong', { text: new Date(release.plannedProductionAt).toLocaleString() })
        ])
      ]),
      spotlight ? el('div', { className: 'release-card-preview' }, [
        el('span', { text: expected.provisional ? 'Planned expected print' : 'Expected print' }),
        el('pre', { text: expected.rendered })
      ]) : null,
      mismatch ? el('p', { className: 'operator-release-error', text: `MESSAGE MISMATCH — STOP PRODUCTION. Expected ${mismatch.expected}, printer reports ${mismatch.actual}. Resend this release and reverify the first print before restarting.` }) : null,
      target.error ? el('p', { className: 'operator-release-error', text: target.error }) : null,
      el('button', {
        className: 'primary', type: 'button', disabled: target.status === 'applying' ? 'disabled' : null,
        dataset: { releaseId: release.id, printerId: target.printerId },
        text: target.status === 'applying' ? 'Sending...' : actionText
      })
    ]));
  }

  function render() {
    const targets = rows();
    const activeTargets = targets.filter(({ release, target }) => release.status !== 'completed' && target.status !== 'ended').sort((a, b) => plannedTime(a) - plannedTime(b));
    const completedTargets = targets.filter(({ target }) => target.status === 'ended').sort((a, b) => plannedTime(b) - plannedTime(a));
    const current = activeTargets.find(({ target }) => target.status === 'running')
      || activeTargets.find(({ target }) => ['awaiting_print_check', 'applying', 'failed'].includes(target.status));
    const next = activeTargets.find(({ target }) => target.status === 'pending');
    const upcomingTargets = activeTargets.filter((row) => row !== current && row !== next);
    clear(elements.current);
    clear(elements.next);
    clear(elements.upcomingList);
    clear(elements.completedList);
    elements.completedButton.textContent = `Release history (${completedTargets.length})`;
    elements.upcomingButton.textContent = `View release schedule (${activeTargets.length})`;
    if (current) renderTarget(elements.current, current, { spotlight: true });
    else elements.current.appendChild(el('div', { className: 'operator-release-empty' }, [el('strong', { text: 'No job is running' }), el('p', { className: 'muted', text: 'Start an approved release from the next job or release schedule.' })]));
    if (next) renderTarget(elements.next, next, { spotlight: true });
    else elements.next.appendChild(el('div', { className: 'operator-release-empty' }, [el('strong', { text: 'No approved release is waiting' }), el('p', { className: 'muted', text: 'Newly approved work for this printer will appear here.' })]));

    const scheduleQuery = elements.upcomingSearch.value;
    const historyQuery = elements.completedSearch.value;
    const scheduleRows = [next, ...upcomingTargets].filter(Boolean).filter((row) => matchesSearch(row, scheduleQuery));
    const historyRows = completedTargets.filter((row) => matchesSearch(row, historyQuery));
    if (!scheduleRows.length) elements.upcomingList.appendChild(el('p', { className: 'operator-release-empty muted', text: scheduleQuery ? 'No releases match this search.' : 'No additional approved releases.' }));
    if (!historyRows.length) elements.completedList.appendChild(el('p', { className: 'operator-release-empty muted', text: historyQuery ? 'No completed releases match this search.' : 'No completed releases yet.' }));
    for (const row of scheduleRows) renderTarget(elements.upcomingList, row);
    for (const row of historyRows) renderTarget(elements.completedList, row);
  }

  function rerenderCurrent() {
    const activeTargets = rows()
      .filter(({ release, target }) => release.status !== 'completed' && target.status !== 'ended')
      .sort((a, b) => plannedTime(a) - plannedTime(b));
    const current = activeTargets.find(({ target }) => target.status === 'running')
      || activeTargets.find(({ target }) => ['awaiting_print_check', 'applying', 'failed'].includes(target.status));

    clear(elements.current);
    if (current) renderTarget(elements.current, current, { spotlight: true });
    else elements.current.appendChild(el('div', { className: 'operator-release-empty' }, [el('strong', { text: 'No job is running' }), el('p', { className: 'muted', text: 'Start an approved release from the next job or release schedule.' })]));
  }

  function setBusy(value) {
    state.busy = value;
    for (const button of [elements.close, elements.cancel, elements.send, elements.verify, elements.report, elements.returnRelease, elements.endRun]) button.disabled = value;
  }

  function fact(label, value) {
    return el('div', {}, [el('span', { text: label }), el('strong', { text: value || '-' })]);
  }

  function showPrintCheck() {
    elements.confirmation.classList.remove('hidden');
    elements.confirmation.querySelector('span').textContent = 'Confirm the first printed code matches the expected printed code before marking this release as running.';
    elements.send.classList.add('hidden');
    elements.verify.classList.remove('hidden');
    elements.report.classList.remove('hidden');
    elements.failureField.classList.remove('hidden');
    setNotice(elements.dialogNotice, 'The message was sent, but the release is not running yet. Physically check the first printed code against the expected printed code.', 'success');
  }

  function open(release, target) {
    state.selected = { release, target };
    const printer = getPrinter(target.printerId);
    elements.title.textContent = {
      awaiting_print_check: 'Verify first printed code', running: 'Production run in progress',
      ended: 'Reapply completed release', failed: 'Attention required — printer state uncertain'
    }[target.status] || 'Send approved release';
    elements.subtitle.textContent = `${printer?.name || target.printerId} · ${printer?.location || 'No line location'}`;
    clear(elements.facts);
    elements.facts.append(
      fact('Product', release.brewSheetProduct), fact('Tracked run', release.runCode),
      fact('Brew number', release.brewNumber),
      fact('Physical line', printer?.location || 'Not configured'), fact('Printer', printer?.name || target.printerId),
      fact('Planned production', new Date(release.plannedProductionAt).toLocaleString()), fact('Approved by', release.reviewedByUsername)
    );
    elements.preview.textContent = releaseExpectedOutput(release, target.printerId).rendered;
    elements.confirmCheck.checked = false;
    elements.failureReason.value = '';
    elements.confirmation.classList.remove('hidden');
    elements.confirmation.querySelector('span').textContent = 'I have checked the product, batch, physical line, printer and approved expected printed code.';
    elements.send.classList.remove('hidden');
    elements.verify.classList.add('hidden');
    elements.report.classList.add('hidden');
    elements.returnRelease.classList.add('hidden');
    elements.endRun.classList.add('hidden');
    elements.failureField.classList.add('hidden');
    elements.reasonLabel.textContent = 'Print problem';
    elements.send.textContent = 'Send approved release';
    setNotice(elements.dialogNotice);
    if (target.status === 'awaiting_print_check') showPrintCheck();
    if (target.status === 'running') {
      const mismatch = messageMismatch(printer || {}, getStatus(target.printerId) || {});
      if (mismatch) {
        elements.confirmation.classList.remove('hidden');
        elements.confirmation.querySelector('span').textContent = 'I have stopped production, quarantined product since the mismatch was detected, and confirm it is safe to resend the approved release.';
        elements.send.classList.remove('hidden');
        elements.failureField.classList.remove('hidden');
        elements.reasonLabel.textContent = 'Mismatch response and reason for resend';
        elements.send.textContent = 'Resend and reverify';
        elements.endRun.classList.remove('hidden');
        setNotice(elements.dialogNotice, `MESSAGE MISMATCH — expected ${mismatch.expected}, printer reports ${mismatch.actual}. Stop production, quarantine affected product, resend the release, then reverify the first print before restarting.`, 'error');
      } else {
        elements.confirmation.classList.add('hidden');
        elements.send.classList.add('hidden');
        elements.endRun.classList.remove('hidden');
        setNotice(elements.dialogNotice, 'This approved release is currently running on the printer.', 'success');
      }
    }
    if (target.status === 'ended') {
      elements.failureField.classList.remove('hidden');
      elements.reasonLabel.textContent = 'Reason for reapplying this completed job';
      elements.send.textContent = 'Confirm reapply';
    }
    if (target.status === 'failed' && target.verifiedAt) {
      const partiallyCompleted = release.executionTargets.some((item) => item.printerId !== target.printerId && ['ended', 'running'].includes(item.status));
      elements.confirmation.classList.remove('hidden');
      elements.confirmation.querySelector('span').textContent = 'I have physically checked this printer and confirm it is safe to resend the same approved message.';
      elements.send.classList.remove('hidden');
      elements.failureField.classList.remove('hidden');
      elements.reasonLabel.textContent = 'Physical check result and reason for retry';
      elements.send.textContent = 'Retry approved message';
      if (partiallyCompleted) {
        setNotice(elements.dialogNotice, 'Another printer target is already completed or running, so this release cannot be edited without changing production history. Retry the same approved message here, or create a new corrected release for this printer only if the approved data is wrong.', 'error');
      } else {
        elements.returnRelease.classList.remove('hidden');
        setNotice(elements.dialogNotice, 'Retry the same approved message after checking the printer, or return the release for correction if the approved data is wrong.', 'error');
      }
    }
    if (target.status === 'failed' && !target.verifiedAt) {
      elements.confirmation.classList.remove('hidden');
      elements.confirmation.querySelector('span').textContent = 'I have physically checked the printer and confirmed its current message and print state.';
      elements.failureField.classList.remove('hidden');
      elements.reasonLabel.textContent = 'Physical check result and reason for retry';
      elements.send.textContent = 'Retry after physical check';
      setNotice(elements.dialogNotice, 'Attention required — printer state uncertain. Physically check the printer before retrying or continuing.', 'error');
    }
    if (!elements.dialog.open) elements.dialog.showModal();
  }

  function replaceRelease(release) {
    const index = state.releases.findIndex((item) => item.id === release.id);
    if (index >= 0) state.releases[index] = release;
    else state.releases.unshift(release);
    render();
  }

  async function send() {
    if (state.busy || !state.selected) return;
    if (!elements.confirmCheck.checked) return setNotice(elements.dialogNotice, 'Complete the operator confirmation before sending.', 'error');
    const { release, target } = state.selected;
    const reapply = target.status === 'ended';
    const reverify = target.status === 'running' && Boolean(messageMismatch(getPrinter(target.printerId) || {}, getStatus(target.printerId) || {}));
    const reason = elements.failureReason.value.trim();
    if (reapply && !reason) return setNotice(elements.dialogNotice, 'Enter why this completed job is being reapplied.', 'error');
    if (reverify && !reason) return setNotice(elements.dialogNotice, 'Record the mismatch response before resending and reverifying.', 'error');
    if (target.status === 'failed' && !reason) return setNotice(elements.dialogNotice, 'Record the physical printer check and reason before retrying.', 'error');
    setBusy(true);
    setNotice(elements.dialogNotice, 'Sending the approved release and checking printer readback...');
    try {
      const response = await apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/targets/${encodeURIComponent(target.printerId)}/apply`, { method: 'POST', body: { reapply, reverify, reason } });
      replaceRelease(response.release);
      state.selected.release = response.release;
      state.selected.target = response.release.executionTargets.find((item) => item.printerId === target.printerId);
      open(state.selected.release, state.selected.target);
    } catch (error) {
      if (error.data?.release) replaceRelease(error.data.release);
      if (error.data?.code === 'RELEASE_DEFINITION_CHANGED') {
        elements.failureField.classList.remove('hidden');
        elements.reasonLabel.textContent = 'Reason for returning this release';
        elements.failureReason.value = normalizeError(error);
        elements.returnRelease.classList.remove('hidden');
      }
      setNotice(elements.dialogNotice, normalizeError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function returnForReview() {
    if (state.busy || !state.selected) return;
    const reason = elements.failureReason.value.trim();
    if (!reason) return setNotice(elements.dialogNotice, 'Enter a reason for returning this release.', 'error');
    setBusy(true);
    try {
      await apiJson(`/api/batch-releases/${encodeURIComponent(state.selected.release.id)}/return-for-review`, { method: 'POST', body: { reason } });
      elements.dialog.close();
      state.selected = null;
      await load();
      setNotice(elements.notice, 'Release returned for correction and independent re-review.', 'success');
    } catch (error) {
      setNotice(elements.dialogNotice, normalizeError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function endRun() {
    if (state.busy || !state.selected) return;
    const { release, target } = state.selected;
    setBusy(true);
    try {
      const response = await apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/targets/${encodeURIComponent(target.printerId)}/end-run`, { method: 'POST', body: {} });
      replaceRelease(response.release);
      elements.dialog.close();
      state.selected = null;
      setNotice(elements.notice, `${release.brewSheetProduct} run ended.`, 'success');
    } catch (error) {
      setNotice(elements.dialogNotice, normalizeError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function printCheck(passed) {
    if (state.busy || !state.selected) return;
    const reason = elements.failureReason.value.trim();
    if (passed && !elements.confirmCheck.checked) return setNotice(elements.dialogNotice, 'Confirm the first printed code matches the expected printed code before marking this release as running.', 'error');
    if (!passed && !reason) return setNotice(elements.dialogNotice, 'Describe the print problem before reporting it.', 'error');
    const { release, target } = state.selected;
    setBusy(true);
    try {
      const response = await apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/targets/${encodeURIComponent(target.printerId)}/print-check`, {
        method: 'POST', body: { passed, reason }
      });
      replaceRelease(response.release);
      setNotice(elements.notice, passed ? `${release.brewSheetProduct} is now running on ${getPrinter(target.printerId)?.name || target.printerId}.` : 'Print problem recorded. The target now requires attention.', passed ? 'success' : 'error');
      elements.dialog.close();
      state.selected = null;
    } catch (error) {
      setNotice(elements.dialogNotice, normalizeError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (state.busy) return;
    elements.dialog.close();
    state.selected = null;
  }

  async function load({ refreshOpenDialog = false } = {}) {
    if (state.loading || state.busy || document.hidden || (elements.dialog.open && !refreshOpenDialog)) return;
    state.loading = true;
    try {
      state.releases = await apiJson('/api/batch-releases?limit=500');
      render();
      if (refreshOpenDialog && state.selected) {
        const release = state.releases.find((item) => item.id === state.selected.release.id);
        const target = release?.executionTargets.find((item) => item.printerId === state.selected.target.printerId);
        if (release && target) open(release, target);
      }
      setNotice(elements.notice);
    } catch (error) {
      setNotice(elements.notice, normalizeError(error), 'error');
    } finally {
      state.loading = false;
    }
  }

  function selectRelease(event) {
    const button = event.target.closest('[data-release-id][data-printer-id]');
    if (!button) return;
    const release = state.releases.find((item) => item.id === button.dataset.releaseId);
    const target = release?.executionTargets.find((item) => item.printerId === button.dataset.printerId);
    if (release && target) {
      if (elements.completedDialog.open) elements.completedDialog.close();
      if (elements.upcomingDialog.open) elements.upcomingDialog.close();
      open(release, target);
    }
  }

  elements.current.addEventListener('click', selectRelease);
  elements.next.addEventListener('click', selectRelease);
  elements.upcomingList.addEventListener('click', selectRelease);
  elements.completedList.addEventListener('click', selectRelease);
  elements.upcomingButton.addEventListener('click', () => {
    if (!elements.upcomingDialog.open) elements.upcomingDialog.showModal();
  });
  elements.upcomingClose.addEventListener('click', () => elements.upcomingDialog.close());
  elements.completedButton.addEventListener('click', () => {
    if (!elements.completedDialog.open) elements.completedDialog.showModal();
  });
  elements.completedClose.addEventListener('click', () => elements.completedDialog.close());
  elements.upcomingSearch.addEventListener('input', render);
  elements.completedSearch.addEventListener('input', render);
  elements.refresh.addEventListener('click', load);
  elements.send.addEventListener('click', send);
  elements.verify.addEventListener('click', () => printCheck(true));
  elements.report.addEventListener('click', () => printCheck(false));
  elements.returnRelease.addEventListener('click', returnForReview);
  elements.endRun.addEventListener('click', endRun);
  elements.close.addEventListener('click', close);
  elements.cancel.addEventListener('click', close);
  closeOnBackdrop(elements.upcomingDialog, () => elements.upcomingDialog.close());
  closeOnBackdrop(elements.completedDialog, () => elements.completedDialog.close());
  closeOnBackdrop(elements.dialog, close);
  elements.dialog.addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });

  window.setInterval(load, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  return { load, refresh: () => load({ refreshOpenDialog: true }), rerender: rerenderCurrent };
}

export { createOperatorReleaseQueue };
