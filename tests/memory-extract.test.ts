import { describe, expect, it } from 'vitest';
import { MAX_FACTS_PER_REPLY, extractMemorySection } from '../src/server/actions/memory-extract.js';

describe('extractMemorySection', () => {
  it('returns the text unchanged when there is no memory section', () => {
    const text = '# Review\n\nAll good.\n\n## Risks\n\n- none';
    expect(extractMemorySection(text)).toEqual({ text, facts: [] });
  });

  it('captures labeled bullets and strips the section from the deliverable', () => {
    const result = extractMemorySection([
      '# Plan',
      '',
      'Step one, step two.',
      '',
      '## Memory',
      '',
      '- user-prefers-dark-mode: The user asked for dark mode twice in this mission.',
      '- lens-data-source: Lens specs come from the panasonic-lens-site JSON.',
    ].join('\n'));

    expect(result.text).toBe('# Plan\n\nStep one, step two.');
    expect(result.facts).toHaveLength(2);
    expect(result.facts[0]).toEqual({
      slug: 'user-prefers-dark-mode',
      description: 'The user asked for dark mode twice in this mission.',
      body: 'The user asked for dark mode twice in this mission.',
    });
  });

  it('derives a slug for bare bullets', () => {
    const result = extractMemorySection('Answer.\n\n## Memory\n- Always ship single file HTML pages here.');
    expect(result.facts[0]?.slug).toBe('always-ship-single-file-html-pages');
  });

  it('caps the number of captured facts per reply', () => {
    const bullets = Array.from({ length: 6 }, (_, i) => `- fact-${i}: detail ${i}`).join('\n');
    const result = extractMemorySection(`Body.\n\n## Memory\n${bullets}`);
    expect(result.facts).toHaveLength(MAX_FACTS_PER_REPLY);
  });

  it('does not strip a mid-document "## Memory" chapter followed by more headings', () => {
    const text = '# Doc\n\n## Memory\n\nAbout memory subsystems.\n\n## API\n\nDetails.';
    expect(extractMemorySection(text)).toEqual({ text, facts: [] });
  });

  it('ignores an empty memory section', () => {
    const result = extractMemorySection('Body.\n\n## Memory\n\n');
    expect(result.facts).toEqual([]);
    expect(result.text).toBe('Body.');
  });
});
