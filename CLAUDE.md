# Zellij Windows Port - Claude Iteration Guide

## Project Goal
Porting Zellij (terminal multiplexer) to Windows. Priority features:
1. **Session management** (highest priority) - create, list, attach, detach, kill sessions
2. **Web server** - browser-based terminal UI via Axum+Tokio

## Branch
Working branch: `windows-port` (based off `main`)

## Build & Test Commands
```bash
# Build all core crates:
cargo build -p zellij-utils && cargo build -p zellij-server && cargo build -p zellij-client

# Build the full binary (MUST use --release, debug build fails on OpenSSL):
cargo build --release

# Install to PATH:
cp target/release/zellij.exe ~/.cargo/bin/zellij.exe

# Run tests for all core crates:
cargo test -p zellij-utils && cargo test -p zellij-server && cargo test -p zellij-client

# Run just the Windows-specific tests:
cargo test -p zellij-utils -- windows_session_tests windows_ipc_tests named_pipe::tests

# Run web server tests (requires feature flag):
cargo test -p zellij-client --features web_server_capability -- test_windows_web_server
```

**DO NOT use** `cargo xtask test` on Windows — it tries to natively compile WASM plugins which fails.
**DO NOT use** `vendored_curl` feature — OpenSSL build is broken on this MSYS2 env.
**DO NOT use** `cargo build` (debug) for the full binary — only `cargo build --release` works because the release build has cached OpenSSL artifacts. Per-crate debug builds (`-p zellij-utils` etc.) work fine.

## Iteration Loop
When working on this project autonomously, follow this loop:

1. **Build**: `cargo build -p zellij-utils && cargo build -p zellij-server && cargo build -p zellij-client`
2. **Test**: `cargo test -p zellij-utils && cargo test -p zellij-server && cargo test -p zellij-client`
3. **Make changes**: Fix issues or add features
4. **Verify**: Re-run build + tests
5. **Full binary**: `cargo build --release` (when needed for manual testing)
6. **Do NOT commit** unless explicitly asked

## Current Test Baseline (Windows)
- **zellij-utils**: 204 passed (incl. 21 Windows-specific), 17 failed (path separator snapshots), 2 ignored
- **zellij-server**: 222 passed, 0 failed, 108 ignored (Unix-only tests gated with `#[cfg(all(test, unix))]`)
- **zellij-client**: 24 passed, 0 failed (without web_server_capability)
- **zellij-client** (with web_server): 27 passed (24 + 3 Windows web server tests), 0 failed

Any regression from this baseline means something broke.

## What Was Fixed to Get Here
- Added missing winapi features to `zellij-utils/Cargo.toml`
- Gated Unix-only server tests with `#[cfg(all(test, unix))]`
- Fixed `get_default_shell()` to use `COMSPEC` instead of `SHELL` (avoids MSYS2 path `/usr/bin/bash`)
- Fixed plugin cache cleanup to retry + downgrade log level for Windows file locks
- Fixed shutdown BrokenPipe error spam in `ipc.rs` recv() — returns None on broken pipe
- Downgraded pipe-closing write errors (232, 109) to debug level in `named_pipe.rs`
- Removed duplicate WebServerStarted match arm in `ipc.rs` Display impl
- Cleaned up unused imports in ipc.rs, sessions.rs, named_pipe.rs
- Cleaned up ~50 warnings across server, client, and utils crates (only 3 dead-code warnings remain)
- Fixed unreachable pattern / wrong constant matching in `ClientOsApi` match on Windows
- Made web client test mocks cross-platform (MockClientOsApi, MockSessionManager)
- Gated Unix-only web client tests with `#[cfg(unix)]`, added Windows-specific web server tests

## Key Files
| Area | File |
|------|------|
| Named pipes IPC | `zellij-utils/src/windows_utils/named_pipe.rs` |
| Session discovery | `zellij-utils/src/sessions.rs` |
| IPC abstraction | `zellij-utils/src/ipc.rs` |
| Platform detection | `zellij-utils/src/lib.rs` |
| Client I/O | `zellij-client/src/os_input_output.rs` |
| Server I/O | `zellij-server/src/os_input_output.rs` |
| Server main | `zellij-server/src/lib.rs` |
| Default shell | `zellij-server/src/pty.rs` (get_default_shell) |
| Web server | `zellij-client/src/web_client/` |
| Windows deps | `zellij-utils/Cargo.toml` (winapi features) |
| Build config | `.cargo/config.toml` (ConPTY-only) |

## Known Issues
- Plugin crate tests (default-plugins/*) cannot run natively — they compile to wasm32-wasip1
- `cargo build` (debug) for the full binary fails on OpenSSL — use `cargo build --release`
- Signal handling is stubbed (uses sysinfo instead of Unix signals)
- `tcdrain()` stubbed as `Ok(())`
- Mouse events not implemented
- 17 snapshot tests fail due to Windows path separators (not a code bug, just snapshot format)
- "about" plugin calls xdg-open/open at startup — harmless "program not found" errors on Windows

## Test Priority: What to Add Next
1. ~~Named pipe round-trip tests~~ DONE (6 tests)
2. ~~IPC round-trip tests~~ DONE (7 tests)
3. ~~Session lifecycle tests~~ DONE (8 tests)
4. **Web server tests** on Windows (HTTP endpoints, WebSocket, auth)
5. **Port Unix-gated tests** to work cross-platform

## Architecture Notes
- Windows uses ConPTY via `winptyrs` (no winpty.dll needed)
- IPC: Named pipes (`\\.\pipe\zellij\<session>`) replace Unix domain sockets
- Session discovery: marker files in ZELLIJ_SOCK_DIR + `WaitNamedPipeW`
- Server window hidden via PowerShell `-WindowStyle Hidden`
- 15MB stack for clap argument parsing on Windows
- Log file: `/tmp/zellij-user/zellij-log/zellij.log`
