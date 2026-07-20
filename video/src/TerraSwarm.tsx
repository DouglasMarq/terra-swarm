import React from 'react';
import {AbsoluteFill, Sequence, useVideoConfig} from 'remotion';
import {COLORS, FONT} from './theme';
import {Title} from './scenes/Title';
import {AppDemo} from './scenes/AppDemo';
import {Features} from './scenes/Features';

export const TerraSwarm: React.FC = () => {
  const {fps, width, height} = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);
  const k = width / 1920;

  return (
    <AbsoluteFill style={{backgroundColor: COLORS.bg, fontFamily: FONT}}>
      <div
        style={{
          width: 1920,
          height: 1080,
          transform: `scale(${k})`,
          transformOrigin: 'top left',
          position: 'absolute',
        }}
      >
        <Sequence durationInFrames={s(2)}>
          <Title />
        </Sequence>
        <Sequence from={s(2)} durationInFrames={s(4.5)}>
          <AppDemo />
        </Sequence>
        <Sequence from={s(6.5)} durationInFrames={s(2)}>
          <Features />
        </Sequence>
      </div>
    </AbsoluteFill>
  );
};
