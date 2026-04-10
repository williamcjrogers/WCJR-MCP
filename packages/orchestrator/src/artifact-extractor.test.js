import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  PRODUCER_WHITELIST,
  inferKind,
  computeArtifactId,
  extractCandidatePathsFromResult,
  mergeArtifactHistory,
  isPlausibleAbsolutePath,
  isBlacklistedPath,
  buildArtifactRecord,
  scanWorkspaceForNewFiles,
  extractArtifactsFromPhase
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

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wcjr-l1-test-"));
}

test("buildArtifactRecord returns a full record for a small text file", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "matter.md");
  await fs.writeFile(filePath, "# Test\nSome markdown content here.", "utf-8");

  const record = await buildArtifactRecord(filePath, {
    phaseId: "p1",
    runId: "task_t1",
    tool: "write_markdown",
    toolArgs: {},
    workspaceDir: dir
  });

  assert.ok(record);
  assert.equal(record.runId, "task_t1");
  assert.equal(record.path, filePath);
  assert.equal(record.relPath, "matter.md");
  assert.equal(record.workspaceHit, true);
  assert.equal(record.kind, "md");
  assert.ok(record.sizeBytes > 0);
  assert.equal(record.previewKind, "text");
  assert.ok(record.preview.includes("# Test"));
  assert.equal(record.producedBy.length, 1);
  assert.equal(record.producedBy[0].phaseId, "p1");
  await fs.rm(dir, { recursive: true, force: true });
});

test("buildArtifactRecord flags binary files with skipped-binary preview", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "image.bin");
  const binaryBuffer = Buffer.from([0, 1, 2, 3, 0, 255, 128, 0]);
  await fs.writeFile(filePath, binaryBuffer);

  const record = await buildArtifactRecord(filePath, {
    phaseId: "p1",
    runId: "task_t1",
    tool: "unknown",
    toolArgs: {},
    workspaceDir: dir
  });

  assert.ok(record);
  assert.equal(record.previewKind, "skipped-binary");
  assert.equal(record.preview, null);
  await fs.rm(dir, { recursive: true, force: true });
});

test("buildArtifactRecord flags large files with skipped-large preview", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "big.txt");
  const big = Buffer.alloc(70 * 1024, 0x61); // 70 KB of 'a'
  await fs.writeFile(filePath, big);

  const record = await buildArtifactRecord(filePath, {
    phaseId: "p1",
    runId: "task_t1",
    tool: "unknown",
    toolArgs: {},
    workspaceDir: dir
  });

  assert.ok(record);
  assert.equal(record.previewKind, "skipped-large");
  assert.equal(record.preview, null);
  await fs.rm(dir, { recursive: true, force: true });
});

test("buildArtifactRecord rejects blacklisted paths", async () => {
  const record = await buildArtifactRecord("/etc/passwd", {
    phaseId: "p1",
    runId: "task_t1",
    tool: "unknown",
    toolArgs: {},
    workspaceDir: "/tmp"
  });
  assert.equal(record, null);
});

test("buildArtifactRecord sets workspaceHit=false for paths outside workspaceDir", async () => {
  const dir = await makeTempDir();
  const outsideDir = await makeTempDir();
  const filePath = path.join(outsideDir, "outside.txt");
  await fs.writeFile(filePath, "outside");

  const record = await buildArtifactRecord(filePath, {
    phaseId: "p1",
    runId: "task_t1",
    tool: "unknown",
    toolArgs: {},
    workspaceDir: dir
  });

  assert.ok(record);
  assert.equal(record.workspaceHit, false);
  assert.equal(record.relPath, null);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

test("scanWorkspaceForNewFiles finds files whose mtime is within the time window", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "new.md");
  const since = Date.now() - 1000;
  await fs.writeFile(filePath, "fresh");
  const until = Date.now() + 2000;

  const found = await scanWorkspaceForNewFiles(dir, since, until);
  assert.ok(found.includes(filePath));
  await fs.rm(dir, { recursive: true, force: true });
});

test("scanWorkspaceForNewFiles ignores files outside the time window", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "old.md");
  await fs.writeFile(filePath, "old");
  // Backdate mtime by 1 hour
  const past = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(filePath, past, past);

  const sinceRecent = Date.now() - 1000;
  const untilRecent = Date.now() + 1000;
  const found = await scanWorkspaceForNewFiles(dir, sinceRecent, untilRecent);
  assert.ok(!found.includes(filePath));
  await fs.rm(dir, { recursive: true, force: true });
});

test("scanWorkspaceForNewFiles recurses into subdirectories up to depth 3", async () => {
  const dir = await makeTempDir();
  const sub = path.join(dir, "a", "b");
  await fs.mkdir(sub, { recursive: true });
  const filePath = path.join(sub, "deep.txt");
  const since = Date.now() - 1000;
  await fs.writeFile(filePath, "deep");
  const until = Date.now() + 2000;

  const found = await scanWorkspaceForNewFiles(dir, since, until);
  assert.ok(found.some((p) => p.endsWith("deep.txt")));
  await fs.rm(dir, { recursive: true, force: true });
});

test("extractArtifactsFromPhase combines whitelist and mtime scan", async () => {
  const dir = await makeTempDir();
  const whitelistPath = path.join(dir, "from-tool.xlsx");
  const mtimePath = path.join(dir, "from-scan.md");

  const phaseStartedAt = Date.now() - 500;
  await fs.writeFile(whitelistPath, "fake xlsx");
  await fs.writeFile(mtimePath, "# scanned");
  const phaseEndedAt = Date.now() + 500;

  const phaseToolTrace = [
    {
      tool: "create_workbook",
      args: {},
      result: { outputPath: whitelistPath, sheets: ["S1"] }
    }
  ];

  const artifacts = await extractArtifactsFromPhase({
    phaseToolTrace,
    workspaceDir: dir,
    phaseId: "p1",
    runId: "task_abc",
    phaseStartedAt,
    phaseEndedAt
  });

  const paths = artifacts.map((a) => a.path).sort();
  assert.ok(paths.includes(whitelistPath));
  assert.ok(paths.includes(mtimePath));
  assert.equal(new Set(paths).size, paths.length, "no duplicates");
  await fs.rm(dir, { recursive: true, force: true });
});
