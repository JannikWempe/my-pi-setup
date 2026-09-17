import assert from "node:assert/strict";
import test from "node:test";
import {
  categorizeSkillsSection,
  extractModelInvocableSkillNames,
} from "./index.ts";

class FakeExpandableText {
  readonly children = undefined;
  readonly collapsed: string;
  readonly expanded: string;
  text: string;
  skillCategoriesApplied?: boolean;

  constructor(collapsed: string, expanded: string, expandedInitially = false) {
    this.collapsed = collapsed;
    this.expanded = expanded;
    this.text = expandedInitially ? expanded : collapsed;
  }

  getCollapsedText() {
    return this.collapsed;
  }

  getExpandedText() {
    return this.expanded;
  }

  setExpanded(expanded: boolean) {
    this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
  }

  setText(text: string) {
    this.text = text;
  }

  invalidate() {}

  render() {
    return this.text.split("\n");
  }
}

test("extracts only model-invocable skills from the system prompt", () => {
  const names = extractModelInvocableSkillNames(`
    <available_skills>
      <skill><name>debugging</name></skill>
      <skill><name>research</name></skill>
    </available_skills>
  `);

  assert.deepEqual([...names], ["debugging", "research"]);
});

test("splits the startup skill list and keeps expanded path details", () => {
  const skills = new FakeExpandableText(
    "[Skills]\n  debugging, handoff, research",
    "[Skills]\n  [User]\n    ~/.pi/agent/skills/debugging/SKILL.md\n    ~/.pi/agent/skills/handoff/SKILL.md",
  );
  const root = {
    children: [skills],
    invalidate() {},
    render() {
      return [];
    },
  };

  assert.equal(
    categorizeSkillsSection(
      root,
      new Set(["debugging", "research"]),
      (text) => `<label>${text}</label>`,
      (text) => `<value>${text}</value>`,
    ),
    true,
  );
  assert.equal(
    skills.text,
    "[Skills]\n  <label>model-invocable</label>  <value>debugging, research</value>\n  <label>user-only</label>        <value>handoff</value>",
  );

  skills.setExpanded(true);
  assert.match(skills.text, /<label>model-invocable<\/label>/);
  assert.match(skills.text, /<label>user-only<\/label>/);
  assert.match(skills.text, /<value>handoff<\/value>/);
  assert.match(skills.text, /~\/\.pi\/agent\/skills\/handoff\/SKILL\.md/);
});
