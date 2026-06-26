import { appUrl, formatDateTime, valueOrDash } from './common.js';

function releasePendingReviewEmail(payload, config = {}) {
  const { release = {}, actor = {} } = payload;
  const product = release.brewSheetProduct || release.id || 'Release';
  const url = appUrl(config.baseUrl, `/production-releases?release=${encodeURIComponent(release.id || '')}`);
  return {
    subject: `Release needs approval: ${product}`,
    text: [
      'A production coding release needs independent approval.',
      '',
      `Product: ${product}`,
      `Brew: ${valueOrDash(release.brewNumber)}`,
      `Planned production: ${formatDateTime(release.plannedProductionAt)}`,
      `Submitted by: ${actor.displayName || actor.username || release.createdByUsername || '-'}`,
      `Release: ${url}`,
      '',
      'Open the Production Coding Releases page to review, approve, reject or return it for correction.'
    ].join('\n')
  };
}

export { releasePendingReviewEmail };
