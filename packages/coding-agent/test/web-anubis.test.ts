import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAnubisChallenge, passChallengeUrl, solveAnubis } from "../src/extensions/web/anubis.ts";

const payload = {
	challenge: { id: "fixture", randomData: "fixture-data" },
	rules: { difficulty: 1, algorithm: "fast" },
};
const html = (value: unknown) =>
	`<script id="anubis_challenge">${JSON.stringify(value)}</script><script id="anubis_base_prefix">"/prefix"</script>`;
afterEach(() => vi.restoreAllMocks());

describe("Anubis proof", () => {
	it("parses and solves the published SHA-256 rule", async () => {
		const challenge = parseAnubisChallenge(html(payload))!;
		const solution = await solveAnubis(challenge);
		expect(solution.hash).toBe(
			createHash("sha256")
				.update(challenge.randomData + solution.nonce)
				.digest("hex"),
		);
		expect(solution.hash.startsWith("0")).toBe(true);
		const url = new URL(
			passChallengeUrl("https://www.startpage.com", challenge, solution, "https://www.startpage.com/"),
		);
		expect(url.pathname).toBe("/prefix/.within.website/x/cmd/anubis/api/pass-challenge");
		expect(url.searchParams.get("response")).toBe(solution.hash);
		expect(url.searchParams.get("id")).toBe("fixture");
	});
	it.each([
		null,
		{},
		{ ...payload, rules: { difficulty: 7 } },
		{ ...payload, rules: { difficulty: 0 } },
		{ ...payload, rules: { difficulty: 1, algorithm: "unknown" } },
		{ ...payload, challenge: { id: "fixture", randomData: "x".repeat(513) } },
	])("rejects unsupported or unbounded wire challenges: %j", (value) =>
		expect(parseAnubisChallenge(html(value))).toBeUndefined(),
	);
	it("ignores malformed script JSON", () =>
		expect(parseAnubisChallenge('<script id="anubis_challenge">broken</script>')).toBeUndefined());
	it("observes cancellation before doing work", async () => {
		const signal = AbortSignal.abort(new Error("cancelled"));
		await expect(solveAnubis(parseAnubisChallenge(html(payload))!, signal)).rejects.toThrow("cancelled");
	});
	it("enforces its wall-clock budget", async () => {
		const challenge = parseAnubisChallenge(html(payload))!;
		vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(20_001);
		await expect(solveAnubis(challenge)).rejects.toThrow("time budget");
	});
});
