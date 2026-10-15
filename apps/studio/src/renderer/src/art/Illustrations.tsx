/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Flat vector art for the app, in the WEBSITE's style: a round ink line over a few flat fills,
// never a gradient, never a shadow, one soft green as the only hue. The parts here (Spark, Drum,
// the blobs) are the website's own, copied by value rather than shared, because the two apps share
// no module; keep them drawing the same. Liby's drawing is NOT here: it is hers (`@snout/liby`), and a
// drawing that shows her takes it from there (`LibyFromAbove`), so the open-source build, whose stub
// draws a neutral mark instead, carries none of it.
//
// Every drawing is an inline SVG with class `ill`, coloured only through the `.ill-*` classes,
// which read the `--ill-*` tokens in styles.css. Those are DERIVED from each theme's own colours
// rather than set per theme (the website has two themes, the app has seven), so a drawing sits
// right in every one of them. Decorative, so always aria-hidden: nothing a user needs is in one.
//
// Adding one: a soft `ill-blob` behind; objects in `ill-paper` / `ill-tint`; ONE `ill-accent`, on
// the thing the picture is about; a couple of Sparks; a Drum for any database. Line weight is the
// class's 2.5. A spot drawing is a `0 0 240 160` box.

import { LibyFromAbove } from '@snout/liby';

/** A small four-point spark, the house ornament. It twinkles (styles.css, reduced motion stops it). */
export function Spark({ x, y, s = 1 }: { x: number; y: number; s?: number }): JSX.Element {
	return (
		<path
			className="ill-spark"
			d={`M${x} ${y - 7 * s} Q${x + 1.4 * s} ${y - 1.4 * s} ${x + 7 * s} ${y} Q${x + 1.4 * s} ${y + 1.4 * s} ${x} ${y + 7 * s} Q${x - 1.4 * s} ${y + 1.4 * s} ${x - 7 * s} ${y} Q${x - 1.4 * s} ${y - 1.4 * s} ${x} ${y - 7 * s} Z`}
		/>
	);
}

/** A database drum: `cx` its centre, `top` its top edge, `h` its body height. */
export function Drum({ cx, top, rx, ry, h, fill = 'ill-tint', bands = 2 }: { cx: number; top: number; rx: number; ry: number; h: number; fill?: string; bands?: number }): JSX.Element {
	const l = cx - rx;
	const r = cx + rx;
	const step = h / (bands + 1);
	return (
		<g>
			<path className={fill} d={`M${l} ${top} V${top + h} A${rx} ${ry} 0 0 0 ${r} ${top + h} V${top}`} />
			{Array.from({ length: bands }, (_, i) => (
				<path key={i} d={`M${l} ${top + step * (i + 1)} A${rx} ${ry} 0 0 0 ${r} ${top + step * (i + 1)}`} />
			))}
			<ellipse className="ill-paper" cx={cx} cy={top} rx={rx} ry={ry} />
		</g>
	);
}

/** The soft ground shape a spot drawing stands on, the website's door-card blob. */
export const SPOT_BLOB = 'M30 100C24 62 66 32 122 36C180 40 222 68 212 108C204 142 154 152 110 148C66 144 36 132 30 100Z';

/**
 * The assistant, for the signed-out panel: one conversation wired to BOTH halves of what it works
 * on. A chat bubble with the spark in it; one thread to a database (your data), one to a window
 * with a switch and a slider (the app itself). The green is the switch it is flipping, since
 * "it changes the app for you" is the half people do not expect.
 */
export function AssistantArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			{/* The conversation. */}
			<g transform="rotate(-3 70 70)">
				<path className="ill-paper" d="M36 40H104A12 12 0 0 1 116 52V86A12 12 0 0 1 104 98H62L44 112L48 98H36A12 12 0 0 1 24 86V52A12 12 0 0 1 36 40Z" />
				<Spark x={42} y={58} s={0.75} />
				<path d="M54 58H100" />
				<path d="M40 72H96" />
				<path d="M40 84H76" />
			</g>
			{/* Your data. */}
			<path className="ill-wire" d="M118 58C138 38 154 40 166 44" />
			<Drum cx={190} top={26} rx={22} ry={8} h={38} />
			{/* The app: a window with a switch being flipped and a slider. */}
			<path className="ill-wire" d="M118 84C140 90 138 112 152 116" />
			<path className="ill-wire-flow" d="M118 84C140 90 138 112 152 116" />
			<rect className="ill-paper" x="152" y="92" width="76" height="52" rx="7" />
			<path className="ill-tint" d="M152 105V99A7 7 0 0 1 159 92H221A7 7 0 0 1 228 99V105Z" />
			<rect className="ill-accent" x="162" y="113" width="24" height="12" rx="6" />
			<circle className="ill-paper" cx="179" cy="119" r="4" />
			<path d="M194 119H218" />
			<path d="M164 134H218" />
			<circle className="ill-paper" cx="200" cy="134" r="4" />
			<Spark x={220} y={14} s={0.8} />
			<Spark x={128} y={22} s={0.5} />
			<Spark x={20} y={128} s={0.6} />
		</svg>
	);
}

/** The website's laptop: the screen at (x, y), `w` by `h`, its base under it. */
function Laptop({ x, y, w, h }: { x: number; y: number; w: number; h: number }): JSX.Element {
	return (
		<g>
			<rect className="ill-paper" x={x} y={y} width={w} height={h} rx="6" />
			<path className="ill-tint" d={`M${x - 12} ${y + h}H${x + w + 12}L${x + w + 22} ${y + h + 12}H${x - 22}Z`} />
		</g>
	);
}

/**
 * The empty workbench (Welcome.tsx, no tab open): the app as a desk. A laptop with a query open
 * under a green title bar, the results charted beside it, the database wired in with a query on
 * its way along the wire, and a mug, because this is where someone sits down to work. A wide
 * `0 0 360 200` box.
 */
export function WorkbenchArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 360 200" aria-hidden="true" focusable="false">
			<path className="ill-blob" d="M26 124C18 76 74 38 160 42C246 46 334 74 330 128C326 172 254 186 180 182C100 178 34 168 26 124Z" />
			<path className="ill-ground" d="M40 186C120 180 240 180 320 186" />
			{/* The results, charted. */}
			<g transform="rotate(-6 66 54)">
				<rect className="ill-paper" x="38" y="32" width="56" height="44" rx="5" />
				<path d="M50 66V58M60 66V50M70 66V55M80 66V44" />
			</g>
			{/* The editor, a query open. Its title bar is the green, as on the website's Studio mark. */}
			<Laptop x={108} y={44} w={146} h={96} />
			<path className="ill-accent" d="M108 57V50A6 6 0 0 1 114 44H248A6 6 0 0 1 254 50V57Z" />
			<circle className="ill-ink-dot" cx="117" cy="50.5" r="1.6" />
			<circle className="ill-ink-dot" cx="124" cy="50.5" r="1.6" />
			<path d="M122 74H168" />
			<path d="M130 86H210" />
			<path d="M130 98H190" />
			<path d="M122 110H152" />
			<path d="M160 104V116" />
			{/* The database, wired in. */}
			<path className="ill-wire" d="M254 100C268 104 274 112 284 110" />
			<path className="ill-wire-flow" d="M254 100C268 104 274 112 284 110" />
			<Drum cx={306} top={74} rx={22} ry={8} h={50} />
			{/* Somebody's coffee. */}
			<path className="ill-clay" d="M52 152H74V170A6 6 0 0 1 68 176H58A6 6 0 0 1 52 170Z" />
			<path d="M74 157C82 157 82 169 74 169" />
			<path className="ill-steam" d="M58 144C56 140 60 138 58 134M68 144C66 140 70 138 68 134" />
			<Spark x={302} y={34} s={0.8} />
			<Spark x={182} y={22} s={0.55} />
			<Spark x={26} y={100} s={0.6} />
		</svg>
	);
}

/**
 * The assistant's empty conversation (ChatPanel.tsx): a question, and the database it can be
 * grounded in. It doubles as the state. `grounded` (a connected database is chosen): the bubble is
 * wired into the database, a query flows down the wire and the database is the green. Otherwise
 * the thread hangs loose and dashed and the database waits in its plain tint, which is the picture
 * of "pick a connection to ground the answers". A `0 0 240 160` box.
 */
export function GroundingArt({ grounded, className = '' }: { grounded: boolean; className?: string }): JSX.Element {
	const thread = 'M108 98C122 124 150 100 166 110';
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			{/* The question. */}
			<g transform="rotate(-3 74 58)">
				<path className="ill-paper" d="M40 28H108A12 12 0 0 1 120 40V74A12 12 0 0 1 108 86H104L110 100L90 86H40A12 12 0 0 1 28 74V40A12 12 0 0 1 40 28Z" />
				<Spark x={46} y={46} s={0.75} />
				<path d="M58 46H106" />
				<path d="M44 60H102" />
				<path d="M44 72H80" />
			</g>
			{/* Into the database, or not yet. */}
			{grounded
				? (
					<>
						<path className="ill-wire" d={thread} />
						<path className="ill-wire-flow" d={thread} />
					</>
				)
				: <path className="ill-thread" d={thread} />}
			<Drum cx={192} top={96} rx={24} ry={8} h={34} fill={grounded ? 'ill-accent' : 'ill-tint'} />
			<Spark x={214} y={34} s={0.8} />
			<Spark x={150} y={22} s={0.5} />
			<Spark x={22} y={118} s={0.6} />
		</svg>
	);
}

/** A page of SQL: a sheet with a folded corner and a few lines, its top-left at (x, y). The
 *  website's `Page`. */
export function Sheet({ x, y, w = 40, h = 52, fill = 'ill-paper', lines = 3 }: { x: number; y: number; w?: number; h?: number; fill?: string; lines?: number }): JSX.Element {
	const f = Math.min(10, w / 4);
	return (
		<g>
			<path className={fill} d={`M${x} ${y}H${x + w - f}L${x + w} ${y + f}V${y + h}H${x}Z`} />
			<path d={`M${x + w - f} ${y}V${y + f}H${x + w}`} />
			{Array.from({ length: lines }, (_, i) => (
				<path key={i} d={`M${x + 8} ${y + 18 + i * 9}H${x + w - (i % 2 ? 16 : 10)}`} />
			))}
		</g>
	);
}

/**
 * The empty workspace (WorkspaceFilesPanel.tsx): an open folder with its scripts fanned up out of
 * it, and the next one arriving, which is the green, with its plus. A `0 0 240 160` box.
 */
export function WorkspaceArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			{/* The folder's back. */}
			<path className="ill-tint" d="M58 64H96L104 72H170A6 6 0 0 1 176 78V134H52V70A6 6 0 0 1 58 64Z" />
			{/* The scripts, fanned up out of it. */}
			<g transform="rotate(-10 92 70)"><Sheet x={74} y={44} /></g>
			<g transform="rotate(6 130 66)"><Sheet x={112} y={40} /></g>
			{/* The folder's front. */}
			<path className="ill-paper" d="M46 92H178A6 6 0 0 1 184 98L178 134H52L40 98A6 6 0 0 1 46 92Z" />
			<path d="M100 112H130" />
			{/* The next one, on its way in. */}
			<g transform="rotate(8 190 52)">
				<Sheet x={170} y={26} w={34} h={44} lines={2} />
			</g>
			<circle className="ill-accent" cx="206" cy="74" r="11" />
			<path d="M206 68V80M200 74H212" />
			<Spark x={36} y={46} s={0.7} />
			<Spark x={150} y={18} s={0.5} />
			<Spark x={218} y={118} s={0.6} />
		</svg>
	);
}

/**
 * No monitors yet (MonitorView.tsx): a dashboard card on the desk, a live line rising with its area
 * in the green and a row of bars beside it, wired to the database it polls. A `0 0 240 160` box.
 */
export function MonitorArt({ className = '' }: { className?: string }): JSX.Element {
	const line = 'M58 92L74 80L88 86L104 66L118 72L134 52';
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			{/* The monitor. */}
			<rect className="ill-paper" x="40" y="30" width="148" height="88" rx="8" />
			<path className="ill-tint" d="M40 43V38A8 8 0 0 1 48 30H180A8 8 0 0 1 188 38V43Z" />
			<circle className="ill-ink-dot" cx="49" cy="36.5" r="1.6" />
			<circle className="ill-ink-dot" cx="56" cy="36.5" r="1.6" />
			{/* A trend: the area under it is the green. */}
			<path className="ill-accent" d={`${line}V104H58Z`} />
			<path d={line} />
			<path d="M54 104H140" />
			<circle className="ill-paper" cx="134" cy="52" r="4" />
			{/* A row of bars. */}
			<path d="M154 104V88M164 104V74M174 104V82" />
			{/* The database it polls. */}
			<path className="ill-wire" d="M188 96C200 100 202 116 210 120" />
			<Drum cx={210} top={112} rx={16} ry={6} h={20} bands={1} />
			<path d="M80 118V128M148 118V128M66 128H162" />
			<Spark x={214} y={30} s={0.8} />
			<Spark x={24} y={70} s={0.6} />
			<Spark x={120} y={14} s={0.5} />
		</svg>
	);
}

/**
 * No history yet (HistoryPanel.tsx, Recent): the queries you ran, as a stack of sheets, with a
 * clock in front; the newest one's top line is the green. A `0 0 240 160` box.
 */
export function HistoryArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<g transform="rotate(-8 92 82)"><Sheet x={66} y={46} w={56} h={72} fill="ill-tint" /></g>
			<g transform="rotate(-2 104 80)"><Sheet x={80} y={42} w={56} h={72} /></g>
			<g transform="rotate(5 118 78)">
				<Sheet x={96} y={38} w={56} h={72} />
				<path className="ill-accent" d="M102 50H136V58H102Z" />
			</g>
			{/* The clock. */}
			<circle className="ill-paper" cx="160" cy="112" r="24" />
			<path d="M160 98V112L170 118" />
			<path d="M160 90V93M182 112H179M160 134V131M138 112H141" />
			<circle className="ill-ink-dot" cx="160" cy="112" r="2.4" />
			<Spark x={44} y={50} s={0.7} />
			<Spark x={186} y={44} s={0.8} />
			<Spark x={212} y={110} s={0.5} />
		</svg>
	);
}

/**
 * No results yet (ResultsGrid.tsx): a database wired into an empty-looking grid, its header in the
 * tint and the one row the next run will bring back in the green, with the run button at its
 * corner. A `0 0 240 160` box.
 */
export function ResultsArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<Drum cx={52} top={74} rx={20} ry={7} h={46} />
			<path className="ill-wire" d="M72 96C84 96 86 84 96 84" />
			{/* The grid. */}
			<rect className="ill-paper" x="96" y="34" width="112" height="92" rx="8" />
			<path className="ill-tint" d="M96 52V42A8 8 0 0 1 104 34H200A8 8 0 0 1 208 42V52Z" />
			<path className="ill-accent" d="M96 72H208V92H96Z" />
			<path d="M96 52H208M96 72H208M96 92H208M96 112H208M134 52V126" />
			<path d="M104 43H124M142 43H172M104 82H122M142 82H186M104 102H118M142 102H178" />
			{/* Run. */}
			<circle className="ill-paper" cx="208" cy="126" r="14" />
			<path className="ill-ink-dot" d="M204 119L215 126L204 133Z" />
			<Spark x={30} y={48} s={0.7} />
			<Spark x={120} y={16} s={0.5} />
			<Spark x={226} y={60} s={0.6} />
		</svg>
	);
}

/**
 * No saved queries (HistoryPanel.tsx, Saved): one query kept, a bookmark ribbon in the green
 * hanging from its top edge. A `0 0 240 160` box.
 */
export function SavedArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<g transform="rotate(-6 96 86)"><Sheet x={64} y={46} w={60} h={80} fill="ill-tint" /></g>
			<g transform="rotate(3 128 82)">
				<Sheet x={96} y={36} w={68} h={90} lines={4} />
				{/* The ribbon. */}
				<path className="ill-accent" d="M144 30H158V72L151 65L144 72Z" />
			</g>
			<Spark x={56} y={40} s={0.7} />
			<Spark x={190} y={52} s={0.8} />
			<Spark x={196} y={118} s={0.55} />
		</svg>
	);
}

/**
 * No projects yet (DashboardPanel.tsx): the website's two doors in one picture. A laptop with its
 * own database (Local, the stack in your Docker) and a cloud with a database hanging from it in the
 * green (SnoutData Cloud). A `0 0 240 160` box.
 */
export function ProjectsArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			{/* Local. */}
			<Laptop x={34} y={78} w={70} h={46} />
			<path d="M44 92H70M44 102H84M44 112H62" />
			<Drum cx={116} top={104} rx={11} ry={4} h={22} bands={1} />
			{/* Cloud. */}
			<path className="ill-paper" d="M140 66C128 66 121 57 124 48C126 40 135 36 143 39C146 27 159 20 172 23C184 25 192 34 194 43C204 40 216 46 217 57C218 65 211 70 202 70Z" />
			<path d="M150 50C153 46 158 45 162 47" />
			<path className="ill-thread" d="M174 70V88" />
			<Drum cx={174} top={92} rx={14} ry={5} h={26} bands={1} fill="ill-accent" />
			<Spark x={28} y={50} s={0.7} />
			<Spark x={110} y={30} s={0.55} />
			<Spark x={218} y={104} s={0.6} />
		</svg>
	);
}

/**
 * No connections yet (Sidebar.tsx): a database, and a cable reaching for it with its plug, in the
 * green, a breath away from the socket. A `0 0 240 160` box.
 */
export function ConnectArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<Drum cx={164} top={46} rx={32} ry={11} h={70} />
			{/* The socket on its side. */}
			<rect className="ill-paper" x="138" y="80" width="16" height="22" rx="3" />
			<circle className="ill-ink-dot" cx="146" cy="86" r="1.8" />
			<circle className="ill-ink-dot" cx="146" cy="96" r="1.8" />
			{/* The cable and its plug, about to go in. */}
			<path d="M22 124C52 124 58 91 86 91" />
			<rect className="ill-accent" x="86" y="81" width="24" height="20" rx="4" />
			<path d="M110 86H122M110 96H122" />
			<Spark x={40} y={52} s={0.7} />
			<Spark x={128} y={26} s={0.55} />
			<Spark x={214} y={130} s={0.6} />
		</svg>
	);
}

/** A model, drawn as a chip: a square with three pins a side and a die in the middle, centred on
 *  (cx, cy), `s` across. */
export function Chip({ cx, cy, s, fill = 'ill-paper', die = 'ill-tint' }: { cx: number; cy: number; s: number; fill?: string; die?: string }): JSX.Element {
	const h = s / 2;
	const p = s / 4;
	const pins = [-p, 0, p];
	return (
		<g>
			{pins.map((d) => <path key={`l${d}`} d={`M${cx - h - 6} ${cy + d}H${cx - h}M${cx + h} ${cy + d}H${cx + h + 6}M${cx + d} ${cy - h - 6}V${cy - h}M${cx + d} ${cy + h}V${cy + h + 6}`} />)}
			<rect className={fill} x={cx - h} y={cy - h} width={s} height={s} rx="6" />
			<rect className={die} x={cx - s / 4} y={cy - s / 4} width={s / 2} height={s / 2} rx="3" />
		</g>
	);
}

/**
 * Data Generation's intro: the model writing records into a table, the newest row the green, still
 * sparkling. A `0 0 240 160` box.
 */
export function GenerateArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<Chip cx={64} cy={82} s={36} />
			<path className="ill-wire" d="M88 82C100 82 104 88 118 88" />
			<path className="ill-wire-flow" d="M88 82C100 82 104 88 118 88" />
			<rect className="ill-paper" x="118" y="36" width="96" height="92" rx="7" />
			<path className="ill-tint" d="M118 50V43A7 7 0 0 1 125 36H207A7 7 0 0 1 214 43V50Z" />
			<path d="M128 64H204M128 78H192M128 92H200" />
			<rect className="ill-accent" x="124" y="102" width="84" height="14" rx="4" />
			<Spark x={214} y={108} s={0.7} />
			<Spark x={40} y={40} s={0.7} />
			<Spark x={104} y={24} s={0.5} />
		</svg>
	);
}

/**
 * Agent access: an agent's terminal reaching a database only through the app, which is the green
 * shield on the wire between them. A `0 0 240 160` box.
 */
export function AgentAccessArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<rect className="ill-paper" x="22" y="44" width="92" height="66" rx="7" />
			<path className="ill-tint" d="M22 57V51A7 7 0 0 1 29 44H107A7 7 0 0 1 114 51V57Z" />
			<path d="M34 72L42 78L34 84" />
			<path d="M48 86H66" />
			<path className="ill-wire" d="M114 78C124 78 126 80 134 80" />
			<path className="ill-accent" d="M152 58L170 64V80C170 92 162 100 152 104C142 100 134 92 134 80V64Z" />
			<circle className="ill-ink-dot" cx="152" cy="77" r="3.2" />
			<path d="M152 80V88" />
			<path className="ill-wire" d="M170 80C176 80 178 82 184 82" />
			<path className="ill-wire-flow" d="M170 80C176 80 178 82 184 82" />
			<Drum cx={204} top={62} rx={20} ry={7} h={40} />
			<Spark x={40} y={28} s={0.7} />
			<Spark x={152} y={32} s={0.6} />
			<Spark x={206} y={128} s={0.5} />
		</svg>
	);
}

/**
 * Knowledge: a note you wrote, and the light it gives the assistant, the bulb in the green.
 * A `0 0 240 160` box.
 */
export function KnowledgeArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<g transform="rotate(-6 92 96)"><Sheet x={50} y={60} w={84} h={72} lines={4} /></g>
			<path d="M162 22V16M188 34L193 29M136 34L131 29M200 58H206M124 58H118" />
			<path className="ill-accent" d="M162 34A24 24 0 0 1 176 78V88H148V78A24 24 0 0 1 162 34Z" />
			<path d="M155 72L159 64L163 72L167 64" />
			<rect className="ill-tint" x="148" y="88" width="28" height="8" rx="2" />
			<rect className="ill-tint" x="152" y="96" width="20" height="8" rx="3" />
			<Spark x={36} y={46} s={0.7} />
			<Spark x={212} y={110} s={0.6} />
		</svg>
	);
}

/**
 * Snoutbot: a pull request's branch merging, and the review it posts, checked against the
 * database the change lands on. The tick on the review is the green. A `0 0 240 160` box.
 */
export function ReviewArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<path d="M44 46V118" />
			<path d="M80 50V70C80 88 44 84 44 102" />
			<circle className="ill-paper" cx="44" cy="40" r="7" />
			<circle className="ill-paper" cx="44" cy="124" r="7" />
			<circle className="ill-paper" cx="80" cy="44" r="7" />
			<path className="ill-paper" d="M112 34H186A10 10 0 0 1 196 44V74A10 10 0 0 1 186 84H136L120 96L124 84H112A10 10 0 0 1 102 74V44A10 10 0 0 1 112 34Z" />
			<path d="M114 50H168M114 62H180M114 72H150" />
			<circle className="ill-accent" cx="192" cy="36" r="11" />
			<path d="M187 36L191 40L198 32" />
			<path className="ill-wire" d="M156 84V100" />
			<Drum cx={156} top={106} rx={22} ry={7} h={24} bands={1} />
			<Spark x={88} y={112} s={0.6} />
			<Spark x={214} y={70} s={0.7} />
			<Spark x={100} y={20} s={0.5} />
		</svg>
	);
}

/**
 * Cloud accounts: a cloud, and the key to it in the green, kept on this computer.
 * A `0 0 240 160` box.
 */
export function CloudKeyArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<g transform="translate(-24 14)">
				<path className="ill-paper" d="M140 66C128 66 121 57 124 48C126 40 135 36 143 39C146 27 159 20 172 23C184 25 192 34 194 43C204 40 216 46 217 57C218 65 211 70 202 70Z" />
				<path d="M150 50C153 46 158 45 162 47" />
			</g>
			<g transform="rotate(-12 110 112)">
				<circle className="ill-accent" cx="82" cy="112" r="15" />
				<circle className="ill-paper" cx="78" cy="112" r="4.5" />
				<path className="ill-accent" d="M97 108H146V116H138V124H130V116H97Z" />
			</g>
			<Spark x={40} y={40} s={0.7} />
			<Spark x={206} y={116} s={0.6} />
			<Spark x={112} y={28} s={0.5} />
		</svg>
	);
}

/**
 * Network: this computer reaching the internet through the proxy, which is the green box on the
 * wire. A `0 0 240 160` box.
 */
export function NetworkArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<Laptop x={36} y={70} w={58} h={40} />
			<path d="M46 84H72M46 94H82" />
			<path className="ill-wire" d="M104 92C108 92 108 94 112 94" />
			<rect className="ill-accent" x="112" y="80" width="30" height="28" rx="6" />
			<path d="M119 94H135M131 90L135 94L131 98" />
			<path className="ill-wire" d="M142 94C148 94 150 90 156 90" />
			<path className="ill-wire-flow" d="M142 94C148 94 150 90 156 90" />
			<circle className="ill-paper" cx="186" cy="84" r="30" />
			<ellipse cx="186" cy="84" rx="12" ry="30" />
			<path d="M156 84H216M160 70Q186 76 212 70M160 98Q186 92 212 98" />
			<Spark x={44} y={44} s={0.7} />
			<Spark x={128} y={52} s={0.5} />
			<Spark x={214} y={128} s={0.6} />
		</svg>
	);
}

/**
 * Privacy: a report on its way out with the private lines blacked out, and the padlock, in the
 * green, on what stays. A `0 0 240 160` box.
 */
export function PrivacyArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<g transform="rotate(-5 96 84)">
				<path className="ill-paper" d="M58 34H122L136 48V132H58Z" />
				<path d="M122 34V48H136" />
				<path d="M68 58H112" />
				<rect className="ill-tint" x="68" y="68" width="56" height="9" rx="2" />
				<path d="M68 88H104" />
				<rect className="ill-tint" x="68" y="98" width="44" height="9" rx="2" />
				<path d="M68 118H118" />
			</g>
			<path d="M160 80V68A16 16 0 0 1 192 68V80" />
			<rect className="ill-accent" x="150" y="80" width="52" height="44" rx="8" />
			<circle className="ill-ink-dot" cx="176" cy="98" r="4" />
			<path d="M176 101V112" />
			<Spark x={40} y={44} s={0.7} />
			<Spark x={210} y={50} s={0.6} />
			<Spark x={214} y={128} s={0.5} />
		</svg>
	);
}

/** One keycap: its base and its top, the top's corner at (x, y). */
function Keycap({ x, y, w = 36, fill = 'ill-paper' }: { x: number; y: number; w?: number; fill?: string }): JSX.Element {
	return (
		<g>
			<rect className="ill-tint" x={x} y={y + 6} width={w} height={34} rx="7" />
			<rect className={fill} x={x} y={y} width={w} height={32} rx="7" />
		</g>
	);
}

/**
 * Shortcuts: a chord being pressed, three keycaps with the last one, the one you are setting, in
 * the green. A `0 0 240 160` box.
 */
export function KeysArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<Keycap x={34} y={74} w={52} />
			<path d="M48 90H72" />
			<Keycap x={96} y={74} w={44} />
			<path d="M108 86L118 92L108 98" />
			<path d="M146 90H152M149 87V93" />
			<Keycap x={160} y={66} w={40} fill="ill-accent" />
			<path d="M174 76V90M174 76H186" />
			<Spark x={44} y={44} s={0.7} />
			<Spark x={210} y={40} s={0.8} />
			<Spark x={120} y={40} s={0.5} />
		</svg>
	);
}

/**
 * Reset: an eraser, its sleeve the green, wiping a page clean, the cleared half already blank.
 * A `0 0 240 160` box.
 */
export function ResetArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<path className="ill-paper" d="M48 36H150V130H48Z" />
			<path d="M60 54H96M60 66H90M60 78H98" />
			<path d="M112 98H138M118 110H136" />
			<g transform="rotate(-32 150 86)">
				<rect className="ill-paper" x="120" y="74" width="30" height="26" rx="4" />
				<rect className="ill-accent" x="150" y="74" width="50" height="26" rx="4" />
				<path d="M164 74V100" />
			</g>
			<path d="M104 112C108 116 114 114 116 118" className="ill-thread" />
			<Spark x={36} y={40} s={0.7} />
			<Spark x={206} y={56} s={0.6} />
			<Spark x={176} y={130} s={0.5} />
		</svg>
	);
}

/**
 * No notifications (NotificationsCenter.tsx): a quiet bell, and a green tick beside it for "all
 * clear". A `0 0 240 160` box.
 */
export function BellArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<circle className="ill-ink-dot" cx="118" cy="32" r="4" />
			<path className="ill-paper" d="M118 36C98 36 88 52 88 72V96L76 110H160L148 96V72C148 52 138 36 118 36Z" />
			<path d="M100 74C100 62 106 54 114 52" />
			<circle className="ill-tint" cx="118" cy="118" r="8" />
			<circle className="ill-accent" cx="162" cy="50" r="13" />
			<path d="M156 50L160 54L168 46" />
			<Spark x={60} y={50} s={0.8} />
			<Spark x={192} y={100} s={0.6} />
			<Spark x={44} y={112} s={0.5} />
		</svg>
	);
}

/**
 * Find your databases (DiscoveryModal.tsx): a laptop, and a magnifying glass passing over the
 * databases beside it; the one under the lens is the green, since it has just been found. A dashed
 * thread runs off to a second machine for the local network. A `0 0 240 160` box.
 */
export function DiscoverArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<Laptop x={38} y={72} w={76} h={52} />
			<path d="M50 88H80M50 98H94M50 108H70" />
			<Drum cx={140} top={98} rx={14} ry={5} h={28} bands={1} />
			<Drum cx={178} top={92} rx={14} ry={5} h={34} bands={1} fill="ill-accent" />
			{/* The lens, over the found one. */}
			<circle cx="178" cy="104" r="24" strokeWidth="4" />
			<path d="M164 92C167 86 172 83 178 82" />
			<path d="M195 121L210 136" strokeWidth="6" />
			{/* The local network, further off. */}
			<rect className="ill-tint" x="64" y="26" width="34" height="24" rx="4" />
			<path d="M72 34H90M72 42H84" />
			<path className="ill-thread" d="M98 38C114 42 116 58 104 72" />
			<Spark x={214} y={40} s={0.8} />
			<Spark x={34} y={50} s={0.6} />
			<Spark x={128} y={20} s={0.5} />
		</svg>
	);
}

/**
 * About (AboutModal.tsx): the tagline drawn. Liby over the four things the app holds,
 * left to right as the sentence names them, each on its own thread: your databases, your data, your
 * projects (a cloud, the green, since running them is the newest of the four) and your agent. A wide
 * `0 0 440 124` banner, not a spot box, because it runs across the top of the card.
 */
export function AboutArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 440 124" aria-hidden="true" focusable="false">
			<path className="ill-blob" d="M22 86C16 54 80 32 160 36C240 40 330 26 398 44C436 54 434 98 404 108C340 122 120 122 54 114C32 110 24 100 22 86Z" />
			<path className="ill-ground" d="M40 116C140 112 300 112 400 116" />
			{/* The threads, down from Liby. */}
			<path className="ill-thread" d="M204 40C160 46 104 54 76 68" />
			<path className="ill-thread" d="M212 48C196 54 178 58 164 64" />
			<path className="ill-thread" d="M228 48C246 54 270 60 290 70" />
			<path className="ill-thread" d="M236 40C290 46 352 54 380 66" />
			<path className="ill-wire-flow" d="M228 48C246 54 270 60 290 70" />
			{/* Your databases. */}
			<Drum cx={70} top={72} rx={22} ry={7} h={34} />
			{/* Your data. */}
			<g transform="rotate(-4 160 88)"><Sheet x={142} y={64} w={36} h={46} lines={3} /></g>
			{/* Your projects. */}
			<path className="ill-accent" d="M266 106H318A15 15 0 0 0 316 76A21 21 0 0 0 276 72A17 17 0 0 0 266 106Z" />
			<path d="M282 94H302M286 86H298" />
			{/* Your agent. */}
			<rect className="ill-paper" x="352" y="68" width="58" height="42" rx="6" />
			<path className="ill-tint" d="M352 78V74A6 6 0 0 1 358 68H404A6 6 0 0 1 410 74V78Z" />
			<path d="M361 87L369 93L361 99" />
			<path d="M374 99H390" />
			{/* Liby, seen from above (her drawing is hers: the open-source build draws a neutral mark here). */}
			<g transform="translate(190 2) scale(0.5)">
				<LibyFromAbove />
			</g>
			<Spark x={118} y={24} s={0.7} />
			<Spark x={322} y={22} s={0.8} />
			<Spark x={30} y={52} s={0.5} />
			<Spark x={420} y={34} s={0.5} />
		</svg>
	);
}

/**
 * Getting started (GettingStarted.tsx): a clipboard of steps, the first two ticked, and the green
 * tick badge for the one about to be done. A `0 0 240 160` box.
 */
export function ChecklistArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<g transform="rotate(-4 118 84)">
				<rect className="ill-paper" x="78" y="30" width="84" height="108" rx="8" />
				<rect className="ill-tint" x="100" y="22" width="40" height="16" rx="5" />
				<rect className="ill-tint" x="92" y="54" width="12" height="12" rx="3" />
				<path d="M95 60L98 63L102 57" />
				<path d="M112 60H148" />
				<rect className="ill-tint" x="92" y="78" width="12" height="12" rx="3" />
				<path d="M95 84L98 87L102 81" />
				<path d="M112 84H140" />
				<rect className="ill-paper" x="92" y="102" width="12" height="12" rx="3" />
				<path d="M112 108H146" />
			</g>
			<circle className="ill-accent" cx="168" cy="112" r="16" />
			<path d="M160 112L166 118L177 106" />
			<Spark x={56} y={46} s={0.8} />
			<Spark x={190} y={48} s={0.6} />
			<Spark x={54} y={120} s={0.5} />
		</svg>
	);
}

/**
 * A monitor with no widgets yet (MonitorView.tsx): the board, one tile already charting, and the
 * empty slot beside it with the next widget, the green, on its way in. A `0 0 240 160` box.
 */
export function WidgetSlotArt({ className = '' }: { className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			<rect className="ill-paper" x="36" y="30" width="164" height="100" rx="8" />
			<path className="ill-tint" d="M36 43V38A8 8 0 0 1 44 30H192A8 8 0 0 1 200 38V43Z" />
			<circle className="ill-ink-dot" cx="45" cy="36.5" r="1.6" />
			<circle className="ill-ink-dot" cx="52" cy="36.5" r="1.6" />
			{/* The tile that is there. */}
			<rect className="ill-tint" x="48" y="54" width="66" height="62" rx="5" />
			<path d="M58 104V92M70 104V80M82 104V86M94 104V70" />
			{/* The empty slot. */}
			<rect className="ill-thread" x="124" y="54" width="64" height="62" rx="5" />
			{/* The widget arriving. */}
			<g transform="rotate(8 186 44)">
				<rect className="ill-accent" x="160" y="20" width="52" height="40" rx="5" />
				<path d="M168 48L178 40L188 44L202 30" />
			</g>
			<circle className="ill-paper" cx="156" cy="85" r="10" />
			<path d="M156 80V90M151 85H161" />
			<Spark x={24} y={60} s={0.6} />
			<Spark x={222} y={86} s={0.7} />
			<Spark x={118} y={16} s={0.5} />
		</svg>
	);
}

/**
 * Something went wrong (NotificationToast.tsx). `unplugged`, for a connection that failed: the
 * database with its cable pulled out and the plug hanging. Otherwise a sheet with a warning on it.
 * The trouble is the warm clay, the one place a drawing borrows the error's colour. A `0 0 240 160` box.
 */
export function ProblemArt({ unplugged, className = '' }: { unplugged: boolean; className?: string }): JSX.Element {
	return (
		<svg className={`ill ${className}`} viewBox="0 0 240 160" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={SPOT_BLOB} />
			<path className="ill-ground" d="M44 146C84 142 160 142 200 146" />
			{unplugged ? (
				<>
					<Drum cx={158} top={44} rx={32} ry={11} h={70} />
					<rect className="ill-paper" x="118" y="76" width="14" height="22" rx="3" />
					<circle className="ill-ink-dot" cx="125" cy="82" r="1.8" />
					<circle className="ill-ink-dot" cx="125" cy="92" r="1.8" />
					<path d="M24 120C46 122 52 112 62 106" />
					<g transform="rotate(-28 74 100)">
						<rect className="ill-clay" x="62" y="90" width="22" height="18" rx="4" />
						<path d="M84 95H94M84 103H94" />
					</g>
					{/* The jolt where it came out. */}
					<path d="M102 70L108 76L102 80L108 86" />
					<path d="M96 108L104 110L100 116" />
				</>
			) : (
				<>
					<g transform="rotate(-5 108 84)"><Sheet x={74} y={36} w={64} h={84} lines={4} /></g>
					<path className="ill-clay" d="M160 54L188 104H132Z" />
					<path d="M160 70V86" />
					<circle className="ill-ink-dot" cx="160" cy="95" r="2.4" />
				</>
			)}
			<Spark x={40} y={50} s={0.7} />
			<Spark x={206} y={34} s={0.6} />
			<Spark x={210} y={128} s={0.5} />
		</svg>
	);
}

// --- Page marks -------------------------------------------------------------------------------
//
// The website's `PageMark` (snoutdata.com's page-heading drawing): a page heading as a drawing. A SMALL scene
// beside the heading's own text, a drawn green stroke under its last word and a spark on that word,
// for the pages with no room for a spot drawing. Each is a `0 0 120 100` box, sized in `em` so it
// follows the heading. A new page adds a drawing to `MARK_ART`, never a new component.

const MARK_BLOB = 'M10 60C6 32 36 14 66 16C96 18 116 36 112 62C108 86 80 94 56 92C30 90 13 82 10 60Z';

/** Appearance: a palette, one well the green, and a brush. */
function AppearanceMarkArt(): JSX.Element {
	return (
		<svg className="ill ill-mark" viewBox="0 0 120 100" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={MARK_BLOB} />
			<path className="ill-paper" d="M58 18C30 18 14 38 16 58C18 76 34 86 50 82C60 80 58 70 66 68C76 66 90 74 98 62C106 48 92 18 58 18Z" />
			<circle className="ill-accent" cx="40" cy="40" r="7" />
			<circle className="ill-tint" cx="62" cy="32" r="6" />
			<circle className="ill-clay" cx="82" cy="44" r="6" />
			<circle className="ill-warm" cx="34" cy="62" r="6" />
			<path d="M92 88L108 58" />
			<path className="ill-tint" d="M104 54L112 58L108 66L100 62Z" />
		</svg>
	);
}

/** Editor & Query: a query window, its title bar the green, a caret mid-line. */
function EditorMarkArt(): JSX.Element {
	return (
		<svg className="ill ill-mark" viewBox="0 0 120 100" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={MARK_BLOB} />
			<rect className="ill-paper" x="18" y="20" width="84" height="62" rx="6" />
			<path className="ill-accent" d="M18 32V26A6 6 0 0 1 24 20H96A6 6 0 0 1 102 26V32Z" />
			<path d="M30 46H62M38 58H80M30 70H50" />
			<path d="M68 52V64" />
		</svg>
	);
}

/** AI Settings: a chat bubble with the spark in it, and the green dot of a model that answers. */
function AiMarkArt(): JSX.Element {
	return (
		<svg className="ill ill-mark" viewBox="0 0 120 100" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={MARK_BLOB} />
			<path className="ill-paper" d="M28 20H92A10 10 0 0 1 102 30V62A10 10 0 0 1 92 72H52L34 86L38 72H28A10 10 0 0 1 18 62V30A10 10 0 0 1 28 20Z" />
			<Spark x={44} y={46} s={1.3} />
			<path d="M62 40H88M62 52H80" />
			<circle className="ill-accent" cx="100" cy="22" r="8" />
		</svg>
	);
}

/** AI Audit: a clipboard of ticked lines, its clip the green. */
function AuditMarkArt(): JSX.Element {
	return (
		<svg className="ill ill-mark" viewBox="0 0 120 100" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={MARK_BLOB} />
			<rect className="ill-paper" x="30" y="18" width="60" height="72" rx="6" />
			<rect className="ill-accent" x="46" y="12" width="28" height="12" rx="4" />
			<path d="M40 40L44 44L50 36M56 40H80" />
			<path d="M40 56L44 60L50 52M56 56H78" />
			<path d="M40 72L44 76L50 68M56 72H74" />
		</svg>
	);
}

/** Account: you, with the green badge of a signed-in plan. */
function AccountMarkArt(): JSX.Element {
	return (
		<svg className="ill ill-mark" viewBox="0 0 120 100" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={MARK_BLOB} />
			<path className="ill-tint" d="M24 88C24 66 40 56 60 56C80 56 96 66 96 88Z" />
			<circle className="ill-paper" cx="60" cy="36" r="18" />
			<circle className="ill-accent" cx="92" cy="30" r="10" />
			<path d="M87 30L91 34L98 26" />
		</svg>
	);
}

/** Settings: a gear, its hub the green, beside a switch. */
function SettingsMarkArt(): JSX.Element {
	return (
		<svg className="ill ill-mark" viewBox="0 0 120 100" aria-hidden="true" focusable="false">
			<path className="ill-blob" d={MARK_BLOB} />
			{[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
				<rect key={angle} className="ill-tint" x="45" y="16" width="14" height="16" rx="3" transform={`rotate(${angle} 52 52)`} />
			))}
			<circle className="ill-paper" cx="52" cy="52" r="24" />
			<circle className="ill-accent" cx="52" cy="52" r="9" />
			<rect className="ill-paper" x="84" y="66" width="28" height="16" rx="8" />
			<circle className="ill-ink-dot" cx="104" cy="74" r="4" />
		</svg>
	);
}

const MARK_ART = {
	settings: SettingsMarkArt,
	account: AccountMarkArt,
	appearance: AppearanceMarkArt,
	editor: EditorMarkArt,
	ai: AiMarkArt,
	audit: AuditMarkArt,
};

export type PageMarkArt = keyof typeof MARK_ART;

export function hasPageMark(id: string): id is PageMarkArt {
	return id in MARK_ART;
}

/** A page heading with its small drawing, the drawn stroke under its last word and a spark on it. */
export function PageMark({ art, text }: { art: PageMarkArt; text: string }): JSX.Element {
	const Art = MARK_ART[art];
	const cut = text.lastIndexOf(' ');
	const lead = cut < 0 ? '' : text.slice(0, cut + 1);
	const key = cut < 0 ? text : text.slice(cut + 1);
	return (
		<span className="page-mark">
			<Art />
			<span className="page-mark-word">
				{lead}
				<span className="mark-key">
					{key}
					<svg className="mark-swash" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true" focusable="false">
						<path d="M3 9C24 4 52 3 97 6" pathLength={1} />
					</svg>
					<svg className="ill mark-spark" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
						<path className="ill-spark" d="M10 2Q11.4 8.6 18 10Q11.4 11.4 10 18Q8.6 11.4 2 10Q8.6 8.6 10 2Z" />
					</svg>
				</span>
			</span>
		</span>
	);
}
