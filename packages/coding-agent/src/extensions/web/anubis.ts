// solves bounded Anubis SHA-256 challenges; adapted from public-domain owencfg search code.
import { createHash } from "node:crypto";

export type AnubisChallenge = {
	id: string;
	randomData: string;
	difficulty: number;
	algorithm: string;
	basePrefix: string;
};
export type AnubisSolution = { hash: string; nonce: number; elapsed: number };
type AnubisScript = string | Record<string, unknown>;

/** Decode a supported challenge without trusting arbitrary page fields or work budgets. */
export function parseAnubisChallenge(html: string): AnubisChallenge | undefined {
	const payload = readJsonScript(html, "anubis_challenge");
	if (!record(payload)) return undefined;
	const challenge = record(payload.challenge) ? payload.challenge : payload;
	const rules = record(payload.rules) ? payload.rules : {};
	const id = challenge.id;
	const randomData = challenge.randomData ?? challenge.random_data;
	const difficulty = rules.difficulty ?? challenge.difficulty;
	if (
		typeof id !== "string" ||
		id.length > 512 ||
		typeof randomData !== "string" ||
		!randomData.length ||
		randomData.length > 512 ||
		typeof difficulty !== "number" ||
		!Number.isInteger(difficulty) ||
		difficulty < 1 ||
		difficulty > 6
	)
		return undefined;
	const algorithm = rules.algorithm ?? "fast";
	if (algorithm !== "fast" && algorithm !== "slow") return undefined;
	const prefix = readJsonScript(html, "anubis_base_prefix");
	return { id, randomData, difficulty, algorithm, basePrefix: typeof prefix === "string" ? prefix : "" };
}

/** Find a proof while yielding for cancellation and enforcing a wall-clock and iteration ceiling. */
export async function solveAnubis(challenge: AnubisChallenge, signal?: AbortSignal): Promise<AnubisSolution> {
	const started = Date.now();
	const prefix = "0".repeat(challenge.difficulty);
	for (let nonce = 0; nonce < 1 << 26; nonce++) {
		if ((nonce & 8191) === 0) {
			signal?.throwIfAborted();
			if (Date.now() - started > 20_000) throw new Error("Anubis proof exceeded its time budget");
			if (nonce) await new Promise<void>((resolve) => setImmediate(resolve));
		}
		const hash = createHash("sha256")
			.update(challenge.randomData + String(nonce))
			.digest("hex");
		if (hash.startsWith(prefix)) return { hash, nonce, elapsed: Date.now() - started };
	}
	throw new Error("Anubis proof exceeded its iteration budget");
}

/** Encode a proof for the engine's validated HTTPS transport. */
export function passChallengeUrl(
	origin: string,
	challenge: AnubisChallenge,
	solution: AnubisSolution,
	redirect: string,
): string {
	const url = new URL(`${challenge.basePrefix}/.within.website/x/cmd/anubis/api/pass-challenge`, origin);
	url.searchParams.set("id", challenge.id);
	url.searchParams.set("response", solution.hash);
	url.searchParams.set("nonce", String(solution.nonce));
	url.searchParams.set("redir", redirect);
	url.searchParams.set("elapsedTime", String(solution.elapsed));
	return url.href;
}

function readJsonScript(html: string, id: string): AnubisScript | undefined {
	const raw = new RegExp(`<script[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, "i").exec(html)?.[1];
	if (!raw) return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		return typeof value === "string" || record(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
