import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedAddress, isAllowedOrigin, expandV6 } from "../lib/net-guard.mjs";
import { isAllowedHost } from "../server.mjs";

test("loopback and private IPv4 are allowed", () => {
  for (const a of ["127.0.0.1", "127.8.9.10", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.10", "192.168.0.1"])
    assert.equal(isAllowedAddress(a), true, a);
});

test("public and edge IPv4 are refused", () => {
  for (const a of ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "11.0.0.1", "100.64.0.1", "169.254.1.1", "0.0.0.0", "203.0.113.9"])
    assert.equal(isAllowedAddress(a), false, a);
});

test("IPv6 loopback, link-local and unique-local are allowed; global is refused", () => {
  for (const a of ["::1", "0:0:0:0:0:0:0:1", "fe80::1", "fe80::1%12", "febf::abcd", "fd12:3456::1", "fc00::1"]) assert.equal(isAllowedAddress(a), true, a);
  for (const a of ["2001:4860:4860::8888", "2404:6800::1", "fec0::1", "::", "::2"]) assert.equal(isAllowedAddress(a), false, a);
});

test("IPv4-mapped forms follow the IPv4 rule", () => {
  for (const a of ["::ffff:192.168.1.10", "::FFFF:10.1.2.3", "::ffff:c0a8:010a", "0:0:0:0:0:ffff:127.0.0.1"]) assert.equal(isAllowedAddress(a), true, a);
  for (const a of ["::ffff:8.8.8.8", "::ffff:0808:0808", "::ffff:172.32.0.1"]) assert.equal(isAllowedAddress(a), false, a);
  assert.deepEqual(expandV6("::ffff:192.168.1.10").slice(5), [0xffff, 0xc0a8, 0x010a]);
});

test("junk is refused", () => {
  for (const a of [undefined, null, "", "localhost", "192.168.1", "192.168.1.1.1", "not-an-ip", "::ffff:999.1.1.1"]) assert.equal(isAllowedAddress(a), false, String(a));
});

test("write origins: pages in the house only", () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin("http://192.168.1.10:8790"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:8791"), true);
  assert.equal(isAllowedOrigin("http://localhost:3000"), true);
  assert.equal(isAllowedOrigin("https://claude.ai"), false);
  assert.equal(isAllowedOrigin("null"), false);
  assert.equal(isAllowedOrigin("http://evil.example"), false);
});

test("host header: addresses and home names, never a rebinding domain", () => {
  assert.equal(isAllowedHost("192.168.1.10:8790"), true);
  assert.equal(isAllowedHost("127.0.0.1:8790"), true);
  assert.equal(isAllowedHost("[::1]:8790"), true);
  assert.equal(isAllowedHost("desk-nitro:8790", "DESK-NITRO"), true);
  assert.equal(isAllowedHost("nitro.local:8790"), true);
  assert.equal(isAllowedHost("8.8.8.8"), false);
  assert.equal(isAllowedHost("attacker.example.com:8790"), false);
});
