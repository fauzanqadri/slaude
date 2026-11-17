import { describe, it, expect } from "bun:test";
import { parseSlashCommand, AGENT_COMMANDS } from "../../../src/gateway/slack/commands";

describe("/workflow and /participant parsing", () => {
  it("/workflow start <pipeline> with a ticket key, free text, or nothing", () => {
    expect(parseSlashCommand("/workflow start ticket PL-1234")).toEqual({ kind: "workflow", action: "start", pipeline: "ticket", ticketRef: "PL-1234", request: "" });
    expect(parseSlashCommand("/workflow start request add a CSV export")).toEqual({ kind: "workflow", action: "start", pipeline: "request", request: "add a CSV export" });
    expect(parseSlashCommand("/workflow start support")).toEqual({ kind: "workflow", action: "start", pipeline: "support", request: "" });
  });
  it("status, cancel and usage", () => {
    expect(parseSlashCommand("/workflow")).toEqual({ kind: "workflow", action: "status" });
    expect(parseSlashCommand("/workflow cancel")).toEqual({ kind: "workflow", action: "cancel" });
    expect(parseSlashCommand("/workflow start")).toEqual({ kind: "workflow", action: "usage" });
    expect(parseSlashCommand("/workflow go")).toEqual({ kind: "workflow", action: "usage" });
  });
  it("/participant add|remove takes Slack mentions; list is the default", () => {
    expect(parseSlashCommand("/participant add <@U111> <@U222|ivan> <@U111>")).toEqual({ kind: "participant", action: "add", userIds: ["U111", "U222"] });
    expect(parseSlashCommand("/participant remove <@U111>")).toEqual({ kind: "participant", action: "remove", userIds: ["U111"] });
    expect(parseSlashCommand("/participant")).toEqual({ kind: "participant", action: "list" });
    expect(parseSlashCommand("/participant add nobody")).toBeNull();
  });
  it("both are listed in help", () => {
    const help = AGENT_COMMANDS.map((c) => c.usage).join(" ");
    expect(help).toContain("/workflow");
    expect(help).toContain("/participant");
  });
});
