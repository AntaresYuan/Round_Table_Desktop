/*
  Parses the optional `## Memory` section a chat-model agent appends to its
  reply. Chat agents have no filesystem, so this is their only write path into
  the memory store: the section is stripped from the deliverable text and each
  bullet becomes a candidate fact for writeProjectFact.

  Pure text-in/text-out — no IO — so the grammar is trivially testable.
*/

import { memorySlug } from './agent-memory.js';

export type ExtractedMemoryFact = {
  slug: string;
  description: string;
  body: string;
};

export type MemoryExtraction = {
  // The reply with the memory section removed; unchanged when none was found.
  text: string;
  facts: ExtractedMemoryFact[];
};

// One reply may contribute at most this many facts — memory is for durable
// lessons, not a second transcript.
export const MAX_FACTS_PER_REPLY = 3;

export function extractMemorySection(text: string): MemoryExtraction {
  const match = text.match(/(?:^|\n)##\s+Memory\s*\n([\s\S]*)$/i);
  if (!match || match.index === undefined) return { text, facts: [] };
  const section = match[1] ?? '';
  // Only a TRAILING section is memory; a "## Memory" chapter followed by more
  // headings is document content and must not be stripped.
  if (/(?:^|\n)##\s+/.test(section)) return { text, facts: [] };

  const facts = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => parseBullet(line.replace(/^[-*]\s+/, '')))
    .filter((fact): fact is ExtractedMemoryFact => fact !== null)
    .slice(0, MAX_FACTS_PER_REPLY);
  return {
    text: text.slice(0, match.index).trimEnd(),
    facts,
  };
}

// Bullet grammar: `slug-name: the fact` — or a bare fact, whose slug is
// derived from its first words.
function parseBullet(content: string): ExtractedMemoryFact | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const labeled = trimmed.match(/^([a-z0-9][a-z0-9-]{1,47}):\s+(.+)$/is);
  const slugSource = labeled?.[1] ?? trimmed;
  const body = (labeled?.[2] ?? trimmed).trim();
  if (!body) return null;
  const slug = memorySlug(slugSource.split(/\s+/).slice(0, 6).join('-'), 48);
  if (!slug) return null;
  return {
    slug,
    description: body.replace(/\s+/g, ' ').slice(0, 120),
    body,
  };
}
