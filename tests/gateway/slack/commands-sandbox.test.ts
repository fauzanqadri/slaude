import { describe, it, expect } from "bun:test";
import { parseSlashCommand, AGENT_COMMANDS } from "../../../src/gateway/slack/commands";

describe("/sandbox parsing", () => {
  it("bare and status → status", () => {
    expect(parseSlashCommand("/sandbox")).toEqual({ kind: "sandbox", action: "status" });
    expect(parseSlashCommand("/sandbox status")).toEqual({ kind: "sandbox", action: "status" });
  });
  it("on / off, case-insensitive", () => {
    expect(parseSlashCommand("/sandbox on")).toEqual({ kind: "sandbox", action: "on" });
    expect(parseSlashCommand("/sandbox OFF")).toEqual({ kind: "sandbox", action: "off" });
  });
  it("an unknown argument is not a command", () => {
    expect(parseSlashCommand("/sandbox maybe")).toBeNull();
  });
  it("is listed in help", () => {
    expect(AGENT_COMMANDS.map((c) => c.usage).join(" ")).toContain("/sandbox");
  });
});
