import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

/**
 * Load the extension the way pi loads it -- through jiti, from a path on disk
 * -- rather than through node's TypeScript stripper. The two resolve
 * differently, so passing the unit tests does not prove pi can start.
 */
describe("pi can load this extension", () => {
	it("registers a working probe tool from a path", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "probe-load-"));
		t.after(() => rm(dir, { recursive: true, force: true }));

		const here = process.cwd();
		const result = await discoverAndLoadExtensions([join(here, "index.ts")], here);

		assert.deepEqual(result.errors ?? [], [], "pi reported a load error");
		const probe = result.extensions
			.flatMap((e) => [...(e.tools ?? new Map()).values()])
			.find((tool) => tool.definition.name === "probe");
		assert.ok(probe, "the probe tool was not registered");
		assert.equal(typeof probe.definition.description, "string");
		assert.ok(probe.definition.description.length > 0);
	});
});
