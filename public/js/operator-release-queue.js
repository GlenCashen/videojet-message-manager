import { apiJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';

function createOperatorReleaseQueue({ elements, getPrinter }) {
  const state = { releases: [], selected: null, busy: false };

  function targetStatusLabel(status) {
    return {
      pending: 'Ready to send', applying: 'Sending', awaiting_print_check: 'First print check',
      completed: 'Completed', failed: 'Attention required'
    }[status] || status;
  }

  function targetTone(status) {
    if (status === 'completed') return 'good';
    if (status === 'failed') return 'bad';
    if (['applying', 'awaiting_print_check'].includes(status)) return 'stale';
    return 'neutral';
  }

  function rows() {
    return state.releases.flatMap((release) => (release.executionTargets || []).map((target) => ({ release, target })));
  }

  function render() {
    clear(elements.list);
    const targets = rows().filter(({ target }) => target.status !== 'completed');
    if (!targets.length) {
      elements.list.appendChild(el('div', { className: 'operator-release-empty' }, [
        el('strong', { text: 'No approved releases need action' }),
        el('p', { className: 'muted', text: 'Newly approved releases for your assigned printers will appear here.' })
      ]));
      return;
    }
    for (const { release, target } of targets) {
      const printer = getPrinter(target.printerId);
      const actionText = target.status === 'awaiting_print_check' ? 'Verify first print' : (target.status === 'failed' ? 'Review and retry' : 'Review and send');
      elements.list.appendChild(el('article', { className: `operator-release-item target-${target.status}` }, [
        el('div', { className: 'operator-release-item-main' }, [
          el('div', {}, [
            el('span', { className: `badge ${targetTone(target.status)}`, text: targetStatusLabel(target.status) }),
            el('h3', { text: release.brewSheetProduct }),
            el('p', { className: 'muted', text: `${printer?.name || target.printerId} · ${printer?.location || 'No line location'} · ${release.runCode || 'Tracked run pending'}` })
          ]),
          el('div', { className: 'operator-release-compact-facts' }, [
            el('span', { text: 'Brew' }), el('strong', { text: release.brewNumber || '-' }),
            el('span', { text: 'Batch' }), el('strong', { text: release.batchNumber || '-' }),
            el('span', { text: 'Planned' }), el('strong', { text: new Date(release.plannedProductionAt).toLocaleString() })
          ])
        ]),
        target.error ? el('p', { className: 'operator-release-error', text: target.error }) : null,
        el('button', {
          className: 'primary', type: 'button', disabled: target.status === 'applying' ? 'disabled' : null,
          dataset: { releaseId: release.id, printerId: target.printerId },
          text: target.status === 'applying' ? 'Sending...' : actionText
        })
      ]));
    }
  }

  function setBusy(value) {
    state.busy = value;
    for (const button of [elements.close, elements.cancel, elements.send, elements.verify, elements.report]) button.disabled = value;
  }

  function fact(label, value) {
    return el('div', {}, [el('span', { text: label }), el('strong', { text: value || '-' })]);
  }

  function showPrintCheck() {
    elements.confirmation.classList.add('hidden');
    elements.send.classList.add('hidden');
    elements.verify.classList.remove('hidden');
    elements.report.classList.remove('hidden');
    elements.failureField.classList.remove('hidden');
    setNotice(elements.dialogNotice, 'The message was sent. Check the first physical print before completing this target.', 'success');
  }

  function open(release, target) {
    state.selected = { release, target };
    const printer = getPrinter(target.printerId);
    elements.title.textContent = target.status === 'awaiting_print_check' ? 'Verify first printed code' : 'Send approved release';
    elements.subtitle.textContent = `${printer?.name || target.printerId} · ${printer?.location || 'No line location'}`;
    clear(elements.facts);
    elements.facts.append(
      fact('Product', release.brewSheetProduct), fact('Tracked run', release.runCode),
      fact('Brew number', release.brewNumber), fact('Batch number', release.batchNumber),
      fact('Physical line', printer?.location || 'Not configured'), fact('Printer', printer?.name || target.printerId),
      fact('Planned production', new Date(release.plannedProductionAt).toLocaleString()), fact('Approved by', release.reviewedByUsername)
    );
    elements.preview.textContent = release.expectedOutput?.rendered || 'No approved output available';
    elements.confirmCheck.checked = false;
    elements.failureReason.value = '';
    elements.confirmation.classList.remove('hidden');
    elements.send.classList.remove('hidden');
    elements.verify.classList.add('hidden');
    elements.report.classList.add('hidden');
    elements.failureField.classList.add('hidden');
    setNotice(elements.dialogNotice);
    if (target.status === 'awaiting_print_check') showPrintCheck();
    elements.dialog.showModal();
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
    setBusy(true);
    setNotice(elements.dialogNotice, 'Sending the approved release and checking printer readback...');
    try {
      const response = await apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/targets/${encodeURIComponent(target.printerId)}/apply`, { method: 'POST', body: {} });
      replaceRelease(response.release);
      state.selected.release = response.release;
      state.selected.target = response.release.executionTargets.find((item) => item.printerId === target.printerId);
      showPrintCheck();
    } catch (error) {
      if (error.data?.release) replaceRelease(error.data.release);
      setNotice(elements.dialogNotice, normalizeError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function printCheck(passed) {
    if (state.busy || !state.selected) return;
    const reason = elements.failureReason.value.trim();
    if (!passed && !reason) return setNotice(elements.dialogNotice, 'Describe the print problem before reporting it.', 'error');
    const { release, target } = state.selected;
    setBusy(true);
    try {
      const response = await apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/targets/${encodeURIComponent(target.printerId)}/print-check`, {
        method: 'POST', body: { passed, reason }
      });
      replaceRelease(response.release);
      setNotice(elements.notice, passed ? `${release.brewSheetProduct} completed on ${getPrinter(target.printerId)?.name || target.printerId}.` : 'Print problem recorded. The target now requires attention.', passed ? 'success' : 'error');
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

  async function load() {
    try {
      state.releases = await apiJson('/api/batch-releases?limit=100');
      render();
      setNotice(elements.notice);
    } catch (error) {
      setNotice(elements.notice, normalizeError(error), 'error');
    }
  }

  elements.list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-release-id][data-printer-id]');
    if (!button) return;
    const release = state.releases.find((item) => item.id === button.dataset.releaseId);
    const target = release?.executionTargets.find((item) => item.printerId === button.dataset.printerId);
    if (release && target) open(release, target);
  });
  elements.refresh.addEventListener('click', load);
  elements.send.addEventListener('click', send);
  elements.verify.addEventListener('click', () => printCheck(true));
  elements.report.addEventListener('click', () => printCheck(false));
  elements.close.addEventListener('click', close);
  elements.cancel.addEventListener('click', close);
  elements.dialog.addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });

  return { load, refresh: load };
}

export { createOperatorReleaseQueue };
