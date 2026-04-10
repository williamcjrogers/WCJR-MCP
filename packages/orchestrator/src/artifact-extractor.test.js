import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCER_WHITELIST,
  inferKind,
  computeArtifactId,
  extractCandidatePathsFromResult,
  mergeArtifactHistory,
  isPlausibleAbsolutePath,
  isBlacklistedPath
} from "./artifact-extractor.js";

test("PRODUCER_WHITELIST covers the known file-producing tools", () => {
  assert.ok(PRODUCER_WHITELIST.create_workbook);
  assert.ok(PRODUCER_WHITELIST.create_document);
  assert.ok(PRODUCER_WHITELIST.export_workbook);
  assert.ok(PRODUCER_WHITELIST.export_document);
  assert.ok(PRODUCER_WHITELIST.merge_documents);
  assert.ok(PRODUCER_WHITELIST.update_workbook);
});

test("inferKind recognizes common extensions", () => {
  assert.equal(inferKind("/a/b/c.xlsx"), "xlsx");
  assert.equal(inferKind("/a/b/c.docx"), "docx");
  assert.equal(inferKind("/a/b/c.pdf"), "pdf");
  assert.equal(inferKind("/a/b/c.md"), "md");
  assert.equal(inferKind("/a/b/c.txt"), "txt");
  assert.equal(inferKind("/a/b/c.json"), "json");
  assert.equal(inferKind("/a/b/c.csv"), "csv");
  assert.equal(inferKind("/a/b/c.html"), "html");
  assert.equal(inferKind("/a/b/c.weird"), "other");
  assert.equal(inferKind("no-extension"), "other");
});

test("computeArtifactId is stable for same runId + relPath", () => {
  const id1 = computeArtifactId("task_123", "matter.xlsx");
  const id2 = computeArtifactId("task_123", "matter.xlsx");
  assert.equal(id1, id2);
  assert.match(id1, /^art_/);
});

test("computeArtifactId differs for different runIds", () => {
  const id1 = computeArtifactId("task_123", "matter.xlsx");
  const id2 = computeArtifactId("task_456", "matter.xlsx");
  assert.notEqual(id1, id2);
});

test("extractCandidatePathsFromResult uses whitelist for known tools", () => {
  const paths = extractCandidatePathsFromResult({
    tool: "create_workbook",
    args: { outputPath: "/tmp/in.xlsx" },
    result: { outputPath: "/tmp/out.xlsx", sheets: ["S1"] }
  });
  assert.deepEqual(paths, ["/tmp/out.xlsx"]);
});

test("extractCandidatePathsFromResult excludes paths that appear in args", () => {
  const paths = extractCandidatePathsFromResult({
    tool: "merge_documents",
    args: { files: ["/tmp/a.docx", "/tmp/b.docx"], outputPath: "/tmp/merged.docx" },
    result: { outputPath: "/tmp/merged.docx", mergedFiles: ["/tmp/a.docx", "/tmp/b.docx"] }
  });
  assert.deepEqual(paths, ["/tmp/merged.docx"]);
});

test("extractCandidatePathsFromResult falls back to regex for unknown tools", () => {
  const paths = extractCandidatePathsFromResult({
    tool: "unknown_tool",
    args: {},
    result: { savedFile: "/tmp/thing.txt", unrelated: 42 }
  });
  assert.deepEqual(paths, ["/tmp/thing.txt"]);
});

test("extractCandidatePathsFromResult ignores non-absolute paths", () => {
  const paths = extractCandidatePathsFromResult({
    tool: "unknown_tool",
    args: {},
    result: { outputFile: "relative/path.txt" }
  });
  assert.deepEqual(paths, []);
});

test("isPlausibleAbsolutePath accepts POSIX and Windows absolute paths", () => {
  assert.ok(isPlausibleAbsolutePath("/tmp/foo.xlsx"));
  assert.ok(isPlausibleAbsolutePath("C:\\Users\\foo.xlsx"));
  assert.ok(isPlausibleAbsolutePath("D:/Work/foo.xlsx"));
  assert.ok(!isPlausibleAbsolutePath("relative/path.xlsx"));
  assert.ok(!isPlausibleAbsolutePath(""));
  assert.ok(!isPlausibleAbsolutePath(null));
  assert.ok(!isPlausibleAbsolutePath(42));
});

test("isBlacklistedPath rejects OS-sensitive prefixes", () => {
  assert.ok(isBlacklistedPath("C:\\Windows\\System32\\evil.exe"));
  assert.ok(isBlacklistedPath("/etc/passwd"));
  assert.ok(isBlacklistedPath("/proc/self/maps"));
  assert.ok(isBlacklistedPath("/sys/kernel/foo"));
  assert.ok(isBlacklistedPath("/dev/null"));
  assert.ok(!isBlacklistedPath("/tmp/legit.xlsx"));
  assert.ok(!isBlacklistedPath("D:\\work\\matter.xlsx"));
});

test("mergeArtifactHistory combines producedBy across duplicate ids", () => {
  const phase1 = {
    id: "art_abc",
    path: "/tmp/matter.xlsx",
    sizeBytes: 100,
    firstProducedAt: "2026-04-10T10:00:00.000Z",
    lastProducedAt: "2026-04-10T10:00:00.000Z",
    producedBy: [{ phaseId: "p1", tool: "create_workbook", at: "2026-04-10T10:00:00.000Z", sizeBytes: 100 }]
  };
  const phase2 = {
    id: "art_abc",
    path: "/tmp/matter.xlsx",
    sizeBytes: 200,
    firstProducedAt: "2026-04-10T10:05:00.000Z",
    lastProducedAt: "2026-04-10T10:05:00.000Z",
    producedBy: [{ phaseId: "p2", tool: "update_workbook", at: "2026-04-10T10:05:00.000Z", sizeBytes: 200 }]
  };
  const merged = mergeArtifactHistory([phase1, phase2]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sizeBytes, 200);
  assert.equal(merged[0].lastProducedAt, "2026-04-10T10:05:00.000Z");
  assert.equal(merged[0].firstProducedAt, "2026-04-10T10:00:00.000Z");
  assert.equal(merged[0].producedBy.length, 2);
  assert.equal(merged[0].producedBy[0].phaseId, "p1");
  assert.equal(merged[0].producedBy[1].phaseId, "p2");
});

test("mergeArtifactHistory preserves distinct ids", () => {
  const a1 = { id: "art_a", path: "/tmp/a.xlsx", sizeBytes: 1, firstProducedAt: "x", lastProducedAt: "x", producedBy: [{ phaseId: "p1" }] };
  const a2 = { id: "art_b", path: "/tmp/b.xlsx", sizeBytes: 1, firstProducedAt: "x", lastProducedAt: "x", producedBy: [{ phaseId: "p1" }] };
  const merged = mergeArtifactHistory([a1, a2]);
  assert.equal(merged.length, 2);
});

test("extractCandidatePathsFromResult regex fallback excludes arg paths for unknown tools", () => {
  const paths = extractCandidatePathsFromResult({
    tool: "unknown_tool",
    args: { outputFile: "/tmp/input.txt" },
    result: { outputFile: "/tmp/input.txt", resultFile: "/tmp/output.txt" }
  });
  // /tmp/input.txt appears in args → excluded; /tmp/output.txt not in args → included
  assert.deepEqual(paths, ["/tmp/output.txt"]);
});
