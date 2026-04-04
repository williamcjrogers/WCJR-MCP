import test from "node:test";
import assert from "node:assert/strict";

import { extractDocumentText, guessDocumentKind } from "./index.js";

test("guessDocumentKind classifies common local formats", () => {
  assert.equal(guessDocumentKind("memo.docx"), "docx");
  assert.equal(guessDocumentKind("scan.pdf"), "pdf");
  assert.equal(guessDocumentKind("shot.png"), "image");
  assert.equal(guessDocumentKind("message.html"), "html");
  assert.equal(guessDocumentKind("notes.txt"), "text");
});

test("extractDocumentText reads utf8 text files", async () => {
  const result = await extractDocumentText({
    buffer: Buffer.from("alpha\nbeta", "utf-8"),
    fileName: "notes.txt"
  });

  assert.equal(result.kind, "text");
  assert.equal(result.method, "utf8");
  assert.equal(result.text, "alpha\nbeta");
  assert.deepEqual(result.warnings, []);
});

test("extractDocumentText strips html markup for browser-style files", async () => {
  const result = await extractDocumentText({
    buffer: Buffer.from("<html><body><h1>Hello</h1><p>World</p></body></html>", "utf-8"),
    fileName: "message.html"
  });

  assert.equal(result.kind, "html");
  assert.equal(result.method, "html-strip");
  assert.equal(result.text, "Hello World");
  assert.deepEqual(result.warnings, []);
});
