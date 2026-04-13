/**
 * tau/sn66 v18: diff normalizer. Post-process git-changed files to strip
 * byte-level noise that would keep our added lines from matching the cursor
 * oracle's added lines under LCS scoring (compare.py).
 *
 * Scoring recap (verified in tau/src/compare.py):
 *   - For each changed file, difflib.SequenceMatcher builds an ordered
 *     sequence of "-:<orig>" / "+:<new>" tokens from opcodes.
 *   - The two agents' sequences are compared with another LCS pass.
 *   - Whoever has more matched lines against the cursor oracle wins.
 *
 * Because matching is byte-exact on line content, the following silently lose
 * score even when the "logical" edit is right:
 *   - trailing whitespace on lines we added (cursor typically emits none)
 *   - CRLF added to a file whose original uses LF (or vice versa)
 *   - trailing-newline flip (added / dropped final newline vs original)
 *   - UTF-8 BOM flip
 *
 * This module walks `git status --porcelain` and rewrites each modified or
 * untracked text file with those four issues normalized, preserving the
 * original file's conventions when it has history and defaulting to LF +
 * trailing newline for brand-new files. Normalization is safe: it only
 * touches whitespace that does not carry meaning, and it runs after the model
 * has finished editing so it cannot confuse later tool calls.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface NormalizerOptions {
	repoRoot?: string;
	log?: (msg: string) => void;
	maxFileBytes?: number;
}

export interface NormalizerResult {
	rewritten: string[];
	skipped: Array<{ path: string; reason: string }>;
	error?: string;
}

const DEFAULT_MAX_FILE_BYTES = 2_000_000;

export function normalizeDiffForScoring(opts: NormalizerOptions = {}): NormalizerResult {
	const result: NormalizerResult = { rewritten: [], skipped: [] };
	const log = opts.log ?? (() => {});
	const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

	let repoRoot = opts.repoRoot;
	if (!repoRoot) {
		try {
			repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch (err) {
			result.error = `cannot locate repo root: ${stringifyError(err)}`;
			log(`normalizer: ${result.error}`);
			return result;
		}
	}

	let changed: string[];
	try {
		changed = listChangedPaths(repoRoot);
	} catch (err) {
		result.error = `git status failed: ${stringifyError(err)}`;
		log(`normalizer: ${result.error}`);
		return result;
	}

	for (const rel of changed) {
		const abs = join(repoRoot, rel);
		if (!existsSync(abs)) {
			result.skipped.push({ path: rel, reason: "deleted" });
			continue;
		}
		let st;
		try {
			st = statSync(abs);
		} catch (err) {
			result.skipped.push({ path: rel, reason: `stat: ${stringifyError(err)}` });
			continue;
		}
		if (!st.isFile()) {
			result.skipped.push({ path: rel, reason: "not_file" });
			continue;
		}
		if (st.size > maxBytes) {
			result.skipped.push({ path: rel, reason: "too_large" });
			continue;
		}

		let currentBytes: Buffer;
		try {
			currentBytes = readFileSync(abs);
		} catch (err) {
			result.skipped.push({ path: rel, reason: `read: ${stringifyError(err)}` });
			continue;
		}
		if (isBinary(currentBytes)) {
			result.skipped.push({ path: rel, reason: "binary" });
			continue;
		}

		let originalBytes: Buffer | null = null;
		try {
			originalBytes = execFileSync("git", ["show", `HEAD:${rel}`], {
				cwd: repoRoot,
				stdio: ["ignore", "pipe", "ignore"],
				maxBuffer: maxBytes * 2,
			});
		} catch {
			originalBytes = null;
		}
		if (originalBytes && isBinary(originalBytes)) {
			result.skipped.push({ path: rel, reason: "binary_original" });
			continue;
		}

		const normalized = normalizeBuffer(currentBytes, originalBytes);
		if (!buffersEqual(normalized, currentBytes)) {
			try {
				writeFileSync(abs, normalized);
				result.rewritten.push(rel);
				log(`normalizer: rewrote ${rel}`);
			} catch (err) {
				result.skipped.push({ path: rel, reason: `write: ${stringifyError(err)}` });
			}
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

function listChangedPaths(repoRoot: string): string[] {
	const out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--no-renames"], {
		cwd: repoRoot,
		stdio: ["ignore", "pipe", "ignore"],
	});
	// Each entry is "XY path" separated by NUL. With --no-renames we never get
	// the rename-source follow-up, so parsing is straightforward.
	const entries: string[] = [];
	let start = 0;
	for (let i = 0; i < out.length; i++) {
		if (out[i] !== 0) continue;
		if (i - start >= 3) {
			const x = out[start];
			const y = out[start + 1];
			// Skip pure deletes: nothing to normalize.
			if (x !== 0x44 /* D */ && y !== 0x44 /* D */) {
				entries.push(out.slice(start + 3, i).toString("utf8"));
			}
		}
		start = i + 1;
	}
	return entries;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

type Eol = "\n" | "\r\n";

function normalizeBuffer(current: Buffer, original: Buffer | null): Buffer {
	const isNewFile = original === null;
	const origText = original ? stripBom(original).toString("utf8") : "";
	const origHadBom = original ? hasBom(original) : false;

	// Detect preferred EOL and trailing-newline from original; for new files
	// default to LF with trailing newline (near-universal cursor behavior).
	const eol: Eol = isNewFile ? "\n" : detectEol(origText) ?? "\n";
	const endsWithNewline = isNewFile ? true : endsWithAnyNewline(origText);

	let text = stripBom(current).toString("utf8");

	// Split on any line ending, strip trailing whitespace per line, rejoin
	// with the original's EOL convention. This is the core fix:
	//   - wrong EOLs on added lines become right EOLs
	//   - trailing whitespace on added lines is removed (score-neutral at
	//     worst, score-positive whenever cursor's added line has none)
	//   - unchanged lines remain byte-equivalent to the original after the
	//     trailing-whitespace pass since the original lines have already gone
	//     through the same function during their own original write — and if
	//     they hadn't, stripping is still LCS-neutral.
	const lines = text.split(/\r\n|\n/);
	// If text ends with EOL, split produces a trailing empty string we must
	// preserve as "file ended with newline".
	const hadTrailingEmpty = lines.length > 0 && lines[lines.length - 1] === "";
	if (hadTrailingEmpty) lines.pop();

	for (let i = 0; i < lines.length; i++) {
		lines[i] = stripTrailingWs(lines[i]);
	}

	let out = lines.join(eol);
	if (endsWithNewline && out.length > 0) {
		out += eol;
	} else if (!endsWithNewline && out.endsWith(eol)) {
		out = out.slice(0, -eol.length);
	}
	// Empty-file edge case: match original-empty or empty-new-file.
	if (lines.length === 0) {
		out = "";
	}

	let bytes = Buffer.from(out, "utf8");
	if (origHadBom) {
		bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
	}
	return bytes;
}

function stripTrailingWs(line: string): string {
	let end = line.length;
	while (end > 0) {
		const c = line.charCodeAt(end - 1);
		if (c === 0x20 || c === 0x09 || c === 0x0d) {
			end--;
		} else {
			break;
		}
	}
	return end === line.length ? line : line.slice(0, end);
}

function detectEol(text: string): Eol | null {
	if (!text) return null;
	// Prefer CRLF only if it is the dominant ending.
	let crlf = 0;
	let lf = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) !== 0x0a) continue;
		lf++;
		if (i > 0 && text.charCodeAt(i - 1) === 0x0d) crlf++;
	}
	if (lf === 0) return null;
	const lfOnly = lf - crlf;
	return crlf > lfOnly ? "\r\n" : "\n";
}

function endsWithAnyNewline(text: string): boolean {
	if (!text) return false;
	const last = text.charCodeAt(text.length - 1);
	return last === 0x0a;
}

function hasBom(buf: Buffer): boolean {
	return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

function stripBom(buf: Buffer): Buffer {
	return hasBom(buf) ? buf.subarray(3) : buf;
}

function isBinary(buf: Buffer): boolean {
	// Same heuristic as compare.py: NUL byte anywhere.
	for (let i = 0; i < buf.length && i < 8192; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}

function buffersEqual(a: Buffer, b: Buffer): boolean {
	return a.length === b.length && a.equals(b);
}

function stringifyError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
