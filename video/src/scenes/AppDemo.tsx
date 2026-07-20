import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {COLORS, MONO} from '../theme';

type Tone = 'cmd' | 'ok' | 'dim';

interface TermLine {
  text: string;
  at: number;
  tone: Tone;
}

const toneColor = (tone: Tone): string =>
  tone === 'ok' ? COLORS.accent : tone === 'dim' ? COLORS.dim : COLORS.text;

const Cursor: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const on = Math.floor(frame / (fps / 3)) % 2 === 0;
  return (
    <span
      style={{
        display: 'inline-block',
        width: 9,
        height: 18,
        marginLeft: 3,
        verticalAlign: 'text-bottom',
        backgroundColor: COLORS.accent,
        opacity: on ? 1 : 0,
      }}
    />
  );
};

const TypedLine: React.FC<{line: TermLine; isLast: boolean}> = ({
  line,
  isLast,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const start = line.at * fps;
  const chars =
    line.tone === 'cmd'
      ? Math.max(0, Math.floor((frame - start) * 0.55))
      : line.text.length;
  if (frame < start) return null;
  const done = chars >= line.text.length;
  return (
    <div style={{color: toneColor(line.tone), whiteSpace: 'nowrap'}}>
      {line.text.slice(0, Math.min(chars, line.text.length))}
      {isLast && done ? <Cursor /> : null}
    </div>
  );
};

const TerminalCard: React.FC<{
  agent: string;
  lines: TermLine[];
  contextPct?: number;
}> = ({agent, lines, contextPct}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const visible = lines.filter((l) => frame >= l.at * fps);
  const lastText = visible[visible.length - 1]?.text;
  const ctx = contextPct
    ? interpolate(frame, [2.4 * fps, 3.8 * fps], [0, contextPct], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 0;

  return (
    <div
      style={{
        backgroundColor: COLORS.panelAlt,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 12,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 42,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 16px',
          borderBottom: `1px solid ${COLORS.border}`,
          backgroundColor: COLORS.panel,
        }}
      >
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 6,
            backgroundColor: COLORS.agents[agent],
          }}
        />
        <span style={{color: COLORS.text, fontSize: 16, fontWeight: 600}}>
          {agent}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          padding: '14px 16px',
          fontFamily: MONO,
          fontSize: 17,
          lineHeight: 1.75,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {lines.map((l) => (
          <TypedLine key={l.text} line={l} isLast={l.text === lastText} />
        ))}
      </div>
      {contextPct ? (
        <div
          style={{
            padding: '0 16px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              flex: 1,
              height: 6,
              borderRadius: 3,
              backgroundColor: COLORS.border,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${ctx}%`,
                height: '100%',
                backgroundColor: COLORS.accent,
              }}
            />
          </div>
          <span style={{color: COLORS.dim, fontSize: 13, fontFamily: MONO}}>
            ctx {Math.round(ctx)}%
          </span>
        </div>
      ) : null}
    </div>
  );
};

export const AppDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();

  const enter = spring({frame, fps, config: {damping: 18, stiffness: 120}});
  const zoom = interpolate(frame, [0, durationInFrames], [1, 1.035]);
  const scale = interpolate(enter, [0, 1], [0.94, 1]) * zoom;
  const opacity = interpolate(enter, [0, 1], [0, 1]);

  const bellAt = 3.0 * fps;
  const bell = spring({
    frame: frame - bellAt,
    fps,
    config: {damping: 10, stiffness: 220},
  });

  const terminals: {agent: string; lines: TermLine[]; contextPct?: number}[] =
    [
      {
        agent: 'claude',
        contextPct: 62,
        lines: [
          {text: '$ claude', at: 0.35, tone: 'cmd'},
          {text: '⏺ Reading src/App.tsx…', at: 1.0, tone: 'dim'},
          {text: '⏺ Editing TerminalGrid.tsx', at: 1.65, tone: 'dim'},
          {text: '✓ 3 files updated, tests passing', at: 2.35, tone: 'ok'},
        ],
      },
      {
        agent: 'codex',
        lines: [
          {text: '$ codex', at: 0.55, tone: 'cmd'},
          {text: '› refactor pty resize handling', at: 1.2, tone: 'dim'},
          {text: '✔ Patch applied to pty.rs', at: 1.95, tone: 'ok'},
        ],
      },
      {
        agent: 'opencode',
        lines: [
          {text: '$ opencode', at: 0.75, tone: 'cmd'},
          {text: '> add workspace drag-to-reorder', at: 1.4, tone: 'dim'},
          {text: '✓ 2 files changed', at: 2.2, tone: 'ok'},
        ],
      },
      {
        agent: 'kimi',
        lines: [
          {text: '$ kimi', at: 0.95, tone: 'cmd'},
          {text: 'K: summarizing swarm activity…', at: 1.75, tone: 'dim'},
          {text: 'K: 4 agents active', at: 2.55, tone: 'ok'},
        ],
      },
    ];

  const workspaces = [
    {name: 'terra-swarm', branch: 'main', active: true, dot: false},
    {name: 'api-server', branch: 'feat/auth', active: false, dot: true},
    {name: 'landing-page', branch: 'main', active: false, dot: false},
  ];

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        background:
          'radial-gradient(1400px 900px at 50% 45%, #10151f 0%, #0b0e14 70%)',
      }}
    >
      <div
        style={{
          width: 1560,
          height: 880,
          borderRadius: 18,
          border: `1px solid ${COLORS.border}`,
          backgroundColor: COLORS.panel,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          opacity,
          transform: `scale(${scale})`,
          boxShadow: '0 40px 120px rgba(0,0,0,0.55)',
        }}
      >
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            padding: '0 20px',
            borderBottom: `1px solid ${COLORS.border}`,
            gap: 16,
          }}
        >
          <div style={{display: 'flex', gap: 8}}>
            {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
              <div
                key={c}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  backgroundColor: c,
                }}
              />
            ))}
          </div>
          <div
            style={{
              flex: 1,
              textAlign: 'center',
              color: COLORS.dim,
              fontSize: 17,
              fontWeight: 600,
              letterSpacing: 1,
            }}
          >
            Terra Swarm — terra-swarm
          </div>
          <div style={{position: 'relative', width: 28, height: 28}}>
            <svg viewBox="0 0 24 24" width={24} height={24} fill={COLORS.dim}>
              <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
            </svg>
            <div
              style={{
                position: 'absolute',
                top: -4,
                right: -6,
                minWidth: 20,
                height: 20,
                borderRadius: 10,
                backgroundColor: COLORS.accent,
                color: '#052e16',
                fontSize: 13,
                fontWeight: 800,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transform: `scale(${bell})`,
              }}
            >
              1
            </div>
          </div>
        </div>

        <div style={{flex: 1, display: 'flex', minHeight: 0}}>
          <div
            style={{
              width: 260,
              borderRight: `1px solid ${COLORS.border}`,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              style={{
                color: COLORS.dim,
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 2,
                marginBottom: 6,
              }}
            >
              WORKSPACES
            </div>
            {workspaces.map((w) => (
              <div
                key={w.name}
                style={{
                  borderRadius: 8,
                  padding: '10px 12px',
                  backgroundColor: w.active ? COLORS.panelAlt : 'transparent',
                  border: w.active
                    ? `1px solid ${COLORS.border}`
                    : '1px solid transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <div
                    style={{color: COLORS.text, fontSize: 16, fontWeight: 600}}
                  >
                    {w.name}
                  </div>
                  <div style={{color: COLORS.dim, fontSize: 12, marginTop: 2}}>
                    {w.branch}
                  </div>
                </div>
                {w.dot ? (
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 5,
                      backgroundColor: COLORS.accent,
                      transform: `scale(${bell})`,
                    }}
                  />
                ) : null}
              </div>
            ))}
          </div>

          <div
            style={{
              flex: 1,
              padding: 16,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gridTemplateRows: '1fr 1fr',
              gap: 14,
              minWidth: 0,
            }}
          >
            {terminals.map((t) => (
              <TerminalCard
                key={t.agent}
                agent={t.agent}
                lines={t.lines}
                contextPct={t.contextPct}
              />
            ))}
          </div>
        </div>

        <div
          style={{
            height: 40,
            borderTop: `1px solid ${COLORS.border}`,
            display: 'flex',
            alignItems: 'center',
            padding: '0 20px',
            gap: 20,
            color: COLORS.dim,
            fontSize: 14,
          }}
        >
          <span style={{color: COLORS.accent}}>● 4 agents running</span>
          <span>main</span>
          <span style={{marginLeft: 'auto'}}>voice: ready</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
