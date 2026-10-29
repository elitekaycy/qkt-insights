import { describe, expect, it } from "vitest";
import { diffCounts, lineDiff, MAX_DIFF_CELLS } from "./diff";

describe("line diff", () => {
  it("marks removed and added lines with each version's line numbers", () => {
    const diff = lineDiff("a\nb\nc\nd", "a\nc\nx\nd")!;
    expect(diff.map((d) => [d.kind, d.text, d.oldNo, d.newNo])).toEqual([
      ["same", "a", 1, 1],
      ["del", "b", 2, null],
      ["same", "c", 3, 2],
      ["add", "x", null, 3],
      ["same", "d", 4, 4],
    ]);
    expect(diffCounts(diff)).toEqual({ added: 1, removed: 1 });
  });

  it("shows an unchanged version as all unchanged and an empty one as all added", () => {
    expect(diffCounts(lineDiff("a\nb", "a\nb")!)).toEqual({ added: 0, removed: 0 });
    expect(lineDiff("", "a\nb")!.map((d) => d.kind)).toEqual(["del", "add", "add"]);
  });

  it("declines two versions too long to diff", () => {
    const long = "x\n".repeat(Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 1);
    expect(lineDiff(long, `${long}y`)).toBeNull();
  });
});
