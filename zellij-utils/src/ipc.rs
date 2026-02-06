//! IPC stuff for starting to split things into a client and server model.

#[cfg(windows)]
use crate::windows_utils::named_pipe::{Pipe, PipeStream};
use crate::{
    data::{ClientId, ConnectToSession, KeyWithModifier, Style},
    errors::{get_current_ctx, prelude::*, ErrorContext},
    input::{actions::Action, cli_assets::CliAssets},
    pane_size::{Size, SizeInPixels},
};

#[cfg(windows)]
use winapi::shared::winerror::ERROR_BROKEN_PIPE;

#[cfg(unix)]
use crate::shared::set_permissions;

#[cfg(unix)]
use interprocess::local_socket::{LocalSocketListener, LocalSocketStream};

#[cfg(unix)]
use nix::unistd::dup;

use serde::{Deserialize, Serialize};
use std::{
    fmt::{Display, Error, Formatter},
    io::{self, Read, Write},
    marker::PhantomData,
    path::Path,
    thread::sleep,
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::io::{AsRawFd, FromRawFd};

type SessionId = u64;

#[derive(PartialEq, Eq, Serialize, Deserialize, Hash)]
pub struct Session {
    // Unique ID for this session
    id: SessionId,
    // Identifier for the underlying IPC primitive (socket, pipe)
    conn_name: String,
    // User configured alias for the session
    alias: String,
}

// How do we want to connect to a session?
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientType {
    Reader,
    Writer,
}

#[derive(Default, Serialize, Deserialize, Debug, Clone)]
pub struct ClientAttributes {
    pub size: Size,
    pub style: Style,
}

#[derive(Default, Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelDimensions {
    pub text_area_size: Option<SizeInPixels>,
    pub character_cell_size: Option<SizeInPixels>,
}

impl PixelDimensions {
    pub fn merge(&mut self, other: PixelDimensions) {
        if let Some(text_area_size) = other.text_area_size {
            self.text_area_size = Some(text_area_size);
        }
        if let Some(character_cell_size) = other.character_cell_size {
            self.character_cell_size = Some(character_cell_size);
        }
    }
}

// Types of messages sent from the client to the server
#[allow(clippy::large_enum_variant)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum ClientToServerMsg {
    DetachSession(Vec<ClientId>),
    TerminalPixelDimensions(PixelDimensions),
    BackgroundColor(String),
    ForegroundColor(String),
    ColorRegisters(Vec<(usize, String)>),
    TerminalResize(Size),
    FirstClientConnected(
        CliAssets,
        bool, // is_web_client
    ),
    AttachClient(
        CliAssets,
        Option<usize>,       // tab position to focus
        Option<(u32, bool)>, // (pane_id, is_plugin) => pane id to focus
        bool,                // is_web_client
    ),
    Action(Action, Option<u32>, Option<ClientId>), // u32 is the terminal id
    Key(KeyWithModifier, Vec<u8>, bool),           // key, raw_bytes, is_kitty_keyboard_protocol
    ClientExited,
    KillSession,
    ConnStatus,
    WebServerStarted(String), // String -> base_url
    FailedToStartWebServer(String),
}

impl Display for ClientToServerMsg {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientToServerMsg::DetachSession(..) => write!(f, "ClientToServerMsg::DetachSession"),
            ClientToServerMsg::TerminalPixelDimensions(..) => {
                write!(f, "ClientToServerMsg::TerminalPixelDimensions")
            },
            ClientToServerMsg::BackgroundColor(..) => {
                write!(f, "ClientToServerMsg::BackgroundColor")
            },
            ClientToServerMsg::ForegroundColor(..) => {
                write!(f, "ClientToServerMsg::ForegroundColor")
            },
            ClientToServerMsg::ColorRegisters(..) => write!(f, "ClientToServerMsg::ColorRegisters"),
            ClientToServerMsg::TerminalResize(..) => write!(f, "ClientToServerMsg::TerminalResize"),

            ClientToServerMsg::FirstClientConnected(..) => {
                write!(f, "ClientToServerMsg::FirstClientConnected")
            },
            ClientToServerMsg::AttachClient(..) => {
                write!(f, "ClientToServerMsg::AttachClient")
            },
            ClientToServerMsg::Action(action, _, _) => {
                write!(f, "ClientToServerMsg::Action({:?})", action)
            },
            ClientToServerMsg::Key(..) => {
                write!(f, "ClientToServerMsg::Key")
            },
            ClientToServerMsg::ClientExited => write!(f, "ClientToServerMsg::ClientExited"),
            ClientToServerMsg::KillSession => write!(f, "ClientToServerMsg::KillSession"),
            ClientToServerMsg::ConnStatus => write!(f, "ClientToServerMsg::ConnStatus"),
            ClientToServerMsg::WebServerStarted(..) => {
                write!(f, "ClientToServerMsg::WebServerStarted")
            },
            ClientToServerMsg::FailedToStartWebServer(..) => {
                write!(f, "ClientToServerMsg::FailedToStartWebServer")
            },
        }
    }
}

// Types of messages sent from the server to the client
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum ServerToClientMsg {
    Render(String),
    UnblockInputThread,
    Exit(ExitReason),
    Connected,
    Log(Vec<String>),
    LogError(Vec<String>),
    SwitchSession(ConnectToSession),
    UnblockCliPipeInput(String),   // String -> pipe name
    CliPipeOutput(String, String), // String -> pipe name, String -> Output
    QueryTerminalSize,
    StartWebServer,
    RenamedSession(String), // String -> new session name
    ConfigFileUpdated,
}

impl Display for ServerToClientMsg {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            ServerToClientMsg::Render(..) => write!(f, "ServerToClientMsg::Render"),
            ServerToClientMsg::UnblockInputThread => {
                write!(f, "ServerToClientMsg::UnblockInputThread")
            },
            ServerToClientMsg::Exit(..) => write!(f, "ServerToClientMsg::Exit"),
            ServerToClientMsg::Connected => write!(f, "ServerToClientMsg::Connected"),
            ServerToClientMsg::Log(..) => write!(f, "ServerToClientMsg::Log"),
            ServerToClientMsg::LogError(..) => write!(f, "ServerToClientMsg::LogError"),
            ServerToClientMsg::SwitchSession(..) => write!(f, "ServerToClientMsg::SwitchSession"),
            ServerToClientMsg::UnblockCliPipeInput(..) => {
                write!(f, "ServerToClientMsg::UnblockCliPipeInput")
            }, // String -> pipe name
            ServerToClientMsg::CliPipeOutput(..) => write!(f, "ServerToClientMsg::CliPipeOutput"), // String -> pipe name, String -> Output
            ServerToClientMsg::QueryTerminalSize => {
                write!(f, "ServerToClientMsg::QueryTerminalSize")
            }, // String -> pipe name, String -> Output
            ServerToClientMsg::StartWebServer => write!(f, "ServerToClientMsg::StartWebServer"),
            ServerToClientMsg::RenamedSession(..) => write!(f, "ServerToClientMsg::RenamedSession"),
            ServerToClientMsg::ConfigFileUpdated => {
                write!(f, "ServerToClientMsg::ConfigFileUpdated")
            },
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum ExitReason {
    Normal,
    NormalDetached,
    ForceDetached,
    CannotAttach,
    Disconnect,
    WebClientsForbidden,
    Error(String),
}

impl Display for ExitReason {
    fn fmt(&self, f: &mut Formatter) -> Result<(), Error> {
        match self {
            Self::Normal => write!(f, "Bye from Zellij!"),
            Self::NormalDetached => write!(f, "Session detached"),
            Self::ForceDetached => write!(
                f,
                "Session was detached from this client (possibly because another client connected)"
            ),
            Self::CannotAttach => write!(
                f,
                "Session attached to another client. Use --force flag to force connect."
            ),
            Self::WebClientsForbidden => write!(
                f,
                "Web clients are not allowed in this session - cannot attach"
            ),
            Self::Disconnect => {
                let session_tip = match crate::envs::get_session_name() {
                    Ok(name) => format!("`zellij attach {}`", name),
                    Err(_) => "see `zellij ls` and `zellij attach`".to_string(),
                };
                write!(
                    f,
                    "
Your zellij client lost connection to the zellij server.

As a safety measure, you have been disconnected from the current zellij session.
However, the session should still exist and none of your data should be lost.

This usually means that your terminal didn't process server messages quick
enough. Maybe your system is currently under high load, or your terminal
isn't performant enough.

There are a few things you can try now:
    - Reattach to your previous session and see if it works out better this
      time: {session_tip}
    - Try using a faster (maybe GPU-accelerated) terminal emulator
    "
                )
            },
            Self::Error(e) => write!(f, "Error occurred in server:\n{}", e),
        }
    }
}

#[cfg(windows)]
pub type IpcSocketStream = PipeStream;
#[cfg(unix)]
pub type IpcSocketStream = LocalSocketStream;

/// Sends messages on a stream socket, along with an [`ErrorContext`].
pub struct IpcSenderWithContext<T: Serialize> {
    sender: io::BufWriter<IpcSocketStream>,
    _phantom: PhantomData<T>,
}

#[cfg(unix)]
impl<T: Serialize> IpcSenderWithContext<T> {
    /// Returns a sender to the given [LocalSocketStream](interprocess::local_socket::LocalSocketStream).
    pub fn new(sender: LocalSocketStream) -> Self {
        Self {
            sender: io::BufWriter::new(sender),
            _phantom: PhantomData,
        }
    }

    /// Sends an event, along with the current [`ErrorContext`], on this [`IpcSenderWithContext`]'s socket.
    pub fn send(&mut self, msg: T) -> Result<()> {
        let err_ctx = get_current_ctx();
        if rmp_serde::encode::write(&mut self.sender, &(msg, err_ctx)).is_err() {
            Err(anyhow!("failed to send message to client"))
        } else {
            if let Err(e) = self.sender.flush() {
                log::error!("Failed to flush ipc sender: {}", e);
            }
            Ok(())
        }
    }

    /// Returns an [`IpcReceiverWithContext`] with the same socket as this sender.
    pub fn get_receiver<F>(&self) -> IpcReceiverWithContext<F>
    where
        F: for<'de> Deserialize<'de> + Serialize,
    {
        let sock_fd = self.sender.get_ref().as_raw_fd();
        let dup_sock = dup(sock_fd).unwrap();
        let socket = unsafe { LocalSocketStream::from_raw_fd(dup_sock) };
        IpcReceiverWithContext::new(socket)
    }
}

#[cfg(windows)]
impl<T: Serialize> IpcSenderWithContext<T> {
    /// Returns a sender to the given [PipeStream](zellij_utils::windows_utils::named_pipe::PipeStream).
    pub fn new(sender: PipeStream) -> Self {
        Self {
            sender: io::BufWriter::new(sender),
            _phantom: PhantomData,
        }
    }

    ///Returns an [`IpcReceiverWithContext`] with the same socket as this sender.
    pub fn get_receiver<F>(&self) -> IpcReceiverWithContext<F>
    where
        F: for<'de> Deserialize<'de> + Serialize,
    {
        let socket = self
            .sender
            .get_ref()
            .try_clone()
            .expect("Failed to duplicate pipe to obtain receiver");
        IpcReceiverWithContext::new(socket)
    }

    /// Sends an event, along with the current [`ErrorContext`], on this [`IpcSenderWithContext`]'s socket.
    pub fn send(&mut self, msg: T) -> Result<()> {
        log::debug!("Sending message");
        let err_ctx = get_current_ctx();
        let data = (msg, err_ctx);
        if let Ok(test_result) = rmp_serde::encode::to_vec(&data) {
            log::debug!("Writing {} bytes to pipe", test_result.len());
        }
        let result = if rmp_serde::encode::write(&mut self.sender, &data).is_err() {
            Err(anyhow!("failed to send message to client"))
        } else {
            // TODO: unwrapping here can cause issues when the server disconnects which we don't mind
            // do we need to handle errors here in other cases?
            let _ = self.sender.flush();
            Ok(())
        };
        log::debug!("Message sent with {:?}", &result);
        result
    }
}

/// Receives messages on a stream socket, along with an [`ErrorContext`].
pub struct IpcReceiverWithContext<T> {
    #[cfg(unix)]
    receiver: io::BufReader<IpcSocketStream>,
    #[cfg(windows)]
    receiver: IpcSocketStream,
    _phantom: PhantomData<T>,
}

#[cfg(unix)]
impl<T> IpcReceiverWithContext<T>
where
    T: for<'de> Deserialize<'de> + Serialize,
{
    /// Returns a receiver to the given [LocalSocketStream](interprocess::local_socket::LocalSocketStream).
    pub fn new(receiver: LocalSocketStream) -> Self {
        Self {
            receiver: io::BufReader::new(receiver),
            _phantom: PhantomData,
        }
    }

    /// Receives an event, along with the current [`ErrorContext`], on this [`IpcReceiverWithContext`]'s socket.
    pub fn recv(&mut self) -> Option<(T, ErrorContext)> {
        match rmp_serde::decode::from_read(&mut self.receiver) {
            Ok(msg) => Some(msg),
            Err(e) => {
                warn!("Error in IpcReceiver.recv(): {:?}", e);
                None
            },
        }
    }

    /// Returns an [`IpcSenderWithContext`] with the same socket as this receiver.
    pub fn get_sender<F: Serialize>(&self) -> IpcSenderWithContext<F> {
        let sock_fd = self.receiver.get_ref().as_raw_fd();
        let dup_sock = dup(sock_fd).unwrap();
        let socket = unsafe { LocalSocketStream::from_raw_fd(dup_sock) };
        IpcSenderWithContext::new(socket)
    }
}

#[cfg(windows)]
impl<T> IpcReceiverWithContext<T>
where
    T: for<'de> Deserialize<'de> + Serialize,
{
    /// Returns a receiver to the given [PipeStream](zellij_utils::windows_utils::named_pipe::PipeStream).
    pub fn new(receiver: PipeStream) -> Self {
        Self {
            receiver,
            _phantom: PhantomData,
        }
    }

    /// Returns an [`IpcSenderWithContext`] with the same socket as this receiver.
    pub fn get_sender<F: Serialize>(&self) -> IpcSenderWithContext<F> {
        let socket = self
            .receiver
            .try_clone()
            .expect("Failed to duplicate pipe to obtain sender");
        IpcSenderWithContext::new(socket)
    }

    pub fn is_usable(&self) -> Result<bool, std::io::Error> {
        match self.receiver.left_bytes() {
            Ok(_) => Ok(true),
            Err(e) => {
                if let Some(code) = e.raw_os_error() {
                    match code as u32 {
                        ERROR_BROKEN_PIPE => Ok(false),
                        _ => Err(e),
                    }
                } else {
                    Err(e)
                }
            },
        }
    }

    pub fn is_read_buffer_remained(&self) -> Result<bool, std::io::Error> {
        match self.receiver.left_bytes() {
            Ok((left_message_bytes, available_bytes)) => {
                Ok(left_message_bytes > 0 || available_bytes > 0)
            },
            Err(e) => Err(e),
        }
    }

    pub fn clear_read_buffer(&mut self) -> Result<(), std::io::Error> {
        loop {
            match self.is_usable() {
                Ok(true) => {},
                Ok(false) => return Ok(()),
                Err(e) => return Err(e),
            }

            if let Ok((_, left_bytes)) = self.receiver.left_bytes() {
                let mut flush_buf: Vec<u8> = Vec::with_capacity(left_bytes);
                let flush_buf_slice: &mut [u8] =
                    unsafe { std::mem::transmute(flush_buf.spare_capacity_mut()) };
                match self.receiver.read(flush_buf_slice) {
                    Ok(_) => {},
                    Err(e) => {
                        if let Some(code) = e.raw_os_error() {
                            match code as u32 {
                                ERROR_BROKEN_PIPE => return Ok(()),
                                _ => return Err(e),
                            }
                        } else {
                            return Err(e);
                        }
                    },
                }
            }
        }
    }

    /// Receives an event, along with the current [`ErrorContext`], on this [`IpcReceiverWithContext`]'s socket.
    pub fn recv(&mut self) -> Option<(T, ErrorContext)> {
        let mut initial_buf_size: usize = 1024;
        if let Ok((_, available_byte)) = self.receiver.left_bytes() {
            initial_buf_size = initial_buf_size.max(available_byte);
        }
        let mut buf = Vec::with_capacity(initial_buf_size);
        log::info!("Reading from pipe");
        loop {
            loop {
                let remaining_buffer = buf.spare_capacity_mut();
                for element in remaining_buffer.iter_mut() {
                    element.write(0);
                }
                let remaining_buffer: &mut [u8] = unsafe { std::mem::transmute(remaining_buffer) };

                match self.receiver.read(remaining_buffer) {
                    Ok(consumed) => unsafe {
                        buf.set_len(buf.len() + consumed);
                        if let Ok((left_message_bytes, _)) = self.receiver.left_bytes() {
                            if left_message_bytes == 0 {
                                break;
                            } else {
                                log::debug!("Request {:?} More Bytes!", left_message_bytes);
                                buf.reserve_exact(left_message_bytes);
                            }
                        }
                    },
                    Err(e) => {
                        if e.kind() == std::io::ErrorKind::BrokenPipe
                            || e.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32)
                        {
                            log::debug!("Pipe closed (broken pipe) in IpcReceiver.recv()");
                            return None;
                        }
                        log::error!("Error in IpcReceiver.recv(): {:?}", e);
                        return None;
                    },
                }
            }
            let input = &buf;
            log::debug!("Read {:?} bytes", input.len());
            match rmp_serde::decode::from_slice(input) {
                Ok(msg) => return Some(msg),
                Err(e) => match e {
                    rmp_serde::decode::Error::LengthMismatch(expected) => {
                        let expected = expected as i32;
                        let input_len = input.len() as i32;
                        log::error!("expected {:?} bytes, but we read {:?}", expected, input_len);
                        if expected > input_len {
                            buf.reserve((expected - input_len) as usize);
                            log::debug!("Request {:?} More Bytes!", expected - input_len);
                        } else {
                            log::error!("We should read less data!");
                            return None;
                        }
                    },
                    rmp_serde::decode::Error::InvalidDataRead(io_error)
                    | rmp_serde::decode::Error::InvalidMarkerRead(io_error)
                        if io_error.kind() == std::io::ErrorKind::UnexpectedEof =>
                    {
                        log::debug!("try read more data since Unexpected EOF err");
                        let mut found_new_message = false;
                        for _ in 0..10 {
                            if let Ok((left_message, available_data)) = self.receiver.left_bytes() {
                                if left_message > 0 {
                                    log::debug!("Found new {} bytes message", left_message);
                                    buf.reserve(left_message);
                                    found_new_message = true;
                                    break;
                                }

                                if available_data > 0 {
                                    log::debug!(
                                        "Found new {} bytes available data",
                                        available_data
                                    );
                                    buf.reserve(available_data);
                                    found_new_message = true;
                                    break;
                                }
                            }
                            sleep(Duration::from_micros(10));
                        }
                        if found_new_message {
                            continue;
                        }
                        log::warn!("Missing some content in {:x?}", &buf);
                        return None;
                    },
                    _ => {
                        log::error!("Error: {:?}", e);
                        log::warn!("Missing some content in {:x?}", &buf);
                        return None;
                    },
                },
            }
        }
    }
}

#[cfg(unix)]
pub fn bind_server(name: &Path) -> Result<LocalSocketListener> {
    let socket_path = name;
    drop(std::fs::remove_file(&socket_path));
    let listener = LocalSocketListener::bind(&*socket_path)?;
    // set the sticky bit to avoid the socket file being potentially cleaned up
    // https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html states that for XDG_RUNTIME_DIR:
    // "To ensure that your files are not removed, they should have their access time timestamp modified at least once every 6 hours of monotonic time or the 'sticky' bit should be set on the file. "
    // It is not guaranteed that all platforms allow setting the sticky bit on sockets!
    drop(set_permissions(&socket_path, 0o1700));

    return Ok(listener);
}

#[cfg(windows)]
pub fn bind_server(name: &Path) -> Result<Pipe> {
    let pipe = Pipe::new(name);

    // Create a marker file in ZELLIJ_SOCK_DIR so session discovery can find this
    // session via fs::read_dir. On Unix, the socket file itself serves this purpose.
    if let Some(parent) = name.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::File::create(name);

    Ok(pipe)
}

#[cfg(all(test, windows))]
mod windows_ipc_tests {
    use super::*;
    use crate::windows_utils::named_pipe::Pipe;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn unique_pipe_path() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        PathBuf::from(format!(
            "ipc_test_{}_{}",
            pid, id
        ))
    }

    #[test]
    fn ipc_sender_receiver_round_trip_conn_status() {
        let path = unique_pipe_path();
        let pipe = Pipe::new(&path);
        let pipe_clone = pipe.clone();

        let server_thread = std::thread::spawn(move || {
            let server_stream = pipe_clone.accept().expect("Server accept failed");
            let mut receiver: IpcReceiverWithContext<ClientToServerMsg> =
                IpcReceiverWithContext::new(server_stream);
            let mut sender = receiver.get_sender::<ServerToClientMsg>();

            // Receive ConnStatus from client
            let (msg, _ctx) = receiver.recv().expect("Server recv failed");
            assert!(
                matches!(msg, ClientToServerMsg::ConnStatus),
                "Expected ConnStatus, got: {:?}",
                msg
            );

            // Send Connected back
            sender.send(ServerToClientMsg::Connected).expect("Server send failed");
        });

        std::thread::sleep(std::time::Duration::from_millis(50));

        let client_stream = pipe.connect().expect("Client connect failed");
        let mut sender: IpcSenderWithContext<ClientToServerMsg> =
            IpcSenderWithContext::new(client_stream);
        let mut receiver = sender.get_receiver::<ServerToClientMsg>();

        // Send ConnStatus
        sender.send(ClientToServerMsg::ConnStatus).expect("Client send failed");

        // Receive Connected
        let (msg, _ctx) = receiver.recv().expect("Client recv failed");
        assert!(
            matches!(msg, ServerToClientMsg::Connected),
            "Expected Connected, got: {:?}",
            msg
        );

        server_thread.join().expect("Server thread panicked");
    }

    #[test]
    fn ipc_sender_receiver_round_trip_kill_session() {
        let path = unique_pipe_path();
        let pipe = Pipe::new(&path);
        let pipe_clone = pipe.clone();

        let server_thread = std::thread::spawn(move || {
            let server_stream = pipe_clone.accept().expect("Server accept failed");
            let mut receiver: IpcReceiverWithContext<ClientToServerMsg> =
                IpcReceiverWithContext::new(server_stream);

            let (msg, _ctx) = receiver.recv().expect("Server recv failed");
            assert!(
                matches!(msg, ClientToServerMsg::KillSession),
                "Expected KillSession, got: {:?}",
                msg
            );
        });

        std::thread::sleep(std::time::Duration::from_millis(50));

        let client_stream = pipe.connect().expect("Client connect failed");
        let mut sender: IpcSenderWithContext<ClientToServerMsg> =
            IpcSenderWithContext::new(client_stream);

        sender.send(ClientToServerMsg::KillSession).expect("Client send failed");
        server_thread.join().expect("Server thread panicked");
    }

    #[test]
    fn ipc_sender_receiver_round_trip_render() {
        let path = unique_pipe_path();
        let pipe = Pipe::new(&path);
        let pipe_clone = pipe.clone();

        let test_render_data = "Hello, Zellij!\x1b[32mGreen text\x1b[0m".to_string();
        let expected_data = test_render_data.clone();

        let server_thread = std::thread::spawn(move || {
            let server_stream = pipe_clone.accept().expect("Server accept failed");
            let receiver: IpcReceiverWithContext<ClientToServerMsg> =
                IpcReceiverWithContext::new(server_stream);
            let mut sender = receiver.get_sender::<ServerToClientMsg>();

            sender
                .send(ServerToClientMsg::Render(test_render_data))
                .expect("Server send failed");
        });

        std::thread::sleep(std::time::Duration::from_millis(50));

        let client_stream = pipe.connect().expect("Client connect failed");
        let mut receiver: IpcReceiverWithContext<ServerToClientMsg> =
            IpcReceiverWithContext::new(client_stream);

        // Use the Windows recv implementation which handles multi-part messages
        let (msg, _ctx) = receiver.recv().expect("Client recv failed");
        match msg {
            ServerToClientMsg::Render(data) => {
                assert_eq!(data, expected_data);
            },
            other => panic!("Expected Render, got: {:?}", other),
        }

        server_thread.join().expect("Server thread panicked");
    }

    #[test]
    fn ipc_large_render_message() {
        // Test sending a large Render message (simulating a full screen redraw)
        let path = unique_pipe_path();
        let pipe = Pipe::new(&path);
        let pipe_clone = pipe.clone();

        // Create a large render payload (~16KB, typical for a full terminal screen)
        let large_payload = "A".repeat(16 * 1024);
        let expected = large_payload.clone();

        let server_thread = std::thread::spawn(move || {
            let server_stream = pipe_clone.accept().expect("Server accept failed");
            let receiver: IpcReceiverWithContext<ClientToServerMsg> =
                IpcReceiverWithContext::new(server_stream);
            let mut sender = receiver.get_sender::<ServerToClientMsg>();

            sender
                .send(ServerToClientMsg::Render(large_payload))
                .expect("Server send failed");
        });

        std::thread::sleep(std::time::Duration::from_millis(50));

        let client_stream = pipe.connect().expect("Client connect failed");
        let mut receiver: IpcReceiverWithContext<ServerToClientMsg> =
            IpcReceiverWithContext::new(client_stream);

        let (msg, _ctx) = receiver.recv().expect("Client recv failed");
        match msg {
            ServerToClientMsg::Render(data) => {
                assert_eq!(data.len(), expected.len(), "Render data length mismatch");
                assert_eq!(data, expected, "Render data content mismatch");
            },
            other => panic!("Expected Render, got: {:?}", other),
        }

        server_thread.join().expect("Server thread panicked");
    }

    #[test]
    fn ipc_sequential_conn_status_requests() {
        // Test that a server can handle multiple sequential ConnStatus requests
        // (simulates session discovery polling)
        let path = unique_pipe_path();
        let pipe = Pipe::new(&path);
        let pipe_clone = pipe.clone();

        let server_thread = std::thread::spawn(move || {
            // Handle 3 sequential client connections
            for i in 0..3 {
                let server_stream = pipe_clone.accept().expect("Server accept failed");
                let mut receiver: IpcReceiverWithContext<ClientToServerMsg> =
                    IpcReceiverWithContext::new(server_stream);
                let mut sender = receiver.get_sender::<ServerToClientMsg>();

                let (msg, _ctx) = receiver.recv().expect("Server recv failed");
                assert!(
                    matches!(msg, ClientToServerMsg::ConnStatus),
                    "Expected ConnStatus on iteration {}, got: {:?}",
                    i,
                    msg
                );
                sender
                    .send(ServerToClientMsg::Connected)
                    .expect("Server send failed");
            }
        });

        // Give server time to start
        std::thread::sleep(std::time::Duration::from_millis(50));

        // Connect 3 times sequentially
        for i in 0..3 {
            let client_stream = pipe
                .connect()
                .unwrap_or_else(|e| panic!("Client connect {} failed: {}", i, e));
            let mut sender: IpcSenderWithContext<ClientToServerMsg> =
                IpcSenderWithContext::new(client_stream);
            let mut receiver = sender.get_receiver::<ServerToClientMsg>();

            sender
                .send(ClientToServerMsg::ConnStatus)
                .unwrap_or_else(|e| panic!("Client send {} failed: {}", i, e));

            let (msg, _ctx) = receiver
                .recv()
                .unwrap_or_else(|| panic!("Client recv {} returned None", i));
            assert!(
                matches!(msg, ServerToClientMsg::Connected),
                "Expected Connected on iteration {}, got: {:?}",
                i,
                msg
            );
        }

        server_thread.join().expect("Server thread panicked");
    }

    #[test]
    fn ipc_sender_receiver_exit_reason() {
        // Test sending Exit messages with different reasons
        let path = unique_pipe_path();
        let pipe = Pipe::new(&path);
        let pipe_clone = pipe.clone();

        let server_thread = std::thread::spawn(move || {
            let server_stream = pipe_clone.accept().expect("Server accept failed");
            let receiver: IpcReceiverWithContext<ClientToServerMsg> =
                IpcReceiverWithContext::new(server_stream);
            let mut sender = receiver.get_sender::<ServerToClientMsg>();

            sender
                .send(ServerToClientMsg::Exit(ExitReason::Normal))
                .expect("Server send failed");
        });

        std::thread::sleep(std::time::Duration::from_millis(50));

        let client_stream = pipe.connect().expect("Client connect failed");
        let mut receiver: IpcReceiverWithContext<ServerToClientMsg> =
            IpcReceiverWithContext::new(client_stream);

        let (msg, _ctx) = receiver.recv().expect("Client recv failed");
        match msg {
            ServerToClientMsg::Exit(ExitReason::Normal) => {},
            other => panic!("Expected Exit(Normal), got: {:?}", other),
        }

        server_thread.join().expect("Server thread panicked");
    }

    #[test]
    fn bind_server_creates_marker_file() {
        let temp_dir = std::env::temp_dir().join(format!(
            "zellij_bind_test_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&temp_dir);

        let session_name = format!("test_session_{}", std::process::id());
        let path = temp_dir.join(&session_name);

        let _pipe = bind_server(&path).expect("bind_server failed");

        // Verify marker file was created
        assert!(path.exists(), "Marker file should exist after bind_server");

        // Cleanup
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&temp_dir);
    }
}
