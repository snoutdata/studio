/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Orbit's WebGL scene.
 *
 * Everything three.js touches lives behind this class, so `OrbitView.tsx` stays a React component
 * that owns a canvas and a rail rather than a component that also owns a renderer. It and Liby's
 * 3D model (`@snout/liby`, the companion's package) are the only code in the app that imports three, each reached only through
 * its own lazily-loaded chunk — importing three from anywhere on the first-paint path would put
 * ~550KB into the launch and fail `e2e/startup.spec.ts`.
 *
 * Four things here are load-bearing rather than stylistic, and all four came out of building the
 * prototype rather than out of reasoning:
 *
 *  - EVERY NODE IS ONE POINT IN ONE CLOUD. A `Points` with per-node `size` and `glow` attributes
 *    and an additive sprite is one draw call for ten thousand objects; a mesh per node is ten
 *    thousand. The variety comes from size, colour and glow, never from geometry.
 *  - EVERY RELATION IS ONE SEGMENT IN ONE BUFFER, vertex-coloured. Same reason.
 *  - THE LOOK IS THE BLOOM PASS over additive blending. Brightness accumulates where objects
 *    overlap, and the bloom smears the hot cores; that is what makes a dense cluster read as a
 *    star rather than a pile of dots. Tonemapping has to come first or the cores clip to grey.
 *  - PICKING AND LABELS SHARE ONE PROJECTION PASS. Projecting every node once per frame and
 *    reading that cache three times is cheaper than three passes, and it is why hovering a
 *    relation cost nothing to add.
 *
 * Two things are deliberately NOT React's business. Labels are positioned by writing to DOM nodes
 * this class owns, because doing it through state would be a re-render every frame. Hover is
 * reported through a callback only when the hovered thing CHANGES, which is rare.
 *
 * The render loop is PAUSED whenever the Orbit tab is not the active one. The tab stays mounted
 * (recreating a WebGL context per switch is worse than keeping one) but a hidden canvas must not
 * cost a frame.
 *
 * SLOTS, AND WHY THIS FILE HAS TWO NUMBER SPACES. Above a few thousand objects the scene
 * no longer draws the whole graph: `shared/orbitLod.ts` decides what is worth drawing, and every
 * buffer here is indexed by its position in THAT list, a SLOT, not by node id. `nodeSlots[slot]`
 * is the node id and `slotOfNode[id]` is the slot or -1. Everything crossing the boundary (hover,
 * pick, focus, `firePath`, `touch`) speaks node and link IDS, because that is what `OrbitView.tsx`
 * and the graph model speak; everything inside a per-frame loop speaks slots. Mixing the two is
 * the one mistake this file can make silently, so the conversion happens at the edges and nowhere
 * else.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { hubs, type OrbitGraph } from '../../../shared/orbit';
import {
	createPickIndex,
	foldedChildren,
	foldedSize,
	lodFor,
	nearestLinkIn,
	starScale,
	visibleLinks,
	visibleNodes,
	type LodBudget,
	type PickIndex,
} from '../../../shared/orbitLod';
import type { OrbitPalette } from './palette';

/**
 * The slice of the layout the scene reads. Structural on purpose: the scene needs positions and
 * the settle/kick/relax verbs, and nothing about how a layout is constructed or tuned.
 */
export interface LayoutSource {
	readonly positions: Float32Array;
	readonly settled: boolean;
	step(): void;
	relax(): void;
	kick(node: number, strength?: number): void;
	excitedCount(): number;
	bounds(): { cx: number; cy: number; cz: number; radius: number };
}

/** What the rail can change about the light. */
export interface OrbitLight {
	bloomStrength: number;
	bloomThreshold: number;
	exposure: number;
}

/** What the rail can change about the matter. */
export interface OrbitMatter {
	nodeScale: number;
	linkOpacity: number;
}

export const DEFAULT_LIGHT: OrbitLight = {
	bloomStrength: 1.15,
	bloomThreshold: 0.42,
	exposure: 1.05,
};

export const DEFAULT_MATTER: OrbitMatter = {
	nodeScale: 1,
	linkOpacity: 0.34,
};

/** What the cursor is over. `kind` is null when it is over the void. */
export interface OrbitHover {
	kind: 'node' | 'link' | null;
	id: number;
}

/** What the scene is actually drawing, so the rail can tell the user what was folded. */
export interface OrbitStats {
	nodes: number;
	drawnNodes: number;
	links: number;
	drawnLinks: number;
	/** Packets travelling a relation right now. Pulse's own reading. */
	inFlight: number;
	/** What the renderer issued last frame. It is 1 for the world plus the passes, and it is the
	 *  number the whole "one draw call for N nodes" design exists to keep flat. */
	drawCalls: number;
	fps: number;
	lod: LodBudget;
}

const STAR_COUNT = 2600;
const LABEL_POOL = 40;
const HUB_LABELS = 16;
/** How far a press may travel and still count as a click rather than a camera drag, in CSS px. */
const CLICK_SLOP_PX = 4;
/** Screen-space pick radius in CSS pixels: generous for a table, tight for an index. */
const NODE_PICK_PX = 22;
const LINK_PICK_PX = 7;

/** No schema may produce a star bigger than this many CSS pixels, however close the camera gets. */
const MAX_POINT_PX = 40;
/**
 * How close two labels may be before the second is dropped, in CSS pixels.
 *
 * Vertically this is a fixed gap, because every label is one line of the same height. Horizontally
 * it cannot be: a label is a WORD, and `warehouse_location` occupies four times the width of
 * `user`. This used to be a symmetric 76px box on both axes, which let a 25-character name sit
 * 120px from a short one and print straight through it. The horizontal test measures the actual
 * name instead (`labelWidth`), and LABEL_GAP_X is only the breathing room added to it.
 */
const LABEL_GAP_X = 10;
const LABEL_GAP_Y = 22;
/** Width of one character of the label face, in CSS pixels. It is 10px monospace; see styles.css. */
const LABEL_CHAR_PX = 6;
/** What the CSS offsets a label by from its star (`transform: translate(9px, -50%)`). */
const LABEL_OFFSET_PX = 9;

/** A soft radial sprite, drawn once. Every star in the scene is this one texture. */
function starTexture(): THREE.Texture {
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (ctx) {
		const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
		grad.addColorStop(0.00, 'rgba(255,255,255,1)');
		grad.addColorStop(0.16, 'rgba(255,255,255,0.85)');
		grad.addColorStop(0.42, 'rgba(255,255,255,0.22)');
		grad.addColorStop(1.00, 'rgba(255,255,255,0)');
		ctx.fillStyle = grad;
		ctx.fillRect(0, 0, size, size);
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.needsUpdate = true;
	return texture;
}

const NODE_VERTEX = `
attribute vec3 acolor;
attribute float size;
attribute float glow;
uniform float scale;
uniform float pixelRatio;
uniform float world;
uniform float maxPoint;
varying vec3 vColor;
varying float vGlow;
void main() {
	vColor = acolor;
	vGlow = glow;
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	float px = size * scale * world * pixelRatio * (900.0 / max(1.0, -mv.z));
	gl_PointSize = clamp(px, pixelRatio, maxPoint * pixelRatio);
	gl_Position = projectionMatrix * mv;
}
`;

/*
 * `glow` carries BOTH directions: positive is a star lighting up, negative is one dimmed because
 * something else is isolated. They are not the same maths, and running the negative half through
 * the positive half's formula is what made isolating a table recolour the world. `mix` with a
 * negative factor EXTRAPOLATES past the colour (it subtracts white), and `1.0 + glow * 2.6` goes
 * negative at glow < -0.385 — so a dimmed gold star reached the composer's float target as a
 * negative colour, and ACES tonemapping turned that into magenta. The render target is float, so
 * nothing clamped it on the way.
 *
 * So: brighten with the positive half only, and dim by MULTIPLYING, which keeps the star its own
 * colour and can never leave [0, 1].
 */
const NODE_FRAGMENT = `
uniform sampler2D map;
uniform float ink;
varying vec3 vColor;
varying float vGlow;
void main() {
	vec4 t = texture2D(map, gl_PointCoord);
	float lit = max(vGlow, 0.0);
	float dim = clamp(1.0 + min(vGlow, 0.0), 0.0, 1.0);
	if (ink > 0.5) {
		// Ink on paper (a light theme): the dark mode's soft falloff, inverted in medium. A node is a
		// blot of its colour that deepens toward its core and fades to nothing at its edge, so a
		// dense cluster builds into a darker wash the way, in the void, cores build into a star.
		// (Hard discs with ink rings came first, and a big schema read as bubble wrap.) A hot node
		// deepens and thickens; a faded one goes transparent.
		float a = t.a;
		float hot = min(1.0, lit);
		vec3 c = mix(vColor, vColor * 0.5, a * a);
		c = mix(c, vColor * 0.4, hot * 0.6);
		gl_FragColor = vec4(c, min(1.0, a * (0.78 + hot * 0.4)) * dim);
		return;
	}
	vec3 c = mix(vColor, vec3(1.0), min(1.0, lit * 0.85));
	gl_FragColor = vec4(c * (1.0 + lit * 2.6) * dim, 1.0) * t.a;
}
`;

/** One statement in flight along one relation. */
interface Packet {
	link: number;
	from: number;
	t: number;
	speed: number;
}

export class OrbitScene {
	private readonly renderer: THREE.WebGLRenderer;
	private readonly scene = new THREE.Scene();
	private readonly camera: THREE.PerspectiveCamera;
	private readonly controls: OrbitControls;
	private readonly composer: EffectComposer;
	private readonly bloom: UnrealBloomPass;
	private readonly sprite: THREE.Texture;
	private readonly backdrop: THREE.Points;
	private readonly backdropMaterial: THREE.PointsMaterial;
	private readonly colour = new THREE.Color();

	private palette: OrbitPalette | null = null;
	/** Drawing as ink on a light ground rather than light in a void (OrbitPalette.ink). */
	private ink = false;
	private matter: OrbitMatter = { ...DEFAULT_MATTER };

	private graph: OrbitGraph | null = null;
	private layout: LayoutSource | null = null;

	// What this size of graph is allowed to draw, and the two number spaces it creates.
	private budget: LodBudget = lodFor(0, 0);
	/** Slot -> node id. */
	private nodeSlots: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
	/** Node id -> slot, or -1 when the node is folded away. */
	private slotOfNode = new Int32Array(0);
	/** Slot -> link id. */
	private linkSlots: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
	/** Link id -> slot, or -1. */
	private slotOfLink = new Int32Array(0);
	/** Two node SLOTS per drawn link, which is what picking and the position write both want. */
	private linkEnds = new Int32Array(0);
	/** Per slot: 1 for an index, which is all `nearestNode` needs to know about kind. */
	private kinds = new Uint8Array(0);
	/** True when every node is drawn and slot === id, which lets several passes skip a lookup. */
	private identity = true;
	/** False for a single-schema database, where `schema.` on every label is a wasted word. */
	private qualifyLabels = true;
	/** True once the world scale has been recomputed against the SETTLED layout. */
	private worldFixed = false;
	/** Set when the layout came back non-finite, so the rail can say so instead of showing void. */
	private layoutWarning: string | null = null;

	// The node cloud.
	private nodeGeometry: THREE.BufferGeometry | null = null;
	private nodeMaterial: THREE.ShaderMaterial | null = null;
	private nodeCloud: THREE.Points | null = null;
	private sizes = new Float32Array(0);
	private glows = new Float32Array(0);
	private colours = new Float32Array(0);
	/** Per slot: how much traffic it has just taken, decaying every frame. */
	private activity = new Float32Array(0);
	/** Per slot: how bright it sits when nothing is happening (hubs run warm). */
	private idle = new Float32Array(0);
	/** Per slot: 1 while the focus has dimmed it. Precomputed, so the glow pass has no Set. */
	private dimmed = new Uint8Array(0);
	/** The compacted position buffer. Aliases the layout's own array when nothing was folded. */
	private drawPositions: Float32Array<ArrayBufferLike> = new Float32Array(0);

	// The relation buffer.
	private linkGeometry: THREE.BufferGeometry | null = null;
	private linkMaterial: THREE.LineBasicMaterial | null = null;
	private linkLines: THREE.LineSegments | null = null;
	private linkPositions = new Float32Array(0);
	private linkColours = new Float32Array(0);
	/** Per drawn link: how much has flowed down it lately, decaying. */
	private traffic = new Float32Array(0);
	/** Per drawn link: 1 when the focus has left it lit. Precomputed for the same reason. */
	private linkLit = new Uint8Array(0);

	// Packets.
	private packetGeometry: THREE.BufferGeometry | null = null;
	private packetMaterial: THREE.PointsMaterial | null = null;
	private packetPoints: THREE.Points | null = null;
	private packetPositions = new Float32Array(0);
	private packets: Packet[] = [];

	// The shared projection cache, per SLOT: screen x, screen y, and whether it is drawable.
	private screenX = new Float32Array(0);
	private screenY = new Float32Array(0);
	private onScreen = new Uint8Array(0);
	private readonly pick: PickIndex = createPickIndex();
	private readonly viewProjection = new THREE.Matrix4();

	private labelHost: HTMLElement | null = null;
	private labelElements: HTMLElement[] = [];
	/** Both hold SLOTS: they are read by the label pass, which only indexes the projection cache. */
	private hubSlots: number[] = [];
	private focusLabels: number[] = [];
	/** Which slots survived this frame's crowding pass. Reused rather than reallocated. */
	private readonly labelShown: number[] = [];
	/** Their widths, indexed alongside, so the crowding test is not re-measuring what it kept. */
	private readonly labelWidths: number[] = [];
	private showLabels = true;

	/** Node id, not slot: the focus is a thing in the database, not a thing in a buffer. */
	private focus = -1;
	private neighbourhood: Set<number> | null = null;
	/** Slots, because they are read by the glow and label passes every frame. */
	private hoverNode = -1;
	private hoverLink = -1;
	private pointerX = -1e4;
	private pointerY = -1e4;
	private pointerLive = false;
	/** Where the current press started, in client space, so a drag can be told from a click. */
	private pressX = 0;
	private pressY = 0;

	private fly: { t: number; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; fromPos: THREE.Vector3; toPos: THREE.Vector3 } | null = null;

	private frameHandle = 0;
	private frameCount = 0;
	/** A rolling frame rate, averaged over about half a second so the readout is legible. */
	private fps = 0;
	private fpsFrames = 0;
	private fpsSince = 0;
	private running = false;
	private disposed = false;

	/** Reported only when the hovered thing changes, so React re-renders on a hover, not a frame. */
	onHover: ((hover: OrbitHover) => void) | null = null;
	/** A click that landed on a node (or -1 for the void). */
	onPick: ((hover: OrbitHover) => void) | null = null;

	constructor(private readonly canvas: HTMLCanvasElement, private readonly reducedMotion: boolean) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = DEFAULT_LIGHT.exposure;
		// Count draw calls across the WHOLE frame rather than the last pass of it. three.js resets
		// its counters at the top of every `render()`, and the composer renders several times, so
		// the default would report the bloom's final fullscreen quad and nothing else: a constant 1
		// that happens to look like the answer we want. Reset once per frame instead.
		this.renderer.info.autoReset = false;

		this.camera = new THREE.PerspectiveCamera(52, 1, 1, 8000);
		this.camera.position.set(880, 400, 1240);

		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.06;
		this.controls.rotateSpeed = 0.5;
		this.controls.zoomSpeed = 0.85;
		this.controls.minDistance = 30;
		this.controls.maxDistance = 4000;
		this.controls.autoRotate = !reducedMotion;
		this.controls.autoRotateSpeed = 0.22;

		this.sprite = starTexture();

		// The far backdrop. Not data: it is what stops an empty region reading as a broken canvas,
		// and it gives the eye something to parallax against while the camera drifts.
		const positions = new Float32Array(STAR_COUNT * 3);
		for (let i = 0; i < STAR_COUNT; i++) {
			const radius = 2200 + Math.random() * 2200;
			const theta = Math.random() * Math.PI * 2;
			const phi = Math.acos(2 * Math.random() - 1);
			positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
			positions[i * 3 + 1] = radius * Math.cos(phi);
			positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
		}
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		this.backdropMaterial = new THREE.PointsMaterial({
			size: 1.5,
			sizeAttenuation: false,
			map: this.sprite,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		this.backdrop = new THREE.Points(geometry, this.backdropMaterial);
		this.backdrop.frustumCulled = false;
		this.scene.add(this.backdrop);

		this.composer = new EffectComposer(this.renderer);
		this.composer.addPass(new RenderPass(this.scene, this.camera));
		this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), DEFAULT_LIGHT.bloomStrength, 0.66, DEFAULT_LIGHT.bloomThreshold);
		this.composer.addPass(this.bloom);

		canvas.addEventListener('pointerdown', this.handlePointerDown);
		canvas.addEventListener('pointermove', this.handlePointerMove);
		canvas.addEventListener('pointerleave', this.handlePointerLeave);
		canvas.addEventListener('click', this.handleClick);

		this.resize();
	}

	private readonly handlePointerDown = (event: PointerEvent): void => {
		this.pressX = event.clientX;
		this.pressY = event.clientY;
	};

	private readonly handlePointerMove = (event: PointerEvent): void => {
		const rect = this.canvas.getBoundingClientRect();
		this.pointerX = event.clientX - rect.left;
		this.pointerY = event.clientY - rect.top;
		this.pointerLive = true;
	};

	private readonly handlePointerLeave = (): void => {
		this.pointerLive = false;
	};

	/**
	 * A click picks. A DRAG does not, however it ends.
	 *
	 * The browser fires `click` at the end of any press-and-release on the canvas, and orbiting the
	 * camera is exactly that, so letting go of a drag over a star used to isolate it. You cannot
	 * turn the world round without landing on something. The test is distance, not time: a slow
	 * deliberate click is still a click, and a fast flick is still a drag.
	 */
	private readonly handleClick = (event: MouseEvent): void => {
		const travelled = Math.hypot(event.clientX - this.pressX, event.clientY - this.pressY);
		if (travelled > CLICK_SLOP_PX) {
			return;
		}
		this.onPick?.(this.hovered());
	};

	/** The hover, converted out of slot space into the ids the rest of the app speaks. */
	private hovered(): OrbitHover {
		if (this.hoverNode >= 0) {
			return { kind: 'node', id: this.nodeSlots[this.hoverNode] };
		}
		if (this.hoverLink >= 0) {
			return { kind: 'link', id: this.linkSlots[this.hoverLink] };
		}
		return { kind: null, id: -1 };
	}

	/* ---------------------------------------------------------------- graph */

	/** Hand the scene a database. Rebuilds every buffer; safe to call again on a schema refresh. */
	setGraph(graph: OrbitGraph, layout: LayoutSource): void {
		this.disposeGraph();
		this.graph = graph;
		this.layout = layout;
		this.budget = lodFor(graph.nodes.length, graph.links.length);
		this.layoutWarning = null;
		this.worldFixed = false;
		this.packets = [];
		this.focus = -1;
		this.neighbourhood = null;
		this.focusLabels = [];
		this.hoverNode = -1;
		this.hoverLink = -1;

		// Past the ceiling nothing is built at all. Refusing in one line beats a window that stops
		// answering for a minute and then shows a smear, and `stats().lod.note` is the sentence
		// the rail puts on screen instead.
		if (this.budget.ceiling) {
			this.nodeSlots = new Uint32Array(0);
			this.linkSlots = new Uint32Array(0);
			this.slotOfNode = new Int32Array(graph.nodes.length).fill(-1);
			this.slotOfLink = new Int32Array(graph.links.length).fill(-1);
			this.linkEnds = new Int32Array(0);
			this.kinds = new Uint8Array(0);
			this.dimmed = new Uint8Array(0);
			this.linkLit = new Uint8Array(0);
			this.activity = new Float32Array(0);
			this.screenX = new Float32Array(0);
			this.screenY = new Float32Array(0);
			this.onScreen = new Uint8Array(0);
			this.hubSlots = [];
			this.buildLabelPool();
			return;
		}

		this.nodeSlots = visibleNodes(graph, this.budget);
		this.linkSlots = visibleLinks(graph, this.budget, this.nodeSlots);
		const drawnNodes = this.nodeSlots.length;
		const drawnLinks = this.linkSlots.length;

		this.slotOfNode = new Int32Array(graph.nodes.length).fill(-1);
		for (let slot = 0; slot < drawnNodes; slot++) {
			this.slotOfNode[this.nodeSlots[slot]] = slot;
		}
		this.slotOfLink = new Int32Array(graph.links.length).fill(-1);
		this.linkEnds = new Int32Array(drawnLinks * 2);
		for (let slot = 0; slot < drawnLinks; slot++) {
			const link = graph.links[this.linkSlots[slot]];
			this.slotOfLink[link.id] = slot;
			this.linkEnds[slot * 2] = this.slotOfNode[link.a];
			this.linkEnds[slot * 2 + 1] = this.slotOfNode[link.b];
		}
		this.identity = drawnNodes === graph.nodes.length;
		// One cluster means every label would start with the same word.
		this.qualifyLabels = graph.clusters.length > 1;

		this.sizes = new Float32Array(drawnNodes);
		this.glows = new Float32Array(drawnNodes);
		this.colours = new Float32Array(drawnNodes * 3);
		this.activity = new Float32Array(drawnNodes);
		this.idle = new Float32Array(drawnNodes);
		this.dimmed = new Uint8Array(drawnNodes);
		this.kinds = new Uint8Array(drawnNodes);
		this.screenX = new Float32Array(drawnNodes);
		this.screenY = new Float32Array(drawnNodes);
		this.onScreen = new Uint8Array(drawnNodes);

		// Fold, do not drop: an index that lost its own star is added to the size of the table it
		// belongs to, so a heavily indexed table stays the big object it is in the schema.
		const folded = foldedChildren(graph, this.nodeSlots);
		for (let slot = 0; slot < drawnNodes; slot++) {
			const id = this.nodeSlots[slot];
			const node = graph.nodes[id];
			this.sizes[slot] = foldedSize(baseSize(graph, id), folded[slot]);
			this.kinds[slot] = node.kind === 'index' ? 1 : 0;
			// A hub runs warm even at rest, so the bloom always has cores to bite on.
			this.idle[slot] = node.kind === 'table' ? Math.min(0.6, Math.max(0, node.fkDegree - 4) * 0.09) : 0;
		}

		// Nothing folded means the layout's own array IS the draw buffer, and the per-frame copy
		// disappears with it. That is the common case, because most databases are small.
		this.drawPositions = this.identity ? layout.positions : new Float32Array(drawnNodes * 3);

		this.nodeGeometry = new THREE.BufferGeometry();
		this.nodeGeometry.setAttribute('position', new THREE.BufferAttribute(this.drawPositions, 3));
		this.nodeGeometry.setAttribute('acolor', new THREE.BufferAttribute(this.colours, 3));
		this.nodeGeometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
		this.nodeGeometry.setAttribute('glow', new THREE.BufferAttribute(this.glows, 1));

		this.nodeMaterial = new THREE.ShaderMaterial({
			uniforms: {
				map: { value: this.sprite },
				scale: { value: this.matter.nodeScale * this.inkScale() },
				pixelRatio: { value: this.renderer.getPixelRatio() },
				world: { value: starScale(layout.bounds().radius) },
				maxPoint: { value: MAX_POINT_PX },
				ink: { value: this.ink ? 1 : 0 },
			},
			vertexShader: NODE_VERTEX,
			fragmentShader: NODE_FRAGMENT,
			blending: this.ink ? THREE.NormalBlending : THREE.AdditiveBlending,
			depthWrite: false,
			transparent: true,
		});
		this.nodeCloud = new THREE.Points(this.nodeGeometry, this.nodeMaterial);
		this.nodeCloud.frustumCulled = false;
		this.scene.add(this.nodeCloud);

		this.linkPositions = new Float32Array(drawnLinks * 6);
		this.linkColours = new Float32Array(drawnLinks * 6);
		this.traffic = new Float32Array(drawnLinks);
		this.linkLit = new Uint8Array(drawnLinks).fill(1);
		this.linkGeometry = new THREE.BufferGeometry();
		this.linkGeometry.setAttribute('position', new THREE.BufferAttribute(this.linkPositions, 3));
		this.linkGeometry.setAttribute('color', new THREE.BufferAttribute(this.linkColours, 3));
		this.linkMaterial = new THREE.LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: this.matter.linkOpacity,
			blending: this.ink ? THREE.NormalBlending : THREE.AdditiveBlending,
			depthWrite: false,
		});
		this.linkLines = new THREE.LineSegments(this.linkGeometry, this.linkMaterial);
		this.linkLines.frustumCulled = false;
		this.scene.add(this.linkLines);

		const packetCap = Math.max(256, Math.min(2000, drawnLinks));
		this.packetPositions = new Float32Array(packetCap * 3);
		this.packetGeometry = new THREE.BufferGeometry();
		this.packetGeometry.setAttribute('position', new THREE.BufferAttribute(this.packetPositions, 3));
		this.packetGeometry.setDrawRange(0, 0);
		this.packetMaterial = new THREE.PointsMaterial({
			// `sizeAttenuation` makes this a WORLD size, so it scales with the world for the same
			// reason the stars do: 5.5 units is a speck in a 900-unit galaxy and a boulder in a
			// 70-unit one.
			size: 5.5 * starScale(layout.bounds().radius),
			sizeAttenuation: true,
			map: this.sprite,
			transparent: true,
			depthWrite: false,
			blending: this.ink ? THREE.NormalBlending : THREE.AdditiveBlending,
		});
		this.packetPoints = new THREE.Points(this.packetGeometry, this.packetMaterial);
		this.packetPoints.frustumCulled = false;
		this.scene.add(this.packetPoints);

		// Only nodes that are DRAWN can carry a label, and the budget decides how many.
		this.hubSlots = hubs(graph, Math.min(HUB_LABELS, this.budget.labels))
			.map((id) => this.slotOfNode[id])
			.filter((slot) => slot >= 0);
		this.buildLabelPool();
		this.writePositions();
		if (this.palette) {
			this.setPalette(this.palette);
		}
		this.frameCamera();
	}

	/**
	 * Where the camera belongs to see the whole database, whatever size it turned out to be.
	 *
	 * Separate from `frameCamera` because two callers want the same answer and only one of them
	 * wants it applied instantly: opening a database cuts to it, and `resetView` flies to it.
	 */
	private framePose(): { target: THREE.Vector3; position: THREE.Vector3 } | null {
		if (!this.layout) {
			return null;
		}
		const { cx, cy, cz, radius } = this.layout.bounds();
		// A force layout can diverge (it does, above roughly 2,500 relations on ONE node) and hand
		// back a non-finite radius. Framing on that puts the camera at NaN and the window goes
		// black with no error, which is the worst of all the ways to fail. Frame on a default
		// instead and let `stats()` say what happened.
		if (!Number.isFinite(radius) || !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) {
			this.layoutWarning = "The layout did not converge for this schema, so positions here are approximate. Isolating a table still works.";
			return { target: new THREE.Vector3(0, 0, 0), position: new THREE.Vector3(880, 400, 1240) };
		}
		const distance = this.worldDistance();
		return {
			target: new THREE.Vector3(cx, cy, cz),
			position: new THREE.Vector3(cx + distance * 0.55, cy + distance * 0.28, cz + distance * 0.79),
		};
	}

	/**
	 * How far out the whole database is framed from. Shared with `flyTo`, which uses it as a
	 * ceiling, so "the opening frame" is one number and the two cannot drift apart.
	 *
	 * The floor is only here to stop a degenerate radius putting the camera inside the near plane.
	 * It used to be 240, which for a one-schema database (radius ~36) meant the camera sat two and
	 * a half times further out than the framing wanted and the whole galaxy was a small smudge in
	 * the middle of the tab. 40 is still forty times the near plane.
	 */
	private worldDistance(): number {
		const radius = this.layout?.bounds().radius ?? 0;
		return Number.isFinite(radius) ? Math.max(40, radius * 2.6) : 1600;
	}

	/** Sit far enough out to see the whole database, whatever size it turned out to be. */
	private frameCamera(): void {
		const pose = this.framePose();
		if (!pose) {
			return;
		}
		this.fly = null;
		this.controls.target.copy(pose.target);
		this.camera.position.copy(pose.position);
		this.controls.update();
	}

	/** What is on screen, and what was folded to get it there. */
	stats(): OrbitStats {
		const lod = this.layoutWarning
			? { ...this.budget, note: this.layoutWarning }
			: this.budget;
		return {
			nodes: this.graph?.nodes.length ?? 0,
			drawnNodes: this.nodeSlots.length,
			links: this.graph?.links.length ?? 0,
			drawnLinks: this.linkSlots.length,
			inFlight: this.packets.length,
			drawCalls: this.renderer.info.render.calls,
			fps: Math.round(this.fps),
			lod,
		};
	}

	/* -------------------------------------------------------------- palette */

	setPalette(palette: OrbitPalette): void {
		this.palette = palette;
		this.setInk(palette.ink);
		this.scene.background = this.colour.setStyle(palette.bg).clone();
		this.backdropMaterial.color.setStyle(palette.star);
		this.packetMaterial?.color.setStyle(palette.packet);
		// The link material's own colour stays WHITE. `vertexColors` MULTIPLIES it by the per-vertex
		// colour, and `paintLinks` already writes the palette's link colour into every vertex, so
		// tinting the material too squared it: `--border` is dark, dark squared is nearly black, and
		// at 0.34 opacity over a dark ground the filaments simply were not there. Foreign keys
		// existed, were picked, were hovered and drew nothing.
		if (this.linkMaterial) {
			this.linkMaterial.color.setRGB(1, 1, 1);
		}
		if (!this.graph || !this.nodeGeometry) {
			return;
		}
		for (let slot = 0; slot < this.nodeSlots.length; slot++) {
			this.colour.setStyle(kindColour(palette, this.graph.nodes[this.nodeSlots[slot]].kind));
			this.colours[slot * 3] = this.colour.r;
			this.colours[slot * 3 + 1] = this.colour.g;
			this.colours[slot * 3 + 2] = this.colour.b;
		}
		this.nodeGeometry.attributes.acolor.needsUpdate = true;
		this.paintLinks();
	}

	/**
	 * Light in a void, or ink on paper. The look in the header comment (additive blending under a
	 * bloom pass) is the DARK half: on a light ground additive light adds nearly nothing, so a light
	 * theme draws the same world with normal blending, no bloom and no tone mapping, the dark ink
	 * of the theme's own tokens on its own pale ground.
	 */
	private setInk(ink: boolean): void {
		if (ink === this.ink) {
			return;
		}
		this.ink = ink;
		const blending = ink ? THREE.NormalBlending : THREE.AdditiveBlending;
		for (const material of [this.backdropMaterial, this.nodeMaterial, this.linkMaterial, this.packetMaterial]) {
			if (material) {
				material.blending = blending;
				material.needsUpdate = true;
			}
		}
		if (this.nodeMaterial) {
			this.nodeMaterial.uniforms.ink.value = ink ? 1 : 0;
			this.nodeMaterial.uniforms.scale.value = this.matter.nodeScale * this.inkScale();
		}
		// The backdrop's specks are a field of distant stars in the void; on paper they are a faint
		// grain, so they are kept, lighter.
		this.backdropMaterial.opacity = ink ? 0.35 : 1;
		this.bloom.enabled = !ink;
		this.renderer.toneMapping = ink ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
	}

	/** Ink nodes are drawn a little larger: in the void the bloom spreads a node's light past its
	 *  point, and on paper nothing does, so the blot's own falloff makes up the difference. */
	private inkScale(): number {
		return this.ink ? 1.35 : 1;
	}

	setLight(light: OrbitLight): void {
		this.bloom.strength = light.bloomStrength;
		this.bloom.threshold = light.bloomThreshold;
		this.renderer.toneMappingExposure = light.exposure;
	}

	setMatter(matter: OrbitMatter): void {
		this.matter = matter;
		if (this.nodeMaterial) {
			this.nodeMaterial.uniforms.scale.value = matter.nodeScale * this.inkScale();
		}
		if (this.linkMaterial) {
			this.linkMaterial.opacity = matter.linkOpacity;
		}
	}

	setDrift(on: boolean): void {
		this.controls.autoRotate = on && !this.reducedMotion;
	}

	setLabelsVisible(on: boolean): void {
		this.showLabels = on;
	}

	/* ---------------------------------------------------------------- focus */

	/** Isolate a node's neighbourhood and fly to it. -1 clears. Ids, not slots. */
	setFocus(node: number, neighbourhood: Set<number> | null): void {
		this.focus = node;
		this.lit(node < 0 ? null : neighbourhood);
		if (node >= 0) {
			this.flyTo(node, this.neighbourhood);
		}
	}

	/**
	 * Light a SET of objects and dim the rest, without isolating any one of them and without
	 * moving the camera. This is what the rail's search does: a query names several tables and
	 * their neighbours, and there is no single thing to fly to.
	 *
	 * It shares every byte of its machinery with `setFocus` because it is the same operation seen
	 * from a different door. What it does NOT share is `this.focus`, which stays -1: nothing is
	 * isolated, so nothing gets the focused star's extra glow.
	 */
	setSpotlight(ids: Set<number> | null): void {
		if (this.focus >= 0) {
			return;
		}
		this.lit(ids);
	}

	/** Resolve a set of node ids into the per-slot dim/lit flags every frame reads. */
	private lit(ids: Set<number> | null): void {
		this.neighbourhood = ids && ids.size > 0 ? ids : null;
		this.focusLabels = [];
		if (this.graph && this.neighbourhood) {
			this.focusLabels = [...this.neighbourhood]
				.filter((id) => this.graph!.nodes[id].kind !== 'index' && this.slotOfNode[id] >= 0)
				.sort((a, b) => this.graph!.nodes[b].fkDegree - this.graph!.nodes[a].fkDegree)
				.slice(0, Math.max(0, Math.min(LABEL_POOL - 4, this.budget.labels)))
				.map((id) => this.slotOfNode[id]);
		}
		// The Set is resolved into per-slot flags HERE rather than being asked once per node per
		// frame. At 30k objects that is 1.8 million Set lookups a second turned into one pass.
		this.dimmed.fill(0);
		this.linkLit.fill(1);
		if (this.graph && this.neighbourhood) {
			for (let slot = 0; slot < this.nodeSlots.length; slot++) {
				this.dimmed[slot] = this.neighbourhood.has(this.nodeSlots[slot]) ? 0 : 1;
			}
			for (let slot = 0; slot < this.linkSlots.length; slot++) {
				const link = this.graph.links[this.linkSlots[slot]];
				this.linkLit[slot] = this.neighbourhood.has(link.a) && this.neighbourhood.has(link.b) ? 1 : 0;
			}
		}
		this.paintLinks();
	}

	/**
	 * Put the camera back where Orbit opened it: the whole world, framed, centred on its own
	 * bounds. It FLIES rather than cutting, through the same interpolation `flyTo` uses, because a
	 * camera that teleports loses the one thing a 3D view has, which is the viewer's sense of
	 * where they just were.
	 */
	resetView(): void {
		const pose = this.framePose();
		if (!pose) {
			return;
		}
		this.fly = {
			t: 0,
			fromTarget: this.controls.target.clone(),
			toTarget: pose.target,
			fromPos: this.camera.position.clone(),
			toPos: pose.position,
		};
	}

	/**
	 * Fly to a node and stop far enough out to hold its neighbourhood in frame.
	 *
	 * The distance is measured from the neighbourhood itself rather than being a constant. It used
	 * to be a flat 190 world units, which is the same mistake the star size and the opening camera
	 * both made: an absolute length in a world whose radius runs from tens of units to thousands.
	 * On a small database 190 units is FURTHER out than the opening frame, so clicking a table
	 * zoomed out, shrank the galaxy to a knot and piled every neighbour's name on top of the next.
	 * Framing the neighbourhood means a leaf table gets close and a hub with two hundred relations
	 * backs off, at any scale.
	 */
	private flyTo(node: number, neighbourhood: Set<number> | null): void {
		if (!this.layout) {
			return;
		}
		const positions = this.layout.positions;
		const target = new THREE.Vector3(positions[node * 3], positions[node * 3 + 1], positions[node * 3 + 2]);
		let reach = 0;
		if (neighbourhood) {
			for (const id of neighbourhood) {
				const dx = positions[id * 3] - target.x;
				const dy = positions[id * 3 + 1] - target.y;
				const dz = positions[id * 3 + 2] - target.z;
				const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
				if (Number.isFinite(distance) && distance > reach) {
					reach = distance;
				}
			}
		}
		const radius = this.layout.bounds().radius;
		// A node with no relations has no reach of its own, so it borrows a fraction of the world.
		if (reach <= 0) {
			reach = Number.isFinite(radius) ? radius * 0.18 : 60;
		}
		// The floor is the near plane's business, not the schema's. The CEILING is the whole
		// database framed: `reach` is measured from the NODE, not across the neighbourhood, so a
		// table on the rim wired to one on the far side has a reach of about the world's DIAMETER,
		// and 2.4x that put the camera nearly twice as far out as the opening frame. Isolating a
		// border table therefore zoomed out and halved the galaxy, which is the flat-190 bug over
		// again in a measurement that looked like it had fixed it. There is never a reason to sit
		// further out than "the whole database, framed", so that is the cap.
		const distance = Math.min(Math.max(24, reach * 2.4), this.worldDistance());
		const direction = this.camera.position.clone().sub(this.controls.target).normalize();
		this.fly = {
			t: 0,
			fromTarget: this.controls.target.clone(),
			toTarget: target,
			fromPos: this.camera.position.clone(),
			toPos: target.clone().add(direction.multiplyScalar(distance)),
		};
	}

	/* ---------------------------------------------------------------- pulse */

	/**
	 * Send packets down a path of relations. `path` is link ids in travel order, each paired with
	 * the node the packet leaves FROM, so a relation can be traversed in either direction.
	 */
	firePath(path: Array<{ link: number; from: number }>, weight = 1): void {
		if (!this.graph || this.packetPositions.length === 0) {
			return;
		}
		const cap = this.packetPositions.length / 3;
		path.forEach((hop, index) => {
			// A relation folded away by the LOD carries no packets: there is no filament to send
			// them down, and the tables at either end still light through `touch`.
			const linkSlot = this.slotOfLink[hop.link] ?? -1;
			if (linkSlot < 0) {
				return;
			}
			this.traffic[linkSlot] = Math.min(1, this.traffic[linkSlot] + 0.3 * weight);
			const count = 3 + Math.round(3 * weight);
			for (let i = 0; i < count; i++) {
				if (this.packets.length >= cap) {
					return;
				}
				this.packets.push({
					link: hop.link,
					from: hop.from,
					t: -index * 0.35 - i * 0.055,
					speed: 0.5 + Math.random() * 0.4,
				});
			}
		});
	}

	/** Light one node without any path: what an app-local statement against a single table does. */
	touch(node: number, amount = 0.7): void {
		if (!this.graph || node < 0 || node >= this.graph.nodes.length) {
			return;
		}
		// Fold, do not drop, applied to Pulse: a folded object's traffic lights the table it was
		// folded into, so a statement against an index still makes something happen on screen.
		let slot = this.slotOfNode[node];
		if (slot < 0) {
			const parent = this.graph.nodes[node].parent;
			slot = parent === undefined ? -1 : this.slotOfNode[parent];
		}
		if (slot < 0) {
			return;
		}
		this.activity[slot] = Math.min(1.6, this.activity[slot] + amount);
		this.layout?.kick(this.nodeSlots[slot]);
	}

	/* ---------------------------------------------------------------- paint */

	private paintLinks(): void {
		if (!this.graph || !this.linkGeometry || !this.palette) {
			return;
		}
		const base = new THREE.Color(this.palette.link);
		const hot = new THREE.Color(this.palette.linkHot);
		for (let slot = 0; slot < this.linkSlots.length; slot++) {
			const link = this.graph.links[this.linkSlots[slot]];
			const lit = this.linkLit[slot] === 1;
			const heat = link.kind === 'fk' ? 0.25 + this.traffic[slot] * 0.75 : 0.12;
			this.colour.copy(base).lerp(hot, lit ? heat : 0.02);
			if (!lit) {
				this.colour.multiplyScalar(0.14);
			}
			if (slot === this.hoverLink) {
				this.colour.setStyle(this.palette.linkHot);
			}
			for (let end = 0; end < 2; end++) {
				const offset = slot * 6 + end * 3;
				this.linkColours[offset] = this.colour.r;
				this.linkColours[offset + 1] = this.colour.g;
				this.linkColours[offset + 2] = this.colour.b;
			}
		}
		this.linkGeometry.attributes.color.needsUpdate = true;
	}

	private writePositions(): void {
		if (!this.layout || !this.linkGeometry || !this.nodeGeometry) {
			return;
		}
		const positions = this.layout.positions;
		// When nothing was folded, `drawPositions` IS the layout's array and there is nothing to
		// compact; otherwise the drawn nodes are gathered into their own buffer.
		if (!this.identity) {
			for (let slot = 0; slot < this.nodeSlots.length; slot++) {
				const source = this.nodeSlots[slot] * 3;
				const target = slot * 3;
				this.drawPositions[target] = positions[source];
				this.drawPositions[target + 1] = positions[source + 1];
				this.drawPositions[target + 2] = positions[source + 2];
			}
		}
		for (let slot = 0; slot < this.linkSlots.length; slot++) {
			const offset = slot * 6;
			const a = this.linkEnds[slot * 2] * 3;
			const b = this.linkEnds[slot * 2 + 1] * 3;
			this.linkPositions[offset] = this.drawPositions[a];
			this.linkPositions[offset + 1] = this.drawPositions[a + 1];
			this.linkPositions[offset + 2] = this.drawPositions[a + 2];
			this.linkPositions[offset + 3] = this.drawPositions[b];
			this.linkPositions[offset + 4] = this.drawPositions[b + 1];
			this.linkPositions[offset + 5] = this.drawPositions[b + 2];
		}
		this.linkGeometry.attributes.position.needsUpdate = true;
		this.nodeGeometry.attributes.position.needsUpdate = true;
	}

	/* -------------------------------------------------------------- picking */

	/**
	 * Project every DRAWN node once, then bucket the result.
	 *
	 * Three things here make it scale. The view-projection matrix is combined once and
	 * applied once per node, instead of `Vector3.project` applying two matrices per node. Anything
	 * behind the camera or well outside the viewport is marked not-drawable before the viewport
	 * map, which is the frustum cull for picking and labels alike. And the result goes straight
	 * into the pick grid, so the two scans that used to walk the whole graph become a lookup.
	 *
	 * The 1.4 margin rather than 1.0 is deliberate: a filament between two tables just off screen
	 * still crosses the view, and clipping its endpoints out would make it unhoverable.
	 */
	private projectAll(): void {
		if (!this.graph || !this.layout || this.nodeSlots.length === 0) {
			return;
		}
		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;
		const halfWidth = width / 2;
		const halfHeight = height / 2;
		this.camera.updateMatrixWorld();
		this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
		this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
		// three's Matrix4 is column-major, so the w row is elements 3, 7, 11, 15.
		const m = this.viewProjection.elements;
		const positions = this.drawPositions;
		for (let slot = 0; slot < this.nodeSlots.length; slot++) {
			const p = slot * 3;
			const x = positions[p];
			const y = positions[p + 1];
			const z = positions[p + 2];
			const w = m[3] * x + m[7] * y + m[11] * z + m[15];
			if (w <= 0) {
				this.onScreen[slot] = 0;
				continue;
			}
			const inverse = 1 / w;
			const ndcX = (m[0] * x + m[4] * y + m[8] * z + m[12]) * inverse;
			const ndcY = (m[1] * x + m[5] * y + m[9] * z + m[13]) * inverse;
			if (ndcX < -1.4 || ndcX > 1.4 || ndcY < -1.4 || ndcY > 1.4) {
				this.onScreen[slot] = 0;
				continue;
			}
			this.onScreen[slot] = 1;
			this.screenX[slot] = ndcX * halfWidth + halfWidth;
			this.screenY[slot] = -ndcY * halfHeight + halfHeight;
		}
		this.pick.rebuild(this.screenX, this.screenY, this.onScreen, this.nodeSlots.length, width, height);
	}

	private nearestNode(): number {
		if (!this.pointerLive || this.nodeSlots.length === 0) {
			return -1;
		}
		return this.pick.nearestNode(this.pointerX, this.pointerY, NODE_PICK_PX, this.kinds, this.screenX, this.screenY, this.budget.pickBudget);
	}

	/**
	 * A scan, and `shared/orbitLod.ts` says why: a spatial index over SEGMENTS costs more to
	 * rebuild each frame than this costs to run. What makes it affordable is that it runs over the
	 * drawn relations rather than all of them, and rejects on a bounding box before any square
	 * root.
	 */
	private nearestLink(): number {
		if (!this.pointerLive || this.linkSlots.length === 0) {
			return -1;
		}
		// An isolated neighbourhood only offers its own relations, the way it always has.
		const eligible = this.neighbourhood ? this.linkLit : undefined;
		return nearestLinkIn(this.pointerX, this.pointerY, LINK_PICK_PX, this.linkEnds, this.screenX, this.screenY, this.onScreen, eligible);
	}

	/* --------------------------------------------------------------- labels */

	setLabelHost(host: HTMLElement | null): void {
		this.labelHost = host;
		this.buildLabelPool();
	}

	private buildLabelPool(): void {
		if (!this.labelHost) {
			return;
		}
		this.labelHost.textContent = '';
		this.labelElements = [];
		// The pool is the SMALLER of the fixed pool and what this size of graph may label, so a
		// warehouse does not put four hundred words over a cloud of stars.
		const size = Math.min(LABEL_POOL, Math.max(0, this.budget.labels) + 3);
		for (let i = 0; i < size; i++) {
			const element = document.createElement('b');
			element.style.display = 'none';
			this.labelHost.appendChild(element);
			this.labelElements.push(element);
		}
	}

	/**
	 * Which nodes are named right now: the hub tables normally, everything in the isolated
	 * neighbourhood while one is focused, plus whatever the cursor is touching. Computed per frame
	 * because the last part changes with the cursor, and it is 40 array slots.
	 */
	private labelTargets(): number[] {
		// What the cursor is on comes FIRST, and the hubs after it. The order is the priority the
		// crowding pass below spends: when two names collide, the one nearer the front wins, so a
		// hovered table can never lose its label to a hub that happens to be behind it.
		const out: number[] = [];
		const add = (slot: number): void => {
			if (slot >= 0 && !out.includes(slot)) {
				out.push(slot);
			}
		};
		add(this.hoverNode);
		if (this.hoverLink >= 0) {
			add(this.linkEnds[this.hoverLink * 2]);
			add(this.linkEnds[this.hoverLink * 2 + 1]);
		}
		if (this.focus >= 0) {
			add(this.slotOfNode[this.focus]);
		}
		for (const slot of this.neighbourhood ? this.focusLabels : this.hubSlots) {
			add(slot);
		}
		return out;
	}

	/**
	 * Roughly how much horizontal room this slot's label needs, measured from its star. Estimated
	 * from the name rather than the DOM on purpose: the crowding pass runs before the text is
	 * written, and reading `offsetWidth` here would force a layout every frame.
	 */
	private labelWidth(slot: number): number {
		if (!this.graph) {
			return LABEL_GAP_X;
		}
		const node = this.graph.nodes[this.nodeSlots[slot]];
		const chars = (this.qualifyLabels ? node.schema.length + 1 : 0) + node.name.length;
		return LABEL_OFFSET_PX + chars * LABEL_CHAR_PX + LABEL_GAP_X;
	}

	private updateLabels(): void {
		if (!this.graph || this.labelElements.length === 0) {
			return;
		}
		const targets = this.showLabels ? this.labelTargets() : [];
		const focusSlot = this.focus >= 0 ? this.slotOfNode[this.focus] : -1;

		// Names that land on top of each other are worse than no name at all: a cluster of twenty
		// tables drew twenty overlapping words and read as a smear. Greedy, in priority order, so
		// the ones that survive are the ones worth reading.
		this.labelShown.length = 0;
		this.labelWidths.length = 0;
		for (const slot of targets) {
			if (this.labelShown.length >= this.labelElements.length) {
				break;
			}
			if (!this.onScreen[slot]) {
				continue;
			}
			const x = this.screenX[slot];
			const y = this.screenY[slot];
			const width = this.labelWidth(slot);
			let crowded = false;
			for (let i = 0; i < this.labelShown.length; i++) {
				const other = this.labelShown[i];
				if (Math.abs(this.screenY[other] - y) >= LABEL_GAP_Y) {
					continue;
				}
				// Two boxes on the same line, each running rightwards from its own star.
				const ox = this.screenX[other];
				if (x < ox + this.labelWidths[i] && ox < x + width) {
					crowded = true;
					break;
				}
			}
			if (!crowded) {
				this.labelShown.push(slot);
				this.labelWidths.push(width);
			}
		}

		for (let i = 0; i < this.labelElements.length; i++) {
			const element = this.labelElements[i];
			if (i >= this.labelShown.length) {
				element.style.display = 'none';
				continue;
			}
			const slot = this.labelShown[i];
			const key = String(slot);
			if (element.dataset.node !== key) {
				element.dataset.node = key;
				const node = this.graph.nodes[this.nodeSlots[slot]];
				element.textContent = this.qualifyLabels ? `${node.schema}.${node.name}` : node.name;
			}
			element.style.display = '';
			element.style.left = `${this.screenX[slot]}px`;
			element.style.top = `${this.screenY[slot]}px`;
			const pinned = slot === this.hoverNode
				|| slot === focusSlot
				|| (this.hoverLink >= 0 && (this.linkEnds[this.hoverLink * 2] === slot || this.linkEnds[this.hoverLink * 2 + 1] === slot));
			element.className = pinned ? 'pin' : '';
		}
	}

	/* ----------------------------------------------------------------- loop */

	resize(): void {
		const width = Math.max(1, this.canvas.clientWidth);
		const height = Math.max(1, this.canvas.clientHeight);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height, false);
		this.composer.setSize(width, height);
		this.bloom.setSize(width, height);
		if (this.nodeMaterial) {
			this.nodeMaterial.uniforms.pixelRatio.value = this.renderer.getPixelRatio();
		}
	}

	start(): void {
		if (this.running || this.disposed) {
			return;
		}
		this.running = true;
		// A paused tab must not report the gap as one very slow frame.
		this.fpsSince = 0;
		this.fpsFrames = 0;
		const tick = (): void => {
			if (!this.running || this.disposed) {
				return;
			}
			this.frameHandle = requestAnimationFrame(tick);
			this.frame();
		};
		this.frameHandle = requestAnimationFrame(tick);
	}

	stop(): void {
		this.running = false;
		if (this.frameHandle) {
			cancelAnimationFrame(this.frameHandle);
			this.frameHandle = 0;
		}
	}

	private frame(): void {
		this.frameCount += 1;
		this.renderer.info.reset();
		const dt = 1 / 60;

		if (this.layout && this.graph) {
			// The layout comes to REST and then stays there. Once settled the only things that move
			// are the nodes a packet just landed on, which spring straight back.
			let moved = false;
			if (!this.layout.settled) {
				this.layout.step();
				moved = true;
			}
			if (this.layout.excitedCount() > 0) {
				this.layout.relax();
				moved = true;
			}
			if (moved) {
				this.writePositions();
			}
			// `setGraph` sizes the stars against a layout the caller only WARMED. It keeps
			// expanding for a second after that, so the scale is taken again the moment it stops.
			if (!this.worldFixed && this.layout.settled) {
				this.worldFixed = true;
				const scale = starScale(this.layout.bounds().radius);
				if (this.nodeMaterial) {
					this.nodeMaterial.uniforms.world.value = scale;
				}
				if (this.packetMaterial) {
					this.packetMaterial.size = 5.5 * scale;
				}
			}
			this.updatePackets(dt);
			this.updateGlow(dt);
		}

		if (this.fly) {
			this.fly.t = Math.min(1, this.fly.t + dt * 1.6);
			const eased = 1 - Math.pow(1 - this.fly.t, 3);
			this.controls.target.lerpVectors(this.fly.fromTarget, this.fly.toTarget, eased);
			this.camera.position.lerpVectors(this.fly.fromPos, this.fly.toPos, eased);
			if (this.fly.t >= 1) {
				this.fly = null;
			}
		}

		this.controls.update();
		this.projectAll();

		const node = this.nearestNode();
		const link = node >= 0 ? -1 : this.nearestLink();
		if (node !== this.hoverNode || link !== this.hoverLink) {
			const relinked = link !== this.hoverLink;
			this.hoverNode = node;
			this.hoverLink = link;
			this.canvas.style.cursor = node >= 0 || link >= 0 ? 'pointer' : '';
			if (relinked) {
				this.paintLinks();
			}
			this.onHover?.(this.hovered());
		}

		this.updateLabels();
		this.composer.render();

		// Measured here rather than handed out per frame: the HUD reads `stats()` a couple of
		// times a second, and a number that changes sixty times a second is unreadable anyway.
		const now = performance.now();
		this.fpsFrames += 1;
		if (this.fpsSince === 0) {
			this.fpsSince = now;
		} else if (now - this.fpsSince >= 500) {
			this.fps = (this.fpsFrames * 1000) / (now - this.fpsSince);
			this.fpsFrames = 0;
			this.fpsSince = now;
		}
	}

	private updatePackets(dt: number): void {
		if (!this.graph || !this.layout || !this.packetGeometry) {
			return;
		}
		const positions = this.layout.positions;
		let written = 0;
		for (let i = this.packets.length - 1; i >= 0; i--) {
			const packet = this.packets[i];
			packet.t += dt * packet.speed * 0.9;
			if (packet.t >= 1) {
				const arrived = this.graph.links[packet.link];
				const end = arrived.a === packet.from ? arrived.b : arrived.a;
				this.touch(end);
				this.packets.splice(i, 1);
				continue;
			}
			if (packet.t < 0) {
				continue;
			}
			const travelling = this.graph.links[packet.link];
			const from = (travelling.a === packet.from ? travelling.a : travelling.b) * 3;
			const to = (travelling.a === packet.from ? travelling.b : travelling.a) * 3;
			this.packetPositions[written * 3] = positions[from] + (positions[to] - positions[from]) * packet.t;
			this.packetPositions[written * 3 + 1] = positions[from + 1] + (positions[to + 1] - positions[from + 1]) * packet.t;
			this.packetPositions[written * 3 + 2] = positions[from + 2] + (positions[to + 2] - positions[from + 2]) * packet.t;
			written += 1;
		}
		this.packetGeometry.setDrawRange(0, written);
		this.packetGeometry.attributes.position.needsUpdate = true;
	}

	private updateGlow(dt: number): void {
		if (!this.graph || !this.nodeGeometry) {
			return;
		}
		const focusSlot = this.focus >= 0 ? this.slotOfNode[this.focus] : -1;
		for (let i = 0; i < this.activity.length; i++) {
			if (this.activity[i] > 0) {
				this.activity[i] *= 0.955;
				if (this.activity[i] < 0.002) {
					this.activity[i] = 0;
				}
			}
			const dimmed = this.dimmed[i] === 1 ? -0.72 : 0;
			const lit = i === this.hoverNode || i === focusSlot ? 1.4 : 0;
			this.glows[i] = this.activity[i] + this.idle[i] + dimmed + lit;
		}
		this.nodeGeometry.attributes.glow.needsUpdate = true;

		for (let i = 0; i < this.traffic.length; i++) {
			if (this.traffic[i] > 0) {
				this.traffic[i] = Math.max(0, this.traffic[i] - dt * 0.12);
			}
		}
		// Relations recolour on a slower beat than they cool: sixteen frames of staleness is
		// invisible to the eye, and this is the single most expensive pass in the file, so the
		// beat SLOWS as the schema grows (`LodBudget.repaintEvery`) rather than staying at a
		// number chosen for a small database.
		if (this.frameCount % this.budget.repaintEvery === 0) {
			this.paintLinks();
		}
	}

	/* -------------------------------------------------------------- teardown */

	private disposeGraph(): void {
		for (const object of [this.nodeCloud, this.linkLines, this.packetPoints]) {
			if (object) {
				this.scene.remove(object);
			}
		}
		this.nodeGeometry?.dispose();
		this.nodeMaterial?.dispose();
		this.linkGeometry?.dispose();
		this.linkMaterial?.dispose();
		this.packetGeometry?.dispose();
		this.packetMaterial?.dispose();
		this.nodeGeometry = null;
		this.nodeMaterial = null;
		this.nodeCloud = null;
		this.linkGeometry = null;
		this.linkMaterial = null;
		this.linkLines = null;
		this.packetGeometry = null;
		this.packetMaterial = null;
		this.packetPoints = null;
	}

	dispose(): void {
		this.stop();
		this.disposed = true;
		this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
		this.canvas.removeEventListener('pointermove', this.handlePointerMove);
		this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
		this.canvas.removeEventListener('click', this.handleClick);
		this.disposeGraph();
		this.controls.dispose();
		this.backdrop.geometry.dispose();
		this.backdropMaterial.dispose();
		this.sprite.dispose();
		this.composer.dispose();
		this.renderer.dispose();
	}
}

/** A table is as big as its data and its connections; an index is dust around it. */
function baseSize(graph: OrbitGraph, id: number): number {
	const node = graph.nodes[id];
	if (node.kind === 'index') {
		return 3.2;
	}
	if (node.kind === 'routine') {
		return 5.4;
	}
	if (node.kind === 'view') {
		return 7;
	}
	return 8 + Math.log10((node.rows ?? 0) + 10) * 3.2 + Math.min(node.degree, 26) * 0.6;
}

function kindColour(palette: OrbitPalette, kind: string): string {
	switch (kind) {
		case 'view': return palette.view;
		case 'index': return palette.index;
		case 'routine': return palette.routine;
		default: return palette.table;
	}
}
