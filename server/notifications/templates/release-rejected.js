import { appUrl, escapeHtml, formatDateTime, valueOrDash } from './common.js';

function releaseRejectedEmail(payload, config = {}) {
  const { release = {}, actor = {} } = payload;
  const product = release.brewSheetProduct || release.id || 'Release';
  const url = appUrl(config.baseUrl, `/production-releases?release=${encodeURIComponent(release.id || '')}`);
  const subject = `Release rejected: ${product}`;
  const planned = formatDateTime(release.plannedProductionAt);
  const rejectedBy = actor.displayName || actor.username || release.reviewedByUsername || '-';
  return {
    subject,
    text: [
      'A production coding release was rejected during independent review.',
      '',
      `Product: ${product}`,
      `Brew: ${valueOrDash(release.brewNumber)}`,
      `Planned production: ${planned}`,
      `Rejected by: ${rejectedBy}`,
      `Reason: ${valueOrDash(release.rejectionReason)}`,
      `Release: ${url}`,
      '',
      'Open the Production Coding Releases page to correct the release and resubmit it for review.'
    ].join('\n'),
    html: `
      <p>A production coding release was rejected during independent review.</p>

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
          <td><strong>Rejected by:</strong></td>
          <td>${escapeHtml(rejectedBy)}</td>
        </tr>
        <tr>
          <td><strong>Reason:</strong></td>
          <td>${escapeHtml(valueOrDash(release.rejectionReason))}</td>
        </tr>
        <tr>
          <td><strong>Release:</strong></td>
          <td><a href="${escapeHtml(url)}">Open release</a></td>
        </tr>
      </table>

      <p>
        Please open the Production Coding Releases page to correct this release
        and resubmit it for review.
      </p>
    `
  };
}

export { releaseRejectedEmail };
