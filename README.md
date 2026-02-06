# Zellij Windows Port

This is an experimental fork of [Zellij](https://github.com/zellij-org/zellij) adding Windows support. Based on [robbert1978/zellij-win](https://github.com/robbert1978/zellij-win).

## Status

### Working

- **Session management** - create, list, attach, detach, kill sessions via named pipes IPC (`\\.\pipe\zellij\<session>`)
- **Terminal emulation** - ConPTY (Windows Console Pseudo Terminal) via `winpty-rs`, no external DLLs required
- **Web server** - browser-based terminal UI via Axum+Tokio (`zellij web --start`), gated behind `web_server_capability` feature
- **CLI** - `--help`, `--version`, subcommands all work
- **Signal handling** - Ctrl+C, Ctrl+Break, console close via `SetConsoleCtrlHandler`
- **Mouse support** - works via ConPTY
- **Terminal resize** - detected via `WINDOW_BUFFER_SIZE_EVENT`
- **Session discovery** - marker files in `ZELLIJ_SOCK_DIR` + `WaitNamedPipeW` validation
- **Server runs hidden** - server window hidden via PowerShell `-WindowStyle Hidden`
- **ZELLIJ_PANE_ID** - environment variable passed to spawned panes

### Partially Working

- **Session persistence** - sessions don't survive client detach because Unix `daemonize` (fork) isn't available on Windows; server process is tied to the client lifetime
- **Session manager plugin** (Ctrl+O, W) - initial pane exits immediately, plugins don't load

### Not Yet Working

- **`tcdrain`** - stubbed as no-op (ConPTY handles flushing internally)
- **E2E tests** - test runner is Linux-only (SSH remote runner)

### Test Results (Windows)

| Crate | Passed | Failed | Ignored | Notes |
|-------|--------|--------|---------|-------|
| zellij-utils | 204 | 17 | 2 | Failures are path separator snapshot mismatches (`/` vs `\`), not bugs |
| zellij-server | 222 | 0 | 108 | Unix-only tests gated with `#[cfg(all(test, unix))]` |
| zellij-client | 24 | 0 | 0 | +3 web server tests with `web_server_capability` feature |

### Windows-Specific Tests Added

- 6 named pipe tests (create, round-trip, multi-message, try_clone, accept iterator, peek)
- 7 IPC round-trip tests (ConnStatus, KillSession, Render, large messages, sequential requests, Exit)
- 8 session lifecycle tests (bind, discover, handshake, get_sessions, exists, kill, stale cleanup, multiple)
- 3 web server tests (version endpoint, login+auth, unauthorized access)

## Build

```bash
# Build all core crates:
cargo build -p zellij-utils && cargo build -p zellij-server && cargo build -p zellij-client

# Build release binary:
cargo build --release -p zellij --no-default-features --features plugins_from_target

# Run tests:
cargo test -p zellij-utils && cargo test -p zellij-server && cargo test -p zellij-client
```

**Note:** Do not use `cargo xtask test` on Windows (WASM plugin link errors) or `vendored_curl` (OpenSSL build broken on MSYS2).

## Key Technical Decisions

- **ConPTY** via `winpty-rs` with `.cargo/config.toml` override (no winpty.dll needed)
- **Named pipes** (`\\.\pipe\zellij\<session>`) replace Unix domain sockets
- **15MB stack** for clap argument parsing thread on Windows
- **`COMSPEC`** used for default shell instead of `SHELL` (avoids MSYS2 path issues)

## License

MIT
