import { describe, it, expect, beforeEach } from "bun:test";
import * as Sandbox from "../../src/db/sandbox";

beforeEach(async () => { await Sandbox._wipeForTests(); });

describe("sandbox_threads", () => {
  it("set then find; set again refreshes created_by", async () => {
    await Sandbox.set({ channelId: "C1", threadTs: "1.0", createdBy: "U_A" });
    expect((await Sandbox.find("C1", "1.0"))?.created_by).toBe("U_A");
    await Sandbox.set({ channelId: "C1", threadTs: "1.0", createdBy: "U_B" });
    expect((await Sandbox.find("C1", "1.0"))?.created_by).toBe("U_B");
    expect(await Sandbox.find("C1", "2.0")).toBeNull();
  });

  it("clear returns the removed row once, then null", async () => {
    await Sandbox.set({ channelId: "C1", threadTs: "1.0", createdBy: "U_A" });
    expect((await Sandbox.clear("C1", "1.0"))?.created_by).toBe("U_A");
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
    expect(await Sandbox.clear("C1", "1.0")).toBeNull();
  });
});
