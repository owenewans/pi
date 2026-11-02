/*
 * request envelopes and response parsing adapted from pi-antigravity.
 *
 * MIT License
 *
 * Copyright (c) 2026 Rahul Arya
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { antigravityEndpoint, antigravityHeaders } from "@earendil-works/pi-ai/providers/antigravity-client";
import { fetchService } from "../../core/http-dispatcher.ts";

export const SEARCH_MODEL = "gemini-3.5-flash-lite";
export const IMAGE_MODEL = "gemini-3.1-flash-image";
export const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
};

export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function requiredText(value: string, name: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
	return value.trim();
}

export async function requestContent(
	apiKey: string | undefined,
	model: string,
	requestType: "agent" | "image_gen",
	request: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	signal?.throwIfAborted();
	if (!apiKey) throw new Error("No Antigravity credentials. Run /login antigravity first.");
	let auth: Record<string, unknown>;
	try {
		auth = record(JSON.parse(apiKey));
	} catch {
		auth = {};
	}
	if (
		typeof auth.token !== "string" ||
		!auth.token.trim() ||
		/[\r\n]/.test(auth.token) ||
		typeof auth.projectId !== "string" ||
		!auth.projectId.trim()
	) {
		throw new Error("Invalid Antigravity credentials. Run /login antigravity.");
	}
	const deadline = AbortSignal.timeout(180_000);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
	try {
		const response = await fetchService("providers", `${antigravityEndpoint()}/v1internal:generateContent`, {
			method: "POST",
			redirect: "error",
			signal: combined,
			headers: antigravityHeaders(auth.token),
			body: JSON.stringify({
				project: auth.projectId,
				model,
				request,
				requestType,
				userAgent: "antigravity",
				requestId: `${requestType}/${Date.now()}/${randomUUID()}/1`,
			}),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Antigravity request failed (HTTP ${response.status})`);
		}
		if (!response.body) throw new Error("Empty Antigravity response");
		const reader = response.body.getReader();
		const chunks: Buffer[] = [];
		let size = 0;
		try {
			for (;;) {
				combined.throwIfAborted();
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.byteLength;
				if (size > MAX_RESPONSE_BYTES) throw new Error("Antigravity response exceeds size limit");
				chunks.push(Buffer.from(chunk.value));
			}
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
		let data: Record<string, unknown>;
		try {
			data = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		} catch {
			throw new Error("Invalid Antigravity JSON response");
		}
		const result = data.response === undefined ? data : record(data.response);
		if (data.error || result.error) throw new Error("Antigravity returned an API error");
		if (!Array.isArray(result.candidates) || !result.candidates.length)
			throw new Error("No Antigravity candidate returned");
		return record(result.candidates[0]);
	} catch (error) {
		signal?.throwIfAborted();
		if (deadline.aborted) throw new Error("Antigravity request timed out");
		if (
			error instanceof Error &&
			/^(Antigravity |Empty Antigravity|Invalid Antigravity|No Antigravity)/.test(error.message)
		)
			throw error;
		throw new Error("Antigravity request failed; check the connection and provider proxy");
	}
}

export function candidateParts(candidate: Record<string, unknown>): Record<string, unknown>[] {
	const parts = record(candidate.content).parts;
	if (!Array.isArray(parts)) throw new Error("Invalid Antigravity candidate parts");
	return parts.map(record).filter((part) => !part.thought);
}

export function searchResult(candidate: Record<string, unknown>) {
	const parts = candidateParts(candidate).flatMap((part, index) =>
		typeof part.text === "string" && part.text ? [{ index, text: part.text }] : [],
	);
	if (!parts.length) throw new Error("No Antigravity search text returned");
	const grounding = record(candidate.groundingMetadata);
	const sources = (Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks : []).flatMap(
		(chunk, index) => {
			const web = record(record(chunk).web);
			if (typeof web.uri !== "string") return [];
			try {
				if (!["https:", "http:"].includes(new URL(web.uri).protocol)) return [];
			} catch {
				return [];
			}
			return [
				{
					index,
					title: typeof web.title === "string" ? web.title : web.uri,
					url: web.uri,
				},
			];
		},
	);
	const supports = (Array.isArray(grounding.groundingSupports) ? grounding.groundingSupports : []).flatMap((value) => {
		const support = record(value);
		const segment = record(support.segment);
		if (typeof segment.text !== "string" || !Array.isArray(support.groundingChunkIndices)) return [];
		const sourceIndices = support.groundingChunkIndices.filter((index) =>
			sources.some((source) => source.index === index),
		);
		return sourceIndices.length ? [{ text: segment.text, sourceIndices }] : [];
	});
	return {
		untrusted: true,
		text: parts.map((part) => part.text).join("\n\n"),
		sources,
		supports,
		queries: Array.isArray(grounding.webSearchQueries)
			? grounding.webSearchQueries.filter((q) => typeof q === "string")
			: [],
	};
}

export function parseImages(candidate: Record<string, unknown>) {
	const parts = candidateParts(candidate);
	const images = parts
		.filter((part) => part.inlineData !== undefined)
		.map((part) => {
			const inline = record(part.inlineData);
			const { data, mimeType } = inline;
			if (typeof mimeType !== "string" || !Object.hasOwn(EXTENSIONS, mimeType))
				throw new Error("Unsupported image MIME type");
			if (
				typeof data !== "string" ||
				!data.length ||
				data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
				!/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
				data.length % 4 !== 0
			)
				throw new Error("Invalid image base64 data");
			const bytes = Buffer.from(data, "base64");
			if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data)
				throw new Error("Invalid image base64 data");
			const valid =
				mimeType === "image/png"
					? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
					: mimeType === "image/jpeg"
						? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
						: bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
			if (!valid) throw new Error("Image data does not match MIME type");
			return { data, mimeType };
		});
	if (!images.length || images.length > 8) throw new Error("Expected one to eight Antigravity images");
	return {
		images,
		text: parts.flatMap((part) => (typeof part.text === "string" ? [part.text] : [])).join("\n"),
	};
}

export function imageTarget(cwd: string, requested?: string): string {
	if (requested && isAbsolute(requested)) throw new Error("Image path must be project-relative");
	const target = resolve(cwd, requested || ".pi/generated-images");
	const rel = relative(resolve(cwd), target);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error("Image path escapes project");
	return target;
}

export async function saveImages(
	cwd: string,
	target: string,
	images: { data: string; mimeType: string }[],
	signal?: AbortSignal,
): Promise<string[]> {
	const root = await realpath(cwd);
	const extension = extname(target);
	const directory = extension ? dirname(target) : target;
	let current = root;
	for (const component of relative(resolve(cwd), directory).split(sep).filter(Boolean)) {
		signal?.throwIfAborted();
		current = join(current, component);
		try {
			await mkdir(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const stat = await lstat(current);
		if (stat.isSymbolicLink() || !stat.isDirectory())
			throw new Error("Image path contains a symlink or non-directory");
	}
	const savedPaths: string[] = [];
	for (const [index, image] of images.entries()) {
		signal?.throwIfAborted();
		const suffix = EXTENSIONS[image.mimeType];
		if (extension && extension !== suffix && !(image.mimeType === "image/jpeg" && extension === ".jpeg"))
			throw new Error("Image path extension does not match MIME type");
		const base = extension ? target.slice(0, -extension.length) : join(target, randomUUID());
		const file = `${base}${extension && images.length > 1 ? `-${index + 1}` : ""}${extension || suffix}`;
		await writeFile(file, Buffer.from(image.data, "base64"), {
			flag: "wx",
			signal,
		});
		savedPaths.push(relative(resolve(cwd), file));
	}
	return savedPaths;
}
