import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';

export const FadeIn: React.FC<{
  children: React.ReactNode;
  durationSec?: number;
  y?: number;
}> = ({children, durationSec = 0.35, y = 24}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const d = durationSec * fps;
  const opacity = interpolate(frame, [0, d], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const translate = interpolate(frame, [0, d], [y, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translate}px)`,
      }}
    >
      {children}
    </div>
  );
};
