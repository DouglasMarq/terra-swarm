import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {COLORS} from '../theme';
import {SwarmMark} from '../components/SwarmMark';
import {FadeIn} from '../components/FadeIn';

export const Title: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const tagOpacity = interpolate(
    frame,
    [0.7 * fps, 1.2 * fps],
    [0, 1],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  const tagY = interpolate(frame, [0.7 * fps, 1.2 * fps], [20, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        gap: 36,
        background:
          'radial-gradient(1200px 700px at 50% 40%, #141a26 0%, #0b0e14 65%)',
      }}
    >
      <FadeIn>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 36,
          }}
        >
          <SwarmMark size={34} gap={12} />
          <div
            style={{
              color: COLORS.text,
              fontSize: 108,
              fontWeight: 800,
              letterSpacing: 10,
            }}
          >
            TERRA SWARM
          </div>
        </div>
      </FadeIn>
      <div
        style={{
          opacity: tagOpacity,
          transform: `translateY(${tagY}px)`,
          color: COLORS.dim,
          fontSize: 40,
          fontWeight: 500,
          letterSpacing: 2,
        }}
      >
        Mission control for AI coding agents
      </div>
    </AbsoluteFill>
  );
};
