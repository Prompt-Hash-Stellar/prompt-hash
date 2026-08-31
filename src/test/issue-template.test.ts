import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractRubricDomains } from "../../scripts/check-issue-templates.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readRepoFile = (relativePath: string) =>
  readFileSync(resolve(REPO_ROOT, relativePath), "utf8");

const GUIDE = readRepoFile("docs/contributor-guide.md");
const HARD_TEMPLATE = readRepoFile(".github/ISSUE_TEMPLATE/hard-issue.yml");
const CONTRIBUTING = readRepoFile("CONTRIBUTING.md");

describe("hard issue template and verification rubric (#237)", () => {
  describe("extractRubricDomains", () => {
    it("returns the five rubric domains in order", () => {
      expect(extractRubricDomains(GUIDE)).toEqual([
        "Frontend / UI",
        "API / Server",
        "Contracts / Chain logic",
        "Documentation / Tooling",
        "Security",
      ]);
    });

    it("does not pick up headings outside the rubric section", () => {
      const domains = extractRubricDomains(GUIDE);
      expect(domains).not.toContain("Maintainer Review Checklist");
      expect(domains).not.toContain("Verification Rubric");
    });

    it("returns an empty list when there is no rubric section", () => {
      expect(extractRubricDomains("# No rubric here\n\nJust prose.\n")).toEqual([]);
    });

    it("stops at the next same-level section heading", () => {
      const doc = ["## Verification Rubric", "#### Alpha", "## Next Section", "#### Beta", ""].join("\n");
      expect(extractRubricDomains(doc)).toEqual(["Alpha"]);
    });

    it("accepts the optional trailing colon", () => {
      const doc = ["## Verification Rubric", "#### With Colon:", "#### No Colon", ""].join("\n");
      expect(extractRubricDomains(doc)).toEqual(["With Colon", "No Colon"]);
    });

    it("ignores lines that are not domain headings", () => {
      const doc = [
        "## Verification Rubric",
        "Some prose.",
        "#### Not a domain",
        "#### Real one:",
        "",
      ].join("\n");
      expect(extractRubricDomains(doc)).toEqual(["Not a domain", "Real one"]);
    });
  });

  describe("rubric content", () => {
    it("gives every domain unique headings", () => {
      const domains = extractRubricDomains(GUIDE);
      expect(new Set(domains.map((d) => d.toLowerCase())).size).toBe(domains.length);
    });

    it("defines at least three domains", () => {
      expect(extractRubricDomains(GUIDE).length).toBeGreaterThanOrEqual(3);
    });

    it("covers the five domains the template expects", () => {
      const domains = extractRubricDomains(GUIDE).map((d) => d.toLowerCase());
      for (const name of ["frontend / ui", "api / server", "contracts / chain logic", "documentation / tooling", "security"]) {
        expect(domains).toContain(name);
      }
    });
  });

  describe("hard-issue template", () => {
    it("asks for problem, scope, acceptance criteria, and test expectations", () => {
      for (const id of ["problem", "scope", "acceptance", "tests"]) {
        expect(HARD_TEMPLATE).toContain(`id: ${id}`);
      }
    });

    it("makes the reward review requirement explicit", () => {
      expect(HARD_TEMPLATE).toContain("id: reward");
      expect(HARD_TEMPLATE).toContain("label: Reward review requirement");
    });

    it("requires the domain and complexity fields", () => {
      expect(HARD_TEMPLATE).toContain("id: domain");
      expect(HARD_TEMPLATE).toContain("id: complexity");
    });

    it("declares the help wanted and hard task labels", () => {
      expect(HARD_TEMPLATE).toContain('"help wanted"');
      expect(HARD_TEMPLATE).toContain('"hard task"');
    });
  });

  describe("contributor guide wiring", () => {
    it("points contributors at the hard issue template", () => {
      expect(CONTRIBUTING).toContain(".github/ISSUE_TEMPLATE/hard-issue.yml");
    });

    it("points contributors at the rubric document", () => {
      expect(CONTRIBUTING).toContain("docs/contributor-guide.md");
    });

    it("names the verifier that runs in CI", () => {
      expect(CONTRIBUTING).toContain("scripts/check-issue-templates.mjs");
    });
  });
});
