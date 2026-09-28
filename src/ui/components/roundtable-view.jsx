'use client';
/* ============================================================================
   Minimal timeline driver for the roundtable scene — play / pause / scrub the
   24s golden-path meeting. A thin stand-in for app.jsx's useScene until the
   full app shell is ported.
   ============================================================================ */
import React from 'react';
import { RT } from '../lib/rt';
import { RoundtableScene, sceneAt } from './roundtable';

const { useState, useEffect, useRef } = React;

const ctrlBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 14px',
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

export default function RoundtableView() {
  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(true);
  const raf = useRef(0);
  const last = useRef(0);

  useEffect(() => {
    if (!playing) return undefined;
    last.current = performance.now();
    const loop = (now) => {
      const dt = now - last.current;
      last.current = now;
      setClock((c) => (c + dt >= RT.SCENE_DURATION ? 0 : c + dt)); // loop the demo
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);

  const scene = sceneAt(clock);
  const noop = () => {};

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div
        style={{
          position: 'relative',
          height: 600,
          borderRadius: 'var(--r-card)',
          overflow: 'hidden',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        <RoundtableScene
          agents={RT.AGENTS}
          scene={scene}
          memberIds={RT.WORKBENCH.members}
          wide={false}
          onOpenArtifact={noop}
          onAction={noop}
          onOpenBreakouts={noop}
          onSeatClick={noop}
          onOpenFiles={noop}
          onZoomWhiteboard={noop}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button style={ctrlBtn} onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          style={ctrlBtn}
          onClick={() => {
            setClock(0);
            setPlaying(true);
          }}
        >
          Replay
        </button>
        <input
          type="range"
          min={0}
          max={RT.SCENE_DURATION}
          value={clock}
          onChange={(e) => {
            setPlaying(false);
            setClock(Number(e.target.value));
          }}
          style={{ flex: 1 }}
        />
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 48, textAlign: 'right' }}>
          {(clock / 1000).toFixed(1)}s
        </span>
      </div>
    </div>
  );
}
