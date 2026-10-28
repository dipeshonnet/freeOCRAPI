import { expect, test } from "vitest";
import { readLimitedBody, ResponseLimitError } from "./network.js";

test("download bound cancels an excessive declared body before reading it", async () => {
  let reads = 0,
    cancelled = false;
  const response = new Response(
    new ReadableStream(
      {
        pull() {
          reads++;
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "Content-Length": "100" } },
  );
  await expect(readLimitedBody(response, 4)).rejects.toBeInstanceOf(
    ResponseLimitError,
  );
  expect(reads).toBe(0);
  expect(cancelled).toBe(true);
});

test("download bound counts multibyte bytes and cancels even with an absent or false length", async () => {
  for (const length of [undefined, "1"]) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ééé"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: length ? { "Content-Length": length } : {} },
    );
    await expect(readLimitedBody(response, 4)).rejects.toBeInstanceOf(
      ResponseLimitError,
    );
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  }
});

test("download bound preserves complete binary bytes at the limit and propagates stream failures", async () => {
  const bytes = new Uint8Array([0, 255, 13, 10]);
  expect(await readLimitedBody(new Response(bytes), bytes.length)).toEqual(
    Buffer.from(bytes),
  );
  expect(await readLimitedBody(new Response(null), 4)).toEqual(Buffer.alloc(0));
  const failure = new Error("fixture stream interrupted");
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(failure);
      },
    }),
  );
  await expect(readLimitedBody(response, 4)).rejects.toBe(failure);
  expect(response.body?.locked).toBe(false);
});
