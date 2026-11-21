import { useTranslation } from 'react-i18next';
import { boxPosition, cagePosition, MAX_WORKERS, percent, STATION_X, workerPosition } from './layout.ts';
import type { BoxView, FloorView, Mood, WorkerView } from './model.ts';
import { STATIONS } from './model.ts';

const SHIRTS = ['#5ab0ff', '#2fbf71', '#ff9f43', '#b06cff', '#d97757', '#78909c'];
const HAIR = ['#1b1730', '#4a2f27', '#e2557a', '#6d4c41', '#9b9b9b', '#4a2f27'];
const SKIN = ['#c68642', '#e0a878', '#f2c79b', '#e0a878', '#f2c79b', '#c68642'];
const STAMP_COLOR = { SHIPPED: '#66bb6a', SCRAPPED: '#ef5350', CHANGES: '#ffa726' } as const;
const SHIPMENT_TAGS = ['#ff77a8', '#26c6da', '#b06cff', '#ffca28'];

const tagColor = (shipment: string): string => {
  let hash = 0;
  for (const char of shipment) hash = (hash * 31 + char.charCodeAt(0)) % SHIPMENT_TAGS.length;
  return SHIPMENT_TAGS[hash] ?? '#ff77a8';
};

const at = (x: number, y: number): { transform: string } => ({ transform: `translate(${x}px, ${y}px)` });

const LED: Record<Mood, string> = { working: '#66bb6a', qc: '#ffca28', needs: '#ef5350', break: '#9aa1ab' };

const Background = ({ names, moods }: { names: readonly string[]; moods: readonly Mood[] }) => (
  <>
    <defs>
      <pattern id="yard" width="16" height="16" patternUnits="userSpaceOnUse">
        <rect width="16" height="16" fill="#5a5f66" />
        <rect x="3" y="5" width="1" height="1" fill="#666b73" />
        <rect x="11" y="12" width="1" height="1" fill="#4e535a" />
      </pattern>
      <pattern id="grass" width="12" height="12" patternUnits="userSpaceOnUse">
        <rect width="12" height="12" fill="#4a8c3f" />
        <rect x="2" y="3" width="1" height="1" fill="#5fa552" />
        <rect x="8" y="8" width="1" height="1" fill="#3d7a34" />
      </pattern>
      <pattern id="floor" width="16" height="16" patternUnits="userSpaceOnUse">
        <rect width="16" height="16" fill="#d6d0bf" />
        <rect width="16" height="1" fill="#c4bdaa" />
        <rect width="1" height="16" fill="#c4bdaa" />
      </pattern>
      <pattern id="mesh" width="4" height="4" patternUnits="userSpaceOnUse">
        <rect width="1" height="1" fill="#6b7280" opacity="0.35" />
        <rect x="2" y="2" width="1" height="1" fill="#6b7280" opacity="0.35" />
      </pattern>
      <pattern id="roof" width="6" height="14" patternUnits="userSpaceOnUse">
        <rect width="6" height="14" fill="#8a929c" />
        <rect width="2" height="14" fill="#9aa2ac" />
        <rect x="5" width="1" height="14" fill="#6f7680" />
      </pattern>
      <pattern id="haz" width="8" height="8" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" fill="#ffca28" />
        <rect width="4" height="8" fill="#15181c" transform="skewX(-30)" />
      </pattern>
      <pattern id="belt" width="6" height="10" patternUnits="userSpaceOnUse">
        <rect width="6" height="10" fill="#3a3f4a" />
        <rect width="1" height="10" fill="#2a2e36" />
      </pattern>
    </defs>
    <rect width="480" height="270" fill="url(#yard)" />
    <rect width="480" height="20" fill="url(#grass)" />
    <rect y="258" width="480" height="12" fill="url(#grass)" />
    <rect x="90" y="24" width="304" height="230" fill="#15181c" />
    <rect x="93" y="27" width="298" height="18" fill="url(#roof)" />
    <rect x="186" y="29" width="112" height="13" fill="#15181c" />
    <rect x="187" y="30" width="110" height="11" fill="#ffca28" />
    <text x="242" y="38" textAnchor="middle" fontFamily="Silkscreen" fontSize="6" fill="#15181c">
      AGENT WORKS · 01
    </text>
    <rect x="96" y="45" width="292" height="206" fill="url(#floor)" />
    <rect x="98" y="48" width="44" height="54" fill="#cfe6f2" />
    <rect x="98" y="48" width="44" height="54" fill="url(#mesh)" opacity="0.4" />
    <rect x="101" y="51" width="38" height="14" fill="#15181c" />
    <rect x="102" y="52" width="36" height="12" fill="#f5f3ec" />
    <text x="120" y="56.4" textAnchor="middle" fontFamily="Silkscreen" fontSize="3" fill="#c62828">
      ORDERS
    </text>
    <rect x="104" y="72" width="32" height="6" fill="#78909c" />
    <text x="120" y="98.6" textAnchor="middle" fontFamily="Silkscreen" fontSize="2.8" fill="#455a64">
      DISPATCH
    </text>
    <rect x="145" y="48" width="63" height="54" fill="#e8d9c4" />
    <rect x="145" y="48" width="63" height="2" fill="#6b7280" />
    <rect x="152" y="91" width="50" height="6" fill="#26a69a" />
    <rect x="152" y="89" width="50" height="3" fill="#00796b" />
    <text x="176.5" y="100.4" textAnchor="middle" fontFamily="Silkscreen" fontSize="2.8" fill="#5d4037">
      BREAK +ENERGY
    </text>
    <rect x="211" y="48" width="57" height="54" fill="#3a2a2e" />
    <rect x="211" y="48" width="57" height="2" fill="#ef5350" />
    <rect x="213" y="50" width="53" height="7" fill="#15181c" />
    <text x="239.5" y="55.4" textAnchor="middle" fontFamily="Silkscreen" fontSize="4" fill="#ef5350">
      FIREWALL
    </text>
    <rect x="211" y="100" width="57" height="2" fill="#ef5350" />
    <rect x="211" y="48" width="2" height="54" fill="#ef5350" />
    <rect x="266" y="48" width="2" height="54" fill="#ef5350" />
    <rect x="216" y="60" width="9" height="6" fill="#66bb6a" />
    <text x="220.5" y="64.4" textAnchor="middle" fontFamily="VT323" fontSize="4" fill="#15181c">
      git
    </text>
    <rect x="254" y="60" width="9" height="6" fill="#66bb6a" />
    <text x="258.5" y="64.4" textAnchor="middle" fontFamily="VT323" fontSize="4" fill="#15181c">
      npm
    </text>
    <rect x="216" y="70" width="4" height="24" fill="#454b55" />
    <rect x="259" y="70" width="4" height="24" fill="#454b55" />
    <rect className="blink" x="220" y="74" width="39" height="1" fill="#ff5252" />
    <rect x="220" y="80" width="39" height="1" fill="#ff5252" />
    <rect className="blink" x="220" y="86" width="39" height="1" fill="#ff5252" />
    <rect x="220" y="92" width="39" height="1" fill="#ff5252" />
    <rect x="271" y="48" width="48" height="54" fill="#cbc4b1" />
    <text x="295" y="54" textAnchor="middle" fontFamily="Silkscreen" fontSize="3.2" fill="#454b55">
      PR RACK
    </text>
    <rect x="274" y="57" width="42" height="2" fill="#e65100" />
    <rect x="322" y="48" width="64" height="196" fill="#b9b4a6" />
    <rect x="322" y="48" width="2" height="196" fill="#6b7280" />
    <rect x="386" y="80" width="5" height="70" fill="#9aa1ab" />
    <rect x="386" y="80" width="5" height="70" fill="url(#roof)" opacity="0.6" />
    <rect x="326" y="52" width="56" height="6" fill="url(#haz)" />
    <text x="354" y="64" textAnchor="middle" fontFamily="Silkscreen" fontSize="4" fill="#15181c">
      SHIPPING
    </text>
    <rect x="335" y="72" width="38" height="78" fill="#15181c" />
    <rect x="337" y="74" width="34" height="64" fill="#eceff1" />
    <rect x="337" y="138" width="34" height="11" fill="#1565c0" />
    <rect x="341" y="140" width="26" height="4" fill="#90caf9" />
    <rect x="326" y="230" width="56" height="10" fill="url(#haz)" />
    {[0, 1, 2, 3, 4, 5].map((slot) => {
      const cage = cagePosition(slot);
      return (
        <g key={slot}>
          <rect x={cage.x} y={cage.y} width="40" height="40" fill="#b9b4a6" />
          <rect x={cage.x} y={cage.y} width="40" height="40" fill="url(#mesh)" />
          <rect x={cage.x} y={cage.y} width="40" height="2" fill="#6b7280" />
          <rect x={cage.x} y={cage.y + 38} width="40" height="2" fill="#6b7280" />
          <rect x={cage.x} y={cage.y} width="2" height="40" fill="#6b7280" />
          <rect x={cage.x + 38} y={cage.y} width="2" height="40" fill="#6b7280" />
          <rect x={cage.x + 38} y={cage.y + 14} width="2" height="12" fill="#b9b4a6" />
          <rect x={cage.x + 37} y={cage.y + 11} width="3" height="3" fill="#15181c" />
          {moods[slot] === undefined ? null : (
            <rect className="blink" x={cage.x + 37.5} y={cage.y + 11.5} width="2" height="2" fill={LED[moods[slot]]} />
          )}
          <rect x={cage.x + 6} y={cage.y + 10} width="26" height="5" fill="#8d6e63" />
          <rect x={cage.x + 14} y={cage.y - 4} width="10" height="7" fill="#15181c" />
          <rect x={cage.x + 15} y={cage.y - 3} width="8" height="5" fill="#0d1a24" />
          <text
            x={cage.x + 20}
            y={cage.y + 36.5}
            textAnchor="middle"
            fontFamily="Silkscreen"
            fontSize="2.8"
            fill="#2f343b"
          >
            {names[slot] === undefined
              ? `CAGE ${slot + 1}`
              : `CAGE ${slot + 1} · ${names[slot].toUpperCase().slice(0, 8)}`}
          </text>
        </g>
      );
    })}
    <rect x="186" y="122" width="150" height="12" fill="#15181c" />
    <rect x="187" y="123" width="148" height="10" fill="url(#belt)" className="belt" />
    <rect x="186" y="114" width="44" height="7" fill="#15181c" />
    <rect x="187" y="115" width="6" height="5" fill="#ffca28" />
    <text x="195" y="119" fontFamily="Silkscreen" fontSize="3.2" fill="#f5f3ec">
      L1
    </text>
    <rect x="250" y="106" width="3" height="128" fill="#455a64" />
    <rect x="264" y="106" width="3" height="128" fill="#455a64" />
    <rect x="250" y="104" width="17" height="4" fill="#ffa726" />
    <rect x="276" y="104" width="22" height="5" fill="#15181c" />
    <rect x="277" y="105" width="20" height="3" fill="#ffca28" />
    <rect x="277" y="108" width="2" height="126" fill="#c79a00" />
    <rect x="295" y="108" width="2" height="126" fill="#c79a00" />
    <rect x="305" y="106" width="14" height="4" fill="#2e7d32" />
    <rect x="305" y="106" width="2" height="128" fill="#2e7d32" />
    <rect x="317" y="106" width="2" height="128" fill="#2e7d32" />
    {[127, 171, 215].map((y) => (
      <rect key={y} className={y === 171 ? undefined : 'blink'} x="253" y={y} width="11" height="1" fill="#ff7043" />
    ))}
    <g className="press">
      <rect x="288" y="117" width="4" height="5" fill="#455a64" />
    </g>
    <rect x="299" y="110" width="4" height="10" fill="#15181c" />
    <rect className="blink" x="300" y="111" width="2" height="2" fill="#ef5350" />
    <rect x="300" y="114" width="2" height="2" fill="#5d4037" />
    <rect x="300" y="117" width="2" height="2" fill="#66bb6a" />
    <g className="press">
      {[121, 165, 209].map((y) => (
        <rect key={y} x="309" y={y} width="6" height="3" fill="#66bb6a" />
      ))}
    </g>
    <text x="258.5" y="241" textAnchor="middle" fontFamily="Silkscreen" fontSize="3" fill="#8a3500">
      TEST
    </text>
    <text x="287" y="241" textAnchor="middle" fontFamily="Silkscreen" fontSize="3" fill="#6b4f00">
      QC
    </text>
    <text x="312" y="241" textAnchor="middle" fontFamily="Silkscreen" fontSize="3" fill="#1b5e20">
      MERGE
    </text>
    {STATIONS.slice(0, 2).map((station) => (
      <text
        key={station}
        x={STATION_X[station] + 4.5}
        y="141"
        textAnchor="middle"
        fontFamily="Silkscreen"
        fontSize="3"
        fill="#454b55"
      >
        {station}
      </text>
    ))}
  </>
);

const Box = ({ box, stack }: { box: BoxView; stack: number }) => {
  const { x, y } = boxPosition(box.station, stack);
  const [fill, band] =
    box.stamp === 'SCRAPPED'
      ? ['#9aa1ab', '#6b7280']
      : box.stamp === 'CHANGES'
        ? ['#ef5350', '#b71c1c']
        : box.station === 'QC'
          ? ['#ffca28', '#c79a00']
          : ['#42a5f5', '#1565c0'];
  return (
    <g className="mover" style={at(x, y)} data-box={box.id} data-station={box.station ?? 'none'}>
      <g className={box.stamp === 'CHANGES' ? 'jump' : undefined}>
        <rect width="9" height="8" fill={fill} />
        <rect y="3.5" width="9" height="1" fill={band} />
        <text x="4.5" y="5.6" textAnchor="middle" fontFamily="VT323" fontSize="3.6" fill="#15181c">
          {box.code.slice(0, 4)}
        </text>
      </g>
      <rect x="5" y="-1" width="4" height="3" fill={tagColor(box.shipment)} stroke="#15181c" strokeWidth="0.4" />
      {box.stamp === null ? null : (
        <g className={box.stamp === 'CHANGES' ? 'blink' : undefined}>
          <rect x="-7" y="-9" width={box.stamp.length * 2.8 + 3} height="6" fill={STAMP_COLOR[box.stamp]} />
          <text x="-5.5" y="-4.6" fontFamily="Silkscreen" fontSize="3" fill="#15181c">
            {box.stamp}
          </text>
        </g>
      )}
    </g>
  );
};

const animOf: Record<Mood, string> = { working: 'bob', needs: 'jump', qc: 'bob', break: '' };

const Sprite = ({ worker, slot }: { worker: WorkerView; slot: number }) => {
  const { x, y } = workerPosition(worker.mood, slot);
  const shirt = SHIRTS[slot] ?? '#78909c';
  const hair = HAIR[slot] ?? '#4a2f27';
  const skin = SKIN[slot] ?? '#e0a878';
  const asleep = worker.mood === 'break';
  const working = worker.mood === 'working';
  const label = worker.name.toUpperCase().slice(0, 8);
  const nameWidth = label.length * 3.4 + 4;
  return (
    <g className="mover" style={at(x, y)} data-worker={worker.name} data-mood={worker.mood}>
      <ellipse cx="5" cy="13.3" rx="5" ry="1.4" fill="#000" opacity="0.28" />
      <g className={animOf[worker.mood]}>
        <rect x="1" y="-2" width="8" height="2" fill="#ffca28" />
        <rect x="0" y="0" width="10" height="1" fill="#c79a00" />
        <rect x="1" y="1" width="1" height="2" fill={hair} />
        <rect x="8" y="1" width="1" height="2" fill={hair} />
        <rect x="2" y="1" width="6" height="4" fill={skin} />
        <rect x="3" y={asleep ? 3.4 : 3} width="1" height={asleep ? 0.5 : 1} fill="#1f2328" />
        <rect x="6" y={asleep ? 3.4 : 3} width="1" height={asleep ? 0.5 : 1} fill="#1f2328" />
        <rect x="1" y="5" width="8" height="4" fill={shirt} />
        <rect x="1" y="7" width="8" height="0.8" fill="#fff59d" />
        <rect className={working ? 'typeA' : undefined} x="0" y="6" width="1" height="3" fill={skin} />
        <rect className={working ? 'typeA' : undefined} x="9" y="6" width="1" height="3" fill={skin} />
        {working ? (
          <>
            <rect className="typeB" x="0" y="5" width="1" height="3" fill={skin} />
            <rect className="typeB" x="9" y="7" width="1" height="3" fill={skin} />
          </>
        ) : null}
        <rect x="2" y="9" width="2" height="3" fill="#3a3f4a" />
        <rect x="6" y="9" width="2" height="3" fill="#3a3f4a" />
        {worker.mood === 'qc' ? <rect x="9" y="5" width="7" height="6" fill="#42a5f5" /> : null}
      </g>
      <rect x={5 - nameWidth / 2} y="-14" width={nameWidth} height="8" fill="#15181c" opacity="0.85" />
      <text x="5" y="-9" textAnchor="middle" fontFamily="Silkscreen" fontSize="3.6" fill="#f5f3ec">
        {label}
      </text>
      {working ? (
        <g>
          <rect x="11" y="-3" width="11" height="6" fill="#f5f3ec" />
          <rect className="blink" x="13" y="-0.5" width="1" height="1" fill="#15181c" />
          <rect x="16" y="-0.5" width="1" height="1" fill="#15181c" />
          <rect className="blink" x="19" y="-0.5" width="1" height="1" fill="#15181c" />
        </g>
      ) : null}
      {asleep ? (
        <>
          <text
            className="zz"
            x="10"
            y="-1"
            fontFamily="Press Start 2P"
            fontSize="4"
            fill="#f5f3ec"
            stroke="#15181c"
            strokeWidth="0.6"
            paintOrder="stroke"
          >
            z
          </text>
          <text
            className="zz"
            x="13"
            y="-4"
            fontFamily="Press Start 2P"
            fontSize="5"
            fill="#f5f3ec"
            stroke="#15181c"
            strokeWidth="0.6"
            paintOrder="stroke"
            style={{ animationDelay: '1s' }}
          >
            Z
          </text>
        </>
      ) : null}
      {worker.mood === 'needs' ? (
        <g className="jump">
          <rect x="1.5" y="-25" width="7" height="9" fill="#15181c" />
          <rect x="2.5" y="-24" width="5" height="7" fill="#ffca28" />
          <rect x="4.5" y="-23" width="1" height="3.5" fill="#15181c" />
          <rect x="4.5" y="-18.6" width="1" height="1" fill="#15181c" />
        </g>
      ) : null}
    </g>
  );
};

export const Scene = ({
  view,
  selected,
  onSelect,
  onAction,
}: {
  view: FloorView;
  selected: string | null;
  onSelect: (name: string) => void;
  onAction: () => void;
}) => {
  const { t } = useTranslation();
  const workers = view.workers.slice(0, MAX_WORKERS);
  const stacks = new Map<string, number>();
  const placed = view.boxes.map((box) => {
    const key = box.station ?? 'none';
    const stack = stacks.get(key) ?? 0;
    stacks.set(key, stack + 1);
    return { box, stack };
  });
  return (
    <div className="scene">
      <svg
        viewBox="0 0 480 270"
        width="100%"
        shapeRendering="crispEdges"
        role="img"
        aria-label={t('floor.scene', { count: view.boxes.length, shipped: view.shipped })}
      >
        <Background names={workers.map((worker) => worker.name)} moods={workers.map((worker) => worker.mood)} />
        {placed.map(({ box, stack }) => (
          <Box key={box.id} box={box} stack={stack} />
        ))}
        {workers.map((worker, slot) => (
          <Sprite key={worker.name} worker={worker} slot={slot} />
        ))}
        {selected === null
          ? null
          : workers.map((worker, slot) => {
              if (worker.name !== selected) return null;
              const { x, y } = workerPosition(worker.mood, slot);
              return (
                <ellipse key={worker.name} className="blink" cx={x + 5} cy={y + 13.5} rx="8" ry="2.2" fill="#ffca28" />
              );
            })}
      </svg>
      {workers.map((worker, slot) => {
        const { x, y } = workerPosition(worker.mood, slot);
        return (
          <div key={worker.name} className="hit mover-html" style={percent(x, y)}>
            <button
              type="button"
              className="hit-worker"
              aria-label={t('floor.hud.selectWorker', { name: worker.name })}
              onClick={() => onSelect(worker.name)}
            />
            {worker.mood === 'needs' ? (
              <button
                type="button"
                className="hit-bang"
                data-testid={`bang-${worker.name}`}
                aria-label={t('floor.hud.openActionItems', { name: worker.name })}
                onClick={onAction}
              >
                !
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
