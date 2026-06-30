import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveProjectPython } from "../../python-runtime.ts";

export type HardwareBridgeV2SideEffectLevel = "read" | "motion" | "acquisition" | "power" | "environment";
export type HardwareBridgeV2CancelBehavior = "none" | "best_effort" | "safe_checkpoint";

export interface HardwareBridgeV2ActionContract {
	domain: string;
	action: string;
	sideEffectLevel: HardwareBridgeV2SideEffectLevel;
	resourcesTouched: string[];
	safeToRetry: boolean;
	cancelBehavior: HardwareBridgeV2CancelBehavior;
	emitsProgress: boolean;
}

export interface HardwareBridgeV2Event {
	event: string;
	id?: string;
	domain?: string;
	action?: string;
	[key: string]: unknown;
}

export interface HardwareBridgeV2ClientOptions {
	cwd: string;
	python?: string;
	bridgePath?: string;
	stageRoot?: string;
	requestTimeoutMs?: number;
	onEvent?: (event: HardwareBridgeV2Event) => void;
	onStderr?: (chunk: string) => void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface BridgeErrorPayload {
	code?: unknown;
	message?: unknown;
	detail?: unknown;
}

export class HardwareBridgeV2RequestError extends Error {
	readonly code: string;
	readonly detail: unknown;

	constructor(code: string, message: string, detail: unknown) {
		super(message);
		this.name = "HardwareBridgeV2RequestError";
		this.code = code;
		this.detail = detail;
	}
}

export class HardwareBridgeV2ProtocolError extends Error {
	readonly code = "bridge_crashed";

	constructor(message: string) {
		super(message);
		this.name = "HardwareBridgeV2ProtocolError";
	}
}

export class HardwareBridgeV2Client {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly requestTimeoutMs: number;
	private readonly onEvent: ((event: HardwareBridgeV2Event) => void) | undefined;
	private readonly exited: Promise<void>;
	private nextRequestNumber = 1;
	private closed = false;

	constructor(options: HardwareBridgeV2ClientOptions) {
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.onEvent = options.onEvent;
		const kernelDir = dirname(fileURLToPath(import.meta.url));
		const extensionDir = dirname(dirname(kernelDir));
		const repoRoot = dirname(dirname(dirname(extensionDir)));
		const bridgePath = options.bridgePath ?? join(extensionDir, "hardware_bridge_v2.py");
		const stageRoot = options.stageRoot ?? resolve(repoRoot, "docs", "Raman");
		this.child = spawn(resolveProjectPython(options.cwd, options.python).pythonPath, [bridgePath, "--stage-root", stageRoot], {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.exited = new Promise((resolveExited) => {
			this.child.once("exit", () => resolveExited());
		});
		this.child.stdout.setEncoding("utf-8");
		this.child.stderr.setEncoding("utf-8");
		createInterface({ input: this.child.stdout }).on("line", (line) => this.handleStdoutLine(line));
		this.child.stderr.on("data", (chunk) => {
			if (options.onStderr) options.onStderr(String(chunk));
		});
		this.child.on("exit", (code, signal) => {
			this.closed = true;
			const reason = signal ? `hardware bridge v2 exited by signal ${signal}` : `hardware bridge v2 exited with code ${code ?? "unknown"}`;
			this.rejectAll(new HardwareBridgeV2ProtocolError(reason));
		});
		this.child.on("error", (error) => {
			this.closed = true;
			this.rejectAll(new HardwareBridgeV2ProtocolError(`hardware bridge v2 process error: ${error.message}`));
		});
	}

	request<Result>(
		domain: string,
		action: string,
		payload: Record<string, unknown> = {},
		timeoutMs: number = this.requestTimeoutMs,
	): Promise<Result> {
		if (this.closed) {
			return Promise.reject(new HardwareBridgeV2ProtocolError("hardware bridge v2 process is closed"));
		}
		const id = `v2-${String(this.nextRequestNumber).padStart(4, "0")}`;
		this.nextRequestNumber += 1;
		return new Promise<Result>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new HardwareBridgeV2ProtocolError(`hardware bridge v2 request timed out: ${domain}.${action}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => resolve(value as Result),
				reject,
				timer,
			});
			const line = `${JSON.stringify({ id, domain, action, payload, timeoutMs })}\n`;
			this.child.stdin.write(line, "utf-8", (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(new HardwareBridgeV2ProtocolError(`hardware bridge v2 stdin write failed: ${error.message}`));
			});
		});
	}

	async listActions(timeoutMs: number = this.requestTimeoutMs): Promise<HardwareBridgeV2ActionContract[]> {
		const result = await this.request<unknown>("bridge", "list_actions", {}, timeoutMs);
		return parseActionContracts(result);
	}

	async shutdown(timeoutMs: number = this.requestTimeoutMs): Promise<void> {
		let shutdownAccepted = false;
		try {
			await this.request("bridge", "shutdown", {}, timeoutMs);
			shutdownAccepted = true;
			await this.waitForExit(1_000);
		} finally {
			if (!shutdownAccepted || !this.hasExited()) {
				this.close();
				await this.waitForExit(1_000);
			}
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.child.stdin.end();
		if (!this.child.killed) {
			this.child.kill();
		}
		this.rejectAll(new HardwareBridgeV2ProtocolError("hardware bridge v2 closed"));
	}

	private hasExited(): boolean {
		return this.child.exitCode !== null || this.child.signalCode !== null;
	}

	private waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.hasExited()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			void this.exited.then(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	private handleStdoutLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.handleProtocolFailure(`hardware bridge v2 emitted non-JSON stdout: ${line}`);
			return;
		}
		if (!isRecord(parsed)) {
			this.handleProtocolFailure("hardware bridge v2 emitted a non-object protocol message");
			return;
		}
		if (typeof parsed.event === "string") {
			this.onEvent?.(parsed as HardwareBridgeV2Event);
			return;
		}
		if (typeof parsed.id !== "string") {
			this.handleProtocolFailure("hardware bridge v2 response is missing id");
			return;
		}
		const pending = this.pending.get(parsed.id);
		if (!pending) {
			this.handleProtocolFailure(`hardware bridge v2 response id was not pending: ${parsed.id}`);
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(parsed.id);
		if (parsed.ok === true) {
			pending.resolve(parsed.result);
			return;
		}
		if (parsed.ok === false && isRecord(parsed.error)) {
			pending.reject(toRequestError(parsed.error));
			return;
		}
		pending.reject(new HardwareBridgeV2ProtocolError(`hardware bridge v2 response for ${parsed.id} was malformed`));
	}

	private handleProtocolFailure(message: string): void {
		this.closed = true;
		this.rejectAll(new HardwareBridgeV2ProtocolError(message));
		if (!this.child.killed) {
			this.child.kill();
		}
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.reject(error);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRequestError(error: BridgeErrorPayload): HardwareBridgeV2RequestError {
	const code = typeof error.code === "string" ? error.code : "bridge_crashed";
	const message = typeof error.message === "string" ? error.message : "Hardware bridge v2 request failed";
	return new HardwareBridgeV2RequestError(code, message, error.detail);
}

function parseActionContracts(value: unknown): HardwareBridgeV2ActionContract[] {
	if (!isRecord(value) || !Array.isArray(value.actions)) {
		throw new HardwareBridgeV2ProtocolError("hardware bridge v2 list_actions result was malformed");
	}
	return value.actions.map(parseActionContract);
}

function parseActionContract(value: unknown): HardwareBridgeV2ActionContract {
	if (!isRecord(value)) {
		throw new HardwareBridgeV2ProtocolError("hardware bridge v2 action contract was not an object");
	}
	const domain = stringField(value, "domain");
	const action = stringField(value, "action");
	const sideEffectLevel = sideEffectLevelField(value, "sideEffectLevel");
	const resourcesTouched = stringArrayField(value, "resourcesTouched");
	const safeToRetry = booleanField(value, "safeToRetry");
	const cancelBehavior = cancelBehaviorField(value, "cancelBehavior");
	const emitsProgress = booleanField(value, "emitsProgress");
	return { domain, action, sideEffectLevel, resourcesTouched, safeToRetry, cancelBehavior, emitsProgress };
}

function stringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new HardwareBridgeV2ProtocolError(`hardware bridge v2 contract field ${key} must be a non-empty string`);
	}
	return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") {
		throw new HardwareBridgeV2ProtocolError(`hardware bridge v2 contract field ${key} must be a boolean`);
	}
	return value;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new HardwareBridgeV2ProtocolError(`hardware bridge v2 contract field ${key} must be a string array`);
	}
	return value;
}

function sideEffectLevelField(record: Record<string, unknown>, key: string): HardwareBridgeV2SideEffectLevel {
	const value = stringField(record, key);
	if (value === "read" || value === "motion" || value === "acquisition" || value === "power" || value === "environment") {
		return value;
	}
	throw new HardwareBridgeV2ProtocolError(`hardware bridge v2 contract field ${key} has unknown side effect level`);
}

function cancelBehaviorField(record: Record<string, unknown>, key: string): HardwareBridgeV2CancelBehavior {
	const value = stringField(record, key);
	if (value === "none" || value === "best_effort" || value === "safe_checkpoint") {
		return value;
	}
	throw new HardwareBridgeV2ProtocolError(`hardware bridge v2 contract field ${key} has unknown cancel behavior`);
}
