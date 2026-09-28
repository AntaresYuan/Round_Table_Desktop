'use client';
/* ============================================================================
   Batch-1 component gallery — renders the golden-path "main table" cards from
   fixtures (mock data) to prove the ported components build + render in Next.
   This is a verification surface, not the final scene (app.jsx) — that lands
   in the next porting increment.
   ============================================================================ */
import React from 'react';
import { RT } from '../lib/rt';
import { TodoListCard, ArtifactRenderer, HandoffCard, BreakoutChip } from './cards';
import RoundtableView from './roundtable-view';

// Show the parallel-running hero state: T1 ∥ T2 running, T3 waiting.
const demoPlan = {
  ...RT.PLAN,
  tasks: RT.PLAN.tasks.map((t) =>
    t.id === 'T3' ? { ...t, status: 'pending' } : { ...t, status: 'running' },
  ),
};

function GallerySection({ title, children }) {
  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <h2
        className="mono"
        style={{
          fontSize: 12,
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: 'var(--text-faint)',
          margin: 0,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function Gallery() {
  const agents = RT.AGENTS;
  const breakout = RT.SCRIPT.find((b) => b.kind === 'breakout');

  return (
    <main
      style={{
        maxWidth: 680,
        margin: '0 auto',
        padding: '48px 24px 96px',
        display: 'grid',
        gap: 32,
        background: 'var(--bg)',
        minHeight: '100vh',
      }}
    >
      <header style={{ display: 'grid', gap: 6 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Roundtable — batch 1</h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14 }}>
          Golden-path cards rendered from fixtures. The main table.
        </p>
      </header>

      <GallerySection title="The roundtable — main table · 24s golden path">
        <RoundtableView />
      </GallerySection>

      <GallerySection title="Live TodoList (parallel)">
        <TodoListCard plan={demoPlan} agents={agents} />
      </GallerySection>

      <GallerySection title="Artifacts — file / diff / preview">
        <ArtifactRenderer art={RT.ARTIFACTS.landing} agents={agents} />
        <ArtifactRenderer art={RT.ARTIFACTS.api} agents={agents} />
        <ArtifactRenderer art={RT.ARTIFACTS.diff} agents={agents} />
        <ArtifactRenderer art={RT.ARTIFACTS.preview} agents={agents} />
      </GallerySection>

      <GallerySection title="HandoffCard">
        <HandoffCard ho={RT.HANDOFF} agents={agents} />
      </GallerySection>

      {breakout && (
        <GallerySection title="Breakout entry (a door, not a toggle)">
          <BreakoutChip data={breakout} agents={agents} />
        </GallerySection>
      )}
    </main>
  );
}
