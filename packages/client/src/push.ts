/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Snout Push: notifications to iPhone, Android and the web, at `/push/v1`.
 *
 *     // In the app, once the platform has given you a token:
 *     await db.push.register({ transport: 'apns', token, environment: 'production' })
 *     // In a browser, with your service worker's registration:
 *     await db.push.subscribeWeb(registration)
 *     // On a server, with the server key (or as a person your policies allow):
 *     await db.push.send({ notification: { title: 'Order shipped' }, userIds: [userId] })
 *
 * Devices, topics, the queue and the delivery log are tables in the project's own database, and
 * its row-level security decides who may notify whom. Every payload carries the id of its
 * delivery, so the app can report it received or opened (`deliveryIdOf`, `receipt`).
 */

import { joinUrl, messageOf, readBody, type Transport } from './http.js';

export class PushError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'PushError';
		this.status = status;
	}
}

export type PushResult<T> = { data: T; error: null } | { data: null; error: PushError };

/** What a notification says, on every transport. */
export interface PushNotification {
	title?: string;
	body?: string;
	/** Delivered to the app beside the notification. */
	data?: Record<string, unknown>;
	badge?: number;
	sound?: string;
	/** Groups notifications on the device. */
	thread?: string;
	image?: string;
	/** Where a click on a web notification goes. */
	url?: string;
	/** Shows nothing and wakes the app to handle `data` (never sent to a browser). */
	background?: boolean;
	/** Fields for one transport, merged over what the server builds. */
	apns?: Record<string, unknown>;
	fcm?: Record<string, unknown>;
	web?: Record<string, unknown>;
}

export interface SendOptions {
	notification: PushNotification;
	/** Exactly one target. */
	userIds?: string[];
	topic?: string;
	deviceIds?: string[];
	/** A time to send at (paid plans), as an ISO string or a Date. */
	sendAt?: string | Date;
	/** Seconds a provider may hold it for an offline device. */
	ttl?: number;
	priority?: 'high' | 'normal';
	/** A newer message with the same key replaces an undelivered older one. */
	collapseKey?: string;
}

export interface RegisterOptions {
	transport: 'apns' | 'fcm' | 'web';
	/** The APNs device token, the FCM registration token, or the Web Push endpoint. */
	token: string;
	/** Web Push only: the subscription's keys. */
	p256dh?: string;
	auth?: string;
	/** APNs only: which of Apple's environments the build is in. Default `production`. */
	environment?: 'production' | 'sandbox';
	/** The app's bundle id or FCM app, when a project has more than one. */
	app?: string;
	locale?: string;
}

export interface MessageStatus {
	id: number;
	status: 'queued' | 'sending' | 'sent' | 'partial' | 'failed' | 'refused' | 'cancelled';
	detail: string | null;
	send_at: string | null;
	created_at: string | null;
	finished_at: string | null;
}

/** The data key every delivery's id rides under. */
export const DELIVERY_KEY = 'snout_push_delivery';

/**
 * The delivery id in a notification's data, as an app receives it (APNs puts data beside `aps`,
 * FCM hands data values over as strings, Web Push as the payload's `data`). Null when absent.
 */
export function deliveryIdOf(data: unknown): number | null {
	if (data === null || typeof data !== 'object') {
		return null;
	}
	const record = data as Record<string, unknown>;
	const found = record[DELIVERY_KEY] ?? (record.data as Record<string, unknown> | undefined)?.[DELIVERY_KEY];
	const id = typeof found === 'string' ? Number(found) : found;
	return typeof id === 'number' && Number.isInteger(id) ? id : null;
}

/**
 * In a service worker: turns a push event's payload into the arguments of
 * `registration.showNotification`. Every browser requires a push to show something.
 *
 *     self.addEventListener('push', (event) => {
 *       const { title, options } = webNotification(event.data?.json())
 *       event.waitUntil(self.registration.showNotification(title, options))
 *     })
 */
export function webNotification(payload: unknown): { title: string; options: Record<string, unknown> } {
	const p = (payload ?? {}) as Record<string, unknown>;
	// `badge` here is the app's badge COUNT; the Notification API's `badge` is an icon URL, so the
	// count travels in `data` with the click target, beside the delivery id.
	const { title, body, tag, image, url, data, badge, background: _background, ...rest } = p;
	return {
		title: typeof title === 'string' ? title : '',
		options: {
			...rest,
			...(typeof body === 'string' ? { body } : {}),
			...(typeof tag === 'string' ? { tag } : {}),
			...(typeof image === 'string' ? { image } : {}),
			data: {
				...(data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}),
				...(typeof url === 'string' ? { url } : {}),
				...(typeof badge === 'number' ? { badge } : {})
			}
		}
	};
}

function base64UrlToBytes(text: string): Uint8Array {
	const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** The browser's `PushSubscription`, as much of it as registering needs. */
interface WebSubscription {
	endpoint: string;
	toJSON(): { keys?: { p256dh?: string; auth?: string } };
}

/** The browser's `ServiceWorkerRegistration`, as much of it as subscribing needs. */
interface WebRegistration {
	pushManager: {
		subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<WebSubscription>;
	};
}

export class PushClient {
	/** Setting and reading the project's own APNs and FCM keys. The server key only. */
	readonly credentials: {
		set(kind: 'apns', body: { topic: string; keys: { p8: string; key_id: string; team_id: string; environment?: 'production' | 'sandbox' | null }[] }): Promise<PushResult<Record<string, unknown>>>;
		set(kind: 'fcm', body: { service_account: string }): Promise<PushResult<Record<string, unknown>>>;
		list(): Promise<PushResult<Record<string, Record<string, unknown>>>>;
		remove(kind: 'apns' | 'fcm'): Promise<PushResult<null>>;
	};

	constructor(
		/** @internal */ readonly url: string,
		private readonly transport: Transport
	) {
		this.credentials = {
			set: (kind: 'apns' | 'fcm', body: unknown) => this.call('PUT', `credentials/${kind}`, body),
			list: () => this.call('GET', 'credentials'),
			remove: (kind) => this.call('DELETE', `credentials/${kind}`)
		} as PushClient['credentials'];
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<PushResult<T>> {
		const headers: Record<string, string> = { ...(await this.transport.headers()) };
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}
		let response: Response;
		try {
			response = await this.transport.fetch(joinUrl(this.url, path), {
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			});
		} catch (cause) {
			return { data: null, error: new PushError(cause instanceof Error ? cause.message : String(cause), 0) };
		}
		const read = await readBody(response);
		if (!response.ok) {
			return { data: null, error: new PushError(messageOf(read, `Push answered ${response.status}`), response.status) };
		}
		return { data: read as T, error: null };
	}

	/** Registers this installation for the signed-in user (or anonymously, where the project allows it). */
	register(options: RegisterOptions): Promise<PushResult<{ id: string }>> {
		return this.call('POST', 'devices', options);
	}

	/** Removes one of the signed-in user's devices, e.g. on sign-out. */
	unregister(deviceId: string): Promise<PushResult<null>> {
		return this.call('DELETE', `devices/${encodeURIComponent(deviceId)}`);
	}

	/** The key a browser subscribes with. */
	vapidPublicKey(): Promise<PushResult<{ id: string; key: string }>> {
		return this.call('GET', 'vapid-public-key');
	}

	/**
	 * In a browser: subscribes the service worker to Web Push with the project's key, and
	 * registers the subscription. Ask the user's permission first (`Notification.requestPermission`).
	 */
	async subscribeWeb(registration: WebRegistration, options: { locale?: string } = {}): Promise<PushResult<{ id: string }>> {
		const key = await this.vapidPublicKey();
		if (key.error) {
			return key;
		}
		let subscription: WebSubscription;
		try {
			subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: base64UrlToBytes(key.data.key)
			});
		} catch (cause) {
			return { data: null, error: new PushError(cause instanceof Error ? cause.message : String(cause), 0) };
		}
		const keys = subscription.toJSON().keys ?? {};
		return this.register({
			transport: 'web',
			token: subscription.endpoint,
			p256dh: keys.p256dh ?? '',
			auth: keys.auth ?? '',
			...(options.locale ? { locale: options.locale } : {})
		});
	}

	/** Adds the signed-in user to a topic. */
	join(topic: string): Promise<PushResult<null>> {
		return this.call('PUT', `topics/${encodeURIComponent(topic)}/members`);
	}

	leave(topic: string): Promise<PushResult<null>> {
		return this.call('DELETE', `topics/${encodeURIComponent(topic)}/members`);
	}

	/** Queues a notification. The project's policies on `push.messages` decide who may. */
	send(options: SendOptions): Promise<PushResult<{ id: number }>> {
		const { notification, userIds, topic, deviceIds, sendAt, ttl, priority, collapseKey } = options;
		return this.call('POST', 'send', {
			notification,
			...(userIds ? { user_ids: userIds } : {}),
			...(topic ? { topic } : {}),
			...(deviceIds ? { device_ids: deviceIds } : {}),
			...(sendAt ? { send_at: sendAt instanceof Date ? sendAt.toISOString() : sendAt } : {}),
			...(ttl !== undefined ? { ttl } : {}),
			...(priority ? { priority } : {}),
			...(collapseKey ? { collapse_key: collapseKey } : {})
		});
	}

	/** A message's status, for its sender. */
	message(id: number): Promise<PushResult<MessageStatus>> {
		return this.call('GET', `messages/${id}`);
	}

	/**
	 * Tells the project a notification reached this device, or was opened. Only these reports
	 * make a delivery "received": a provider's acceptance never does.
	 */
	receipt(deliveryId: number, event: 'received' | 'opened'): Promise<PushResult<null>> {
		return this.call('POST', 'receipts', { delivery_id: deliveryId, event });
	}
}
