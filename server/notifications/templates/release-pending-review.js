import { appUrl, escapeHtml, formatDateTime, valueOrDash } from './common.js';

function releasePendingReviewEmail(payload, config = {}) {
  const { release = {}, actor = {} } = payload;
  const product = release.brewSheetProduct || release.id || 'Release';
  const url = appUrl(config.baseUrl, `/production-releases?release=${encodeURIComponent(release.id || '')}`);
  const subject = 'Production coding release approval required';
  const submittedBy = actor.displayName || actor.username || release.createdByUsername || '-';
  const planned = formatDateTime(release.plannedProductionAt);
  return {
    subject,
    text: [
      'A production coding release needs independent approval.',
      '',
      `Product: ${product}`,
      `Brew: ${valueOrDash(release.brewNumber)}`,
      `Planned production: ${planned}`,
      `Submitted by: ${submittedBy}`,
      `Release: ${url}`,
      '',
      'Open the Production Coding Releases page to review, approve, reject or return it for correction.'
    ].join('\n'),
    html: `
      <p>A production coding release needs independent approval.</p>

      <table cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
        <tr>
          <td><strong>Product:</strong></td>
          <td>${escapeHtml(product)}</td>
        </tr>
        <tr>
          <td><strong>Brew:</strong></td>
          <td>${escapeHtml(valueOrDash(release.brewNumber))}</td>
        </tr>
        <tr>
          <td><strong>Planned production:</strong></td>
          <td>${escapeHtml(planned)}</td>
        </tr>
        <tr>
          <td><strong>Submitted by:</strong></td>
          <td>${escapeHtml(submittedBy)}</td>
        </tr>
        <tr>
          <td><strong>Release:</strong></td>
          <td><a href="${escapeHtml(url)}">Open release</a></td>
        </tr>
      </table>

      <p>
        Please open the Production Coding Releases page to review this release and
        either approve, reject, or return it for correction.
      </p>
    `
  };
}

export { releasePendingReviewEmail };
