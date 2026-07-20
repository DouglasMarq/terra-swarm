import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {COLORS} from '../theme';
import {FadeIn} from '../components/FadeIn';

const FEATURES = [
  {label: 'Workspaces', sub: 'one folder, one swarm', color: COLORS.accent},
  {label: 'Agent grid', sub: 'claude · codex · opencode · kimi', color: '#d97757'},
  {label: 'Session resume', sub: 'pick up where agents left off', color: '#60a5fa'},
  {label: 'Voice input', sub: 'offline Whisper into any terminal', color: '#a78bfa'},
  {label: 'Notifications', sub: 'know when an agent needs you', color: '#f472b6'},
  {label: 'Keyboard-first', sub: 'every shortcut remappable', color: '#facc15'},
];

export const Features: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();

  const fadeOut = interpolate(
    frame,
    [durationInFrames - 0.4 * fps, durationInFrames - 1],
    [1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        background:
          'radial-gradient(1200px 700px at 50% 40%, #141a26 0%, #0b0e14 65%)',
      }}
    >
      <div
        style={{
          opacity: fadeOut,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 56,
        }}
      >
      <FadeIn>
        <div
          style={{
            color: COLORS.text,
            fontSize: 64,
            fontWeight: 800,
            letterSpacing: 2,
            textAlign: 'center',
          }}
        >
          One window. Every agent.
        </div>
      </FadeIn>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 440px)',
          gap: 22,
        }}
      >
        {FEATURES.map((f, i) => {
          const enter = spring({
            frame: frame - (0.25 + i * 0.12) * fps,
            fps,
            config: {damping: 15, stiffness: 160},
          });
          return (
            <div
              key={f.label}
              style={{
                backgroundColor: COLORS.panel,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 14,
                padding: '22px 24px',
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                opacity: enter,
                transform: `translateY(${(1 - enter) * 26}px) scale(${
                  0.95 + enter * 0.05
                })`,
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  backgroundColor: f.color,
                  flexShrink: 0,
                }}
              />
              <div>
                <div
                  style={{color: COLORS.text, fontSize: 24, fontWeight: 700}}
                >
                  {f.label}
                </div>
                <div style={{color: COLORS.dim, fontSize: 17, marginTop: 3}}>
                  {f.sub}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      </div>
    </AbsoluteFill>
  );
};
