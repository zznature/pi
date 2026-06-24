import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveProjectPython } from "../../python-runtime.ts";

export type RamanBridgeAction =
	| "connect"
	| "probe"
	| "active_probe"
	| "visit_point"
	| "autofocus"
	| "acquire_spectrum"
	| "xy_correct"
	| "calibrate_xy"
	| "calibrate_xy_sequence"
	| "run_unit"
	| "stop"
	| "shutdown";

export interface RamanBridgeEvent {
	event: string;
	[key: string]: unknown;
}

export interface RamanBridgeClientOptions {
	cwd: string;
	python?: string;
	bridgePath?: string;
	stageRoot?: string;
	requestTimeoutMs?: number;
	onEvent?: (event: RamanBridgeEvent) => void;
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

export class RamanBridgeRequestError extends Error {
	readonly code: string;
	readonly detail: unknown;

	constructor(code: string, message: string, detail: unknown) {
		super(message);
		this.name = "RamanBridgeRequestError";
		this.code = code;
		this.detail = detail;
	}
}

export class RamanBridgeProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RamanBridgeProtocolError";
	}
}

export class RamanBridgeClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly requestTimeoutMs: number;
	private readonly onEvent: ((event: RamanBridgeEvent) => void) | undefined;
	private readonly exited: Promise<void>;
	private nextRequestNumber = 1;
	private closed = false;

	constructor(options: RamanBridgeClientOptions) {
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.onEvent = options.onEvent;
		const kernelDir = dirname(fileURLToPath(import.meta.url));
		const extensionDir = dirname(dirname(kernelDir));
		const repoRoot = dirname(dirname(dirname(extensionDir)));
		const bridgePath = options.bridgePath ?? join(extensionDir, "raman_bridge.py");
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
			const reason = signal ? `bridge exited by signal ${signal}` : `bridge exited with code ${code ?? "unknown"}`;
			this.rejectAll(new RamanBridgeProtocolError(reason));
		});
		this.child.on("error", (error) => {
			this.closed = true;
			this.rejectAll(new RamanBridgeProtocolError(`bridge process error: ${error.message}`));
		});
	}

	request<Result>(action: RamanBridgeAction, payload: unknown = {}, timeoutMs: number = this.requestTimeoutMs): Promise<Result> {
		if (this.closed) {
			return Promise.reject(new RamanBridgeProtocolError("bridge process is closed"));
		}
		const id = `c-${String(this.nextRequestNumber).padStart(4, "0")}`;
		this.nextRequestNumber += 1;
		return new Promise<Result>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RamanBridgeProtocolError(`bridge request timed out: ${action}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => resolve(value as Result),
				reject,
				timer,
			});
			const line = `${JSON.stringify({ id, action, payload })}\n`;
			this.child.stdin.write(line, "utf-8", (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(new RamanBridgeProtocolError(`bridge stdin write failed: ${error.message}`));
			});
		});
	}

	stop(timeoutMs: number = this.requestTimeoutMs): Promise<{ stopped: boolean }> {
		return this.request("stop", {}, timeoutMs);
	}

	async shutdown(timeoutMs: number = this.requestTimeoutMs): Promise<void> {
		let shutdownAccepted = false;
		try {
			await this.request("shutdown", {}, timeoutMs);
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
		this.rejectAll(new RamanBridgeProtocolError("bridge closed"));
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
			this.handleProtocolFailure(`bridge emitted non-JSON stdout: ${line}`);
			return;
		}
		if (!isRecord(parsed)) {
			this.handleProtocolFailure("bridge emitted a non-object protocol message");
			return;
		}
		if (typeof parsed.event === "string") {
			this.onEvent?.(parsed as RamanBridgeEvent);
			return;
		}
		if (typeof parsed.id !== "string") {
			this.handleProtocolFailure("bridge response is missing id");
			return;
		}
		const pending = this.pending.get(parsed.id);
		if (!pending) {
			this.handleProtocolFailure(`bridge response id was not pending: ${parsed.id}`);
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
		pending.reject(new RamanBridgeProtocolError(`bridge response for ${parsed.id} was malformed`));
	}

	private handleProtocolFailure(message: string): void {
		this.closed = true;
		this.rejectAll(new RamanBridgeProtocolError(message));
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

function toRequestError(error: BridgeErrorPayload): RamanBridgeRequestError {
	const code = typeof error.code === "string" ? error.code : "bridge_crashed";
	const message = typeof error.message === "string" ? error.message : "Raman bridge request failed";
	return new RamanBridgeRequestError(code, message, error.detail);
}
