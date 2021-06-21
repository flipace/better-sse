import EventEmitter from "events";
import {randomBytes} from "crypto";
import {Readable} from "stream";
import {IncomingMessage, ServerResponse, OutgoingHttpHeaders} from "http";
import serialize, {SerializerFunction} from "./lib/serialize";
import sanitize, {SanitizerFunction} from "./lib/sanitize";

export interface SessionOptions {
	/**
	 * Serialize data to a string that can be written.
	 *
	 * Note that only values written with `.data()` or `.push()` are serialized, as everything else is assumed to already be a string.
	 *
	 * Defaults to `JSON.stringify`.
	 */
	serializer?: SerializerFunction;

	/**
	 * Sanitize values so as to not prematurely dispatch events when writing fields whose text inadvertently contains newlines.
	 *
	 * By default, CR, LF and CRLF characters are replaced with a single LF character (`\n`) and then any trailing LF characters are stripped so as to prevent a blank line being written and accidentally dispatching the event before `.dispatch()` is called.
	 */
	sanitizer?: SanitizerFunction;

	/**
	 * Whether to trust the last event ID given by the client in the `Last-Event-ID` request header.
	 *
	 * When set to `false`, the `lastId` property will always be initialized to an empty string.
	 *
	 * Defaults to `true`.
	 */
	trustClientEventId?: boolean;

	/**
	 * Time in milliseconds for the client to wait before attempting to reconnect if the connection is closed. This is a request to the client browser, and does not guarantee that the client will actually respect the given time.
	 *
	 * This is equivalent to immediately calling `.retry().dispatch()` after a connection is made.
	 *
	 * Give as `null` to avoid sending an explicit reconnection time and allow the client browser to decide itself.
	 *
	 * Defaults to `2000` milliseconds.
	 *
	 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html#concept-event-stream-reconnection-time
	 */
	retry?: number | null;

	/**
	 * Status code to be sent to the client.
	 *
	 * Event stream requests can be redirected using HTTP 301 and 307 status codes.
	 *
	 * Make sure to set `Location` header when using these status codes using the `headers` property.
	 *
	 * A client can be asked to stop reconnecting by using 204 status code.
	 *
	 * Defaults to `200`.
	 */
	statusCode?: number;

	/**
	 * Additional headers to be sent along with the response.
	 */
	headers?: OutgoingHttpHeaders;
}

export interface StreamOptions {
	/**
	 * Event name/type to be emitted when stream data is sent to the client.
	 *
	 * Defaults to `"stream"`.
	 */
	event?: string;
}

/**
 * A Session represents an open connection between the server and a client.
 *
 * It extends from the {@link https://nodejs.org/api/events.html#events_class_eventemitter | EventEmitter} class.
 *
 * It emits the `connected` event after it has connected and flushed all headers to the client, and the
 * `disconnected` event after client connection has been closed.
 *
 * @param req - The Node HTTP {@link https://nodejs.org/api/http.html#http_class_http_incomingmessage | ServerResponse} object.
 * @param res - The Node HTTP {@link https://nodejs.org/api/http.html#http_class_http_serverresponse | IncomingMessage} object.
 * @param options - Options given to the session instance.
 */
class Session extends EventEmitter {
	/**
	 * The last ID sent to the client.
	 * This is initialized to the last event ID given by the user, and otherwise is equal to the last number given to the `.id` method.
	 */
	lastId = "";

	private req: IncomingMessage;
	private res: ServerResponse;

	private serialize: SerializerFunction;
	private sanitize: SanitizerFunction;
	private trustClientEventId: boolean;
	private initialRetry: number | null;
	private statusCode: number;
	private headers: OutgoingHttpHeaders;

	constructor(
		req: IncomingMessage,
		res: ServerResponse,
		options: SessionOptions = {}
	) {
		super();

		this.req = req;
		this.res = res;

		this.serialize = options.serializer ?? serialize;
		this.sanitize = options.sanitizer ?? sanitize;
		this.trustClientEventId = options.trustClientEventId ?? true;
		this.initialRetry =
			options.retry === null ? null : options.retry ?? 2000;
		this.statusCode = options.statusCode ?? 200;
		this.headers = options.headers ?? {};

		this.req.on("close", this.onDisconnected);
		setImmediate(this.onConnected);
	}

	private onConnected = () => {
		if (this.trustClientEventId) {
			const givenLastEventId = this.req.headers["last-event-id"] ?? "";

			this.lastId = givenLastEventId as string;
		}

		Object.entries(this.headers).forEach(([name, value]) => {
			this.res.setHeader(name, value ?? "");
		});

		this.res.statusCode = this.statusCode;
		this.res.setHeader("Content-Type", "text/event-stream");
		this.res.setHeader("Cache-Control", "no-cache, no-transform");
		this.res.setHeader("Connection", "keep-alive");
		this.res.flushHeaders();

		if (this.initialRetry !== null) {
			this.retry(this.initialRetry).dispatch();
		}

		this.emit("connected");
	};

	private onDisconnected = () => {
		this.emit("disconnected");
	};

	/**
	 * Write a line with a field key and value appended with a newline character.
	 */
	private writeField = (name: string, value: string): this => {
		const sanitized = this.sanitize(value);

		const text = `${name}:${sanitized}\n`;

		this.res.write(text);

		return this;
	};

	/**
	 * Flush the buffered data to the client by writing an additional newline.
	 */
	dispatch = (): this => {
		this.res.write("\n");

		return this;
	};

	/**
	 * Set the event to the given name (also referred to as "type" in the specification).
	 *
	 * @param type - Event name/type.
	 */
	event(type: string): this {
		this.writeField("event", type);

		return this;
	}

	/**
	 * Write arbitrary data onto the wire that is automatically serialized to a string using the given `serializer` function option or JSON stringification by default.
	 *
	 * @param data - Data to serialize and write.
	 */
	data = (data: unknown): this => {
		const serialized = this.serialize(data);

		this.writeField("data", serialized);

		return this;
	};

	/**
	 * Set the event ID to the given string.
	 *
	 * Passing `null` will set the event ID to an empty string value.
	 *
	 * @param id - Identification string to write.
	 */
	id = (id: string | null): this => {
		const stringifed = id ? id : "";

		this.writeField("id", stringifed);

		this.lastId = stringifed;

		return this;
	};

	/**
	 * Set the suggested reconnection time to the given milliseconds.
	 *
	 * @param time - Time in milliseconds to retry.
	 */
	retry = (time: number): this => {
		const stringifed = time.toString();

		this.writeField("retry", stringifed);

		return this;
	};

	/**
	 * Write a comment (an ignored field).
	 *
	 * This will not fire an event, but is often used to keep the connection alive.
	 *
	 * @param text - Text of the comment. Otherwise writes an empty field value.
	 */
	comment = (text?: string): this => {
		this.writeField("", text ?? "");

		return this;
	};

	/**
	 * Create and dispatch an event with the given data all at once.
	 * This is equivalent to calling `.event()`, `.id()`, `.data()` and `.dispatch()` in that order.
	 *
	 * If no event name is given, the event name (type) is set to `"message"`.
	 *
	 * Note that this sets the event ID (and thus the `lastId` property) to a string of eight random characters (`a-z0-9`).
	 *
	 * @param eventOrData - Event name or data to write.
	 * @param data - Data to write if `eventOrData` was an event name.
	 */
	push = (eventOrData: string | unknown, data?: unknown): this => {
		let eventName;
		let rawData;

		if (eventOrData && typeof data === "undefined") {
			eventName = "message";
			rawData = eventOrData;
		} else {
			eventName = (eventOrData as string).toString();
			rawData = data;
		}

		const nextId = randomBytes(4).toString("hex");

		this.event(eventName).id(nextId).data(rawData).dispatch();

		return this;
	};

	/**
	 * Pipe readable stream data to the client.
	 *
	 * Each data emission by the stream emits a new event that is dispatched to the client.
	 * This uses the `push` method under the hood.
	 *
	 * If no event name is given in the options object, the event name (type) is to `"stream"`.
	 *
	 * @param stream - Readable stream to consume from.
	 * @param options - Options to alter how the stream is flushed to the client.
	 *
	 * @returns A promise that resolves or rejects based on the success of the stream write finishing.
	 */
	stream = async (
		stream: Readable,
		options: StreamOptions = {}
	): Promise<boolean> => {
		const {event = "stream"} = options;

		return new Promise<boolean>((resolve, reject) => {
			stream.on("data", (chunk) => {
				let data: string;

				if (Buffer.isBuffer(chunk)) {
					data = chunk.toString();
				} else {
					data = chunk;
				}

				this.push(event, data);
			});

			stream.once("end", () => resolve(true));
			stream.once("close", () => resolve(true));
			stream.once("error", (err) => reject(err));
		});
	};
}

export default Session;
