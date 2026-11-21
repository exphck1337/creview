import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Run the real registered handlers in a disposable package, without any provider or LLM.
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "creview-presets-"));
try {
  fs.mkdirSync(path.join(root, "extensions"));
  fs.cpSync(path.join(source, "extensions", "creview.ts"), path.join(root, "extensions", "creview.ts"));
  fs.cpSync(path.join(source, "templates"), path.join(root, "templates"), { recursive: true });
  const { default: creview } = await import(pathToFileURL(path.join(root, "extensions", "creview.ts")));
  const file = path.join(root, "creview.json");
  const reviewers = { alpha: "fixture/alpha", beta: "fixture/beta", gamma: "fixture/gamma" };
  const save = presets => fs.writeFileSync(file, JSON.stringify({ reviewers, presets }));
  const load = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const hosts = Object.fromEntries(["omp", "pi"].map(id => {
    const commands = {}, events = {}, notices = [], messages = [], dialogs = [];
    let choices = [], inputs = [];
    const models = Object.values(reviewers).map(selector => ({ provider: "fixture", id: selector.split("/")[1] }));
    const api = {
      ...(id === "omp" ? { arktype: {} } : {}),
      on: (name, handler) => { events[name] = handler; },
      registerCommand: (name, command) => { commands[name] = command.handler; },
      sendUserMessage: text => messages.push(text),
      exec: () => { throw new Error("Unexpected command execution"); },
    };
    const ctx = {
      mode: "rpc", hasUI: false, cwd: root,
      models: { list: () => models },
      modelRegistry: { getAvailable: () => models, find: () => undefined, hasConfiguredAuth: () => false },
      ui: {
        notify: (text, type) => notices.push({ text, type }),
        select: async (title, options) => {
          dialogs.push({ title, options });
          const choice = choices.shift();
          if (choice === undefined) return undefined;
          const found = options.find(o => (typeof o === "string" ? o : o.label) === choice ||
            (typeof o === "string" && o.replace(/^\[[ x]\] /, "").split(" - ")[0] === choice));
          assert.notEqual(found, undefined, `${id}: ${choice} missing from ${JSON.stringify(options)}`);
          return typeof found === "string" ? found : found.label;
        },
        input: async () => inputs.shift(), confirm: async () => true,
        onTerminalInput: () => () => {},
      },
    };
    creview(api);
    return [id, {
      events, ctx, notices, messages, dialogs,
      async command(name, args = "", select = [], input = [], ui = false) {
        choices = [...select]; inputs = [...input]; ctx.hasUI = ui;
        notices.length = 0; messages.length = 0; dialogs.length = 0;
        await commands[name](args, ctx);
        assert.equal(choices.length, 0, `${id}: unused dialog responses`);
        return notices.at(-1)?.text ?? "";
      },
    }];
  }));
  const config = (h, action, choices = [], inputs = []) => h.command("creview-config", "", [action, ...choices], inputs, true);
  const labels = dialog => dialog.options.map(o => typeof o === "string" ? o.split(" - ")[0] : o.label);

  for (const h of Object.values(hosts)) {
    assert.match(await h.command("creview-config"), /No review presets yet/);
    assert.match(await h.command("creview", "missing scope"), /No review presets yet/);
    assert.equal(fs.existsSync(file), false);
  }
  // Flat legacy maps, including host-looking names, remain read-only until the first mutation.
  const legacy = { legacy: ["alpha"], omp: ["beta"], pi: ["gamma"] };
  save(legacy);
  const original = fs.readFileSync(file, "utf8");
  assert.match(await hosts.omp.command("creview-config"), /legacy:/);
  assert.match(await hosts.omp.command("creview-config"), /omp:/);
  assert.match(await hosts.omp.command("creview-config"), /pi:/);
  assert.match(await hosts.pi.command("creview-config"), /No review presets yet/);
  assert.match(await hosts.pi.command("creview", "legacy scope"), /No review presets yet/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  // pi can create the same name; all old arrays are retained under omp.
  hosts.pi.ctx.modelRegistry.find = (provider, id) => modelsForPi(provider, id);
  function modelsForPi(provider, id) {
    return Object.values(reviewers).includes(`${provider}/${id}`) ? { provider, id } : undefined;
  }
  hosts.pi.ctx.modelRegistry.hasConfiguredAuth = () => true;
  await config(hosts.pi, "Create a preset", ["beta", "Done (1 selected)"], ["legacy"]);
  assert.deepEqual(load(), { reviewers, presets: { omp: legacy, pi: { legacy: ["beta"] } } });

  for (const id of ["omp", "pi"]) {
    const h = hosts[id], other = id === "omp" ? "pi" : "omp";
    const presets = { omp: { same: ["alpha"], "omp-only": ["alpha"] }, pi: { same: ["beta"], "pi-only": ["beta"] } };
    save(presets);
    const otherBefore = structuredClone(presets[other]);
    const ownMember = id === "omp" ? "alpha" : "beta";
    assert.match(await h.command("creview-config"), new RegExp(`${id}-only:`));
    assert.doesNotMatch(h.notices.at(-1).text, new RegExp(`${other}-only:`));
    await h.command("creview", "", [], [], true);
    assert.deepEqual(labels(h.dialogs[0]), ["same", `${id}-only`]);
    assert.match(await h.command("creview", `${other}-only scope`), /Unknown preset/);
    assert.equal(h.messages.length, 0);
    if (id === "pi") h.ctx.modelRegistry.find = () => undefined; // preflight reports members, never spawns a child
    await h.command("creview", "same scope");
    if (id === "omp") {
      assert.match(h.messages[0], /reviewer-alpha/);
      assert.doesNotMatch(h.messages[0], /reviewer-beta/);
    } else {
      assert.match(h.notices.at(-1).text, /reviewer-beta/);
      assert.doesNotMatch(h.notices.at(-1).text, /reviewer-alpha/);
      h.ctx.modelRegistry.find = modelsForPi;
    }
    await config(h, "Create a preset", ["gamma", "Done (1 selected)"], [`${other}-only`]);
    assert.deepEqual(load().presets[other], otherBefore);
    assert.deepEqual(load().presets[id][`${other}-only`], ["gamma"]);
    await config(h, "Add reviewers to a preset", ["same", "gamma", "Done (1 selected)"]);
    assert.deepEqual(load().presets[id].same, [ownMember, "gamma"]);
    assert.deepEqual(load().presets[other], otherBefore);
    await config(h, "Remove reviewers from a preset", ["same", ownMember, "Done (1 selected)"]);
    assert.deepEqual(load().presets[id].same, ["gamma"]);
    assert.deepEqual(load().presets[other], otherBefore);
    await config(h, "Remove a preset", ["same"]);
    assert.equal(Object.hasOwn(load().presets[id], "same"), false);
    assert.deepEqual(load().presets[other], otherBefore);
    assert.deepEqual(load().reviewers, reviewers);
  }
  // Any malformed section blocks every mutation, including when it belongs to the other host.
  for (const id of ["omp", "pi"]) for (const broken of ["omp", "pi"]) {
    for (const invalid of [null, [], { bad: [42] }, { bad: "alpha" }]) {
      save({ omp: { same: ["alpha", "beta"] }, pi: { same: ["alpha", "beta"] }, [broken]: invalid });
      const before = fs.readFileSync(file, "utf8");
      for (const action of ["Create a preset", "Add reviewers to a preset", "Remove reviewers from a preset", "Remove a preset"]) {
        assert.match(await config(hosts[id], action), /creview.json:/);
        assert.equal(fs.readFileSync(file, "utf8"), before);
      }
    }
  }
  save({ omp: { shared: ["alpha"] }, pi: { shared: ["beta"] } });
  hosts.omp.events.session_start({}, hosts.omp.ctx);
  assert.deepEqual(fs.readdirSync(path.join(root, "agents")).sort(), Object.keys(reviewers).map(n => `reviewer-${n}.md`).sort());
  console.log("PASS host presets: legacy, host-name arrays, missing file, list/picker/typed isolation, all mutations, shared reviewers/agents, malformed sections (both hosts)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
