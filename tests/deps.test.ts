import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	authorizeDeps,
	buildMetadataBlock,
	extractScriptMetadata,
	normalizePackageName,
	readDeclaredDeps,
	readRequiresPython,
} from "../src/deps.ts";

const NO_PACKAGES = { allowedPackages: [] as string[] };

const withDeps = (...list: string[]) =>
	`# /// script\n# dependencies = [${list.map((d) => `"${d}"`).join(", ")}]\n# ///\nprint("hi")\n`;

describe("normalizePackageName", () => {
	it("applies PEP 503 folding", () => {
		assert.equal(normalizePackageName("Rich"), "rich");
		assert.equal(normalizePackageName("typing_extensions"), "typing-extensions");
		assert.equal(normalizePackageName("zope.interface"), "zope-interface");
	});
});

describe("extractScriptMetadata", () => {
	it("finds a well-formed block", () => {
		const block = extractScriptMetadata(withDeps("rich"));
		assert.ok(block?.startsWith("# /// script"));
		assert.ok(block?.endsWith("# ///"));
	});

	it("returns null when the source declares nothing", () => {
		assert.equal(extractScriptMetadata("print('hi')\n"), null);
	});

	it("tolerates CRLF line endings", () => {
		assert.ok(extractScriptMetadata(withDeps("rich").replace(/\n/g, "\r\n")));
	});

	it("is not fooled by a marker in the middle of the code", () => {
		const code = 'print("# /// script")\nprint("not metadata")\n';
		assert.equal(extractScriptMetadata(code), null);
	});
});

describe("readDeclaredDeps", () => {
	it("reads plain names", () => {
		assert.deepEqual(
			readDeclaredDeps(withDeps("rich", "pandas")).map((d) => d.name),
			["rich", "pandas"],
		);
	});

	it("strips version specifiers and extras", () => {
		assert.deepEqual(
			readDeclaredDeps(withDeps("requests>=2.31", "uvicorn[standard]==0.30", "rich ~= 13.7")).
				map((d) => d.name),
			["requests", "uvicorn", "rich"],
		);
	});

	it("keeps the name out of an environment marker", () => {
		assert.deepEqual(
			readDeclaredDeps(withDeps("pywin32 ; sys_platform == 'win32'")).map((d) => d.name),
			["pywin32"],
		);
	});

	it("handles single quotes and mixed spacing", () => {
		assert.deepEqual(
			readDeclaredDeps("# /// script\n# dependencies = [ 'rich' ,\"pandas\" ]\n# ///\n").
				map((d) => d.name),
			["rich", "pandas"],
		);
	});

	it("marks URL references as direct", () => {
		const [dep] = readDeclaredDeps(withDeps("evil @ https://example.com/evil.whl"));
		assert.equal(dep?.direct, true);
		assert.equal(dep?.name, "");
	});

	it("marks a bare URL as direct", () => {
		const [dep] = readDeclaredDeps(withDeps("https://example.com/evil.tar.gz"));
		assert.equal(dep?.direct, true);
	});

	it("returns nothing when there is no block", () => {
		assert.deepEqual(readDeclaredDeps("import pandas\n"), []);
	});
});

describe("authorizeDeps", () => {
	const none = { allowedPackages: [] };

	it("asks about everything by default", () => {
		const decision = authorizeDeps(readDeclaredDeps(withDeps("rich")), none);
		assert.deepEqual(decision.approved, []);
		assert.deepEqual(decision.needsApproval, ['rich']);
		assert.deepEqual(decision.pendingKeys, ["rich"]);
	});

	it("lets a blessed name through without asking", () => {
		const decision = authorizeDeps(readDeclaredDeps(withDeps("Rich")), {
			allowedPackages: ["rich"],
		});
		assert.deepEqual(decision.approved, ['Rich']);
		assert.deepEqual(decision.needsApproval, []);
	});

	it("honours a name approved earlier in the session", () => {
		const decision = authorizeDeps(readDeclaredDeps(withDeps("rich")), none, new Set(["rich"]));
		assert.deepEqual(decision.approved, ['rich']);
	});

	it("refuses a direct reference no matter what is allowed", () => {
		const decision = authorizeDeps(
			readDeclaredDeps(withDeps("evil @ https://example.com/e.whl")),
			{ allowedPackages: ["evil", "rich"] },
			new Set(["evil"]),
		);
		assert.deepEqual(decision.refused, ['evil @ https://example.com/e.whl']);
		assert.deepEqual(decision.approved, []);
	});

	it("splits a mixed list correctly", () => {
		const decision = authorizeDeps(
			readDeclaredDeps(withDeps("rich", "evil @ https://x/e.whl", "pandas>=2")),
			{ allowedPackages: ["pandas"] },
		);
		assert.deepEqual(decision.approved, ['pandas>=2']);
		assert.deepEqual(decision.needsApproval, ['rich']);
		assert.equal(decision.refused.length, 1);
	});

	it("de-duplicates pending keys but keeps raw entries", () => {
		const decision = authorizeDeps(readDeclaredDeps(withDeps("rich", "rich>=13")), none);
		assert.deepEqual(decision.pendingKeys, ["rich"]);
		assert.equal(decision.needsApproval.length, 2);
	});
});

/**
 * These came out of review. Each one reproduced a way the human could approve
 * a name that was not the name that got installed.
 */
describe("multi-line dependency lists", () => {
	const multiline = `# /// script
# dependencies = [
#   "rich",  # harmless looking
#   "evil",
# ]
# ///
import rich
`;

	it("reads the real names out of a multi-line list", () => {
		assert.deepEqual(
			readDeclaredDeps(multiline).map((d) => d.name),
			["rich", "evil"],
		);
	});

	it("does not show the human a name mangled by comment syntax", () => {
		const decision = authorizeDeps(readDeclaredDeps(multiline), NO_PACKAGES);
		assert.deepEqual(decision.pendingKeys, ["rich", "evil"]);
		assert.doesNotMatch(decision.needsApproval.join(" "), /#/);
	});

	it("keeps version specifiers from a multi-line list", () => {
		const d = readDeclaredDeps(`# /// script\n# dependencies = [\n#   "pandas>=2.0",\n# ]\n# ///\n`);
		assert.deepEqual(d.map((x) => x.raw), ["pandas>=2.0"]);
		assert.deepEqual(d.map((x) => x.name), ["pandas"]);
	});

	it("reads an empty multi-line list as no dependencies", () => {
		assert.deepEqual(readDeclaredDeps(`# /// script\n# dependencies = [\n# ]\n# ///\n`), []);
	});

	it("keeps a # inside a quoted requirement", () => {
		const d = readDeclaredDeps(`# /// script\n# dependencies = ["weird#name"]\n# ///\n`);
		assert.deepEqual(d.map((x) => x.raw), ["weird#name"]);
	});
});

describe("path and archive references", () => {
	for (const spec of ["./pkg", "../shared/lib", "/opt/pkg", "~/pkg", "C:\\pkgs\\thing", "pkg-1.0.whl", "pkg-1.0.tar.gz"]) {
		it(`treats ${spec} as a direct reference`, () => {
			const dep = readDeclaredDeps(`# /// script\n# dependencies = ["${spec}"]\n# ///\n`)[0];
			assert.equal(dep?.direct, true, `${spec} should not be installable by name`);
			assert.equal(dep?.name, "");
		});
	}

	it("does not mistake an ordinary package for a path", () => {
		for (const name of ["rich", "pandas>=2", "uvicorn[standard]==0.30", "python-dateutil"]) {
			const dep = readDeclaredDeps(`# /// script\n# dependencies = ["${name}"]\n# ///\n`)[0];
			assert.equal(dep?.direct, false, `${name} is a normal package`);
		}
	});
});

describe("the block handed to uv", () => {
	it("cannot carry a tool.uv index override through to resolution", () => {
		const code = `# /// script
# dependencies = ["evil"]
# [tool.uv]
# index = "https://evil.example/simple"
# ///
import evil
`;
		const block = buildMetadataBlock(readDeclaredDeps(code), readRequiresPython(code));
		assert.doesNotMatch(block, /evil\.example/);
		assert.doesNotMatch(block, /tool\.uv/);
		assert.doesNotMatch(block, /index/);
		assert.match(block, /dependencies = \["evil"\]/);
	});

	it("preserves a legitimate requires-python", () => {
		const code = `# /// script\n# requires-python = ">=3.11"\n# dependencies = ["rich"]\n# ///\n`;
		const block = buildMetadataBlock(readDeclaredDeps(code), readRequiresPython(code));
		assert.match(block, /requires-python = ">=3\.11"/);
	});

	it("produces a block uv accepts with no dependencies at all", () => {
		assert.equal(buildMetadataBlock([], undefined), "# /// script\n# dependencies = []\n# ///");
	});

	it("quotes an entry containing a quote so the block stays parseable", () => {
		const block = buildMetadataBlock([{ raw: 'a"b', name: "a-b", direct: false }], undefined);
		assert.match(block, /dependencies = \["a\\"b"\]/);
	});
});
