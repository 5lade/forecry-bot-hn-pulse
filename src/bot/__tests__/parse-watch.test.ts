import { describe, expect, it } from "vitest";
import { WatchParseError, parseWatchTarget } from "../parse-watch.js";

describe("parseWatchTarget", () => {
  it("parses an HN item id", () => {
    expect(parseWatchTarget("38765432")).toEqual({
      watch_type: "item",
      watch_value: "38765432",
    });
  });

  it("parses a submitter with @ prefix", () => {
    expect(parseWatchTarget("@pg")).toEqual({
      watch_type: "submitter",
      watch_value: "pg",
    });
  });

  it("parses a bare domain", () => {
    expect(parseWatchTarget("example.com")).toEqual({
      watch_type: "domain",
      watch_value: "example.com",
    });
  });

  it("parses a domain with subdomain", () => {
    expect(parseWatchTarget("blog.example.co.uk")).toEqual({
      watch_type: "domain",
      watch_value: "blog.example.co.uk",
    });
  });

  it("strips www. from domain input", () => {
    expect(parseWatchTarget("www.example.com")).toEqual({
      watch_type: "domain",
      watch_value: "example.com",
    });
  });

  it("extracts domain from a URL", () => {
    expect(parseWatchTarget("https://www.example.com/path?q=1")).toEqual({
      watch_type: "domain",
      watch_value: "example.com",
    });
  });

  it("rejects empty input", () => {
    expect(() => parseWatchTarget("")).toThrow(WatchParseError);
  });

  it("rejects invalid submitter handles", () => {
    expect(() => parseWatchTarget("@a")).toThrow(WatchParseError);
    expect(() => parseWatchTarget("@!!")).toThrow(WatchParseError);
  });

  it("rejects garbage that looks neither like id, domain, nor submitter", () => {
    expect(() => parseWatchTarget("not a target")).toThrow(WatchParseError);
    expect(() => parseWatchTarget("foo")).toThrow(WatchParseError);
  });
});
