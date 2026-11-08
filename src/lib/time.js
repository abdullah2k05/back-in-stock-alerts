'use strict';

const nowIso = () => new Date().toISOString();

function truncate(value, max = 500) {
  const str = String(value ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

module.exports = { nowIso, truncate };
