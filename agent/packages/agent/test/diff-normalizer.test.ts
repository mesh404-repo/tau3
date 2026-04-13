import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeDiffForScoring } from "../src/diff-normalizer.js";

function run(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "normtest-"));
	run(dir, "init", "-q", "-b", "main");
	run(dir, "config", "user.email", "t@t");
	run(dir, "config", "user.name", "t");
	return dir;
}

function commit(dir: string, rel: string, bytes: Buffer | string): void {
	writeFileSync(join(dir, rel), bytes);
	run(dir, "add", rel);
	run(dir, "commit", "-qm", "init");
}

describe("diff normalizer", () => {
	let repo: string;
	beforeEach(() => {
		repo = makeRepo();
	});
	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("strips trailing whitespace on modified file", () => {
		commit(repo, "a.ts", "line1\nline2\n");
		writeFileSync(join(repo, "a.ts"), "line1\nline2  \nline3\t\n");
		normalizeDiffForScoring({ repoRoot: repo });
		expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("line1\nline2\nline3\n");
	});

	it("preserves CRLF when original used CRLF", () => {
		commit(repo, "b.ts", "line1\r\nline2\r\n");
		writeFileSync(join(repo, "b.ts"), "line1\nline2\nline3\n");
		normalizeDiffForScoring({ repoRoot: repo });
		expect(readFileSync(join(repo, "b.ts"), "utf8")).toBe("line1\r\nline2\r\nline3\r\n");
	});

	it("preserves final-newline-absent when original lacked it", () => {
		commit(repo, "c.ts", "one\ntwo");
		writeFileSync(join(repo, "c.ts"), "one\ntwo\nthree\n");
		normalizeDiffForScoring({ repoRoot: repo });
		expect(readFileSync(join(repo, "c.ts"), "utf8")).toBe("one\ntwo\nthree");
	});

	it("adds final newline for untracked new file", () => {
		writeFileSync(join(repo, "new.ts"), "hello  \nworld");
		normalizeDiffForScoring({ repoRoot: repo });
		expect(readFileSync(join(repo, "new.ts"), "utf8")).toBe("hello\nworld\n");
	});

	it("skips binary files", () => {
		commit(repo, "img.bin", Buffer.from([1, 2, 3, 0, 4, 5]));
		const dirty = Buffer.from([1, 2, 0, 0, 9]);
		writeFileSync(join(repo, "img.bin"), dirty);
		normalizeDiffForScoring({ repoRoot: repo });
		expect(readFileSync(join(repo, "img.bin"))).toEqual(dirty);
	});

	it("preserves BOM when original had one", () => {
		const bom = Buffer.from([0xef, 0xbb, 0xbf]);
		commit(repo, "d.ts", Buffer.concat([bom, Buffer.from("line\n")]));
		writeFileSync(join(repo, "d.ts"), Buffer.concat([bom, Buffer.from("line\nadded  \n")]));
		normalizeDiffForScoring({ repoRoot: repo });
		const out = readFileSync(join(repo, "d.ts"));
		expect(out.subarray(0, 3)).toEqual(bom);
		expect(out.subarray(3).toString("utf8")).toBe("line\nadded\n");
	});

	it("is a no-op on clean working tree", () => {
		commit(repo, "e.ts", "clean\n");
		const r = normalizeDiffForScoring({ repoRoot: repo });
		expect(r.rewritten).toEqual([]);
		expect(readFileSync(join(repo, "e.ts"), "utf8")).toBe("clean\n");
	});

	it("handles deleted files gracefully", () => {
		commit(repo, "f.ts", "gone\n");
		rmSync(join(repo, "f.ts"));
		const r = normalizeDiffForScoring({ repoRoot: repo });
		expect(r.rewritten).toEqual([]);
	});
});
