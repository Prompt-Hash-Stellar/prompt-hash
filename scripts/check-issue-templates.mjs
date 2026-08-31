#!/usr/bin/env node
/**
 * check-issue-templates.mjs
 *
 * CI + local verifier for the canonical hard-issue template and the
 * domain verification rubric (closes #237).
 *
 * The verifier checks that every promise made in `.github/ISSUE_TEMPLATE/`
 * resolves to a real file in the repository, that the rubric's domains are
 * unique, and that the contributor guide actually points contributors at the
 * template. Failures exit non-zero so CI gates on them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = path.join(ROOT, '.github', 'ISSUE_TEMPLATE');
const TEMPLATE_FILE = path.join(TEMPLATE_DIR, 'hard-issue.yml');
const CONTRIBUTING = path.join(ROOT, 'CONTRIBUTING.md');

const REQUIRED_TEMPLATE_FILES = [
  '.github/ISSUE_TEMPLATE/hard-issue.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
];

/**
 * Extract the domain names listed in the Verification Rubric section of a
 * contributor-facing markdown document.
 *
 * A domain line looks like a level-4 heading whose text starts with the
 * domain name followed by a colon, e.g. `#### Frontend / UI:`. Returns an
 * empty array for documents that do not contain a rubric.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractRubricDomains(markdown) {
  const lines = String(markdown).split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase().startsWith('## verification rubric'));
  if (start === -1) return [];

  const domains = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    // Stop at the next same-level or shallower heading (the next section).
    if (/^#{1,3}\s/.test(trimmed)) break;
    // Domain headings end with a colon, but the colon is optional so a
    // reviewer can trim the document without breaking the check.
    const match = /^####\s+([^#][^:]*?)\s*:?\s*$/.exec(trimmed);
    if (match) domains.push(match[1].trim());
  }
  return domains;
}

function readUtf8(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function relativeToRoot(filePath) {
  return path.relative(ROOT, filePath);
}

function collectReferences(markdown) {
  const refs = new Set();
  const fence = /`((?:\.github|docs)\/[^\s`]+?)`/g;
  let match;
  while ((match = fence.exec(markdown)) !== null) {
    const ref = match[1].replace(/[,;.)]+$/, '');
    if (ref.endsWith('/')) continue;
    if (/^(https?:)?\/\//.test(ref)) continue;
    refs.add(ref);
  }
  return refs;
}

function check() {
  const failures = [];

  // 1. Template directory and required files
  if (!fs.existsSync(TEMPLATE_DIR)) {
    failures.push('.github/ISSUE_TEMPLATE/ directory is missing');
  }
  for (const ref of REQUIRED_TEMPLATE_FILES) {
    if (!fs.existsSync(path.join(ROOT, ref))) {
      failures.push(`required template file is missing: ${ref}`);
    }
  }

  const template = readUtf8(TEMPLATE_FILE);
  if (template === null) {
    failures.push('could not read .github/ISSUE_TEMPLATE/hard-issue.yml');
  } else {
    // 2. YAML shape
    const requiredKeys = ['name', 'description', 'labels', 'title', 'body'];
    for (const key of requiredKeys) {
      if (!new RegExp(`^${key}:\\s`, 'm').test(template)) {
        failures.push(`hard-issue.yml is missing top-level key: ${key}`);
      }
    }

    // 3. Every referenced repository file must exist
    for (const ref of collectReferences(template)) {
      if (!fs.existsSync(path.join(ROOT, ref))) {
        failures.push(`hard-issue.yml references a file that does not exist: ${ref}`);
      }
    }
  }

  // 4. Rubric domains must be unique
  const rubric = readUtf8(path.join(ROOT, 'docs', 'contributor-guide.md'));
  if (rubric === null) {
    failures.push('docs/contributor-guide.md is missing');
  } else {
    const domains = extractRubricDomains(rubric);
    if (domains.length < 3) {
      failures.push(`docs/contributor-guide.md rubric should define at least 3 domains, found ${domains.length}`);
    }
    const seen = new Map();
    domains.forEach((domain, index) => {
      const normalized = domain.toLowerCase();
      if (seen.has(normalized)) {
        failures.push(`duplicate rubric domain "${domain}" at lines ${seen.get(normalized)} and ${index}`);
      } else {
        seen.set(normalized, index);
      }
    });
    const expected = ['Frontend / UI', 'API / Server', 'Contracts / Chain logic', 'Documentation / Tooling', 'Security'];
    for (const name of expected) {
      if (!domains.some((domain) => domain.toLowerCase() === name.toLowerCase())) {
        failures.push(`docs/contributor-guide.md rubric is missing domain: ${name}`);
      }
    }
  }

  // 5. Contributor guide must point at the template
  const contributing = readUtf8(CONTRIBUTING);
  if (contributing === null) {
    failures.push('CONTRIBUTING.md is missing');
  } else if (!contributing.includes('.github/ISSUE_TEMPLATE/hard-issue.yml')) {
    failures.push('CONTRIBUTING.md does not reference .github/ISSUE_TEMPLATE/hard-issue.yml');
  }

  if (failures.length > 0) {
    console.error('Issue template verification failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    return false;
  }

  const domains = extractRubricDomains(readUtf8(path.join(ROOT, 'docs', 'contributor-guide.md')) ?? '');
  const refCount = template === null ? 0 : collectReferences(template).size;
  console.log(`Issue templates verified: ${REQUIRED_TEMPLATE_FILES.length} template files, ${refCount} referenced files, ${domains.length} rubric domains`);
  return true;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(check() ? 0 : 1);
}
