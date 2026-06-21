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
  masterRegister: document.getElementById('productMasterRegister'),
  masterSearch: document.getElementById('productMasterSearch'),
  masterList: document.getElementById('productMasterList'),
  formWorkspace: document.getElementById('releaseFormWorkspace'),
  masterSection: document.getElementById('productMasterSection'),
  masterTitle: document.getElementById('productMasterTitle'),
  masterForm: document.getElementById('productMasterForm'),
  masterProductCode: document.getElementById('masterProductCode'),
  masterDisplayName: document.getElementById('masterDisplayName'),
  masterNextRun: document.getElementById('masterNextRun'),
  masterRunPrefix: document.getElementById('masterRunPrefix'),
  masterRunWidth: document.getElementById('masterRunWidth'),
  masterEnabled: document.getElementById('masterEnabled'),
  masterPrinterConfigurations: document.getElementById('masterPrinterConfigurations'),
  cancelMaster: document.getElementById('cancelProductMasterEdit'),
  saveMaster: document.getElementById('saveProductMaster'),
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
  presenceSweep: null, editingMasterId: null, editingReleaseId: null, openAuditId: null, audits: new Map()
};

function selectedMaster() {
  return state.masters.find((master) => master.id === nodes.releaseMaster.value) || null;
}

function checkboxList(container, printers, dataName) {
  clear(container);
  container.appendChild(el('legend', { text: 'Target printers' }));
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

function renderConfiguredLines(configuration, sourceValues) {
  const values = { bestBeforeDate: sourceValues.bestBeforeDate, currentTime: sourceValues.productionTime, productionTime: sourceValues.productionTime };
  for (const mapping of configuration.fieldMappings || []) values[mapping.fieldKey] = sourceValues[mapping.source] || '';
  return (configuration.previewLines || []).map((line) => line.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, key) => values[key] ?? `[${key}]`));
}

function pad2(value) { return String(value).padStart(2, '0'); }

function releasePreviewValues(configuration, release) {
  const production = new Date(release.plannedProductionAt);
  const bestBefore = new Date(production.valueOf());
  const day = bestBefore.getUTCDate();
  bestBefore.setUTCDate(1);
  bestBefore.setUTCMonth(bestBefore.getUTCMonth() + Number(configuration.dateRule?.months || 0));
  bestBefore.setUTCDate(Math.min(day, new Date(Date.UTC(bestBefore.getUTCFullYear(), bestBefore.getUTCMonth() + 1, 0)).getUTCDate()));
  const dateValues = { DD: pad2(bestBefore.getUTCDate()), MM: pad2(bestBefore.getUTCMonth() + 1), YYYY: String(bestBefore.getUTCFullYear()), YY: String(bestBefore.getUTCFullYear()).slice(-2) };
  const bestBeforeDate = (configuration.dateRule?.format || 'DD/MM/YYYY').replace(/YYYY|YY|DD|MM/g, (token) => dateValues[token]);
  const hour = production.getUTCHours();
  const timeFormat = configuration.timeRule?.format || 'HH:mm:ss';
  const productionTime = timeFormat === 'HH:mm'
    ? `${pad2(hour)}:${pad2(production.getUTCMinutes())}`
    : timeFormat === 'hh:mm A'
      ? `${pad2(hour % 12 || 12)}:${pad2(production.getUTCMinutes())} ${hour >= 12 ? 'PM' : 'AM'}`
      : `${pad2(hour)}:${pad2(production.getUTCMinutes())}:${pad2(production.getUTCSeconds())}`;
  return {
    run_code: release.runCode || '[assigned when sent]',
    brew_sheet_product: release.brewSheetProduct,
    brew_number: release.brewNumber || '',
    batch_number: release.batchNumber || '',
    bestBeforeDate,
    productionTime
  };
}

function messagesForPrinter(printerId) {
  return state.messages.filter((message) => (message.printerAssignments || [])
    .some((assignment) => assignment.printerId === printerId && assignment.enabled));
}

function renderPrinterMappings(card, message, mappings = []) {
  const summary = card.querySelector('[data-master-message-summary]');
  const container = card.querySelector('[data-master-field-mappings]');
  const preview = card.querySelector('[data-master-expected-preview]');
  clear(container);
  summary.textContent = message
    ? `${message.fields.length} fields · ${message.dateRule?.months ?? 0} month offset · ${message.previewLines.length} print lines`
    : 'Select a message assigned to this printer.';
  for (const [index, field] of (message?.fields || []).entries()) {
    const select = el('select', { required: 'required', dataset: { masterFieldKey: field.key } });
    for (const [value, label] of FIELD_SOURCES) select.appendChild(el('option', { value, text: label }));
    select.value = mappings.find((mapping) => mapping.fieldKey === field.key)?.source || defaultSource(field, index);
    container.appendChild(el('div', { className: 'master-field-row' }, [
      el('div', {}, [el('strong', { text: field.label }), el('small', { text: `${field.printerFieldName} · {{${field.key}}}` })]),
      select
    ]));
  }
  if (message && !message.fields.length) container.appendChild(el('p', {
    className: 'no-message-fields', text: 'No user fields. This printer will receive only the stored message selection.'
  }));
  const configuration = {
    fieldMappings: [...container.querySelectorAll('[data-master-field-key]')]
      .map((select) => ({ fieldKey: select.dataset.masterFieldKey, source: select.value })),
    previewLines: message?.previewLines || []
  };
  preview.textContent = message ? renderConfiguredLines(configuration, {
    run_code: '[Tracked product run]', brew_sheet_product: '[Brew-sheet product]', brew_number: '[Brew number]',
    batch_number: '[Batch number]', bestBeforeDate: `[Date +${message.dateRule?.months ?? 0} months]`, productionTime: '[Production time]'
  }).join('\n') : 'Select a message to preview its expected print.';
}

function renderMasterPrinterConfigurations(master = null) {
  clear(nodes.masterPrinterConfigurations);
  const configurations = master?.specification?.printerConfigurations || [];
  const configuredPrinterIds = new Set(configurations.map((configuration) => configuration.printerId));
  for (const printer of state.printers.filter((item) => item.enabled || configuredPrinterIds.has(item.id))) {
    const existing = configurations.find((configuration) => configuration.printerId === printer.id);
    const available = messagesForPrinter(printer.id);
    const enabled = Boolean(existing);
    const checkbox = el('input', { type: 'checkbox', checked: enabled ? 'checked' : null, dataset: { masterPrinterEnabled: printer.id } });
    const select = el('select', { dataset: { masterPrinterMessage: printer.id }, disabled: enabled ? null : 'disabled' });
    select.appendChild(el('option', { value: '', text: available.length ? 'Select stored message' : 'No assigned messages available' }));
    for (const message of available) {
      const assignment = message.printerAssignments.find((item) => item.printerId === printer.id);
      select.appendChild(el('option', { value: message.id, text: `${message.displayName} · ${assignment.printerMessageName}` }));
    }
    if (existing?.messageId && !available.some((message) => message.id === existing.messageId)) {
      const existingMessage = state.messages.find((message) => message.id === existing.messageId);
      select.appendChild(el('option', { value: existing.messageId, text: `${existingMessage?.displayName || existing.messageId} · unavailable for this printer` }));
    }
    select.value = existing?.messageId || '';
    const card = el('article', { className: `master-printer-card${enabled ? ' enabled' : ''}`, dataset: { masterPrinterCard: printer.id } }, [
      el('div', { className: 'master-printer-card-heading' }, [
        el('label', { className: 'checkbox-line' }, [checkbox, el('span', {}, [el('strong', { text: printer.name }), el('small', { text: printer.location || `${printer.host}:${printer.port}` })])]),
        el('span', { className: 'master-printer-state', text: enabled ? 'Included' : 'Not used' })
      ]),
      el('label', {}, [el('span', { text: 'Stored message for this printer' }), select]),
      el('div', { className: 'master-message-summary', dataset: { masterMessageSummary: printer.id } }),
      el('div', { className: 'master-field-mappings', dataset: { masterFieldMappings: printer.id } }),
      el('div', { className: 'master-config-preview' }, [el('span', { text: 'Parsed expected print' }), el('pre', { dataset: { masterExpectedPreview: printer.id } })])
    ]);
    nodes.masterPrinterConfigurations.appendChild(card);
    renderPrinterMappings(card, state.messages.find((message) => message.id === select.value), existing?.fieldMappings || []);
  }
}

function masterPrinterSummary(master) {
  const configurations = master.specification?.printerConfigurations || [];
  return configurations.map((configuration) => {
    const printer = state.printers.find((item) => item.id === configuration.printerId);
    const message = state.messages.find((item) => item.id === configuration.messageId);
    return `${printer?.name || configuration.printerId}: ${message?.displayName || configuration.messageId}`;
  }).join(' · ');
}

function printerRequirement(configuration, release) {
  const printer = state.printers.find((item) => item.id === configuration.printerId);
  const message = state.messages.find((item) => item.id === configuration.messageId);
  const sources = Object.fromEntries(FIELD_SOURCES);
  return el('article', { className: 'review-printer-requirement' }, [
    el('div', {}, [
      el('strong', { text: printer?.name || configuration.printerId }),
      el('span', { text: message?.displayName || configuration.messageId })
    ]),
    el('pre', { text: renderConfiguredLines(configuration, releasePreviewValues(configuration, release)).join('\n') }),
    configuration.fieldMappings?.length ? el('small', {
      text: configuration.fieldMappings.map((mapping) => `${mapping.fieldKey}: ${sources[mapping.source] || mapping.source}`).join(' · ')
    }) : el('small', { text: 'No user fields' })
  ]);
}

function renderMasterRegister() {
  clear(nodes.masterList);
  const query = nodes.masterSearch.value.trim().toLowerCase();
  const masters = state.masters.filter((master) => [master.productCode, master.displayName, masterPrinterSummary(master)]
    .some((value) => String(value || '').toLowerCase().includes(query)));
  if (!masters.length) {
    nodes.masterList.appendChild(el('div', { className: 'release-empty' }, [
      el('strong', { text: query ? 'No matching product masters' : 'No product masters yet' }),
      el('p', { className: 'muted', text: query ? 'Try another product or printer name.' : 'Create the first versioned coding specification.' })
    ]));
    return;
  }
  for (const master of masters) {
    nodes.masterList.appendChild(el('article', { className: 'master-register-row' }, [
      el('div', { className: 'master-register-main' }, [
        el('div', {}, [el('h4', { text: master.productCode }), el('p', { text: master.displayName })]),
        el('div', { className: 'master-register-meta' }, [
          el('span', { text: `Version ${master.currentVersion}` }), el('span', { text: `Next run ${master.nextRunNumber}` }),
          el('span', { className: `badge ${master.enabled ? 'good' : 'neutral'}`, text: master.enabled ? 'Enabled' : 'Disabled' })
        ]),
        el('small', { text: masterPrinterSummary(master) || 'No printer configuration' })
      ]),
      el('button', { className: 'ghost bordered', type: 'button', dataset: { masterAction: 'edit', masterId: master.id }, text: 'Edit master' })
    ]));
  }
}

function renderReleasePrinters() {
  const allowed = new Set(selectedMaster()?.specification?.printerIds || []);
  checkboxList(nodes.releasePrinters, state.printers.filter((printer) => allowed.has(printer.id) && printer.enabled), 'releasePrinter');
}

function statusTone(status) {
  if (['released', 'running', 'completed'].includes(status)) return 'good';
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
          fact('Run', release.runCode || 'Assigned automatically when sent'),
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
  const printerConfigurations = [...nodes.masterPrinterConfigurations.querySelectorAll('[data-master-printer-card]')]
    .filter((card) => card.querySelector('[data-master-printer-enabled]').checked)
    .map((card) => ({
      printerId: card.dataset.masterPrinterCard,
      messageId: card.querySelector('[data-master-printer-message]').value,
      fieldMappings: [...card.querySelectorAll('[data-master-field-key]')]
        .map((select) => ({ fieldKey: select.dataset.masterFieldKey, source: select.value }))
    }));
  const editing = Boolean(state.editingMasterId);
  setNotice(nodes.notice, editing ? 'Creating a new immutable master version...' : 'Creating the first immutable master version...');
  try {
    if (!printerConfigurations.length) throw new Error('Include at least one printer and select its stored message.');
    if (printerConfigurations.some((configuration) => !configuration.messageId)) throw new Error('Every included printer needs a stored message.');
    await apiJson(editing ? `/api/product-masters/${encodeURIComponent(state.editingMasterId)}` : '/api/product-masters', { method: editing ? 'PUT' : 'POST', body: {
      productCode: nodes.masterProductCode.value,
      displayName: nodes.masterDisplayName.value,
      nextRunNumber: Number(nodes.masterNextRun.value),
      enabled: nodes.masterEnabled.checked,
      specification: {
        runPrefix: nodes.masterRunPrefix.value,
        runWidth: Number(nodes.masterRunWidth.value),
        printerConfigurations
      }
    }});
    await loadReleaseWorkflow();
    resetMasterForm();
    setNotice(nodes.notice, editing ? 'Product master updated as a new permanent version.' : 'Product master created. Its first specification version is now fixed.', 'success');
  } catch (error) { setNotice(nodes.notice, normalizeError(error), 'error'); }
}

function resetMasterForm({ hide = true } = {}) {
  state.editingMasterId = null;
  nodes.masterForm.reset();
  nodes.masterTitle.textContent = 'New product master';
  nodes.masterProductCode.readOnly = false;
  nodes.masterRunPrefix.value = 'T';
  nodes.masterRunWidth.value = '4';
  nodes.masterNextRun.value = '1';
  nodes.masterEnabled.checked = true;
  nodes.saveMaster.textContent = 'Create product master';
  renderMasterPrinterConfigurations();
  if (hide) {
    nodes.masterSection.classList.add('hidden');
    if (nodes.releaseSection.classList.contains('hidden')) nodes.formWorkspace.classList.add('hidden');
  }
}

function editMaster(master) {
  state.editingMasterId = master.id;
  nodes.formWorkspace.classList.remove('hidden');
  nodes.masterSection.classList.remove('hidden');
  nodes.releaseSection.classList.add('hidden');
  nodes.masterTitle.textContent = `Edit ${master.productCode}`;
  nodes.masterProductCode.value = master.productCode;
  nodes.masterProductCode.readOnly = true;
  nodes.masterDisplayName.value = master.displayName;
  nodes.masterNextRun.value = String(master.nextRunNumber);
  nodes.masterRunPrefix.value = master.specification.runPrefix;
  nodes.masterRunWidth.value = String(master.specification.runWidth);
  nodes.masterEnabled.checked = master.enabled;
  nodes.saveMaster.textContent = 'Create new master version';
  renderMasterPrinterConfigurations(master);
  nodes.masterDisplayName.focus();
  nodes.masterSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  nodes.releaseHelp.textContent = 'The product run is assigned automatically when the operator sends the approved release.';
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
      fact('Planned production', new Date(release.plannedProductionAt).toLocaleString()), fact('Tracked run', release.runCode || 'Assigned automatically when the operator sends it')
    ]),
    el('div', { className: 'review-printer-list' }, [el('span', { text: 'Target printers' }), el('strong', { text: release.printerIds.map((id) => state.printers.find((printer) => printer.id === id)?.name || id).join(', ') })]),
    el('section', { className: 'review-printer-requirements' }, [
      el('h3', { text: 'Approved coding requirement by printer' }),
      ...(release.productMasterSpecification?.printerConfigurations || [])
        .filter((configuration) => release.printerIds.includes(configuration.printerId))
        .map((configuration) => printerRequirement(configuration, release))
    ])
  );
  nodes.approvalAttestation.classList.toggle('hidden', mode !== 'approve');
  nodes.rejectionField.classList.toggle('hidden', mode !== 'reject');
  nodes.approvalCheck.checked = false; nodes.rejectionReason.value = '';
  nodes.confirmDialog.textContent = mode === 'approve' ? 'Approve release' : 'Reject release';
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
    setNotice(nodes.notice, mode === 'approve' ? 'Release approved. Its product run will be assigned automatically when it is sent.' : 'Release returned with a rejection reason.', 'success');
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
  nodes.masterRegister.classList.toggle('hidden', !hasCapability('manageProductMasters'));
  nodes.openRelease.classList.toggle('hidden', !hasCapability('createBatchReleases'));
  renderMasterPrinterConfigurations(state.masters.find((master) => master.id === state.editingMasterId));
  renderMasterRegister(); renderMasterOptions(); renderReleases();
}

function setupReleaseWorkflow() {
  nodes.masterForm.addEventListener('submit', createMaster);
  nodes.releaseForm.addEventListener('submit', createRelease);
  nodes.releaseMaster.addEventListener('change', renderReleasePrinters);
  nodes.masterSearch.addEventListener('input', renderMasterRegister);
  nodes.masterList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-master-action="edit"]');
    const master = state.masters.find((item) => item.id === button?.dataset.masterId);
    if (master) editMaster(master);
  });
  nodes.masterPrinterConfigurations.addEventListener('change', (event) => {
    const card = event.target.closest('[data-master-printer-card]');
    if (!card) return;
    if (event.target.matches('[data-master-printer-enabled]')) {
      const enabled = event.target.checked;
      card.classList.toggle('enabled', enabled);
      card.querySelector('.master-printer-state').textContent = enabled ? 'Included' : 'Not used';
      card.querySelector('[data-master-printer-message]').disabled = !enabled;
    }
    if (event.target.matches('[data-master-printer-message]')) {
      renderPrinterMappings(card, state.messages.find((message) => message.id === event.target.value));
    }
    if (event.target.matches('[data-master-field-key]')) {
      const mappings = [...card.querySelectorAll('[data-master-field-key]')]
        .map((select) => ({ fieldKey: select.dataset.masterFieldKey, source: select.value }));
      const messageId = card.querySelector('[data-master-printer-message]').value;
      renderPrinterMappings(card, state.messages.find((message) => message.id === messageId), mappings);
    }
  });
  nodes.search.addEventListener('input', renderReleases);
  nodes.statusFilter.addEventListener('change', renderReleases);
  nodes.openMaster.addEventListener('click', () => {
    resetMasterForm({ hide: false });
    nodes.formWorkspace.classList.remove('hidden');
    nodes.masterSection.classList.remove('hidden');
    nodes.releaseSection.classList.add('hidden');
    nodes.masterProductCode.focus();
  });
  nodes.cancelMaster.addEventListener('click', () => resetMasterForm());
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
