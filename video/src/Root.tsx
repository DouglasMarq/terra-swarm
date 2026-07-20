import React from 'react';
import {Composition} from 'remotion';
import {TerraSwarm} from './TerraSwarm';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TerraSwarm"
        component={TerraSwarm}
        durationInFrames={255}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="TerraSwarmGif"
        component={TerraSwarm}
        durationInFrames={255}
        fps={30}
        width={1280}
        height={720}
      />
    </>
  );
};
