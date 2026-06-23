import crypto from 'node:crypto';
import { getDb } from '../db.js';

const PRODUCT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,29}$/;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,29}$/;
const PACKAGING_CATEGORIES = new Set(['cans', 'bottles']);

function normalizePackagingCategory(value, fallback = 'cans') {
  const category = String(value || fallback).trim().toLowerCase();
  if (!PACKAGING_CATEGORIES.has(category)) throw new Error('Packaging category must be cans or bottles.');
  return category;
}

function actorRecord(actor = {}) {
  return {
    userId: actor.developmentIdentity ? null : (actor.id || null),
    username: actor.username || null
  };
}

function normalizeSpecification(input = {}) {
  const runPrefix = String(input.runPrefix ?? 'T').trim().toUpperCase();
  const runWidth = Number(input.runWidth ?? 4);
  const bestBeforeMonths = Number(input.bestBeforeMonths ?? 12);
  const bestBeforeDays = Number(input.bestBeforeDays ?? 0);
  const defaultBrewSheetProduct = String(input.defaultBrewSheetProduct || '').trim().toUpperCase();
  const requestedConfigurations = Array.isArray(input.printerConfigurations) ? input.printerConfigurations : [];
  const printerConfigurations = requestedConfigurations.map((configuration) => ({
    printerId: String(configuration.printerId || '').trim(),
    messageId: String(configuration.messageId || '').trim(),
    fieldMappings: (Array.isArray(configuration.fieldMappings) ? configuration.fieldMappings : [])
      .map((mapping) => ({
        fieldKey: String(mapping.fieldKey || '').trim(),
        source: String(mapping.source || '').trim()
      })),
    dateRule: configuration.dateRule || input.dateRule || { type: 'offset-months', months: bestBeforeMonths, format: 'DD/MM/YYYY' },
    timeRule: configuration.timeRule || input.timeRule || { type: 'production-time', format: 'HH:mm:ss' },
    previewLines: (configuration.previewLines || input.previewLines || [
      input.firstLineTemplate || '{{run}}{{batch}}',
      input.secondLineTemplate || 'BBD: {{bestBeforeDate}} {{productionTime}}'
    ]).filter(Boolean).map(String)
  }));
  const printerIds = printerConfigurations.map((configuration) => configuration.printerId);
  const primary = printerConfigurations[0] || {};
  if (!runPrefix || runPrefix.length > 10 || !/^[\x20-\x7E]+$/.test(runPrefix)) throw new Error('Run prefix must be 1-10 printable characters.');
  if (!Number.isInteger(runWidth) || runWidth < 1 || runWidth > 8) throw new Error('Run width must be between 1 and 8 digits.');
  if (!Number.isInteger(bestBeforeMonths) || bestBeforeMonths < 0 || bestBeforeMonths > 120) throw new Error('Best-before months must be between 0 and 120.');
  if (!Number.isInteger(bestBeforeDays) || bestBeforeDays < 0 || bestBeforeDays > 3650) throw new Error('Best-before days must be between 0 and 3650.');
  if (defaultBrewSheetProduct.length > 50) throw new Error('Default brew-sheet product must be at most 50 characters.');
  if (printerConfigurations.some((configuration) => !configuration.printerId || !configuration.messageId)) throw new Error('Every permitted printer requires a stored message.');
  if (printerConfigurations.some((configuration) => configuration.fieldMappings.some((mapping) => !FIELD_KEY_PATTERN.test(mapping.fieldKey)))) throw new Error('Message field mappings are invalid.');
  if (new Set(printerIds).size !== printerIds.length) throw new Error('Each printer can appear only once in a product master.');
  if (!printerIds.length) throw new Error('Select at least one permitted printer.');
  return {
    runPrefix,
    runWidth,
    bestBeforeMonths,
    bestBeforeDays,
    defaultBrewSheetProduct,
    fieldMappings: primary.fieldMappings,
    messageId: primary.messageId,
    printerIds,
    printerConfigurations,
    dateRule: primary.dateRule || input.dateRule || { type: 'offset-months', months: bestBeforeMonths, format: 'DD/MM/YYYY' },
    timeRule: primary.timeRule || input.timeRule || { type: 'production-time', format: 'HH:mm:ss' },
    previewLines: primary.previewLines?.length
      ? primary.previewLines
      : [String(input.firstLineTemplate || '{{run}}{{batch}}'), String(input.secondLineTemplate || 'BBD: {{bestBeforeDate}} {{productionTime}}')],
    firstLineTemplate: String(input.firstLineTemplate || '{{run}}{{batch}}'),
    secondLineTemplate: String(input.secondLineTemplate || 'BBD: {{bestBeforeDate}} {{productionTime}}')
  };
}

function versionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    productMasterId: row.product_master_id,
    version: row.version,
    specification: JSON.parse(row.specification_json),
    createdByUserId: row.created_by_user_id || null,
    createdByUsername: row.created_by_username || null,
    createdAt: row.created_at
  };
}

function masterFromRow(row, db) {
  if (!row) return null;
  const version = versionFromRow(db.prepare(`
    SELECT * FROM product_master_versions WHERE product_master_id = ? AND version = ?
  `).get(row.id, row.current_version));
  return {
    id: row.id,
    productCode: row.product_code,
    displayName: row.display_name,
    packagingCategory: row.packaging_category,
    enabled: Boolean(row.enabled),
    currentVersion: row.current_version,
    nextRunNumber: row.next_run_number,
    specification: version?.specification || null,
    version,
    createdByUserId: row.created_by_user_id || null,
    createdByUsername: row.created_by_username || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getProductMaster(id, db = getDb()) {
  return masterFromRow(db.prepare('SELECT * FROM product_masters WHERE id = ?').get(id), db);
}

function listProductMasters({ enabledOnly = false, packagingCategory = '' } = {}, db = getDb()) {
  const where = [];
  const params = [];
  if (enabledOnly) where.push('enabled = 1');
  if (packagingCategory) {
    where.push('packaging_category = ?');
    params.push(normalizePackagingCategory(packagingCategory));
  }
  const rows = db.prepare(`SELECT * FROM product_masters ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY packaging_category, display_name COLLATE NOCASE`).all(...params);
  return rows.map((row) => masterFromRow(row, db));
}

function createProductMaster(input, actor = {}, db = getDb()) {
  const productCode = String(input.productCode || '').trim().toUpperCase();
  const displayName = String(input.displayName || '').trim();
  const nextRunNumber = Number(input.nextRunNumber ?? 1);
  const packagingCategory = normalizePackagingCategory(input.packagingCategory);
  if (!PRODUCT_CODE_PATTERN.test(productCode)) throw new Error('Product code must be 2-30 letters, numbers, dots, hyphens or underscores.');
  if (!displayName || displayName.length > 100) throw new Error('Display name must be 1-100 characters.');
  if (!Number.isInteger(nextRunNumber) || nextRunNumber < 1) throw new Error('Next run number must be a positive integer.');
  const specification = normalizeSpecification(input.specification);
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const creator = actorRecord(actor);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO product_masters (
        id, product_code, display_name, packaging_category, enabled, current_version, next_run_number,
        created_by_user_id, created_by_username, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(id, productCode, displayName, packagingCategory, input.enabled === false ? 0 : 1, nextRunNumber, creator.userId, creator.username, now, now);
    db.prepare(`
      INSERT INTO product_master_versions (
        id, product_master_id, version, specification_json, created_by_user_id, created_by_username, created_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)
    `).run(versionId, id, JSON.stringify(specification), creator.userId, creator.username, now);
  })();
  return getProductMaster(id, db);
}

function updateProductMaster(id, input, actor = {}, db = getDb()) {
  const current = getProductMaster(id, db);
  if (!current) return null;
  const displayName = String(input.displayName ?? current.displayName).trim();
  const packagingCategory = normalizePackagingCategory(input.packagingCategory, current.packagingCategory);
  if (!displayName || displayName.length > 100) throw new Error('Display name must be 1-100 characters.');
  const specification = normalizeSpecification(input.specification || current.specification);
  const nextRunNumber = Number(input.nextRunNumber ?? current.nextRunNumber);
  if (!Number.isInteger(nextRunNumber) || nextRunNumber < 1) throw new Error('Next run number must be a positive integer.');
  const nextVersion = current.currentVersion + 1;
  const now = new Date().toISOString();
  const creator = actorRecord(actor);
  db.transaction(() => {
    db.prepare('UPDATE product_masters SET display_name = ?, packaging_category = ?, enabled = ?, current_version = ?, next_run_number = ?, updated_at = ? WHERE id = ?')
      .run(displayName, packagingCategory, (input.enabled ?? current.enabled) ? 1 : 0, nextVersion, nextRunNumber, now, id);
    db.prepare(`
      INSERT INTO product_master_versions (
        id, product_master_id, version, specification_json, created_by_user_id, created_by_username, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), id, nextVersion, JSON.stringify(specification), creator.userId, creator.username, now);
  })();
  return getProductMaster(id, db);
}

export { createProductMaster, getProductMaster, listProductMasters, normalizeSpecification, updateProductMaster };
