import { appUrl, formatDateTime, notificationHtml, valueOrDash } from './common.js';

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
    html: notificationHtml({
      title: subject,
      intro: 'A production coding release was rejected during independent review.',
      rows: [
        { label: 'Product', value: product },
        { label: 'Brew', value: release.brewNumber },
        { label: 'Planned production', value: planned },
        { label: 'Rejected by', value: rejectedBy },
        { label: 'Reason', value: release.rejectionReason }
      ],
      actionUrl: url,
      actionLabel: 'Correct release',
      tone: 'warning'
    })
  };
}

export { releaseRejectedEmail };
