import { apiJson } from './api.js';
import { clear, el, normalizeError, setNotice } from './dom.js';
import { currentSession, hasCapability } from './session.js';

const nodes = {
  panel: document.getElementById('releaseWorkflowPanel'),
  notice: document.getElementById('releaseWorkflowNotice'),
  refresh: document.getElementById('refreshReleaseWorkflow'),
  draftCount: document.getElementById('releaseDraftCount'),
  reviewCount: document.getElementById('releaseReviewCount'),
  readyCount: document.getElementById('releaseReadyCount'),
  search: document.getElementById('releaseSearch'),
  statusFilter: document.getElementById('releaseStatusFilter'),
  openMaster: document.getElementById('openProductMasterForm'),
  openRelease: document.getElementById('openBatchReleaseForm'),
  formWorkspace: document.getElementById('releaseFormWorkspace'),
  masterSection: document.getElementById('productMasterSection'),
  masterForm: document.getElementById('productMasterForm'),
  masterProductCode: document.getElementById('masterProductCode'),
  masterDisplayName: document.getElementById('masterDisplayName'),
  masterNextRun: document.getElementById('masterNextRun'),
  masterRunPrefix: document.getElementById('masterRunPrefix'),
  masterRunWidth: document.getElementById('masterRunWidth'),
  masterMessage: document.getElementById('masterMessage'),
  masterMessageSummary: document.getElementById('masterMessageSummary'),
  masterFieldMappings: document.getElementById('masterFieldMappings'),
  masterPrinters: document.getElementById('masterPrinters'),
  releaseSection: document.getElementById('batchReleaseSection'),
  releaseForm: document.getElementById('batchReleaseForm'),
  releaseMaster: document.getElementById('releaseProductMaster'),
  releaseBrewProduct: document.getElementById('releaseBrewProduct'),
  releaseBrewNumber: document.getElementById('releaseBrewNumber'),
  releaseBatchNumber: document.getElementById('releaseBatchNumber'),
  releaseProductionAt: document.getElementById('releaseProductionAt'),
  releasePrinters: document.getElementById('releasePrinters'),
  releaseNotes: document.getElementById('releaseNotes'),
  list: document.getElementById('batchReleaseList'),
  dialog: document.getElementById('releaseReviewDialog'),
  dialogTitle: document.getElementById('releaseReviewDialogTitle'),
  dialogBody: document.getElementById('releaseReviewBody'),
  closeDialog: document.getElementById('closeReleaseReview'),
  cancelDialog: document.getElementById('cancelReleaseReview'),
  approvalAttestation: document.getElementById('releaseApprovalAttestation'),
  approvalCheck: document.getElementById('releaseApprovalCheck'),
  rejectionField: document.getElementById('releaseRejectionField'),
  rejectionReason: document.getElementById('releaseRejectionReason'),
  dialogNotice: document.getElementById('releaseReviewNotice'),
  confirmDialog: document.getElementById('confirmReleaseReview')
};

const state = { masters: [], releases: [], printers: [], messages: [], review: null };

function selectedMaster() {
  return state.masters.find((master) => master.id === nodes.releaseMaster.value) || null;
}

function checkboxList(container, printers, dataName) {
  clear(container);
  container.appendChild(el('legend', { text: dataName === 'masterPrinter' ? 'Permitted printers' : 'Target printers' }));
  for (const printer of printers) {
    container.appendChild(el('label', { className: 'message-job-target-option' }, [
      el('input', { type: 'checkbox', value: printer.id, dataset: { [dataName]: printer.id } }),
      el('span', {}, [el('strong', { text: printer.name }), el('small', { text: printer.location || `${printer.host}:${printer.port}` })])
    ]));
  }
}

function renderMasterOptions() {
  clear(nodes.releaseMaster);
  for (const master of state.masters.filter((item) => item.enabled)) {
    nodes.releaseMaster.appendChild(el('option', { value: master.id, text: `${master.productCode} — ${master.displayName}` }));
  }
  renderReleasePrinters();
}

const FIELD_SOURCES = [
  ['run_code', 'Tracked product run (optional)'],
  ['brew_sheet_product', 'Brew-sheet product'],
  ['brew_number', 'Brew number'],
  ['batch_number', 'Batch number']
];

function defaultSource(field, index) {
  const text = `${field.key} ${field.label} ${field.printerFieldName}`.toLowerCase();
  if (text.includes('run')) return 'run_code';
  if (text.includes('batch')) return 'brew_sheet_product';
  if (text.includes('brew')) return 'brew_number';
  return FIELD_SOURCES[Math.min(index + 1, FIELD_SOURCES.length - 1)][0];
}

function renderMessageSummary() {
  const message = state.messages.find((item) => item.id === nodes.masterMessage.value);
  clear(nodes.masterFieldMappings);
  for (const [index, field] of (message?.fields || []).entries()) {
    const select = el('select', { required: 'required', dataset: { masterFieldKey: field.key } });
    for (const [value, label] of FIELD_SOURCES) select.appendChild(el('option', { value, text: label }));
    select.value = defaultSource(field, index);
    nodes.masterFieldMappings.appendChild(el('div', { className: 'master-field-row' }, [
      el('div', {}, [el('strong', { text: field.label }), el('small', { text: `${field.key} · printer field ${field.printerFieldName}` })]),
      select
    ]));
  }
  nodes.masterMessageSummary.textContent = message
    ? `${message.fields.length} message fields · ${message.dateRule?.months || '?'} month best before · ${message.previewLines.length} print lines`
    : 'Select a stored message to load its fields and print format.';
  if (message && !message.fields.length) {
    nodes.masterFieldMappings.appendChild(el('p', {
      className: 'no-message-fields',
      text: 'This message has no user fields. The product run is still reserved for traceability, but no field values will be sent.'
    }));
  }
}

function renderReleasePrinters() {
  const allowed = new Set(selectedMaster()?.specification?.printerIds || []);
  checkboxList(nodes.releasePrinters, state.printers.filter((printer) => allowed.has(printer.id) && printer.enabled), 'releasePrinter');
}

function statusTone(status) {
  if (['released', 'completed'].includes(status)) return 'good';
  if (['rejected', 'failed', 'cancelled'].includes(status)) return 'bad';
  if (status === 'pending_review') return 'stale';
  return 'neutral';
}

function fact(label, value) {
  return el('div', { className: 'release-fact' }, [el('span', { text: label }), el('strong', { text: value || '—' })]);
}

function canApprove(release) {
  const session = currentSession();
  if (!hasCapability('reviewBatchReleases') || release.status !== 'pending_review') return false;
  if (release.createdByUserId && session?.user?.id) return release.createdByUserId !== session.user.id;
  return release.createdByUsername.toLowerCase() !== String(session?.user?.username || '').toLowerCase();
}

function releaseActions(release) {
  const actions = [];
  if (hasCapability('createBatchReleases') && ['draft', 'rejected'].includes(release.status)) {
    actions.push(el('button', { className: 'secondary', type: 'button', dataset: { releaseAction: 'submit', releaseId: release.id }, text: 'Submit for review' }));
  }
  if (hasCapability('reviewBatchReleases') && release.status === 'pending_review') {
    actions.push(el('button', {
      className: 'primary', type: 'button', disabled: canApprove(release) ? null : 'disabled',
      title: canApprove(release) ? null : 'A different person must approve this release.',
      dataset: { releaseAction: 'review', releaseId: release.id }, text: 'Open independent review'
    }));
    actions.push(el('button', { className: 'ghost bordered', type: 'button', dataset: { releaseAction: 'reject', releaseId: release.id }, text: 'Reject' }));
  }
  return actions.length ? el('div', { className: 'actions release-row-actions' }, actions) : null;
}

function renderReleases() {
  clear(nodes.list);
  const query = nodes.search.value.trim().toLowerCase();
  const status = nodes.statusFilter.value;
  const releases = state.releases.filter((release) => {
    if (status && release.status !== status) return false;
    if (!query) return true;
    return [release.brewSheetProduct, release.brewNumber, release.batchNumber, release.runCode, release.createdByUsername]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
  nodes.draftCount.textContent = String(state.releases.filter((release) => release.status === 'draft').length);
  nodes.reviewCount.textContent = String(state.releases.filter((release) => release.status === 'pending_review').length);
  nodes.readyCount.textContent = String(state.releases.filter((release) => release.status === 'released').length);
  if (!releases.length) {
    nodes.list.appendChild(el('div', { className: 'release-empty' }, [el('strong', { text: 'No production releases yet' }), el('p', { className: 'muted', text: 'Create a draft to begin the controlled review process.' })]));
    return;
  }
  for (const release of releases) {
    const master = state.masters.find((item) => item.id === release.productMasterId);
    nodes.list.appendChild(el('article', { className: `release-row release-${release.status}` }, [
      el('div', { className: 'release-status-rail' }),
      el('div', { className: 'release-row-main' }, [
        el('div', { className: 'release-row-heading' }, [
          el('div', {}, [el('h4', { text: release.brewSheetProduct }), el('p', { text: `${master?.displayName || 'Product'} · ${new Date(release.plannedProductionAt).toLocaleString()}` })]),
          el('span', { className: `badge ${statusTone(release.status)}`, text: release.status.replaceAll('_', ' ').toUpperCase() })
        ]),
        el('div', { className: 'release-facts' }, [
          fact('Run', release.runCode || 'Reserved on approval'),
          fact('Brew', release.brewNumber),
          fact('Batch', release.batchNumber),
          fact('Printers', release.printerIds.map((id) => state.printers.find((printer) => printer.id === id)?.name || id).join(', '))
        ]),
        release.expectedOutput ? el('pre', { className: 'release-output', text: release.expectedOutput.rendered }) : null,
        release.rejectionReason ? el('p', { className: 'release-rejection', text: `Rejected: ${release.rejectionReason}` }) : null,
        el('div', { className: 'release-row-footer' }, [
          el('small', { text: `Created by ${release.createdByUsername} · Pinned master version ${release.productMasterVersion || '?'}` }),
          releaseActions(release)
        ])
      ])
    ]));
  }
}

async function createMaster(event) {
  event.preventDefault();
  const printerIds = [...nodes.masterPrinters.querySelectorAll('[data-master-printer]:checked')].map((input) => input.value);
  const fieldMappings = [...nodes.masterFieldMappings.querySelectorAll('[data-master-field-key]')]
    .map((select) => ({ fieldKey: select.dataset.masterFieldKey, source: select.value }));
  setNotice(nodes.notice, 'Creating immutable product master version...');
  try {
    await apiJson('/api/product-masters', { method: 'POST', body: {
      productCode: nodes.masterProductCode.value,
      displayName: nodes.masterDisplayName.value,
      nextRunNumber: Number(nodes.masterNextRun.value),
      specification: {
        runPrefix: nodes.masterRunPrefix.value,
        runWidth: Number(nodes.masterRunWidth.value),
        messageId: nodes.masterMessage.value,
        fieldMappings,
        printerIds
      }
    }});
    nodes.masterForm.reset();
    nodes.masterRunPrefix.value = 'T'; nodes.masterRunWidth.value = '4'; nodes.masterNextRun.value = '1';
    await loadReleaseWorkflow();
    nodes.formWorkspace.classList.add('hidden');
    setNotice(nodes.notice, 'Product master created. Its first specification version is now fixed.', 'success');
  } catch (error) { setNotice(nodes.notice, normalizeError(error), 'error'); }
}

async function createRelease(event) {
  event.preventDefault();
  const printerIds = [...nodes.releasePrinters.querySelectorAll('[data-release-printer]:checked')].map((input) => input.value);
  setNotice(nodes.notice, 'Saving draft release...');
  try {
    const data = await apiJson('/api/batch-releases', { method: 'POST', body: {
      productMasterId: nodes.releaseMaster.value,
      brewSheetProduct: nodes.releaseBrewProduct.value,
      brewNumber: nodes.releaseBrewNumber.value,
      batchNumber: nodes.releaseBatchNumber.value,
      plannedProductionAt: new Date(nodes.releaseProductionAt.value).toISOString(),
      printerIds,
      notes: nodes.releaseNotes.value
    }});
    state.releases.unshift(data.release);
    renderReleases();
    nodes.releaseForm.reset();
    setDefaultProductionTime(); renderMasterOptions();
    nodes.formWorkspace.classList.add('hidden');
    setNotice(nodes.notice, 'Draft saved. Submit it when the brew-sheet values are ready for independent review.', 'success');
  } catch (error) { setNotice(nodes.notice, normalizeError(error), 'error'); }
}

function openReview(release, mode) {
  state.review = { release, mode };
  const master = state.masters.find((item) => item.id === release.productMasterId);
  nodes.dialogTitle.textContent = mode === 'approve' ? 'Independent release review' : 'Reject production release';
  clear(nodes.dialogBody);
  nodes.dialogBody.append(
    el('div', { className: 'release-review-summary' }, [
      fact('Product', release.brewSheetProduct), fact('Pinned product master', `${master?.productCode || ''} · version ${release.productMasterVersion || '?'}`),
      fact('Brew number', release.brewNumber), fact('Batch number', release.batchNumber),
      fact('Planned production', new Date(release.plannedProductionAt).toLocaleString()), fact('Next run', `${master?.specification?.runPrefix || ''}${String(master?.nextRunNumber || '').padStart(master?.specification?.runWidth || 4, '0')} (reserved on approval)`)
    ]),
    el('div', { className: 'review-printer-list' }, [el('span', { text: 'Target printers' }), el('strong', { text: release.printerIds.map((id) => state.printers.find((printer) => printer.id === id)?.name || id).join(', ') })])
  );
  nodes.approvalAttestation.classList.toggle('hidden', mode !== 'approve');
  nodes.rejectionField.classList.toggle('hidden', mode !== 'reject');
  nodes.approvalCheck.checked = false; nodes.rejectionReason.value = '';
  nodes.confirmDialog.textContent = mode === 'approve' ? 'Approve and reserve run' : 'Reject release';
  nodes.confirmDialog.className = mode === 'approve' ? 'primary' : 'danger';
  setNotice(nodes.dialogNotice);
  nodes.dialog.showModal();
}

async function performReview() {
  const { release, mode } = state.review || {};
  if (!release) return;
  if (mode === 'approve' && !nodes.approvalCheck.checked) return setNotice(nodes.dialogNotice, 'Confirm the independent review before approving.', 'error');
  if (mode === 'reject' && !nodes.rejectionReason.value.trim()) return setNotice(nodes.dialogNotice, 'Enter a reason for rejection.', 'error');
  nodes.confirmDialog.disabled = true;
  try {
    await apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/${mode}`, { method: 'POST', body: mode === 'reject' ? { reason: nodes.rejectionReason.value } : {} });
    nodes.dialog.close();
    await loadReleaseWorkflow();
    setNotice(nodes.notice, mode === 'approve' ? 'Release approved and product run reserved.' : 'Release returned with a rejection reason.', 'success');
  } catch (error) { setNotice(nodes.dialogNotice, normalizeError(error), 'error'); }
  finally { nodes.confirmDialog.disabled = false; }
}

async function handleReleaseAction(button) {
  const release = state.releases.find((item) => item.id === button.dataset.releaseId);
  if (!release) return;
  if (button.dataset.releaseAction === 'review') return openReview(release, 'approve');
  if (button.dataset.releaseAction === 'reject') return openReview(release, 'reject');
  button.disabled = true;
  try {
    await apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/submit`, { method: 'POST', body: {} });
    await loadReleaseWorkflow();
    setNotice(nodes.notice, 'Release submitted for independent review.', 'success');
  } catch (error) { setNotice(nodes.notice, normalizeError(error), 'error'); }
  finally { button.disabled = false; }
}

function setDefaultProductionTime() {
  const next = new Date(Date.now() + 24 * 60 * 60 * 1000);
  next.setMinutes(0, 0, 0);
  const local = new Date(next.valueOf() - next.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  nodes.releaseProductionAt.value = local;
}

async function loadReleaseWorkflow() {
  const requests = [apiJson('/api/product-masters'), apiJson('/api/batch-releases?limit=100'), apiJson('/api/printers')];
  if (hasCapability('manageProductMasters')) requests.push(apiJson('/api/messages'));
  const [masters, releases, printers, messages = []] = await Promise.all(requests);
  state.masters = masters; state.releases = releases; state.printers = printers; state.messages = messages;
  nodes.openMaster.classList.toggle('hidden', !hasCapability('manageProductMasters'));
  nodes.openRelease.classList.toggle('hidden', !hasCapability('createBatchReleases'));
  checkboxList(nodes.masterPrinters, printers.filter((printer) => printer.enabled), 'masterPrinter');
  clear(nodes.masterMessage);
  for (const message of messages) nodes.masterMessage.appendChild(el('option', { value: message.id, text: message.displayName }));
  renderMessageSummary();
  renderMasterOptions(); renderReleases();
}

function setupReleaseWorkflow() {
  nodes.masterForm.addEventListener('submit', createMaster);
  nodes.releaseForm.addEventListener('submit', createRelease);
  nodes.releaseMaster.addEventListener('change', renderReleasePrinters);
  nodes.masterMessage.addEventListener('change', renderMessageSummary);
  nodes.search.addEventListener('input', renderReleases);
  nodes.statusFilter.addEventListener('change', renderReleases);
  nodes.openMaster.addEventListener('click', () => {
    nodes.formWorkspace.classList.remove('hidden');
    nodes.masterSection.classList.remove('hidden');
    nodes.releaseSection.classList.add('hidden');
    nodes.masterProductCode.focus();
  });
  nodes.openRelease.addEventListener('click', () => {
    nodes.formWorkspace.classList.remove('hidden');
    nodes.masterSection.classList.add('hidden');
    nodes.releaseSection.classList.remove('hidden');
    nodes.releaseMaster.focus();
  });
  nodes.refresh.addEventListener('click', async (event) => { event.preventDefault(); try { await loadReleaseWorkflow(); setNotice(nodes.notice); } catch (error) { setNotice(nodes.notice, normalizeError(error), 'error'); } });
  nodes.list.addEventListener('click', (event) => { const button = event.target.closest('[data-release-action]'); if (button) handleReleaseAction(button); });
  nodes.closeDialog.addEventListener('click', () => nodes.dialog.close());
  nodes.cancelDialog.addEventListener('click', () => nodes.dialog.close());
  nodes.confirmDialog.addEventListener('click', performReview);
  window.addEventListener('messages-saved', () => loadReleaseWorkflow().catch((error) => setNotice(nodes.notice, normalizeError(error), 'error')));
  setDefaultProductionTime();
}

export { loadReleaseWorkflow, setupReleaseWorkflow };
