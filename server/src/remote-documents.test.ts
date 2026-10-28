import { expect, test } from "vitest";
import { publicAddress } from "./remote-documents.js";
test("remote document fetching rejects private, loopback and mapped addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.1.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fc00::1",
  ])
    expect(publicAddress(address), address).toBe(false);
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(publicAddress("2606:4700:4700::1111")).toBe(true);
});
