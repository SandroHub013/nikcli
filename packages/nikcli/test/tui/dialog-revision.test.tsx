import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal, Show } from "solid-js";
import { DialogProvider, useDialog, type DialogContext } from "@tui/ui/dialog";
import { ToastProvider, useToast } from "@tui/ui/toast";
import { ThemeContext, createStandaloneTheme } from "@tui/context/theme";
import { loadBuiltInTheme } from "@tui/context/theme-catalog";
import { SyncContext } from "@tui/context/sync";
import { SDKProvider } from "@tui/context/sdk";
import { ProjectProvider } from "@tui/context/project";
import { KeybindProvider } from "@tui/context/keybind";
import { DialogProfile } from "@tui/component/dialog-profile";

const theme = createStandaloneTheme({
  document: await loadBuiltInTheme("nikcli"),
  mode: "dark",
});

function barrier<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function mount() {
  const [visible, setVisible] = createSignal(true);
  let dialog!: DialogContext;
  let toast!: ReturnType<typeof useToast>;
  const patch = barrier<Response>();
  const started = barrier<void>();
  const requests: { path: string; method: string; body: string }[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push({ path, method: request.method, body: await request.text() });
    if (path === "/profile" && request.method === "PATCH") {
      started.resolve();
      return patch.promise;
    }
    if (path === "/profile")
      return Response.json({
        version: 1,
        key: "test",
        updatedAt: 1,
        name: "Niko",
      });
    if (path === "/profile/habits") return Response.json({ content: "" });
    if (path === "/profile/preview")
      return Response.json({ lines: [], habitsFile: "" });
    if (path === "/skill" || path === "/tool/ids") return Response.json([]);
    if (path === "/path")
      return Response.json({
        state: "",
        config: "",
        worktree: "/test",
        directory: "/test",
        home: "",
      });
    if (path.startsWith("/experimental/workspace")) return Response.json([]);
    if (path === "/user/account")
      return Response.json({ email: "test@example.com" });
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  }) as typeof fetch;
  function Probe() {
    dialog = useDialog();
    toast = useToast();
    return <text>background</text>;
  }
  const screen = await testRender(
    () => (
      <ThemeContext.Provider value={theme as never}>
        <SyncContext.Provider
          value={
            {
              data: {
                config: {
                  keybinds: { leader: "ctrl+x", input_submit: "return" },
                },
              },
            } as never
          }
        >
          <SDKProvider
            url="http://dialog.test"
            fetch={transport}
            events={{ subscribe: async () => () => {} }}
          >
            <ProjectProvider>
              <KeybindProvider>
                <ToastProvider>
                  <Show when={visible()}>
                    <DialogProvider>
                      <Probe />
                    </DialogProvider>
                  </Show>
                </ToastProvider>
              </KeybindProvider>
            </ProjectProvider>
          </SDKProvider>
        </SyncContext.Provider>
      </ThemeContext.Provider>
    ),
    { width: 100, height: 40 },
  );
  async function openName() {
    dialog.replace(() => <DialogProfile />);
    await screen.waitForFrame((frame) => frame.includes("Search settings"));
    screen.mockInput.pressEnter();
    await screen.waitForFrame((frame) =>
      frame.includes("Used when an agent addresses you directly."),
    );
  }
  async function submit() {
    screen.mockInput.pressEnter();
    await started.promise;
  }
  async function select(title: string) {
    await screen.mockInput.typeText(title);
    await screen.flush();
    screen.mockInput.pressEnter();
  }
  async function openPrompt(kind: "language" | "list" | "skills" | "tools") {
    dialog.replace(() => <DialogProfile />);
    await screen.waitForFrame((frame) => frame.includes("Search settings"));
    await select(
      {
        language: "Reply language",
        list: "Stack",
        skills: "Preferred skills",
        tools: "Preferred tools",
      }[kind],
    );
    if (kind !== "language") {
      await screen.waitForFrame((frame) => frame.includes("+ Add"));
      await select(kind === "list" ? "+ Add" : "+ Add by name");
    }
    await screen.waitForFrame((frame) => frame.includes("submit"));
    await screen.mockInput.typeText("test-value");
  }
  return {
    ...screen,
    dialog,
    toast,
    requests,
    patch,
    openName,
    openPrompt,
    submit,
    disposeProvider: () => setVisible(false),
  };
}

describe("dialog stack revision", () => {
  test("provider disposal invalidates the current revision", async () => {
    const h = await mount();
    try {
      h.dialog.replace(() => <text>child</text>);
      const revision = h.dialog.revision;
      h.disposeProvider();
      await h.flush();
      expect(h.dialog.revision).toBe(revision + 1);
    } finally {
      h.renderer.destroy();
    }
  });
  test("replace, clear, Escape and non-interactive Ctrl+C invalidate before close callbacks", async () => {
    const h = await mount();
    try {
      expect(h.dialog.revision).toBe(0);
      let closedAt = -1;
      h.dialog.replace(
        () => <text>first</text>,
        () => (closedAt = h.dialog.revision),
      );
      expect(h.dialog.revision).toBe(1);
      h.dialog.setSize("large");
      expect(h.dialog.revision).toBe(1);
      h.dialog.replace(() => <text>second</text>);
      expect(closedAt).toBe(2);
      expect(h.dialog.stack).toHaveLength(1);
      h.dialog.clear();
      expect(h.dialog.revision).toBe(3);
      h.dialog.clear();
      expect(h.dialog.revision).toBe(4);
      h.dialog.replace(
        () => <text>escape</text>,
        () => (closedAt = h.dialog.revision),
      );
      h.mockInput.pressEscape();
      await h.flush();
      expect(h.dialog.stack).toHaveLength(0);
      expect(closedAt).toBe(6);
      h.dialog.replace(
        () => <text>interrupt</text>,
        () => (closedAt = h.dialog.revision),
      );
      h.mockInput.pressCtrlC();
      await h.flush();
      expect(h.dialog.stack).toHaveLength(0);
      expect(closedAt).toBe(8);
    } finally {
      h.renderer.destroy();
    }
  });
});

describe("profile name chaining races", () => {
  test("provider disposal during save drops completion side effects", async () => {
    const h = await mount();
    try {
      await h.openName();
      await h.submit();
      h.disposeProvider();
      await h.flush();
      const revision = h.dialog.revision;
      const reads = h.requests.filter((r) => r.method === "GET").length;
      h.patch.resolve(
        Response.json({ version: 1, key: "test", updatedAt: 2, name: "Niko" }),
      );
      await h.flush();
      expect(h.dialog.revision).toBe(revision);
      expect(h.toast.toasts).toHaveLength(0);
      expect(h.requests.filter((r) => r.method === "GET")).toHaveLength(reads);
    } finally {
      h.renderer.destroy();
    }
  });
  test("a submitted answer superseded before its continuation cannot start a save", async () => {
    const h = await mount();
    try {
      await h.openName();
      h.mockInput.pressEnter();
      h.dialog.replace(() => <text>newer dialog</text>);
      const revision = h.dialog.revision;
      await h.flush();
      expect(h.dialog.revision).toBe(revision);
      expect(h.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
      expect(h.toast.toasts).toHaveLength(0);
      expect(h.captureCharFrame()).toContain("newer dialog");
    } finally {
      h.renderer.destroy();
    }
  });

  for (const leave of ["escape", "replace"] as const) {
    test(`${leave} while answering the child cannot save or reopen the profile`, async () => {
      const h = await mount();
      try {
        await h.openName();
        const childRevision = h.dialog.revision;
        if (leave === "escape") h.mockInput.pressEscape();
        else h.dialog.replace(() => <text>newer dialog</text>);
        await h.flush();
        expect(h.dialog.revision).toBe(childRevision + 1);
        expect(h.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
        expect(h.toast.toasts).toHaveLength(0);
        expect(h.dialog.stack).toHaveLength(leave === "escape" ? 0 : 1);
        if (leave === "replace")
          expect(h.captureCharFrame()).toContain("newer dialog");
      } finally {
        h.renderer.destroy();
      }
    });
    for (const outcome of ["success", "failure"] as const) {
      test(`${leave} during save drops late ${outcome}, toast, refetch and reopen`, async () => {
        const h = await mount();
        try {
          await h.openName();
          await h.submit();
          if (leave === "escape") h.mockInput.pressEscape();
          else h.dialog.replace(() => <text>newer dialog</text>);
          if (leave === "escape")
            await h.waitFor(() => h.dialog.stack.length === 0);
          const revision = h.dialog.revision;
          const reads = h.requests.filter((r) => r.method === "GET").length;
          if (outcome === "success")
            h.patch.resolve(
              Response.json({
                version: 1,
                key: "test",
                updatedAt: 2,
                name: "Niko",
              }),
            );
          else h.patch.reject(new Error("save failed"));
          await h.flush();
          expect(h.dialog.revision).toBe(revision);
          expect(h.toast.toasts).toHaveLength(0);
          expect(h.requests.filter((r) => r.method === "GET")).toHaveLength(
            reads,
          );
          expect(h.dialog.stack).toHaveLength(leave === "escape" ? 0 : 1);
          if (leave === "replace")
            expect(h.captureCharFrame()).toContain("newer dialog");
        } finally {
          h.renderer.destroy();
        }
      });
    }
  }

  test("unchanged child stack saves and reopens even though replace disposed the caller", async () => {
    const h = await mount();
    try {
      await h.openName();
      const revision = h.dialog.revision;
      await h.submit();
      h.patch.resolve(
        Response.json({ version: 1, key: "test", updatedAt: 2, name: "Niko" }),
      );
      await h.waitForFrame((frame) => frame.includes("Search settings"));
      expect(h.dialog.revision).toBe(revision + 1);
      expect(h.dialog.stack).toHaveLength(1);
      expect(
        h.requests
          .filter((r) => r.method === "PATCH")
          .map((r) => JSON.parse(r.body)),
      ).toEqual([{ name: "Niko" }]);
      expect(h.toast.toasts.map((t) => t.message)).toEqual(["Name saved"]);
    } finally {
      h.renderer.destroy();
    }
  });
});

describe("profile prompt continuation revisions", () => {
  for (const kind of ["language", "list", "skills", "tools"] as const) {
    test(`${kind}: superseded submitted prompt cannot save or reopen`, async () => {
      const h = await mount();
      try {
        await h.openPrompt(kind);
        h.mockInput.pressEnter();
        h.dialog.replace(() => <text>newer dialog</text>);
        const revision = h.dialog.revision;
        await h.flush();
        expect(h.dialog.revision).toBe(revision);
        expect(h.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
        expect(h.toast.toasts).toHaveLength(0);
        expect(h.captureCharFrame()).toContain("newer dialog");
      } finally {
        h.renderer.destroy();
      }
    });

    for (const outcome of ["success", "failure"] as const) {
      test(`${kind}: superseded save drops late ${outcome} and reopen`, async () => {
        const h = await mount();
        try {
          await h.openPrompt(kind);
          await h.submit();
          h.dialog.replace(() => <text>newer dialog</text>);
          const revision = h.dialog.revision;
          const reads = h.requests.filter((r) => r.method === "GET").length;
          if (outcome === "success")
            h.patch.resolve(
              Response.json({ version: 1, key: "test", updatedAt: 2 }),
            );
          else h.patch.reject(new Error("save failed"));
          await h.flush();
          expect(h.dialog.revision).toBe(revision);
          expect(h.toast.toasts).toHaveLength(0);
          expect(h.requests.filter((r) => r.method === "GET")).toHaveLength(
            reads,
          );
          expect(h.captureCharFrame()).toContain("newer dialog");
        } finally {
          h.renderer.destroy();
        }
      });
    }
  }
});
