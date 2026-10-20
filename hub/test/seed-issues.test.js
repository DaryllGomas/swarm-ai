// The seed issues in docs/SEED-ISSUES.md must pass the same screen as any issue text: none may be held.
import { describe, it, expect } from 'vitest';
import seed from '../../docs/SEED-ISSUES.md?raw';
import { makeScreen } from '../src/screen.js';

const issues = seed.split(/\n---\n/).map((c) => c.trim()).filter((c) => /^## \d+\./m.test(c));

describe('docs/SEED-ISSUES.md', () => {
  it('has 10 to 15 issues, each with a title, a size label and a body', () => {
    expect(issues.length).toBeGreaterThanOrEqual(10);
    expect(issues.length).toBeLessThanOrEqual(15);
    for (const c of issues) {
      expect(c).toMatch(/^## \d+\. .{8,}/m);
      expect(c).toMatch(/Size: `swarm:(1|3|8)`/);
      for (const part of ['Goal:', 'Acceptance criteria:', 'Output format:', 'Out of scope:']) expect(c).toContain(part);
    }
  });

  it('none would be held by the screen, and none has a link or a handle', () => {
    for (const c of issues) {
      const title = /^## \d+\. (.+)$/m.exec(c)[1];
      const body = c.slice(c.indexOf('Body:') + 5);
      const sc = makeScreen();
      sc.t(title, 120); sc.t(body, 3000);
      expect(sc.reason, title).toBe('');
      expect(body, title).not.toMatch(/https?:\/\/|@\w/);
    }
  });
});
