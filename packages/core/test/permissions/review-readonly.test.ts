import { PermissionProfileSchema } from "@penumbra/api-contract";
import {
  agentEnforcesPermissionProfile,
  classifyShellCommand,
  evaluateProfileToolCall,
  PERMISSION_PROFILE_REVIEW_READONLY,
  profilesEnforcedBySeats,
  renderOpencodeProfileConfig,
  renderSandboxExecProfile,
  resolveSandboxDenyRoots,
  REVIEW_READONLY_MCP_ALLOWLIST,
} from "@penumbra/core";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("PermissionProfileSchema", () => {
  test("accepts review_readonly", () => {
    expect(PermissionProfileSchema.parse("review_readonly")).toBe("review_readonly");
  });

  test("rejects unknown and empty values", () => {
    for (const value of ["readonly", "review_exec", "", "REVIEW_READONLY", 0, null, true]) {
      expect(PermissionProfileSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("agentEnforcesPermissionProfile", () => {
  const profile = PERMISSION_PROFILE_REVIEW_READONLY;

  test("openai-compat-http enforces natively (no tool surface)", () => {
    expect(agentEnforcesPermissionProfile({ adapter: "openai-compat-http" }, profile)).toBe(true);
  });

  test("opencode-acp enforces natively (config-delivered policy)", () => {
    expect(agentEnforcesPermissionProfile({ adapter: "opencode-acp" }, profile)).toBe(true);
  });

  test("stdio-acp enforces only with explicit opt-in", () => {
    expect(agentEnforcesPermissionProfile({ adapter: "stdio-acp" }, profile)).toBe(false);
    expect(
      agentEnforcesPermissionProfile(
        { adapter: "stdio-acp", enforces_permission_profiles: ["review_readonly"] },
        profile,
      ),
    ).toBe(true);
  });

  test("explicit opt-in list is authoritative when present", () => {
    expect(
      agentEnforcesPermissionProfile(
        { adapter: "opencode-acp", enforces_permission_profiles: [] },
        profile,
      ),
    ).toBe(false);
    expect(
      agentEnforcesPermissionProfile(
        { adapter: "agy-cli", enforces_permission_profiles: ["review_readonly"] },
        profile,
      ),
    ).toBe(true);
  });

  test("cli adapters and unknown agents fail closed", () => {
    for (const adapter of [
      "agy-cli",
      "claude-cli",
      "codex-cli",
      "gemini-cli",
      "opencode-cli",
      "unknown-adapter",
    ]) {
      expect(agentEnforcesPermissionProfile({ adapter }, profile)).toBe(false);
    }
    expect(agentEnforcesPermissionProfile(undefined, profile)).toBe(false);
    expect(agentEnforcesPermissionProfile(null, profile)).toBe(false);
    expect(agentEnforcesPermissionProfile({}, profile)).toBe(false);
  });
});

describe("classifyShellCommand (Layer A denylist)", () => {
  const allow = (cmd: string): void => {
    const result = classifyShellCommand(cmd);
    expect(result.decision).toBe("allow");
  };
  const deny = (cmd: string): void => {
    const result = classifyShellCommand(cmd);
    expect(result.decision).toBe("deny");
  };

  describe("read-only git allowed", () => {
    test.each([
      "git log --oneline -3",
      "git -C /repo diff --stat",
      "git show HEAD:src/a.ts",
      "git show HEAD:src/a.ts | head",
      "cd x && git show HEAD:a.ts | head",
      "git status",
      "git status --short",
      "git blame src/a.ts",
      "git grep -n foo",
      "git rev-parse HEAD",
      "git ls-files",
      "git ls-tree HEAD",
      "git cat-file -p abc123",
      "git merge-base main feature",
      "git describe --tags",
      "git shortlog -sn",
      "git for-each-ref",
      "git branch --list",
      "git branch -a",
      "git branch --show-current",
      "git stash list",
      "git stash show -p stash@{0}",
      "git worktree list",
      "git remote -v",
      "git remote show origin",
      "git remote get-url origin",
      "git config --get user.name",
      "git config --list",
      "git reflog",
      "git reflog show",
      "git tag --list",
      "git tag",
      "git notes list",
      "git submodule status",
      "git fsck",
      "git diff HEAD~1 HEAD",
      "git whatchanged -1",
      "git cherry main feature",
      "git rev-list --count HEAD",
      "git name-rev HEAD",
      "git count-objects -v",
      "git symbolic-ref HEAD",
      "git symbolic-ref --short HEAD",
      "git log -- 2>/dev/null",
      "git status 2>&1",
      "git log 2>&1 | head",
    ])("allow: %s", allow);
  });

  describe("mutating git denied", () => {
    test.each([
      "git stash",
      "git stash push",
      "git stash pop",
      "git stash apply",
      "git stash drop",
      "git stash create",
      "git checkout abc123",
      "git checkout -- file.ts",
      "git checkout -b x",
      "git switch main",
      "git commit -m x",
      "git add .",
      "git rm file",
      "git mv a b",
      "git push",
      "git push origin main",
      "git pull",
      "git fetch",
      "git fetch origin",
      "git rebase main",
      "git rebase -i HEAD~3",
      "git merge feature",
      "git clean -fd",
      "git restore .",
      "git restore --staged x",
      "git apply p.patch",
      "git apply -R p.patch",
      "git cherry-pick abc",
      "git revert HEAD",
      "git reset",
      "git reset --hard HEAD",
      "git branch feature",
      "git branch -d feature",
      "git branch -D feature",
      "git branch -m old new",
      "git tag v1.0",
      "git tag -a v1.0 -m msg",
      "git tag -d v1.0",
      "git worktree add /tmp/x",
      "git worktree remove /tmp/x",
      "git worktree prune",
      "git worktree lock x",
      "git remote add x url",
      "git remote remove x",
      "git remote set-url origin url",
      "git remote prune origin",
      "git config user.name x",
      "git config --unset x",
      "git -c core.pager=sh log",
      "git --config-env=x=y log",
      "git init",
      "git clone url",
      "git gc",
      "git prune",
      "git reflog expire --all",
      "git reflog delete HEAD@{1}",
      "git notes add -m x",
      "git notes remove",
      "git replace -d x",
      "git update-index x",
      "git update-ref HEAD x",
      "git write-tree",
      "git commit-tree x",
      "git mktree",
      "git hash-object -w f",
      "git filter-branch -f",
      "git filter-repo --force",
      "git submodule update",
      "git submodule foreach echo",
      "git sparse-checkout set x",
      "git format-patch -1",
      "git send-email --to x",
      "git archive HEAD -o x.tar",
      "git bundle create x.bundle",
      "git maintenance run",
      "git bisect start",
      "git am p.patch",
      "git read-tree HEAD",
      "git checkout-index -a",
      "git symbolic-ref -d HEAD",
      "git symbolic-ref HEAD refs/heads/x",
      "git diff --output=f.txt",
      "git log --output=f.txt",
      "git diff --ext-diff",
      "git log --open-files-in-pager",
      "git stash && echo done",
      "echo x && git stash",
      "cd repo; git stash",
      "cd repo || git checkout main",
    ])("deny: %s", deny);
  });

  describe("read-only programs allowed (corpus-widened)", () => {
    test.each([
      "rg foo",
      "rg -n 'pattern' src/",
      "rg foo 2>/dev/null",
      "rg foo 2>&1",
      "rg --hidden foo",
      "rg foo | head",
      "grep -rn foo src/",
      "ls -la",
      "cat file.ts",
      "head -20 file",
      "tail -f log",
      "wc -l file",
      "sort file",
      "uniq -c file",
      "cut -d: -f1 file",
      "pwd",
      "echo hello",
      "printf '%s' x",
      "which git",
      "file binary",
      "stat file",
      "jq .data file.json",
      "jq -r '.x' f.json | head",
      "sed -n '1,20p' file",
      "sed -n '/start/,/end/p' file",
      "sed 's/a/b/' file",
      "find . -name '*.ts'",
      "find src -type f -name '*.ts' | head",
      "tr a-z A-Z < file",
      "od -c file | head",
      "xxd file | head",
      "nl file",
      "diff a b",
      "cmp a b",
      "strings binary | head",
      "awk '{print $1}' file",
      "tree -L 2",
      "column -t file",
      "base64 file",
      "iconv -f utf8 file",
      "md5 file",
      "shasum -a 256 file",
      "realpath .",
      "readlink link",
      "basename /a/b/c",
      "dirname /a/b/c",
      "true",
      "false",
      "sleep 1",
      "seq 1 10",
      "id",
      "whoami",
      "uname -a",
      "date",
      "hostname",
      "sw_vers",
      "uptime",
      "ps aux | head",
      "lsof -i :8080",
      "du -sh .",
      "df -h",
      "export FOO=bar && git log",
      "FOO=bar git log",
      "export PATH=/x:$PATH && rg foo",
      "test -f file",
      "[ -f file ]",
      "zcat file.gz | head",
      "history | tail",
      "man git | head -5",
      "cat package.json | jq .name",
      "cd /repo && git log --oneline -1",
    ])("allow: %s", allow);
  });

  describe("mutating/side-effect programs denied", () => {
    test.each([
      "rm file",
      "rm -rf dir",
      "mv a b",
      "cp a b",
      "mkdir dir",
      "rmdir dir",
      "touch file",
      "ln -s a b",
      "chmod +x f",
      "chown u f",
      "chgrp g f",
      "chflags hidden f",
      "truncate -s 0 f",
      "dd if=a of=b",
      "tee f",
      "cat a | tee f",
      "install -m 755 a b",
      "patch < p.patch",
      "rsync -a a/ b/",
      "sqlite3 db 'DELETE FROM t'",
      "sed -i 's/a/b/' f",
      "sed -i.bak 's/a/b/' f",
      "sed --in-place 's/a/b/' f",
      "sed 'w out.txt' f",
      "sed 'e whoami' f",
      "find . -delete",
      "find . -exec rm {} +",
      "find . -execdir rm {} +",
      "find . -ok rm {} +",
      "find . -fprint out.txt",
      "find . -fprintf out.txt %p",
      "rg --pre cat foo",
      "rg --pre=cat foo",
      "xargs rm",
      "ls | xargs git stash",
      "parallel rm",
      "env git stash",
      "env FOO=1 git stash",
      "sudo rm f",
      "nohup git stash",
      "timeout 10 git stash",
      "stdbuf -o0 git stash",
      "watch git stash",
      "eval 'git stash'",
      "exec git stash",
      "bash -c 'git stash'",
      "sh -c 'rm -f x'",
      "zsh -c 'x'",
      "bash script.sh",
      "sh script.sh",
      "python3 -c 'x'",
      "python -c 'x'",
      "python3 <<'EOF'\nx\nEOF",
      "node -e 'x'",
      "node script.js",
      "deno run x.ts",
      "ruby -e 'x'",
      "perl -pe 's/a/b/' f",
      "php -r 'x'",
      "lua -e 'x'",
      "osascript -e 'x'",
      "killall vim",
      "pkill -f x",
      "launchctl list",
      "crontab -e",
      "defaults write x y",
      "brew install x",
      "docker ps",
      "kubectl get pods",
      "systemctl status x",
      "gh pr list",
      "hub issue",
      "jj log",
      "ssh host",
      "scp a b:",
      "sftp host",
      "curl https://x",
      "wget https://x",
      "nc -l 8080",
      "telnet host 80",
      "ping 8.8.8.8",
      "dig x",
      "nslookup x",
      "gpg --gen-key",
      "ssh-keygen",
      "vim f",
      "nano f",
      "ed f",
      "code f",
      "fzf --bind 'enter:execute(rm {})'",
      "tar xf a.tar",
      "tar cf a.tar dir",
      "tar -xzf a.tgz",
      "unzip a.zip",
      "zip -r a.zip dir",
      "7z x a.7z",
      "gzip file",
      "gunzip f.gz",
      "split -l 10 f",
      "csplit f 10",
      "mktemp -d /tmp/x.XXXX",
      "unlink f",
      "rename a b",
      "ditto a b",
      "cpio -o > a.cpio",
      "git-stash-helper",
      "git-secret x",
    ])("deny: %s", deny);
  });

  describe("test/typecheck/build runners denied", () => {
    test.each([
      "bun test",
      "bun test path/file.test.ts",
      "bun run test",
      "bun run typecheck",
      "bun run build",
      "bun run lint:strict",
      "bun run check:ci",
      "bun install",
      "bun install --frozen-lockfile",
      "bun --version",
      "bunx tsc",
      "bun x vitest",
      "npm test",
      "npm run build",
      "npm install",
      "npx tsc",
      "pnpm test",
      "pnpm install",
      "yarn test",
      "yarn build",
      "tsc -p x",
      "tsc --noEmit",
      "vitest",
      "vitest run",
      "jest",
      "jest --watch",
      "mocha",
      "pytest",
      "pytest -k x",
      "cargo test",
      "cargo build",
      "cargo check",
      "go test ./...",
      "go build ./...",
      "go install x",
      "make",
      "make check",
      "cmake --build .",
      "ninja",
      "gradle build",
      "./gradlew test",
      "mvn test",
      "dotnet test",
      "composer install",
      "phpunit",
      "rspec",
      "rake test",
      "swift test",
      "swift build",
      "eslint --fix src/",
      "prettier --write src/",
      "biome check --write src/",
      "go fmt ./...",
      "gofmt -w .",
      "pip install x",
      "pip3 install x",
      "poetry install",
      "uv pip install x",
      "gem install x",
      "bundler install",
    ])("deny: %s", deny);
  });

  describe("redirects and chaining", () => {
    test.each([
      "cat a > b",
      "cat a >> b",
      "echo x > file",
      "echo x >> file",
      "rg foo > out.txt",
      "git log > log.txt",
      "echo x 1> f",
      "echo x 2> err.txt",
      "cmd &> all.txt",
      "cmd &>> all.txt",
      "cat <<'EOF' > f\nx\nEOF",
      "tee >(cat > f)",
      "git stash > /tmp/out",
    ])("deny: %s", deny);

    test.each([
      "rg foo 2>/dev/null",
      "rg foo 2>&1",
      "cmd 2>&-",
      "cmd >/dev/null",
      "cmd >>/dev/null",
      "cmd >&2",
      "cmd 1>&2",
      "git log 2>&1 | head",
      "cmd 2>/dev/null && git log",
    ])("allow: %s", allow);
  });

  describe("command substitution classified recursively", () => {
    test("mutating inner substitution denied", () => {
      deny("echo $(git stash)");
      deny("echo `git stash`");
      deny("git log $(git rev-parse HEAD) && git stash");
    });
    test("read-only inner substitution allowed", () => {
      allow("echo $(git rev-parse HEAD)");
      allow("git show $(git rev-parse HEAD):a.ts");
      allow("cd $(git rev-parse --show-toplevel) && git log -1");
    });
  });

  test("empty and whitespace commands allowed", () => {
    allow("");
    allow("   ");
  });

  describe("shell-syntax bypasses", () => {
    describe("control keywords hiding the real program", () => {
      test.each([
        "if rm -rf .; then echo hi; fi",
        'while read f; do rm "$f"; done',
        "for f in a b; do rm $f; done",
        "until false; do rm x; done",
        "case x in x) rm y;; esac",
        "{ rm -rf .; }",
        "! rm x",
        "then rm x",
        "select f in a; do rm $f; done",
      ])("deny: %s", deny);

      test.each([
        "if git log; then echo ok; fi",
        "for f in a b; do echo $f; done",
        "while read -r l; do echo $l; done < file",
        "{ git log; }",
        "case x in x) echo hi;; esac",
      ])("allow: %s", allow);
    });

    describe("exec-capable builtins and wrappers", () => {
      test.each([
        "time rm -rf .",
        "time -p rm x",
        "coproc rm x",
        "coproc X { rm x; }",
        "trap 'rm -rf /tmp/x' EXIT",
        'bind -x \'"x":"rm y"\'',
        "enable -f /tmp/evil.so evil",
        "fc -s ls",
        "complete -C 'rm x' foo",
        "mapfile -C 'rm x' -c 1 arr",
        "readarray -C 'rm x' -c 1 arr",
        "zmodload zsh/net/tcp",
        "builtin -f /tmp/evil.so evil",
        "builtin --load /tmp/evil.so",
      ])("deny: %s", deny);

      test.each(["command -v rm", "builtin echo hi"])("allow: %s", allow);
    });

    describe("ANSI-C $'' quoting decodes escapes", () => {
      test.each(["$'\\x72\\x6d' -rf .", "echo $'ok'; $'\\x72\\x6d' x"])("deny: %s", deny);

      test.each(["echo $'safe'", "printf $'line\\n'"])("allow: %s", allow);
    });

    describe("indirect program names are uninspectable", () => {
      test.each(["r=rm; $r -rf .", "${cmd} x", "/usr/bin/$tool arg", "PAGER=x $prog"])(
        "deny: %s",
        deny,
      );

      test.each(["echo $HOME", "git log --format=%s", "echo $1 $@"])("allow: %s", allow);
    });
  });
});

describe("evaluateProfileToolCall", () => {
  const profile = PERMISSION_PROFILE_REVIEW_READONLY;

  test("fs write tools denied with reason", () => {
    for (const toolName of [
      "fs.write_text_file",
      "fs_write",
      "fs.write",
      "fs.edit",
      "fs_edit",
      "write",
      "edit",
      "apply_patch",
    ]) {
      const result = evaluateProfileToolCall(profile, toolName, { path: "x", content: "y" });
      expect(result.decision).toBe("deny");
    }
  });

  test("fs read tools approved", () => {
    for (const toolName of ["fs.read_text_file", "fs_read", "fs_glob", "fs_grep", "read"]) {
      const result = evaluateProfileToolCall(profile, toolName, { path: "x" });
      expect(result.decision).toBe("approve");
    }
  });

  test("terminal.create classifies command", () => {
    expect(evaluateProfileToolCall(profile, "terminal.create", { cmd: "git stash" }).decision).toBe(
      "deny",
    );
    expect(
      evaluateProfileToolCall(profile, "terminal.create", { command: "rm -rf /" }).decision,
    ).toBe("deny");
    expect(evaluateProfileToolCall(profile, "terminal.create", { cmd: "git log" }).decision).toBe(
      "approve",
    );
    expect(
      evaluateProfileToolCall(profile, "terminal_create", { argv: ["git", "stash"] }).decision,
    ).toBe("deny");
    expect(
      evaluateProfileToolCall(profile, "terminal.create", { argv: ["git", "log"] }).decision,
    ).toBe("approve");
  });

  test("terminal.create classifies argv even when the cmd label is benign", () => {
    // ACP terminal/create carries a display `command`/`cmd` label AND the real
    // `args`/`argv` vector — the classifier must check both, not stop at the
    // first inspectable string.
    expect(
      evaluateProfileToolCall(profile, "terminal.create", {
        cmd: "ls",
        argv: ["rm", "-rf", "."],
      }).decision,
    ).toBe("deny");
    expect(
      evaluateProfileToolCall(profile, "terminal_create", {
        command: "list files",
        args: ["git", "commit", "-m", "x"],
      }).decision,
    ).toBe("deny");
  });

  test("terminal.create argv is classified as argv, not re-tokenized as shell", () => {
    // `echo a; rm x` as argv executes echo only — the `;` is data, not an
    // operator. A shell-string re-parse would false-deny this.
    expect(
      evaluateProfileToolCall(profile, "terminal.create", { argv: ["echo", "a; rm x"] }).decision,
    ).toBe("approve");
    expect(
      evaluateProfileToolCall(profile, "terminal.create", {
        argv: ["env", "GIT_PAGER=sh", "git", "log"],
      }).decision,
    ).toBe("deny");
  });

  test("every command-string field is classified, not just the first", () => {
    expect(
      evaluateProfileToolCall(profile, "terminal.create", {
        cmd: "git log",
        command: "rm -rf .",
      }).decision,
    ).toBe("deny");
  });

  test("shell/fs.exec style tools classify command", () => {
    expect(evaluateProfileToolCall(profile, "fs.exec", { command: "rm f" }).decision).toBe("deny");
    expect(evaluateProfileToolCall(profile, "fs_exec", { command: "git log" }).decision).toBe(
      "approve",
    );
    expect(evaluateProfileToolCall(profile, "shell.run", { command: "git push" }).decision).toBe(
      "deny",
    );
    expect(evaluateProfileToolCall(profile, "bash", { command: "git stash" }).decision).toBe(
      "deny",
    );
  });

  test("unknown tool names fail open to Layer B", () => {
    const result = evaluateProfileToolCall(profile, "memory_recall", {});
    expect(result.decision).toBe("approve");
  });
});

describe("renderOpencodeProfileConfig", () => {
  test("renders explicit deny rules with no ask", () => {
    const config = renderOpencodeProfileConfig();
    const permission = (config as { permission: Record<string, unknown> }).permission;
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('"ask"');
    expect(permission.edit).toBe("deny");
    expect(permission.webfetch).toBe("deny");
    expect(permission.websearch).toBe("deny");
    expect(permission.task).toBe("deny");
    expect(permission.external_directory).toBe("deny");
    expect(permission.doom_loop).toBe("deny");
    expect((config as { experimental: { continue_loop_on_deny: boolean } }).experimental).toEqual({
      continue_loop_on_deny: true,
    });
  });

  test("bash ruleset allows reads and denies mutations", () => {
    const { permission } = renderOpencodeProfileConfig() as {
      permission: { bash: Record<string, string> };
    };
    const bash = permission.bash;
    expect(bash["*"]).toBe("allow");
    for (const pattern of [
      "git stash -*",
      "git stash --*",
      "git commit*",
      "git push*",
      "git checkout*",
      "git reset*",
      "git restore*",
      "git apply*",
      "git worktree add*",
      "rm*",
      "mv*",
      "cp*",
      "mkdir*",
      "tee*",
      "sed *-i*",
      "find *-exec*",
      "find *-delete*",
      "bun*",
      "npm*",
      "python*",
      "bash -c*",
      "sh -c*",
      "env *",
      "xargs*",
      "curl*",
      "wget*",
      "sudo*",
      "gh*",
      "docker*",
      "rg --pre*",
      "git -c*",
      "git config*",
      "git fetch*",
      "git pull*",
      "git rebase*",
      "git merge*",
      "git clean*",
      "git cherry-pick*",
      "git revert*",
      "git branch -d*",
      "git branch -D*",
      "git tag -d*",
      "git remote add*",
      "git remote remove*",
      "git remote set-url*",
      "git init*",
      "git clone*",
      "git add*",
      "git rm*",
      "git mv*",
      "git switch*",
      "git gc*",
      "git prune*",
      "git reflog expire*",
      "git notes*",
      "git submodule*",
      "git sparse-checkout*",
      "git format-patch*",
      "git send-email*",
      "git filter-*",
      "git update-index*",
      "git update-ref*",
      "git write-tree*",
      "git commit-tree*",
      "git mktree*",
      "git hash-object*",
      "git symbolic-ref*",
      "git stash push*",
      "git stash pop*",
      "git stash apply*",
      "git stash drop*",
      "git stash clear*",
      "git stash create*",
      "git stash branch*",
      "tsc*",
      "vitest*",
      "jest*",
      "pytest*",
      "cargo*",
      "make*",
      "go test*",
      "go build*",
      "dd*",
      "chmod*",
      "chown*",
      "ln*",
      "install*",
      "patch*",
      "rsync*",
      "ssh*",
      "scp*",
      "killall*",
      "pkill*",
      "open*",
      "sqlite3*",
      "tar*",
      "unzip*",
      "zip*",
      "gzip*",
      "gunzip*",
      "split*",
      "git stash",
    ]) {
      expect(bash[pattern]).toBe("deny");
    }
  });

  test("read ruleset allows reads but denies dotenv", () => {
    const { permission } = renderOpencodeProfileConfig() as {
      permission: { read: Record<string, string> };
    };
    expect(permission.read["*"]).toBe("allow");
    expect(permission.read["*.env"]).toBe("deny");
    expect(permission.read["*.env.*"]).toBe("deny");
  });

  test("agent-scoped permission mirrors top-level when agent provided", () => {
    const config = renderOpencodeProfileConfig({ agent: "reviewer" }) as {
      permission: Record<string, unknown>;
      agent: Record<string, { permission: Record<string, unknown> }>;
    };
    expect(config.agent.reviewer.permission).toEqual(config.permission);
  });

  test("every opencode tool id has an explicit rule", () => {
    const { permission } = renderOpencodeProfileConfig() as { permission: Record<string, unknown> };
    const knownTools = [
      "edit",
      "write",
      "apply_patch",
      "bash",
      "read",
      "glob",
      "grep",
      "list",
      "lsp",
      "webfetch",
      "websearch",
      "task",
      "skill",
      "question",
      "external_directory",
      "doom_loop",
      "todowrite",
      "todoread",
      "codesearch",
      "invalid",
    ];
    for (const tool of knownTools) {
      expect(Object.hasOwn(permission, tool)).toBe(true);
    }
  });
});

describe("renderSandboxExecProfile", () => {
  test("emits deny file-write* over every protected root", () => {
    const profile = renderSandboxExecProfile(["/repo", "/home/u/.penumbra"]);
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain('(deny file-write* (subpath "/repo"))');
    expect(profile).toContain('(deny file-write* (subpath "/home/u/.penumbra"))');
  });

  test("escapes quotes and backslashes in paths", () => {
    const profile = renderSandboxExecProfile(['/weird"path']);
    expect(profile).toContain('\\"');
  });

  test("empty roots still yields a parseable deny-nothing profile", () => {
    const profile = renderSandboxExecProfile([]);
    expect(profile).toContain("(version 1)");
    expect(profile).not.toContain("deny file-write*");
  });
});

describe("resolveSandboxDenyRoots", () => {
  test("returns the realpath'd cwd plus every extra root, deduped and sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "deny-roots-"));
    try {
      const real = realpathSync(dir);
      const roots = resolveSandboxDenyRoots(dir, [dir, join(dir, "sub"), null, undefined]);
      // tmpdir() itself is a symlink on macOS (/var→/private/var) — all entries
      // must be canonical or SBPL subpath rules silently miss.
      expect(roots).toEqual([...new Set([real, join(real, "sub")])].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves missing roots through their nearest real ancestor", () => {
    const dir = mkdtempSync(join(tmpdir(), "deny-roots-"));
    try {
      const missing = join(dir, "not-yet-created", "deeper");
      const roots = resolveSandboxDenyRoots(missing);
      expect(roots).toEqual([join(realpathSync(dir), "not-yet-created", "deeper")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("collapses a symlinked root to its target", () => {
    const dir = mkdtempSync(join(tmpdir(), "deny-roots-"));
    mkdirSync(join(dir, "target"));
    const link = join(dir, "link");
    symlinkSync(join(dir, "target"), link, "dir");
    try {
      const roots = resolveSandboxDenyRoots(link);
      expect(roots).toEqual([join(realpathSync(dir), "target")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("REVIEW_READONLY_MCP_ALLOWLIST", () => {
  test("contains only read-oriented tool ids", () => {
    expect(REVIEW_READONLY_MCP_ALLOWLIST).toEqual([
      "memory_search",
      "memory_recall",
      "memory_timeline",
      "memory_get_observations",
      "read_handle",
      "fs_read",
      "fs_glob",
      "fs_grep",
      "handoff_get",
      "chain_list_agents",
    ]);
  });
});

describe("profilesEnforcedBySeats", () => {
  test("returns the union of profiles any seat can enforce", () => {
    const seats = [
      { adapter: "claude-cli" },
      { adapter: "openai-compat-http" },
      { adapter: "stdio-acp", enforces_permission_profiles: ["review_readonly"] },
    ];
    expect(profilesEnforcedBySeats(seats)).toEqual(["review_readonly"]);
  });

  test("returns [] when no seat can enforce any profile", () => {
    expect(profilesEnforcedBySeats([{ adapter: "claude-cli" }, { adapter: "stdio-acp" }])).toEqual(
      [],
    );
    expect(profilesEnforcedBySeats([])).toEqual([]);
  });

  test("an explicit opt-out list does not count even for native adapters", () => {
    const seats = [{ adapter: "openai-compat-http", enforces_permission_profiles: [] }];
    expect(profilesEnforcedBySeats(seats)).toEqual([]);
  });
});
