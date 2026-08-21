import { describe, it, expect } from "bun:test"
import { parseUnifiedDiff } from "./diff"

describe("parseUnifiedDiff", () => {
  it("parses a simple modified file", () => {
    const diffText = `diff --git a/file.txt b/file.txt
index 1234567..890abcd 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line 1
-line 2
+line 2 changed
 line 3`
    const files = parseUnifiedDiff(diffText)
    expect(files.length).toBe(1)
    expect(files[0].path).toBe("file.txt")
    expect(files[0].status).toBe("modified")
    expect(files[0].added).toBe(1)
    expect(files[0].removed).toBe(1)
    expect(files[0].hunks.length).toBe(1)
    expect(files[0].hunks[0].lines.length).toBe(4)
    expect(files[0].hunks[0].lines[2].text).toBe("line 2 changed")
  })

  it("parses added and deleted files", () => {
    const diffText = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1234567..0000000
--- a/old.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye`
    const files = parseUnifiedDiff(diffText)
    expect(files.length).toBe(2)
    expect(files[0].status).toBe("added")
    expect(files[1].status).toBe("deleted")
  })

  it("parses renamed files", () => {
    const diffText = `diff --git a/old_name.txt b/new_name.txt
similarity index 100%
rename from old_name.txt
rename to new_name.txt`
    const files = parseUnifiedDiff(diffText)
    expect(files.length).toBe(1)
    expect(files[0].status).toBe("renamed")
    expect(files[0].oldPath).toBe("old_name.txt")
    expect(files[0].path).toBe("new_name.txt")
  })

  it("parses binary files", () => {
    const diffText = `diff --git a/image.png b/image.png
index 123..456 100644
Binary files a/image.png and b/image.png differ`
    const files = parseUnifiedDiff(diffText)
    expect(files.length).toBe(1)
    expect(files[0].binary).toBe(true)
  })

  it("handles No newline at end of file", () => {
    const diffText = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,2 @@
-foo
\\ No newline at end of file
+foo
+bar
\\ No newline at end of file`
    const files = parseUnifiedDiff(diffText)
    expect(files[0].added).toBe(2)
    expect(files[0].removed).toBe(1)
  })
})
