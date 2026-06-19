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
  releaseTitle: document.getElementById('batchReleaseTitle'),
  releaseHelp: document.getElementById('batchReleaseHelp'),
  releaseForm: document.getElementById('batchReleaseForm'),
  releaseMaster: document.getElementById('releaseProductMaster'),
  releaseBrewProduct: document.getElementById('releaseBrewProduct'),
  releaseBrewNumber: document.getElementById('releaseBrewNumber'),
  releaseBatchNumber: document.getElementById('releaseBatchNumber'),
  releaseProductionAt: document.getElementById('releaseProductionAt'),
  releasePrinters: document.getElementById('releasePrinters'),
  releaseNotes: document.getElementById('releaseNotes'),
  saveRelease: document.getElementById('saveBatchRelease'),
  cancelReleaseEdit: document.getElementById('cancelBatchReleaseEdit'),
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

const state = {
  masters: [], releases: [], printers: [], messages: [], review: null, reviewHeartbeat: null,
  presenceSweep: null, editingReleaseId: null, openAuditId: null, audits: new Map()
};

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

function reviewClaimMine(release) {
  const claim = release.reviewClaim;
  const user = currentSession()?.user;
  if (!claim || !user) return false;
  if (claim.claimedByUserId && user.id) return claim.claimedByUserId === user.id;
  return claim.claimedByUsername.toLowerCase() === String(user.username || '').toLowerCase();
}

function releaseActions(release) {
  const actions = [];
  if (hasCapability('createBatchReleases') && ['draft', 'rejected'].includes(release.status)) {
    actions.push(el('button', { className: 'ghost bordered', type: 'button', dataset: { releaseAction: 'edit', releaseId: release.id }, text: 'Edit' }));
  }
  if (hasCapability('createBatchReleases') && release.status === 'draft') {
    actions.push(el('button', { className: 'secondary', type: 'button', dataset: { releaseAction: 'submit', releaseId: release.id }, text: 'Submit for review' }));
  }
  if (hasCapability('reviewBatchReleases') && release.status === 'pending_review') {
    const claimedByOther = release.reviewClaim && !reviewClaimMine(release);
    actions.push(el('button', {
      className: 'primary', type: 'button', disabled: canApprove(release) && !claimedByOther ? null : 'disabled',
      title: claimedByOther ? `${release.reviewClaim.claimedByUsername} is reviewing this release.` : (canApprove(release) ? null : 'A different person must approve this release.'),
      dataset: { releaseAction: 'review', releaseId: release.id }, text: 'Open independent review'
    }));
    actions.push(el('button', {
      className: 'ghost bordered', type: 'button', disabled: claimedByOther ? 'disabled' : null,
      title: claimedByOther ? `${release.reviewClaim.claimedByUsername} is reviewing this release.` : null,
      dataset: { releaseAction: 'reject', releaseId: release.id }, text: 'Reject'
    }));
  }
  actions.push(el('button', { className: 'ghost bordered', type: 'button', dataset: { releaseAction: 'history', releaseId: release.id }, text: state.openAuditId === release.id ? 'Hide history' : 'History' }));
  return actions.length ? el('div', { className: 'actions release-row-actions' }, actions) : null;
}

function auditLabel(action) {
  return String(action || 'event').replace(/^batch-release-/, '').replaceAll('-', ' ');
}

function releaseAudit(release) {
  if (state.openAuditId !== release.id) return null;
  const events = state.audits.get(release.id);
  if (!events) return el('section', { className: 'release-audit' }, [el('p', { className: 'muted', text: 'Loading release history...' })]);
  if (!events.length) return el('section', { className: 'release-audit' }, [el('p', { className: 'muted', text: 'No recorded changes for this release.' })]);
  return el('section', { className: 'release-audit' }, [
    el('h5', { text: 'Release history' }),
    el('ol', { className: 'release-audit-list' }, events.map((event) => el('li', {}, [
      el('span', { className: 'release-audit-marker' }),
      el('div', {}, [
        el('strong', { text: auditLabel(event.action) }),
        el('p', { text: `${event.actorUsername || 'System'} · ${new Date(event.occurredAt).toLocaleString()}` }),
        event.details?.reason ? el('small', { text: `Reason: ${event.details.reason}` }) : null,
        event.details?.previousStatus ? el('small', { text: `${event.details.previousStatus.replaceAll('_', ' ')} → ${event.details.status.replaceAll('_', ' ')}` }) : null
      ])
    ])))
  ]);
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
        release.reviewClaim ? el('p', {
          className: `release-presence ${reviewClaimMine(release) ? 'mine' : ''}`,
          text: reviewClaimMine(release) ? 'You are reviewing this release now' : `${release.reviewClaim.claimedByUsername} is reviewing this release now`
        }) : null,
        release.rejectionReason ? el('p', { className: 'release-rejection', text: `Rejected: ${release.rejectionReason}` }) : null,
        el('div', { className: 'release-row-footer' }, [
          el('small', { text: `Created by ${release.createdByUsername} · Pinned master version ${release.productMasterVersion || '?'}` }),
          releaseActions(release)
        ]),
        releaseAudit(release)
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
  const editing = Boolean(state.editingReleaseId);
  setNotice(nodes.notice, editing ? 'Saving release changes...' : 'Saving draft release...');
  try {
    const data = await apiJson(editing ? `/api/batch-releases/${encodeURIComponent(state.editingReleaseId)}` : '/api/batch-releases', { method: editing ? 'PUT' : 'POST', body: {
      productMasterId: nodes.releaseMaster.value,
      brewSheetProduct: nodes.releaseBrewProduct.value,
      brewNumber: nodes.releaseBrewNumber.value,
      batchNumber: nodes.releaseBatchNumber.value,
      plannedProductionAt: new Date(nodes.releaseProductionAt.value).toISOString(),
      printerIds,
      notes: nodes.releaseNotes.value
    }});
    await loadReleaseWorkflow();
    resetReleaseForm();
    nodes.formWorkspace.classList.add('hidden');
    setNotice(nodes.notice, editing ? 'Changes saved as a draft. It can now be submitted for review again.' : 'Draft saved. Submit it when the brew-sheet values are ready for independent review.', 'success');
  } catch (error) { setNotice(nodes.notice, normalizeError(error), 'error'); }
}

function localDateTime(value) {
  const date = new Date(value);
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function resetReleaseForm() {
  state.editingReleaseId = null;
  nodes.releaseForm.reset();
  nodes.releaseMaster.disabled = false;
  nodes.releaseTitle.textContent = 'New batch release';
  nodes.releaseHelp.textContent = 'Run numbers are reserved only after independent approval.';
  nodes.saveRelease.textContent = 'Save draft';
  nodes.cancelReleaseEdit.classList.add('hidden');
  setDefaultProductionTime();
  renderMasterOptions();
}

function editRelease(release) {
  state.editingReleaseId = release.id;
  nodes.formWorkspace.classList.remove('hidden');
  nodes.masterSection.classList.add('hidden');
  nodes.releaseSection.classList.remove('hidden');
  nodes.releaseTitle.textContent = release.status === 'rejected' ? 'Correct rejected release' : 'Edit draft release';
  nodes.releaseHelp.textContent = release.status === 'rejected'
    ? `Review feedback: ${release.rejectionReason}`
    : 'Update the draft values before submitting for independent review.';
  nodes.releaseMaster.value = release.productMasterId;
  nodes.releaseMaster.disabled = true;
  nodes.releaseBrewProduct.value = release.brewSheetProduct;
  nodes.releaseBrewNumber.value = release.brewNumber || '';
  nodes.releaseBatchNumber.value = release.batchNumber || '';
  nodes.releaseProductionAt.value = localDateTime(release.plannedProductionAt);
  nodes.releaseNotes.value = release.notes || '';
  renderReleasePrinters();
  for (const input of nodes.releasePrinters.querySelectorAll('[data-release-printer]')) input.checked = release.printerIds.includes(input.value);
  nodes.saveRelease.textContent = 'Save changes';
  nodes.cancelReleaseEdit.classList.remove('hidden');
  nodes.releaseBrewProduct.focus();
  nodes.releaseSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function toggleReleaseAudit(release) {
  if (state.openAuditId === release.id) {
    state.openAuditId = null;
    renderReleases();
    return;
  }
  state.openAuditId = release.id;
  renderReleases();
  try {
    state.audits.set(release.id, await apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/audit`));
  } catch (error) {
    state.audits.set(release.id, [{ action: 'history-error', actorUsername: normalizeError(error), occurredAt: new Date().toISOString(), details: {} }]);
  }
  renderReleases();
}

async function openReview(release, mode) {
  try {
    const result = await apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/review-claim`, { method: 'POST', body: {} });
    Object.assign(release, result.release);
  } catch (error) {
    if (error.data?.reviewClaim) release.reviewClaim = error.data.reviewClaim;
    renderReleases();
    setNotice(nodes.notice, normalizeError(error), 'error');
    return;
  }
  state.review = { release, mode };
  window.clearInterval(state.reviewHeartbeat);
  state.reviewHeartbeat = window.setInterval(async () => {
    try {
      const result = await apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/review-claim`, { method: 'POST', body: {}, timeoutMs: 10000 });
      Object.assign(release, result.release);
      renderReleases();
    } catch (error) {
      setNotice(nodes.dialogNotice, `Review presence could not be renewed: ${normalizeError(error)}`, 'error');
    }
  }, 15000);
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
  renderReleases();
}

function stopReviewClaim(releaseOnServer = true) {
  window.clearInterval(state.reviewHeartbeat);
  state.reviewHeartbeat = null;
  const release = state.review?.release;
  state.review = null;
  if (!release) return;
  release.reviewClaim = null;
  renderReleases();
  if (releaseOnServer) {
    apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/review-claim`, { method: 'DELETE' }).catch(() => {});
  }
}

async function performReview() {
  const { release, mode } = state.review || {};
  if (!release) return;
  if (mode === 'approve' && !nodes.approvalCheck.checked) return setNotice(nodes.dialogNotice, 'Confirm the independent review before approving.', 'error');
  if (mode === 'reject' && !nodes.rejectionReason.value.trim()) return setNotice(nodes.dialogNotice, 'Enter a reason for rejection.', 'error');
  nodes.confirmDialog.disabled = true;
  try {
    await apiJson(`/api/batch-releases/${encodeURIComponent(release.id)}/${mode}`, { method: 'POST', body: mode === 'reject' ? { reason: nodes.rejectionReason.value } : {} });
    stopReviewClaim(false);
    nodes.dialog.close();
    await loadReleaseWorkflow();
    setNotice(nodes.notice, mode === 'approve' ? 'Release approved and product run reserved.' : 'Release returned with a rejection reason.', 'success');
  } catch (error) { setNotice(nodes.dialogNotice, normalizeError(error), 'error'); }
  finally { nodes.confirmDialog.disabled = false; }
}

async function handleReleaseAction(button) {
  const release = state.releases.find((item) => item.id === button.dataset.releaseId);
  if (!release) return;
  if (button.dataset.releaseAction === 'edit') return editRelease(release);
  if (button.dataset.releaseAction === 'history') return toggleReleaseAudit(release);
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

function applyReleasePresence(payload) {
  const release = state.releases.find((item) => item.id === payload?.releaseId);
  if (!release) return;
  release.reviewClaim = payload.reviewClaim || null;
  if (payload.status) release.status = payload.status;
  if (state.review?.release.id === release.id && release.reviewClaim && !reviewClaimMine(release)) {
    const claimedBy = release.reviewClaim.claimedByUsername;
    stopReviewClaim(false);
    if (nodes.dialog.open) nodes.dialog.close();
    setNotice(nodes.notice, `${claimedBy} is now reviewing this release.`, 'error');
    return;
  }
  renderReleases();
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
    resetReleaseForm();
    nodes.formWorkspace.classList.remove('hidden');
    nodes.masterSection.classList.add('hidden');
    nodes.releaseSection.classList.remove('hidden');
    nodes.releaseMaster.focus();
  });
  nodes.cancelReleaseEdit.addEventListener('click', () => {
    resetReleaseForm();
    nodes.formWorkspace.classList.add('hidden');
  });
  nodes.refresh.addEventListener('click', async (event) => { event.preventDefault(); try { await loadReleaseWorkflow(); setNotice(nodes.notice); } catch (error) { setNotice(nodes.notice, normalizeError(error), 'error'); } });
  nodes.list.addEventListener('click', (event) => { const button = event.target.closest('[data-release-action]'); if (button) handleReleaseAction(button); });
  nodes.closeDialog.addEventListener('click', () => { stopReviewClaim(); nodes.dialog.close(); });
  nodes.cancelDialog.addEventListener('click', () => { stopReviewClaim(); nodes.dialog.close(); });
  nodes.dialog.addEventListener('cancel', () => stopReviewClaim());
  nodes.confirmDialog.addEventListener('click', performReview);
  window.addEventListener('messages-saved', () => loadReleaseWorkflow().catch((error) => setNotice(nodes.notice, normalizeError(error), 'error')));
  window.clearInterval(state.presenceSweep);
  state.presenceSweep = window.setInterval(() => {
    let changed = false;
    for (const release of state.releases) {
      if (release.reviewClaim && new Date(release.reviewClaim.expiresAt).valueOf() <= Date.now()) {
        release.reviewClaim = null;
        changed = true;
      }
    }
    if (changed) renderReleases();
  }, 5000);
  setDefaultProductionTime();
}

export { applyReleasePresence, loadReleaseWorkflow, setupReleaseWorkflow };
