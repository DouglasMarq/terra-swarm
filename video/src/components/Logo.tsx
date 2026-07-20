import React from 'react';
import {Img, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';

export const Logo: React.FC<{size?: number}> = ({size = 140}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const scale = spring({
    frame,
    fps,
    config: {damping: 13, stiffness: 140},
  });
  return (
    <Img
      src={staticFile('logo.png')}
      style={{
        width: size,
        height: size,
        transform: `scale(${scale})`,
      }}
    />
  );
};
