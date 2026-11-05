import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the release loop-breaker.
 *
 * On this fork `release.yml` pushes the `chore(release)` commit with the
 * built-in `GITHUB_TOKEN`, whose pushes start no workflow run. That exemption
 * does not hold for a GitHub App installation token — the identity upstream
 * needs to get past a ruleset on `main`, and the one this fork would need if it
 * ever adds one. With such a token the only thing stopping every release from
 * re-triggering Release (and Mutation testing's full-scope job) is the
 * `[skip ci]` marker in the `@semantic-release/git` commit message template.
 *
 * Nothing else would catch its removal. The release itself would still succeed,
 * just pay for a duplicate pipeline on every version, with the cause several
 * files away from the symptom. Hence this assertion. Release identity and its
 * prerequisites: `docs/release-automation.md` (Admin prerequisites).
 */

const rc = JSON.parse(readFileSync(new URL('../../.releaserc.json', import.meta.url), 'utf8')) as {
  plugins: unknown[];
};

const gitPluginConfig = rc.plugins.find(
  (p): p is [string, Record<string, unknown>] =>
    Array.isArray(p) && p[0] === '@semantic-release/git',
)?.[1];

describe('.releaserc.json @semantic-release/git', () => {
  it('configures a commit message template', () => {
    expect(gitPluginConfig).toBeDefined();
    expect(typeof gitPluginConfig?.message).toBe('string');
  });

  it('keeps [skip ci] in the literal part of the message, ahead of the release notes', () => {
    const message = gitPluginConfig?.message as string;
    // GitHub accepts the marker anywhere in the commit message, but only the
    // text before `${nextRelease.notes}` is authored here — the notes are
    // generated per release and cannot be relied on to carry it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matches the literal semantic-release placeholder ${nextRelease.notes}
    const literalPrefix = message.split('${nextRelease.notes}')[0];
    expect(literalPrefix).toContain('[skip ci]');
  });
});
