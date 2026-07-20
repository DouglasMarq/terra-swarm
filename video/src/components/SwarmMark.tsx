import React from 'react';
import {spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {COLORS} from '../theme';

export const SwarmMark: React.FC<{size?: number; gap?: number}> = ({
  size = 26,
  gap = 10,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(3, ${size}px)`,
        gap,
      }}
    >
      {new Array(9).fill(null).map((_, i) => {
        const scale = spring({
          frame: frame - i * 1.5,
          fps,
          config: {damping: 12, stiffness: 180},
        });
        return (
          <div
            key={i}
            style={{
              width: size,
              height: size,
              borderRadius: size * 0.32,
              backgroundColor: i === 4 ? COLORS.accent : COLORS.border,
              transform: `scale(${scale})`,
            }}
          />
        );
      })}
    </div>
  );
};
