import test from "node:test";
import assert from "node:assert/strict";

import { assertSafeFetchUrl, fetchWithSafeRedirects, isBlockedAddress } from "./server.js";

test("isBlockedAddress rejects localhost and private addresses", () => {
  assert.equal(isBlockedAddress("localhost"), true);
  assert.equal(isBlockedAddress("127.0.0.1"), true);
  assert.equal(isBlockedAddress("10.0.0.5"), true);
  assert.equal(isBlockedAddress("192.168.1.10"), true);
  assert.equal(isBlockedAddress("169.254.169.254"), true);
  assert.equal(isBlockedAddress("8.8.8.8"), false);
});

test("assertSafeFetchUrl rejects non-http schemes and internal targets", async () => {
  await assert.rejects(() => assertSafeFetchUrl("file:///etc/passwd"), /Blocked URL scheme/i);
  await assert.rejects(() => assertSafeFetchUrl("http://127.0.0.1/test"), /Blocked internal address/i);
  await assert.rejects(
    () => assertSafeFetchUrl("https://metadata.google.internal/computeMetadata/v1"),
    /Blocked internal address/i
  );
});

test("fetchWithSafeRedirects re-validates redirect targets", async () => {
  let fetchCount = 0;
  const fetchImpl = async (url) => {
    fetchCount += 1;
    assert.equal(url, "https://public.example/start");
    return {
      status: 302,
      headers: new Headers({
        location: "http://127.0.0.1/private"
      })
    };
  };

  await assert.rejects(
    () => fetchWithSafeRedirects("https://public.example/start", { fetchImpl }),
    /Blocked internal address/i
  );
  assert.equal(fetchCount, 1);
});

test("fetchWithSafeRedirects stops redirect loops", async () => {
  const fetchImpl = async () => ({
    status: 302,
    headers: new Headers({
      location: "https://public.example/loop"
    })
  });

  await assert.rejects(
    () => fetchWithSafeRedirects("https://public.example/loop", { fetchImpl, maxRedirects: 1 }),
    /Too many redirects/i
  );
});
